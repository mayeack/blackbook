/**
 * Ask your network (web; the iMessage `?` path shares the engine).
 *
 *   POST /api/v1/ask                        AskRequest → text/event-stream of AskEvent frames
 *   GET  /api/v1/ask/conversations?cursor=&limit=   → AskConversationList (+ suggested prompts)
 *   GET  /api/v1/ask/conversations/:id      → AskConversation
 *
 * The POST is a normal JSON + `X-YB: 1` request (CSRF); the browser reads the stream with fetch + ReadableStream
 * (EventSource can't POST) and parses frames with `SseParser`. Frame: `event: <type>\ndata: <json>\n\n`, one
 * AskEvent per frame, `type` = the event name. Order: start → (tool_status | delta | citation)* → done | error.
 *
 * Citations: inline ids in the answer text (`[m:8812]`, `[F881]`, `[E12]`, `[P17]`); the server strips any id no
 * tool returned in that session. Without an LLM (no key / budget) the answer is retrieval-only (`degraded`).
 */
import { z } from 'zod';
import { Ms, PersonChip } from './common';

export const ASK_TOOLS = ['search_people', 'search_messages', 'search_facts', 'get_person', 'graph_neighbors', 'list_events'] as const;
export const AskToolName = z.enum(ASK_TOOLS);
export type AskToolName = z.infer<typeof AskToolName>;

export const AskRequest = z.object({
  question: z.string().trim().min(1).max(2000),
  /** Continue a conversation (append-only history); omitted = new conversation. */
  conversationId: z.string().optional(),
});
export type AskRequest = z.infer<typeof AskRequest>;

export const AskCitation = z.object({
  /** As written in the answer: 'm:8812', 'F881', 'E12', 'P17'. */
  ref: z.string(),
  kind: z.enum(['message', 'fact', 'event', 'person']),
  /** "Sam · iMessage Oct 3", "Lives in Austin (since Mar)". */
  label: z.string(),
  /** Web deep link (/p/<id>?m=<msg>, /e/<id>, /p/<id>). */
  href: z.string().nullable(),
  at: Ms.nullable(),
});
export type AskCitation = z.infer<typeof AskCitation>;

/** One person in a people answer ("who do I know in London?"): the web renders these rows as a table. */
export const AskPeopleRow = z.object({
  person: PersonChip,
  /** Why they're on the list and the key details, as the answer line says it (citation ids inline: "lives in London [F2c]"). */
  detail: z.string(),
  /** Where they live now, from their profile. */
  city: z.string().nullable(),
  circles: z.array(z.string()),
  lastContactAt: Ms.nullable(),
});
export type AskPeopleRow = z.infer<typeof AskPeopleRow>;

/**
 * An answer that lists people, one line per person (the answer text keeps the same lines for iMessage and history).
 * `intro` is the text above the list (one short line at most) and `note` anything after it; both may be ''.
 */
export const AskPeopleList = z.object({
  intro: z.string(),
  rows: z.array(AskPeopleRow),
  note: z.string(),
});
export type AskPeopleList = z.infer<typeof AskPeopleList>;

export const AskUsage = z.object({
  toolCalls: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
});
export type AskUsage = z.infer<typeof AskUsage>;

export const AskEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), conversationId: z.string(), turnId: z.string() }),
  /** Streamed answer text (may contain citation ids, resolved by `citation` events and the final `done`). */
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({
    type: z.literal('tool_status'),
    tool: AskToolName,
    status: z.enum(['running', 'done', 'error']),
    /** "Searching people in Austin", "Found 4 people". Never message text. */
    summary: z.string().nullable(),
    count: z.number().int().nullable(),
  }),
  z.object({ type: z.literal('citation'), citation: AskCitation }),
  z.object({
    type: z.literal('done'),
    conversationId: z.string(),
    turnId: z.string(),
    /** Final answer with only valid citation ids left in it. */
    answer: z.string(),
    citations: z.array(AskCitation),
    people: z.array(PersonChip),
    /** Set when the answer is a list of people (the web shows a table). Optional so an older server's frames still parse. */
    list: AskPeopleList.nullish(),
    /** True when no LLM answered (retrieval-only fallback). */
    degraded: z.boolean(),
    usage: AskUsage.nullable(),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type AskEvent = z.infer<typeof AskEvent>;
export type AskEventType = AskEvent['type'];

export const AskTurn = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string().nullable(),
  citations: z.array(AskCitation),
  people: z.array(PersonChip),
  list: AskPeopleList.nullish(),
  channel: z.enum(['web', 'imessage']),
  status: z.enum(['running', 'done', 'error', 'degraded']),
  createdAt: Ms,
});
export type AskTurn = z.infer<typeof AskTurn>;

export const AskConversation = z.object({
  id: z.string(),
  title: z.string(),
  turns: z.array(AskTurn),
  createdAt: Ms,
  updatedAt: Ms,
});
export type AskConversation = z.infer<typeof AskConversation>;

export const AskConversationSummary = z.object({
  id: z.string(),
  title: z.string(),
  turnCount: z.number().int(),
  createdAt: Ms,
  updatedAt: Ms,
});
export type AskConversationSummary = z.infer<typeof AskConversationSummary>;

export const AskConversationList = z.object({
  conversations: z.array(AskConversationSummary),
  /** Pass as `cursor` for the next (older) page; null on the last page. */
  nextCursor: z.string().nullable(),
  suggestedPrompts: z.array(z.string()),
});
export type AskConversationList = z.infer<typeof AskConversationList>;

// ------------------------------------------------------------------------------------------------ SSE framing

/** One SSE frame for an AskEvent (server side). */
export function encodeSseEvent(event: AskEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Incremental SSE parser (client side): feed decoded text chunks, get complete AskEvents back. Frames that are
 * comments (`: ping`), have no data, or fail validation are skipped.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): AskEvent[] {
    this.buffer += chunk.replace(/\r\n?/g, '\n');
    const out: AskEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const parsed = AskEvent.safeParse(json);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }
}
