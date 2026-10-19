/**
 * The deterministic self-thread grammar (intelligence §6 with the PLAN/critic resolutions). Pure: text in,
 * clauses out; binding to a digest, gating and effects happen in the executor.
 *
 *   nums   := "all" | N ( [ ,]+ N | "-" N )*                ; N = digest item number (1–20)
 *   dur    := \d+(h|d|w|m) | tomorrow | next week | until <weekday|date> | <date>   ; default 7d
 *   done   := (done|d|✅|👍|✓) nums? | bare nums            ; bare "2" == done 2 ("d" needs numbers)
 *   snooze := (snooze|s|later) nums? dur?                   ; "s"/"later" need numbers
 *   skip   := (skip|x|dismiss|no) nums?                     ; "x"/"no" need numbers
 *   wrong  := wrong nums? text?
 *   why    := why N?           draft := draft N?
 *   (no number: the suggestion whose own text this replies to. Bare "done" may also mean the only open item; the
 *    others without a number are free text unless they reply to a suggestion's text. "this"/"it"/"one"/"with" right
 *    after the verb are fillers: "skip this one", "done with 2")
 *   undo   := undo [last]      ; only the last acknowledged command's effect (agent-run undo is web-only)
 *   log    := (log|l) ":" text ; always accepted.  "log text" (no colon) is a gated command
 *   ask    := "?" text         ; always accepted.  who/what/… questions are gated free text
 *   pause [dur] | resume | more | help | status
 * Several clauses may share a message: "done 2, snooze 1 2w · skip 3". A "yb" prefix addresses the bot
 * explicitly ("yb help"); it is how free text outside the 12 h window still reaches the intent parser.
 */
import { isUnitWord } from './time';

export const MAX_ITEM = 20;

export type Selection = { all: true } | { all: false; nums: number[] };

export type Clause =
  | { verb: 'done'; sel: Selection | null }
  | { verb: 'snooze'; sel: Selection | null; dur: string | null }
  | { verb: 'skip'; sel: Selection | null }
  | { verb: 'wrong'; sel: Selection | null; note: string | null }
  | { verb: 'why'; n: number | null }
  | { verb: 'draft'; n: number | null }
  /** `target`: anything after "undo" other than "last" (only the last command can be undone over iMessage). */
  | { verb: 'undo'; target: string | null }
  | { verb: 'log'; text: string; explicit: boolean }
  | { verb: 'ask'; question: string }
  | { verb: 'pause'; dur: string | null }
  | { verb: 'resume' }
  | { verb: 'more' }
  | { verb: 'help' }
  | { verb: 'status' };

export type Verb = Clause['verb'];

/** Verbs that act on digest items (need a target digest). */
export const ITEM_VERBS: ReadonlySet<Verb> = new Set(['done', 'snooze', 'skip', 'wrong', 'why', 'draft']);

/**
 * An item verb written without a number that only makes sense as a reply to one suggestion's own text ("skip",
 * "wrong, she moved", "snooze 2w", "why", "draft"). Bare "done" is older and keeps its own rule (the only open item).
 */
export const isImplicitItemClause = (c: Clause): boolean =>
  ((c.verb === 'skip' || c.verb === 'snooze' || c.verb === 'wrong') && c.sel === null) || ((c.verb === 'why' || c.verb === 'draft') && c.n === null);

export interface Parsed {
  raw: string;
  /** Text after the yb prefix. */
  body: string;
  yb: boolean;
  /** commands = every token consumed by the grammar; free = anything else (intent parser / Ask). */
  kind: 'commands' | 'free' | 'empty';
  clauses: Clause[];
  /** `?…` and `log:` are accepted with no gating. */
  alwaysAccepted: boolean;
  /** The message is only number(s): "2", "1 3" (clarification answers, or done N). */
  bareNumbers: number[] | null;
  /** who/what/when/… or a trailing "?" (free text only). */
  looksLikeQuestion: boolean;
}

interface Tok {
  text: string;
  lower: string;
  start: number;
  end: number;
}

