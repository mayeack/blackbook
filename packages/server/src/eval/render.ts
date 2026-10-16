/**
 * EvalItem DTOs for the labeling page (/settings/eval). Lines are rendered at read time from the live tables,
 * never from copies: a message retracted since sampling disappears, phones and emails are masked, hidden
 * people's lines, names and claims never show (an item about a hidden person isn't listed at all). The owner
 * sees his real messages here (his own data, on his own server); nothing in this module is logged or sent.
 */
import type { EvalItem, EvalLine, EvalPrediction } from '@yb/shared';
import type { DB } from '../db/connection';
import { hiddenNameRedactor, maskText } from '../routes/people';
import type { ExtractionPayload, IdentityPayload, Item, ReplyPayload } from './types';
import { canonFn, inList, meId, shortName, SOURCE_LABEL, sourceGroup, visibleFn, type PersonInfo } from './util';

const MAX_TEXT = 1200;

export interface RenderContext {
  db: DB;
  me: string | null;
  canon: (id: string) => string;
  visible: (id: string | null | undefined) => PersonInfo | null;
  redact: (s: string | null) => string | null;
}

export function renderContext(db: DB): RenderContext {
  return { db, me: meId(db), canon: canonFn(db), visible: visibleFn(db), redact: hiddenNameRedactor(db) };
}

const clean = (r: RenderContext, s: string | null): string => {
  const t = r.redact(s ?? '') ?? '';
  return maskText(t).slice(0, MAX_TEXT);
};

interface MsgRow {
  id: number;
  text: string | null;
  kind: string;
  sent_at: number;
  is_from_me: number;
  person_id: string | null;
  retracted_at: number | null;
}

