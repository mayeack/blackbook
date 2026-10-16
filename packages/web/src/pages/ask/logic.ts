/**
 * Ask: the live-turn reducer over SSE events and the answer renderer's parsing (citations → footnotes / person
 * chips, plain-text blocks). Pure and unit-tested.
 */
import type { AskCitation, AskEvent, AskToolName, AskTurn, AskUsage, PersonChip } from '@yb/shared';

export interface ToolStep {
  tool: AskToolName;
  status: 'running' | 'done' | 'error';
  summary: string | null;
  count: number | null;
}

export type TurnStatus = 'pending' | 'streaming' | 'done' | 'degraded' | 'error' | 'stopped';

export interface LiveTurn {
  /** Client key (stable across the stream; the server's turn id once known). */
  key: string;
  conversationId: string | null;
  turnId: string | null;
  question: string;
  text: string;
  status: TurnStatus;
  tools: ToolStep[];
  citations: AskCitation[];
  people: PersonChip[];
  usage: AskUsage | null;
  error: { code: string; message: string } | null;
  createdAt: number;
}

export function newTurn(key: string, question: string, conversationId: string | null, now = Date.now()): LiveTurn {
  return { key, conversationId, turnId: null, question, text: '', status: 'pending', tools: [], citations: [], people: [], usage: null, error: null, createdAt: now };
}

const addCitation = (list: AskCitation[], c: AskCitation) => (list.some((x) => x.ref === c.ref) ? list : [...list, c]);

/** One SSE event applied to a turn. Events after done/error/stop are ignored. */
export function applyEvent(t: LiveTurn, e: AskEvent): LiveTurn {
  if (t.status === 'done' || t.status === 'degraded' || t.status === 'error' || t.status === 'stopped') return t;
  switch (e.type) {
    case 'start':
      return { ...t, conversationId: e.conversationId, turnId: e.turnId, status: 'streaming' };
    case 'delta':
      return { ...t, text: t.text + e.text, status: 'streaming' };
    case 'tool_status': {
      const tools = [...t.tools];
      if (e.status === 'running') tools.push({ tool: e.tool, status: 'running', summary: e.summary, count: e.count });
      else {
        // Close the most recent running call of that tool (parallel calls finish in any order).
        const i = tools.findLastIndex((x) => x.tool === e.tool && x.status === 'running');
        const step: ToolStep = { tool: e.tool, status: e.status, summary: e.summary ?? (i >= 0 ? tools[i]!.summary : null), count: e.count };
        if (i >= 0) tools[i] = step;
        else tools.push(step);
      }
      return { ...t, tools, status: 'streaming' };
    }
    case 'citation':
      return { ...t, citations: addCitation(t.citations, e.citation) };
    case 'done':
      return {
        ...t,
        conversationId: e.conversationId,
        turnId: e.turnId,
        text: e.answer,
        citations: e.citations,
        people: e.people,
        usage: e.usage,
        status: e.degraded ? 'degraded' : 'done',
        tools: t.tools.map((s) => (s.status === 'running' ? { ...s, status: 'done' } : s)),
      };
    case 'error':
      return { ...t, status: 'error', error: { code: e.code, message: e.message }, tools: t.tools.map((s) => (s.status === 'running' ? { ...s, status: 'error' } : s)) };
  }
}

/** A stored turn (GET /ask/conversations/:id) as a LiveTurn for rendering. */
export function fromStored(t: AskTurn, conversationId: string): LiveTurn {
  const status: TurnStatus = t.status === 'running' ? 'pending' : t.status;
  return {
    key: t.id,
    conversationId,
    turnId: t.id,
    question: t.question,
    text: t.answer ?? '',
    status,
    tools: [],
    citations: t.citations,
    people: t.people,
    usage: null,
    error: t.status === 'error' ? { code: 'error', message: t.answer || 'This answer didn’t finish.' } : null,
    createdAt: t.createdAt,
  };
}

export const isActive = (t: Pick<LiveTurn, 'status'>) => t.status === 'pending' || t.status === 'streaming';

// ---------------------------------------------------------------------------------------------- tool labels

const TOOL_LABELS: Record<AskToolName, string> = {
  search_people: 'Searching people',
  search_messages: 'Searching messages',
  search_facts: 'Checking what you know',
  get_person: 'Looking someone up',
  graph_neighbors: 'Checking who knows whom',
  list_events: 'Checking events',
};
export const toolLabel = (s: ToolStep) => s.summary ?? TOOL_LABELS[s.tool] ?? s.tool;

// ---------------------------------------------------------------------------------------------- answer parsing

