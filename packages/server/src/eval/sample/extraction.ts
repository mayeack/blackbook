/**
 * G1 extraction windows (intelligence §8, scaled down): applied windows and triage-skipped ones, stratified by
 * source (iMessage 60 % / WhatsApp 24 % / Instagram 16 %), chat (DM 60 % / group 40 %) and signal type (what the
 * window produced: relation > commitment > needs_reply > fact > nothing; ~20 % "nothing here" windows, triage
 * skips included so triage misses show up as recall). Each item snapshots the window's lines as sent, the
 * pseudonymized user turn (for prompt replays) and what was applied from it.
 */
import { loadPacket } from '../../extraction';
import { appliedPredictions } from '../predictions';
import type { ExtractionPayload, NewItem, PayloadLine } from '../types';
import { inList, shortDate, shortName, shuffle, SOURCE_LABEL, sourceGroup } from '../util';
import { fillStrata, type SampleContext, type SampleResult } from './context';

const SOURCE_W: Record<string, number> = { imessage: 0.6, whatsapp: 0.24, instagram: 0.16 };
const CHAT_W: Record<string, number> = { dm: 0.6, group: 0.4 };
const SIGNAL_W: Record<string, number> = { fact: 0.36, commitment: 0.16, needs_reply: 0.16, relation: 0.12, nothing: 0.2 };
const SIGNALS = ['relation', 'commitment', 'needs_reply', 'fact'] as const;

interface WindowCand {
  id: string;
  conversation_id: string;
  mode: 'steady' | 'historical';
  status: 'applied' | 'triaged_out';
  prompt_version: string | null;
  source: string;
  conv_kind: 'direct' | 'group';
}