const TOKEN_RE = /\p{Extended_Pictographic}️?|[✓✔]️?|\d+[a-z]+|\d+(?:\s*[-–]\s*\d+)?|[\p{L}][\p{L}'’]*|\S/giu;

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  for (const m of s.matchAll(TOKEN_RE)) {
    out.push({ text: m[0], lower: m[0].toLowerCase().replace(/️/g, ''), start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

const VERBS: Record<string, Verb> = {
  done: 'done', did: 'done', d: 'done', '✅': 'done', '👍': 'done', '✓': 'done', '✔': 'done',
  snooze: 'snooze', s: 'snooze', later: 'snooze',
  skip: 'skip', x: 'skip', dismiss: 'skip', no: 'skip', nope: 'skip',
  wrong: 'wrong',
  why: 'why',
  draft: 'draft', drafts: 'draft',
  undo: 'undo',
  pause: 'pause',
  resume: 'resume', unpause: 'resume',
  more: 'more',
  help: 'help', commands: 'help',
  status: 'status',
};
/** One-letter or ambiguous verbs only count when numbers follow ("s 2", never a bare "s"). */
const NEEDS_NUMS = new Set(['d', 's', 'x', 'no', 'nope', 'did', 'later']);
const FILLER = new Set([',', 'and', '&', 'then', 'please', 'pls', 'plz', '+', '.', '!', '?', 'also', 'thanks', 'thx', 'ty']);
const UNDO_TAIL = new Set(['last', 'that', 'it', 'this']);
/** Words after an item verb with no number ("skip this one", "done with that"). */
const ITEM_TAIL = new Set(['it', 'this', 'that', 'one', 'with']);
const skipItemTail = (tokens: Tok[], i: number): number => {
  let j = i;
  // "one" before a unit is a number ("snooze one week"), not a filler.
  while (j < tokens.length && ITEM_TAIL.has(tokens[j]!.lower) && !(tokens[j]!.lower === 'one' && tokens[j + 1] && isUnitWord(tokens[j + 1]!.lower))) j++;
  return j;
};

const NUM_RE = /^#?(\d{1,2})[.)]?$/;
const RANGE_RE = /^(\d{1,2})\s*[-–]\s*(\d{1,2})$/;

const isNumTok = (t: Tok | undefined) => !!t && (NUM_RE.test(t.lower) || RANGE_RE.test(t.lower));

function numsOf(t: Tok): number[] | null {
  const r = RANGE_RE.exec(t.lower);
  if (r) {
    const a = Number(r[1]);
    const b = Number(r[2]);
    if (a < 1 || b > MAX_ITEM || b < a || b - a > MAX_ITEM) return null;
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  const m = NUM_RE.exec(t.lower);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= MAX_ITEM ? [n] : null;
}

/** Whether a clause starts at tokens[j] (used to end free-text tails such as a snooze date). */
function verbStartsAt(tokens: Tok[], j: number): boolean {
  const t = tokens[j];
  if (!t) return false;
  const v = VERBS[t.lower];
  if (!v) return false;
  return NEEDS_NUMS.has(t.lower) ? isNumTok(tokens[j + 1]) : true;
}

class ParseFail extends Error {}

/** Numbers at tokens[i…]: "all" | N ([ ,]+ N | N-N)*. Returns [selection, next index]. */
function parseSelection(tokens: Tok[], i: number, opts: { stopBeforeUnit?: boolean } = {}): [Selection | null, number] {
  if (tokens[i]?.lower === 'all') return [{ all: true }, i + 1];
  const nums: number[] = [];
  let j = i;
  while (j < tokens.length) {
    const t = tokens[j]!;
    if (isNumTok(t)) {
      const n = numsOf(t);
      // "snooze 1 2 weeks", "snooze 1 10/28": the trailing number belongs to the duration. With no item number yet,
      // "snooze 2 weeks" / "snooze 10/28" (a reply to one suggestion's text) is all duration.
      const next = tokens[j + 1]?.lower;
      // ("d" is both a unit and the done verb: "s 2 d 3" is snooze 2 + done 3.)
      const durNext = next === '/' || (next !== undefined && isUnitWord(next) && !verbStartsAt(tokens, j + 1));
      if (opts.stopBeforeUnit && (nums.length ? !n || durNext : durNext)) break;
      if (!n) throw new ParseFail();
      nums.push(...n);
      j++;
      continue;
    }
    if (nums.length && (t.lower === ',' || t.lower === 'and' || t.lower === '&') && isNumTok(tokens[j + 1])) {
      j++;
      continue;
    }
    break;
  }
  return nums.length ? [{ all: false, nums: [...new Set(nums)] }, j] : [null, i];
}

/** Skips a free-text remark after an explicit verb's numbers ("skip 3 not interested") up to the next clause. */
function skipRemark(tokens: Tok[], i: number): number {
  let j = i;
  while (j < tokens.length && !verbStartsAt(tokens, j)) j++;
  return j;
}

/** The raw text of tokens[i…] up to the next clause (a snooze/pause duration). */
function tailUntilVerb(s: string, tokens: Tok[], i: number): [string | null, number] {
  let j = i;
  while (j < tokens.length && !verbStartsAt(tokens, j)) j++;
  // Trailing separators belong to the boundary, not the duration.
  let k = j;
  while (k > i && FILLER.has(tokens[k - 1]!.lower)) k--;
  const text = k > i ? s.slice(tokens[i]!.start, tokens[k - 1]!.end).trim() : '';
  return [text || null, j];
}

function parseSegment(s: string): Clause[] {
  const tokens = tokenize(s);
  const out: Clause[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (FILLER.has(t.lower)) {
      i++;
      continue;
    }
    if (isNumTok(t)) {
      const [sel, j] = parseSelection(tokens, i);
      if (!sel) throw new ParseFail();
      out.push({ verb: 'done', sel });
      i = j;
      continue;
    }
    const verb = VERBS[t.lower];
    if (!verb) throw new ParseFail();
    if (NEEDS_NUMS.has(t.lower) && !isNumTok(tokens[i + 1]) && tokens[i + 1]?.lower !== 'all') throw new ParseFail();
    i++;
    switch (verb) {
      // Fillers come before the number ("done with 2", "why this 2", "skip this one"), so a number after them is the
      // verb's own selection, never a new bare-number clause.
      case 'done': {
        const [sel, j] = parseSelection(tokens, skipItemTail(tokens, i));
        out.push({ verb, sel });
        i = sel ? skipRemark(tokens, j) : j;
        break;
      }
      case 'snooze': {
        const [sel, j] = parseSelection(tokens, skipItemTail(tokens, i), { stopBeforeUnit: true });
        const [dur, k] = tailUntilVerb(s, tokens, j);
        out.push({ verb, sel, dur });
        i = k;
        break;
      }
      case 'skip': {
        const [sel, j] = parseSelection(tokens, skipItemTail(tokens, i));
        out.push({ verb, sel });
        i = sel ? skipRemark(tokens, j) : j;
        break;
      }
      case 'wrong': {
        const [sel, j] = parseSelection(tokens, skipItemTail(tokens, i));
        const note = j < tokens.length ? s.slice(tokens[j]!.start).replace(/^[\s:,–—-]+/, '').trim() : '';
        out.push({ verb, sel, note: note || null });
        i = tokens.length;
        break;
      }
      case 'why':
      case 'draft': {
        const [sel, j] = parseSelection(tokens, skipItemTail(tokens, i));
        if (sel && (sel.all || sel.nums.length !== 1)) throw new ParseFail();
        out.push({ verb, n: sel ? sel.nums[0]! : null });
        i = j;
        break;
      }
      case 'undo': {
        if (tokens[i] && UNDO_TAIL.has(tokens[i]!.lower)) i++;
        const j = skipRemark(tokens, i);
        const rest = j > i ? s.slice(tokens[i]!.start, tokens[j - 1]!.end).trim() : '';
        out.push({ verb, target: rest || null });
        i = j;
        break;
      }
      case 'pause': {
        const [dur, k] = tailUntilVerb(s, tokens, i);
        out.push({ verb, dur });
        i = k;
        break;
      }
      default:
        out.push({ verb } as Clause);
    }
  }
  return out;
}

const QUESTION_RE = /^(who|whom|whose|what|when|where|which|does|did|is|are|has|have|do|how|anyone|any)\b/i;
const YB_RE = /^\s*yb\b[\s:,.-]*/i;
const LOG_COLON_RE = /^(?:log|l)\s*:\s*/i;
const LOG_WORD_RE = /^log\s+(?=\S)/i;

export function parseCommand(raw: string): Parsed {
  const trimmed = raw.trim();
  const ybMatch = YB_RE.exec(trimmed);
  const yb = !!ybMatch;
  const body = (ybMatch ? trimmed.slice(ybMatch[0].length) : trimmed).trim();
  const base: Parsed = { raw, body, yb, kind: 'empty', clauses: [], alwaysAccepted: false, bareNumbers: null, looksLikeQuestion: false };
  if (!body) return yb ? { ...base, kind: 'commands', clauses: [{ verb: 'help' }] } : base;

  if (body.startsWith('?') || body.startsWith('？')) {
    const question = body.slice(1).trim();
    return question
      ? { ...base, kind: 'commands', clauses: [{ verb: 'ask', question }], alwaysAccepted: true }
      : { ...base, kind: 'commands', clauses: [{ verb: 'help' }] };
  }
  const logColon = LOG_COLON_RE.exec(body);
  if (logColon) {
    const text = body.slice(logColon[0].length).trim();
    return text ? { ...base, kind: 'commands', clauses: [{ verb: 'log', text, explicit: true }], alwaysAccepted: true } : { ...base, kind: 'free' };
  }
  const logWord = LOG_WORD_RE.exec(body);
  if (logWord) return { ...base, kind: 'commands', clauses: [{ verb: 'log', text: body.slice(logWord[0].length).trim(), explicit: false }] };

  const bare = /^[#\d\s,&-]+$/.test(body) ? tokenize(body).filter((t) => t.lower !== ',' && t.lower !== '&') : null;
  const bareNumbers = bare && bare.length && bare.every(isNumTok) ? [...new Set(bare.flatMap((t) => numsOf(t) ?? []))] : null;

  try {
    const clauses = body.split(/\s*(?:[;\n·•|]|\band then\b)\s*/i).filter(Boolean).flatMap(parseSegment);
    if (clauses.length) return { ...base, kind: 'commands', clauses, bareNumbers };
  } catch (e) {
    if (!(e instanceof ParseFail)) throw e;
  }
  return { ...base, kind: 'free', bareNumbers, looksLikeQuestion: QUESTION_RE.test(body) || /\?\s*$/.test(body) };
}

/** The item numbers a selection names, given the digest's ordinals ("all" = every open one). */
export function selectionNums(sel: Selection, openOrdinals: number[]): number[] {
  return sel.all ? [...openOrdinals] : sel.nums;
}