const ID = String.raw`(?:m:[0-9a-z]{1,10}|[FEP][0-9a-z]{1,10})`;
/** `[F1a]`, and defensively `[m:2n9c, F3]` groups (the server normalizes to singles). */
const CITE_RE = new RegExp(String.raw`\[(${ID}(?:\s*[,;]\s*${ID})*)\]`, 'g');

/** An id the model wrote that is clearly meant as one (a digit, or the m: prefix), as the server decides. */
const looksLikeId = (id: string) => id.startsWith('m:') || /\d/.test(id);

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'cite'; ref: string; n: number; citation: AskCitation }
  | { kind: 'person'; ref: string; citation: AskCitation };

export type Block = { kind: 'p'; inlines: Inline[] } | { kind: 'ul'; items: Inline[][] };

export interface ParsedAnswer {
  blocks: Block[];
  /** Footnotes in order of first appearance (messages, facts, events; people render inline). */
  footnotes: { n: number; citation: AskCitation }[];
}

/**
 * Splits answer text into paragraphs / bullet lists with inline citations. Footnote numbers follow first
 * appearance. Ids with no known citation are dropped (while streaming they may resolve on a later event).
 */
export function parseAnswer(text: string, citations: readonly AskCitation[]): ParsedAnswer {
  const byRef = new Map(citations.map((c) => [c.ref, c]));
  const numbers = new Map<string, number>();
  const footnotes: { n: number; citation: AskCitation }[] = [];

  const inlines = (line: string): Inline[] => {
    const out: Inline[] = [];
    let last = 0;
    for (const m of line.matchAll(CITE_RE)) {
      const before = line.slice(last, m.index);
      if (before) out.push({ kind: 'text', text: before });
      last = m.index + m[0].length;
      const refs = m[1]!.split(/\s*[,;]\s*/);
      // "[Pizza]" is a word, not an id (ids have a digit or the m: prefix): keep it as text.
      if (!refs.some((r) => byRef.has(r)) && !refs.some(looksLikeId)) {
        out.push({ kind: 'text', text: m[0] });
        continue;
      }
      for (const ref of refs) {
        const c = byRef.get(ref);
        if (!c) continue;
        if (c.kind === 'person') {
          out.push({ kind: 'person', ref, citation: c });
          continue;
        }
        let n = numbers.get(ref);
        if (n === undefined) {
          n = numbers.size + 1;
          numbers.set(ref, n);
          footnotes.push({ n, citation: c });
        }
        out.push({ kind: 'cite', ref, n, citation: c });
      }
    }
    const rest = line.slice(last);
    if (rest) out.push({ kind: 'text', text: rest });
    // Merge adjacent text pieces and trim a trailing space left before a dropped id.
    return out.reduce<Inline[]>((acc, x) => {
      const prev = acc[acc.length - 1];
      if (x.kind === 'text' && prev?.kind === 'text') prev.text += x.text;
      else acc.push(x.kind === 'text' ? { ...x } : x);
      return acc;
    }, []);
  };

  const blocks: Block[] = [];
  let para: string[] = [];
  let list: Inline[][] | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ kind: 'p', inlines: inlines(para.join('\n')) });
    para = [];
  };
  const flushList = () => {
    if (list?.length) blocks.push({ kind: 'ul', items: list });
    list = null;
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      (list ??= []).push(inlines(bullet[1]!));
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return { blocks, footnotes };
}

/** Superscript digits for footnote markers. */
const SUP = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
export const superscript = (n: number) =>
  String(n)
    .split('')
    .map((d) => SUP[Number(d)] ?? d)
    .join('');

/**
 * The in-app link for a citation: relative paths only. Message links get `at=` (the message time) so the
 * person timeline can jump to the right conversation without scanning.
 */
export function citationHref(c: Pick<AskCitation, 'href' | 'kind' | 'at'>): string | null {
  if (!c.href || !c.href.startsWith('/') || c.href.startsWith('//')) return null;
  if (c.kind === 'message' && c.at != null && /[?&]m=/.test(c.href) && !/[?&]at=/.test(c.href)) return `${c.href}&at=${c.at}`;
  return c.href;
}

/** The person id a citation points at (for chips), from its `/p/<id>` link. */
export function citationPersonId(c: Pick<AskCitation, 'href'>): string | null {
  return c.href ? (/^\/p\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(c.href)?.[1] ?? null) : null;
}

/** The degraded lead says why no model answered; "needs key" gets its own banner. */
export const isNeedsKeyAnswer = (text: string) => /needs the Anthropic API key/i.test(text);
