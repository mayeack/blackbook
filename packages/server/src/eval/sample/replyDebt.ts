/**
 * G3 reply debt (intelligence §8, scaled down): conversations frozen at a fixed timestamp (the sampling time).
 * Half are live debts (the system says "needs your reply"), half are conversations whose last message is theirs,
 * old enough to count, with no debt (the system says nothing is owed) — the negatives recall is measured on.
 * Stratified by DM / small group and source. The item shows only messages up to the frozen time, so later replies
 * can't leak into the judgement.
 */
import type { NewItem, ReplyPayload, StoredPrediction } from '../types';
import { DAY, HOUR, shortName, shuffle, SOURCE_LABEL, sourceGroup } from '../util';
import { fillStrata, type SampleContext, type SampleResult } from './context';

export const LINES_SHOWN = 12;
const MSG_OK = `m.retracted_at IS NULL AND m.is_bot = 0 AND m.is_spam = 0 AND m.dup_of IS NULL AND m.kind NOT IN ('system','group_event')`;
const GROUP_MAX = 8;
const MIN_AGE = { direct: 4 * HOUR, group: 12 * HOUR } as const;
const ACTIVE_DAYS = 30;
const NEG_SCAN = 3000;

const SIDE_W: Record<string, number> = { pos: 0.5, neg: 0.5 };
const CHAT_W: Record<string, number> = { direct: 0.6, group: 0.4 };
const SOURCE_W: Record<string, number> = { imessage: 0.6, whatsapp: 0.24, instagram: 0.16 };

interface Case {
  side: 'pos' | 'neg';
  conversationId: string;
  source: string;
  chat: 'direct' | 'group';
  debt: {
    id: string;
    personId: string;
    debtMsg: number | null;
    lastInbound: number;
    askedAt: number;
    reason: string | null;
    urgency: string | null;
    classifier: string;
    confidence: number | null;
    llmState: string | null;
    status: string;
  } | null;
}

const RELATIVE = (ms: number) => (ms >= DAY ? `${Math.round(ms / DAY)}d` : `${Math.max(1, Math.round(ms / HOUR))}h`);

