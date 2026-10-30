/**
 * Ask conversation history (ask_conversations / ask_turns, migration 018). System tables: Ask is read-only, so
 * nothing here is journaled. Titles are the first question (masked); answers are stored de-tokenized for display
 * plus the validated model text (tokens intact) for follow-ups.
 */
import { uuidv7, type AskCitation, type AskConversation, type AskConversationSummary, type AskPeopleList, type AskTurn, type AskUsage, type PersonChip } from '@yb/shared';
import type { DB } from '../db/connection';
import { hiddenNameRedactor, maskText } from '../routes/people';
import type { AskChannel, PriorTurn } from './prompt';

export interface TurnStart {
  conversationId: string;
  turnId: string;
  seq: number;
}

const titleOf = (q: string) => {
  const t = maskText(q.replace(/\s+/g, ' ').trim());
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
};

export function conversationExists(db: DB, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM ask_conversations WHERE id = ?').get(id);
}

/** Creates the conversation if needed and a running turn. */
export function startTurn(db: DB, o: { conversationId?: string | null; question: string; channel: AskChannel; now: number }): TurnStart {
  return db.transaction(() => {
    let conversationId = o.conversationId ?? null;
    if (conversationId && !conversationExists(db, conversationId)) conversationId = null;
    if (!conversationId) {
      conversationId = uuidv7(o.now);
      db.prepare('INSERT INTO ask_conversations (id, title, channel, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(conversationId, titleOf(o.question), o.channel, o.now, o.now);
    }
    const seq = ((db.prepare('SELECT max(seq) FROM ask_turns WHERE conversation_id = ?').pluck().get(conversationId) as number | null) ?? 0) + 1;
    const turnId = uuidv7(o.now);
    db.prepare(
      `INSERT INTO ask_turns (id, conversation_id, seq, channel, question, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    ).run(turnId, conversationId, seq, o.channel, o.question, o.now);
    db.prepare('UPDATE ask_conversations SET updated_at = ? WHERE id = ?').run(o.now, conversationId);
    return { conversationId, turnId, seq };
  })();
}

export interface TurnResult {
  status: 'done' | 'error' | 'degraded';
  answer: string | null;
  modelAnswer: string | null;
  citations: AskCitation[];
  people: PersonChip[];
  /** An answer listing people (people-list.ts), or null. */
  list: AskPeopleList | null;
  citableIds: string[];
  degradedReason?: string | null;
  errorCode?: string | null;
  toolCalls: number;
  violations: number;
  usage: AskUsage | null;
  llmRequest?: string | null;
  promptVersion?: string | null;
}

export function finishTurn(db: DB, turnId: string, r: TurnResult, now: number): void {
  db.prepare(
    `UPDATE ask_turns SET status = @status, answer = @answer, model_answer = @model, citations = @citations, people = @people,
       people_list = @list, citable_ids = @citable, degraded_reason = @degraded, error_code = @error, tool_calls = @toolCalls, violations = @violations,
       usage = @usage, cost_usd = @cost, llm_request = @req, prompt_version = @pv, finished_at = @now
     WHERE id = @id`,
  ).run({
    id: turnId,
    status: r.status,
    answer: r.answer,
    model: r.modelAnswer,
    citations: JSON.stringify(r.citations),
    people: JSON.stringify(r.people),
    list: r.list ? JSON.stringify(r.list) : null,
    citable: JSON.stringify(r.citableIds),
    degraded: r.degradedReason ?? null,
    error: r.errorCode ?? null,
    toolCalls: r.toolCalls,
    violations: r.violations,
    usage: r.usage ? JSON.stringify(r.usage) : null,
    cost: r.usage?.costUsd ?? null,
    req: r.llmRequest ?? null,
    pv: r.promptVersion ?? null,
    now,
  });
}

/** Earlier finished turns of a conversation (oldest first, at most `limit`), and every id they made citable. */
export function priorContext(db: DB, conversationId: string, beforeSeq: number, limit = 4): { turns: PriorTurn[]; citable: Set<string> } {
  const rows = db
    .prepare(
      `SELECT question, model_answer, citable_ids FROM ask_turns
       WHERE conversation_id = ? AND seq < ? AND status IN ('done','degraded') ORDER BY seq DESC LIMIT ?`,
    )
    .all(conversationId, beforeSeq, limit) as { question: string; model_answer: string | null; citable_ids: string }[];
  const citable = new Set<string>();
  for (const r of rows) for (const id of JSON.parse(r.citable_ids) as string[]) citable.add(id);
  return { turns: rows.reverse().map((r) => ({ question: r.question, answer: r.model_answer })), citable };
}

interface TurnRow {
  id: string;
  question: string;
  answer: string | null;
  citations: string;
  people: string;
  people_list: string | null;
  channel: AskChannel;
  status: AskTurn['status'];
  created_at: number;
}

/**
 * Stored turns are re-checked on every read: someone hidden (or merged away) since the answer was written drops
 * out of the chips and person-linked citations, and their name is blanked in the text, as /events does for titles.
 */
function visibilityFilter(db: DB): { turn: (r: TurnRow) => AskTurn; title: (t: string) => string } {
  const redact = hiddenNameRedactor(db);
  const visible = db.prepare('SELECT 1 FROM person_visible WHERE id = ?').pluck();
  const cache = new Map<string, boolean>();
  const isVisible = (id: string) => {
    let v = cache.get(id);
    if (v === undefined) cache.set(id, (v = !!visible.get(id)));
    return v;
  };
  const personOfHref = (href: string | null) => (href ? (/^\/p\/([0-9a-f-]{36})/i.exec(href)?.[1] ?? null) : null);
  return {
    title: (t) => redact(t) ?? t,
    turn: (r) => ({
      id: r.id,
      question: redact(r.question) ?? r.question,
      answer: r.answer === null ? null : redact(r.answer),
      citations: (JSON.parse(r.citations) as AskCitation[]).filter((c) => {
        const pid = personOfHref(c.href);
        return !pid || isVisible(pid);
      }),
      people: (JSON.parse(r.people) as PersonChip[]).filter((p) => isVisible(p.id)),
      list: r.people_list ? visibleList(JSON.parse(r.people_list) as AskPeopleList, isVisible, redact) : null,
      channel: r.channel,
      status: r.status,
      createdAt: r.created_at,
    }),
  };
}

/** A stored people list as of now: rows of people hidden since drop out, hidden names are blanked in its text. */
function visibleList(l: AskPeopleList, isVisible: (id: string) => boolean, redact: (s: string) => string | null): AskPeopleList | null {
  const rows = l.rows.filter((r) => isVisible(r.person.id)).map((r) => ({ ...r, detail: redact(r.detail) ?? r.detail }));
  return rows.length ? { intro: redact(l.intro) ?? l.intro, rows, note: redact(l.note) ?? l.note } : null;
}

export function getConversation(db: DB, id: string): AskConversation | null {
  const c = db.prepare('SELECT id, title, created_at, updated_at FROM ask_conversations WHERE id = ?').get(id) as
    | { id: string; title: string; created_at: number; updated_at: number }
    | undefined;
  if (!c) return null;
  const f = visibilityFilter(db);
  const turns = (db
    .prepare('SELECT id, question, answer, citations, people, people_list, channel, status, created_at FROM ask_turns WHERE conversation_id = ? ORDER BY seq')
    .all(id) as TurnRow[]).map(f.turn);
  return { id: c.id, title: f.title(c.title), turns, createdAt: c.created_at, updatedAt: c.updated_at };
}

/** A list page cursor: the previous page's last row, `<updated_at>.<id>`. */
export const CONVERSATION_CURSOR = /^(\d{1,15})\.([0-9a-f-]{36})$/i;

/** Most recent first, `limit` per page; `cursor` (a page's nextCursor) continues after that page. */
export function listConversations(db: DB, limit = 50, cursor: string | null = null): { conversations: AskConversationSummary[]; nextCursor: string | null } {
  const f = visibilityFilter(db);
  const after = cursor ? CONVERSATION_CURSOR.exec(cursor) : null;
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.created_at, c.updated_at, (SELECT count(*) FROM ask_turns t WHERE t.conversation_id = c.id) AS n
       FROM ask_conversations c ${after ? 'WHERE c.updated_at < ? OR (c.updated_at = ? AND c.id < ?)' : ''}
       ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
    )
    .all(...(after ? [Number(after[1]), Number(after[1]), after[2]!.toLowerCase()] : []), limit + 1) as {
    id: string;
    title: string;
    created_at: number;
    updated_at: number;
    n: number;
  }[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    conversations: page.map((r) => ({ id: r.id, title: f.title(r.title), turnCount: r.n, createdAt: r.created_at, updatedAt: r.updated_at })),
    nextCursor: rows.length > limit && last ? `${last.updated_at}.${last.id}` : null,
  };
}

/** Turns left 'running' by a crash or restart are closed as errors (they'll never finish). */
export function closeStaleTurns(db: DB, now: number, olderThanMs = 10 * 60_000): number {
  return db
    .prepare(`UPDATE ask_turns SET status = 'error', error_code = 'interrupted', finished_at = ? WHERE status = 'running' AND created_at < ?`)
    .run(now, now - olderThanMs).changes;
}