export async function sampleExtraction(c: SampleContext): Promise<SampleResult> {
  const db = c.db;
  const cands = db
    .prepare(
      `SELECT w.id, w.conversation_id, w.mode, w.status, w.prompt_version, c.source, c.kind AS conv_kind
       FROM windows w JOIN conversations c ON c.id = w.conversation_id
       WHERE w.mode IN ('steady','historical') AND c.kind IN ('direct','group') AND c.agent_excluded = 0
         AND ((w.status = 'applied' AND EXISTS (SELECT 1 FROM extraction_packets p WHERE p.window_id = w.id))
              OR (w.status = 'triaged_out' AND EXISTS (SELECT 1 FROM extraction_coverage ec WHERE ec.window_id = w.id)))`,
    )
    .all() as WindowCand[];
  const pool = cands.filter((w) => !c.exclude.has(`win:${w.id}`));
  if (!pool.length || c.size <= 0) return { items: [], pool: 0 };

  // Signal per window, set-based (evidence on the window's NEW messages; its needs_reply verdict).
  const signals = new Map<string, Set<string>>();
  const add = (id: string, s: string) => {
    let set = signals.get(id);
    if (!set) signals.set(id, (set = new Set()));
    set.add(s);
  };
  for (const r of db
    .prepare(
      // evidence drives the loop (CROSS JOIN fixes the order): it is far smaller than the coverage of every message.
      `SELECT ec.window_id AS id, e.subject_type AS t FROM evidence e CROSS JOIN extraction_coverage ec ON ec.message_id = e.message_id
       WHERE e.subject_type IN ('fact','commitment','edge_label') GROUP BY ec.window_id, e.subject_type`,
    )
    .all() as { id: string; t: string }[]) {
    add(r.id, r.t === 'edge_label' ? 'relation' : r.t);
  }
  for (const id of db.prepare(`SELECT DISTINCT window_id FROM reply_verdicts WHERE state = 'needs_reply' AND window_id IS NOT NULL`).pluck().all() as string[]) {
    add(id, 'needs_reply');
  }
  const signalOf = (w: WindowCand): string => {
    if (w.status === 'triaged_out') return 'nothing';
    const s = signals.get(w.id);
    return SIGNALS.find((x) => s?.has(x)) ?? 'nothing';
  };

  const groups = new Map<string, WindowCand[]>();
  for (const w of shuffle(pool, c.rand)) {
    const key = `${sourceGroup(w.source)}|${w.conv_kind === 'direct' ? 'dm' : 'group'}|${signalOf(w)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(w);
  }
  const weight = (key: string) => {
    const [src, chat, sig] = key.split('|') as [string, string, string];
    return (SOURCE_W[src] ?? 0.1) * (CHAT_W[chat] ?? 0.5) * (SIGNAL_W[sig] ?? 0.1);
  };
  const items = await fillStrata(groups, weight, c.size, (w, stratum) => buildExtractionItem(c, w, stratum));
  return { items, pool: pool.length };
}

function linesFromPacket(c: SampleContext, windowId: string): { lines: PayloadLine[]; userText: string | null; counterpart: string | null } | null {
  const pk = loadPacket(c.db, windowId);
  if (!pk) return null;
  const lines: PayloadLine[] = pk.packet.lines.map((l) => ({
    msgId: l.msgId,
    n: l.n,
    role: l.role,
    at: l.at,
    authorPersonId: l.authorPersonId ? c.canon(l.authorPersonId) : null,
    body: l.body,
  }));
  return { lines, userText: pk.userText, counterpart: pk.packet.dmCounterpart ? c.canon(pk.packet.dmCounterpart) : null };
}

/** A triage-skipped window never had a packet: its messages come from the coverage table. */
function linesFromCoverage(c: SampleContext, windowId: string): PayloadLine[] | null {
  const rows = c.db
    .prepare(
      `SELECT m.id, m.sent_at, m.is_from_me, i.person_id FROM extraction_coverage ec JOIN messages m ON m.id = ec.message_id
       LEFT JOIN identities i ON i.id = m.sender_identity_id WHERE ec.window_id = ? ORDER BY m.sent_at, m.id`,
    )
    .all(windowId) as { id: number; sent_at: number; is_from_me: number; person_id: string | null }[];
  const lines: PayloadLine[] = [];
  for (const r of rows) {
    if (!r.is_from_me && !r.person_id) continue;
    lines.push({ msgId: r.id, n: 0, role: 'new', at: r.sent_at, authorPersonId: r.is_from_me ? null : c.canon(r.person_id!), body: null });
  }
  return lines.length ? lines : null;
}

function buildExtractionItem(c: SampleContext, w: WindowCand, stratum: string): NewItem | null {
  let lines: PayloadLine[] | null;
  let userText: string | null = null;
  let counterpart: string | null = null;
  if (w.status === 'applied') {
    const p = linesFromPacket(c, w.id);
    if (!p) return null;
    ({ lines, userText, counterpart } = p);
  } else {
    lines = linesFromCoverage(c, w.id);
  }
  if (!lines?.length) return null;
  // Hidden people never appear outside Settings → Hidden: skip windows they wrote in.
  if (lines.some((l) => l.authorPersonId !== null && l.authorPersonId !== c.meId && !c.visible(l.authorPersonId))) return null;
  const fresh = lines.filter((l) => l.role === 'new');
  if (!fresh.length) return null;
  // Lines whose message is gone (retracted, deleted) can't be shown or judged.
  const live = new Set(
    c.db
      .prepare(`SELECT id FROM messages WHERE retracted_at IS NULL AND id IN (${inList(fresh.length)})`)
      .pluck()
      .all(...fresh.map((l) => l.msgId)) as number[],
  );
  if (!fresh.some((l) => live.has(l.msgId))) return null;

  const predictions = w.status === 'applied' ? appliedPredictions({ db: c.db, tz: c.tz, canon: c.canon, visible: c.visible, meId: c.meId }, w.id, fresh.map((l) => l.msgId)) : [];
  const group = sourceGroup(w.source);
  const chat = w.conv_kind === 'direct' ? 'dm' : 'group';
  const other = counterpart ? c.visible(counterpart) : null;
  const firstAt = Math.min(...fresh.map((l) => l.at));
  const title = [
    SOURCE_LABEL[group],
    chat === 'dm' ? (other ? `DM with ${shortName(other)}` : 'DM') : 'group',
    ...(w.mode === 'historical' ? ['history'] : []),
    ...(w.status === 'triaged_out' ? ['skipped by triage'] : []),
    shortDate(firstAt, c.tz, c.now),
  ].join(' · ');
  const payload: ExtractionPayload = {
    kind: 'extraction',
    windowId: w.id,
    conversationId: w.conversation_id,
    source: w.source,
    chat,
    mode: w.mode,
    status: w.status,
    lines,
    userText,
  };
  return { set: 'extraction', subjectRef: `win:${w.id}`, stratum, title, frozenAt: c.now, payload, predictions, promptVersion: w.prompt_version };
}