export async function sampleReplyDebt(c: SampleContext): Promise<SampleResult> {
  const db = c.db;
  const T = c.now;
  const pos = (
    db
      .prepare(
        `SELECT d.id, d.conversation_id, d.person_id, d.debt_msg, d.last_inbound_msg, d.asked_at, d.reason, d.urgency, d.classifier, d.confidence, d.llm_state,
                d.status, c.source, c.kind
         FROM reply_debts d JOIN conversations c ON c.id = d.conversation_id
         WHERE d.status IN ('open','snoozed') AND c.agent_excluded = 0 AND c.kind IN ('direct','group')`,
      )
      .all() as {
      id: string;
      conversation_id: string;
      person_id: string;
      debt_msg: number | null;
      last_inbound_msg: number;
      asked_at: number;
      reason: string | null;
      urgency: string | null;
      classifier: string;
      confidence: number | null;
      llm_state: string | null;
      status: string;
      source: string;
      kind: 'direct' | 'group';
    }[]
  ).map(
    (r): Case => ({
      side: 'pos',
      conversationId: r.conversation_id,
      source: r.source,
      chat: r.kind,
      debt: {
        id: r.id,
        personId: c.canon(r.person_id),
        debtMsg: r.debt_msg,
        lastInbound: r.last_inbound_msg,
        askedAt: r.asked_at,
        reason: r.reason,
        urgency: r.urgency,
        classifier: r.classifier,
        confidence: r.confidence,
        llmState: r.llm_state,
        status: r.status,
      },
    }),
  );
  const neg = (
    db
      .prepare(
        `SELECT c.id, c.source, c.kind FROM conversations c
         WHERE c.kind IN ('direct','group') AND c.agent_excluded = 0 AND c.last_message_at >= ?
           AND NOT EXISTS (SELECT 1 FROM reply_debts d WHERE d.conversation_id = c.id AND d.status IN ('open','snoozed'))
         ORDER BY c.last_message_at DESC LIMIT ?`,
      )
      .all(T - ACTIVE_DAYS * DAY, NEG_SCAN) as { id: string; source: string; kind: 'direct' | 'group' }[]
  ).map((r): Case => ({ side: 'neg', conversationId: r.id, source: r.source, chat: r.kind, debt: null }));

  // One case per conversation across top-ups (a later freeze of the same chat would be a near-duplicate).
  const taken = new Set([...c.exclude].map((e) => /^conv:(.+)@\d+$/.exec(e)?.[1]).filter((x): x is string => !!x));
  const pool = [...pos, ...neg].filter((x) => !taken.has(x.conversationId));
  if (!pool.length || c.size <= 0) return { items: [], pool: 0 };
  const groups = new Map<string, Case[]>();
  for (const x of shuffle(pool, c.rand)) {
    const key = `${x.side}|${x.chat}|${sourceGroup(x.source)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(x);
  }
  const weight = (key: string) => {
    const [side, chat, src] = key.split('|') as [string, string, string];
    return (SIDE_W[side] ?? 0.5) * (CHAT_W[chat] ?? 0.5) * (SOURCE_W[src] ?? 0.1);
  };
  const items = await fillStrata(groups, weight, c.size, (x, stratum) => buildCase(c, x, stratum));
  return { items, pool: pool.length };
}

const refOf = (conversationId: string, frozenAt: number) => `conv:${conversationId}@${frozenAt}`;

function buildCase(c: SampleContext, x: Case, stratum: string): NewItem | null {
  const db = c.db;
  const T = c.now;
  if (x.chat === 'group') {
    const n = (db.prepare('SELECT count(*) FROM conversation_members WHERE conversation_id = ? AND is_active = 1').pluck().get(x.conversationId) as number) + 1;
    if (n > GROUP_MAX) return null;
  }
  const msgs = db
    .prepare(
      `SELECT m.id, m.sent_at, m.is_from_me, i.person_id FROM messages m LEFT JOIN identities i ON i.id = m.sender_identity_id
       WHERE m.conversation_id = ? AND m.sent_at <= ? AND ${MSG_OK}
       ORDER BY m.sent_at DESC, m.id DESC LIMIT ?`,
    )
    .all(x.conversationId, T, LINES_SHOWN) as { id: number; sent_at: number; is_from_me: number; person_id: string | null }[];
  if (!msgs.length) return null;
  // Every author must be the owner or a visible person (hidden people never show up here).
  for (const m of msgs) if (!m.is_from_me && (!m.person_id || !c.visible(m.person_id))) return null;
  const last = msgs[0]!;
  let prediction: StoredPrediction;
  let personId: string | null;
  if (x.side === 'pos') {
    const d = x.debt!;
    if (!c.visible(d.personId)) return null;
    personId = d.personId;
    const p = c.visible(d.personId)!;
    const by = d.classifier === 'llm' || d.llmState ? 'confirmed by Claude' : 'heuristic';
    prediction = {
      id: 'reply',
      kind: 'needs_reply',
      label: 'Needs your reply',
      detail: `${shortName(p)} · asked ${RELATIVE(T - d.askedAt)} ago · ${d.reason ?? 'other'} · ${by}${d.confidence !== null ? ` · conf ${d.confidence.toFixed(2)}` : ''}${d.status === 'snoozed' ? ' · snoozed' : ''}`,
      refs: [`m:${d.debtMsg ?? d.lastInbound}`],
      m: { decision: d.status, cat: d.reason, personId: d.personId, subjectId: d.id, conf: d.confidence, method: d.classifier },
    };
  } else {
    if (last.is_from_me) return null;
    if (T - last.sent_at < MIN_AGE[x.chat]) return null;
    personId = c.canon(last.person_id!);
    const p = c.visible(personId)!;
    prediction = {
      id: 'reply',
      kind: 'no_reply',
      label: 'No reply needed',
      detail: `last message from ${shortName(p)}, ${RELATIVE(T - last.sent_at)} before the freeze`,
      refs: [`m:${last.id}`],
      m: { decision: 'none', personId },
    };
  }
  const counterpart = personId ? c.visible(personId) : null;
  const title = [SOURCE_LABEL[sourceGroup(x.source)], x.chat === 'direct' ? (counterpart ? `DM with ${shortName(counterpart)}` : 'DM') : 'group'].join(' · ');
  const payload: ReplyPayload = {
    kind: 'reply_debt',
    conversationId: x.conversationId,
    source: x.source,
    chat: x.chat,
    frozenAt: T,
    msgIds: msgs.map((m) => m.id).reverse(),
    debtId: x.debt?.id ?? null,
    debtMsg: x.debt?.debtMsg ?? null,
    personId,
  };
  return { set: 'reply_debt', subjectRef: refOf(x.conversationId, T), stratum, title, frozenAt: T, payload, predictions: [prediction], promptVersion: null };
}