function messages(db: DB, ids: readonly number[]): Map<number, MsgRow> {
  if (!ids.length) return new Map();
  const rows = db
    .prepare(
      `SELECT m.id, m.text, m.kind, m.sent_at, m.is_from_me, i.person_id, m.retracted_at FROM messages m
       LEFT JOIN identities i ON i.id = m.sender_identity_id WHERE m.id IN (${inList(ids.length)})`,
    )
    .all(...ids) as MsgRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

const KIND_TEXT: Record<string, string> = { attachment: '<attachment>', sticker: '<sticker>', link: '<link>', poll: '<poll>' };

/** One message line, or null when it can't be shown (gone, retracted, hidden author). */
function messageLine(r: RenderContext, m: MsgRow | undefined, context: boolean): EvalLine | null {
  if (!m || m.retracted_at !== null) return null;
  let author: string;
  if (m.is_from_me) author = 'You';
  else {
    const p = m.person_id ? r.visible(m.person_id) : null;
    if (!p) return null;
    author = shortName(p);
  }
  const text = m.text?.trim() ? clean(r, m.text) : (KIND_TEXT[m.kind] ?? '');
  return { ref: `m:${m.id}`, at: m.sent_at, author, text, context };
}

/** Whether every person the item is about is still visible (else the item is not listed). */
export function itemVisible(r: RenderContext, it: Item): boolean {
  const p = it.payload;
  if (p.kind === 'identity') return r.visible(p.a) !== null && r.visible(p.b) !== null && !hiddenRecord(r.db, p);
  if (p.kind === 'reply_debt') return !p.personId || r.visible(p.personId) !== null;
  if (p.kind === 'extraction') return p.lines.every((l) => l.authorPersonId === null || l.authorPersonId === r.me || r.visible(l.authorPersonId) !== null);
  return true;
}

const hiddenRecord = (db: DB, p: IdentityPayload): boolean =>
  (db.prepare(`SELECT count(*) FROM people WHERE id IN (?, ?) AND is_hidden = 1`).pluck().get(p.a, p.b) as number) > 0;

function extractionLines(r: RenderContext, p: ExtractionPayload): EvalLine[] {
  const ms = messages(r.db, p.lines.map((l) => l.msgId));
  const out: EvalLine[] = [];
  for (const l of p.lines) {
    const line = messageLine(r, ms.get(l.msgId), l.role === 'context');
    if (line) out.push(line);
  }
  return out;
}

function replyLines(r: RenderContext, p: ReplyPayload): EvalLine[] {
  const ms = messages(r.db, p.msgIds);
  const ordered = p.msgIds.map((id) => ms.get(id)).filter((m): m is MsgRow => !!m && m.sent_at <= p.frozenAt);
  // The unanswered run (after my last message) is what's judged; earlier lines are context.
  let lastMine = -1;
  ordered.forEach((m, i) => {
    if (m.is_from_me) lastMine = i;
  });
  const out: EvalLine[] = [];
  ordered.forEach((m, i) => {
    const line = messageLine(r, m, i <= lastMine);
    if (line) out.push(line);
  });
  return out;
}

const IDENTITY_KIND: Record<string, string> = {
  phone: 'phone',
  email: 'email',
  whatsapp_jid: 'WhatsApp',
  whatsapp_lid: 'WhatsApp',
  instagram_id: 'Instagram',
  instagram_username: 'Instagram',
  instagram_name: 'Instagram name',
  partiful_user: 'Partiful',
  addressbook_id: 'Contacts card',
  beeper_user: 'Beeper',
  x_username: 'X',
  linkedin_url: 'LinkedIn',
  legacy_id: 'old app',
};

/** "phone ••0123", masked email, "@handle": enough to judge a pair, never a full identifier. */
function identityHint(kind: string, key: string): string {
  const label = IDENTITY_KIND[kind] ?? kind;
  if (kind === 'phone' || kind === 'whatsapp_jid' || kind === 'whatsapp_lid' || kind === 'partiful_user' || kind === 'beeper_user' || kind === 'instagram_id') {
    const digits = key.replace(/\D/g, '');
    return `${label} ••${(digits || key).slice(-4)}`;
  }
  if (kind === 'email') return maskText(key);
  if (kind === 'instagram_username' || kind === 'x_username') return `${label} @${key.replace(/^@/, '')}`;
  if (kind === 'addressbook_id' || kind === 'legacy_id') return label;
  return `${label}`;
}

function personSide(r: RenderContext, personId: string, tag: string): EvalLine[] {
  const db = r.db;
  const p = db.prepare(`SELECT display_name, nickname, company, job_title, created_at FROM people WHERE id = ?`).get(personId) as
    | { display_name: string; nickname: string | null; company: string | null; job_title: string | null; created_at: number }
    | undefined;
  if (!p) return [];
  const ref = `P:${personId}`;
  const ids = db.prepare(`SELECT kind, key, source FROM identities WHERE person_id = ? AND status = 'active' ORDER BY kind, created_at LIMIT 8`).all(personId) as {
    kind: string;
    key: string;
    source: string;
  }[];
  const activity = db
    .prepare(
      `SELECT c.source AS source, count(*) AS n, max(m.sent_at) AS last FROM identities i
       JOIN messages m ON m.sender_identity_id = i.id JOIN conversations c ON c.id = m.conversation_id
       WHERE i.person_id = ? GROUP BY c.source ORDER BY n DESC`,
    )
    .all(personId) as { source: string; n: number; last: number }[];
  const lastAt = activity.reduce<number | null>((m, a) => (m === null || a.last > m ? a.last : m), null);
  const name = [p.display_name, p.nickname ? `“${p.nickname}”` : null, [p.job_title, p.company].filter(Boolean).join(' at ') || null].filter(Boolean).join(' · ');
  const lines: EvalLine[] = [{ ref, at: p.created_at, author: tag, text: clean(r, name), context: false }];
  if (ids.length) lines.push({ ref, at: null, author: tag, text: clean(r, ids.map((i) => identityHint(i.kind, i.key)).join(' · ')), context: false });
  lines.push({
    ref,
    at: lastAt,
    author: tag,
    text: activity.length ? activity.map((a) => `${SOURCE_LABEL[sourceGroup(a.source)] ?? a.source} ${a.n} msgs`).join(' · ') : 'no messages',
    context: true,
  });
  return lines;
}

function identityLines(r: RenderContext, p: IdentityPayload): EvalLine[] {
  const lines = [...personSide(r, p.a, 'A'), ...personSide(r, p.b, 'B')];
  const why = [p.families.length ? `evidence: ${p.families.join(' + ')}` : null, p.guards.length ? `guards: ${p.guards.join(', ')}` : null].filter(Boolean).join(' · ');
  if (why) lines.push({ ref: 'pair', at: null, author: 'matcher', text: why, context: true });
  return lines;
}

function askLines(r: RenderContext, it: Item): EvalLine[] {
  const p = it.payload;
  if (p.kind !== 'ask') return [];
  const lines: EvalLine[] = [{ ref: 'q', at: p.askedAt, author: 'You', text: clean(r, p.question), context: false }];
  if (p.answer) lines.push({ ref: 'a', at: p.finishedAt, author: 'Yeackbot', text: clean(r, p.answer), context: true });
  return lines;
}

/** Predictions about people who are hidden now are left out. */
function predictions(r: RenderContext, it: Item): EvalPrediction[] {
  return it.predictions
    .filter((p) => !p.m.personId || p.m.personId === r.me || r.visible(p.m.personId) !== null)
    .map((p) => ({ id: p.id, kind: p.kind, label: p.label, detail: p.detail, refs: p.refs }));
}

export function renderItem(r: RenderContext, it: Item): EvalItem {
  const p = it.payload;
  const lines =
    p.kind === 'extraction' ? extractionLines(r, p) : p.kind === 'reply_debt' ? replyLines(r, p) : p.kind === 'identity' ? identityLines(r, p) : askLines(r, it);
  return {
    id: it.id,
    set: it.set,
    title: clean(r, it.title),
    lines,
    predictions: predictions(r, it),
    expectedPersonIds: it.expectedPersonIds.filter((id) => r.visible(id) !== null),
    label: it.label ? { verdicts: it.label.verdicts, missing: it.label.missing, note: it.label.note, labeledAt: it.label.labeledAt } : null,
    promptVersion: it.promptVersion,
    createdAt: it.createdAt,
  };
}
