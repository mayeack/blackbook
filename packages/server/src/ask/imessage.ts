/**
 * Ask over iMessage (the self-thread `?` command; PLAN "Two-way texting", intelligence §7):
 *
 *   answerForImessage(question, { db, services }) → the reply body, ≤ IMESSAGE_ANSWER_CHARS (room is left for the
 *   🅨 marker the sender prepends; MAX_ANSWER_CHARS = 600 in total). The caller sends it with
 *   outbound.sendToSelf(`${BOT_MARKER} ${text}`, 'answer', clientRef) — this module never sends anything.
 *
 * Rules (enforced here, whatever the model wrote):
 *   - effort low, plain text; citations become footnotes ("¹ Sam · iMessage Oct 3"), at most 3; person
 *     citations are dropped (the names are in the text);
 *   - no sensitive content: sentences touching health, sex, money, breakups, life events and the like are
 *     removed (the tools never return sensitive facts in the first place);
 *   - no phone numbers or emails (masked), and the only link is yeackbot.com (the full answer); every other URL
 *     is reduced to its first label;
 *   - names are first name + last initial.
 */
import { BOT_MARKER, checkOutboundText, MAX_ANSWER_CHARS, stripIpLinks } from '../delivery/types';
import type { DB } from '../db/connection';
import type { Logger } from '../ops/logger';
import { maskText } from '../routes/people';
import type { ServicesConfig, ServicesProvider } from '../services';
import { askNetwork, type AskEngineAnswer } from './engine';

export const WEB_ORIGIN = 'https://yeackbot.com';
/** The reply body budget: MAX_ANSWER_CHARS minus the marker and a space. */
export const IMESSAGE_ANSWER_CHARS = MAX_ANSWER_CHARS - BOT_MARKER.length - 1;
const MAX_FOOTNOTES = 3;
const SUP = ['¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

/** Health, sex, money, breakups, legal trouble, religion/politics and life events (never texted). */
const SENSITIVE_RE =
  /\b(?:therap\w*|depress\w*|anxiety|adhd|autis\w*|medicat\w*|rehab|sober|sobriety|addict\w*|hiv|std|sti|ivf|fertility|sexual\w*|gay|lesbian|bisexual|queer|transgender|dating app|hookup|break ?up|broke up|separated|divorc\w*|debt|bankrupt\w*|loan|salary|evict\w*|lawsuit|arrest\w*|court case|immigration|visa status|religio\w*|politic\w*|disabilit\w*|illness|sick|hospital\w*|injur\w*|pregnan\w*|miscarr\w*|diagnos\w*|cancer|chemo\w*|tumou?r|surgery|passed away|died|death|funeral)\b/i;

export const isSensitiveSentence = (s: string): boolean => SENSITIVE_RE.test(s);

const URL_RE = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s]*)?/gi;

/** Only yeackbot.com links survive; any other URL-looking text becomes its first label ("acme.io" → "acme"). */
export function allowlistLinks(text: string): string {
  // IP-literal links go entirely (no domain to allowlist); other hosts keep only their first label.
  return stripIpLinks(text).replace(URL_RE, (m, host: string) => {
    const h = host.toLowerCase();
    if (h === 'yeackbot.com' || h.endsWith('.yeackbot.com')) return m;
    return host.split('.')[0] ?? '';
  });
}

function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1');
}

/** Sentences (keeping their trailing punctuation and line breaks). */
const sentences = (s: string) => s.match(/[^.!?\n]+(?:[.!?]+|\n|$)\s*/g) ?? [s];

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
  if (end > max * 0.5) return cut.slice(0, end + 1).trim();
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).trim()}…`;
}

const clipLabel = (s: string, n = 44) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Formats an engine answer as the iMessage reply body (see the module comment for the rules). */
export function formatImessageAnswer(r: Pick<AskEngineAnswer, 'answer' | 'citations' | 'conversationId'>, max = IMESSAGE_ANSWER_CHARS): string {
  const labels = new Map(r.citations.map((c) => [c.ref, c]));
  const notes: string[] = [];
  const numberOf = new Map<string, number>();
  let body = stripMarkdown(r.answer);
  // Drop sensitive sentences first (their citations go with them).
  body = sentences(body)
    .filter((s) => !isSensitiveSentence(s))
    .join('')
    .trim();
  body = body.replace(/ ?\[(m:[0-9a-z]{1,10}|[FEP][0-9a-z]{1,10})\]/g, (_m, ref: string) => {
    const c = labels.get(ref);
    if (!c || c.kind === 'person' || isSensitiveSentence(c.label)) return '';
    let n = numberOf.get(ref);
    if (n === undefined) {
      if (notes.length >= MAX_FOOTNOTES) return '';
      n = notes.length;
      numberOf.set(ref, n);
      notes.push(`${SUP[n]} ${clipLabel(c.label)}`);
    }
    return SUP[n]!;
  });
  body = allowlistLinks(maskText(body))
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!body) body = 'Nothing I can text about that — open the app for details.';
  const link = r.conversationId ? `Full answer: ${WEB_ORIGIN}/ask/${r.conversationId}` : '';
  const footer = () => [...notes.map((n) => allowlistLinks(maskText(n))), link].filter(Boolean).join('\n');
  let foot = footer();
  // Footnotes shrink before the body does: keep at least ~half the budget for the answer.
  while (notes.length && foot.length > max / 2) {
    const dropped = notes.length - 1;
    notes.pop();
    body = body.split(SUP[dropped]!).join('');
    foot = footer();
  }
  const room = max - (foot ? foot.length + 1 : 0);
  let text = `${truncate(body, Math.max(40, room))}${foot ? `\n${foot}` : ''}`;
  if (text.length > max) text = truncate(text, max);
  // Belt and braces: what the sender would refuse never leaves here.
  if (checkOutboundText(`${BOT_MARKER} ${text}`).length) {
    text = link ? `I found an answer, but it’s best read in the app. ${link}` : 'I found an answer, but it’s best read in the app.';
  }
  return text;
}

export interface ImessageAskContext {
  db: DB;
  services?: ServicesProvider;
  config?: ServicesConfig;
  log?: Logger;
  now?: number;
  signal?: AbortSignal;
}

export interface ImessageAnswer {
  /** The reply body (no marker), ≤ IMESSAGE_ANSWER_CHARS. */
  text: string;
  conversationId: string | null;
  degraded: boolean;
  /** The engine's full answer (for logs/tests; never text it as is). */
  engine: AskEngineAnswer;
}

/** Asks over the iMessage channel and returns the formatted reply plus the engine's result. */
export async function askForImessage(question: string, ctx: ImessageAskContext): Promise<ImessageAnswer> {
  const engine = await askNetwork({
    db: ctx.db,
    question,
    channel: 'imessage',
    services: ctx.services,
    config: ctx.config,
    log: ctx.log,
    now: ctx.now,
    signal: ctx.signal,
  });
  return { text: formatImessageAnswer(engine), conversationId: engine.conversationId, degraded: engine.degraded, engine };
}

/** The `?` command's answer: ≤ 600 characters with the marker, no sensitive facts, only yeackbot.com links. */
export async function answerForImessage(question: string, ctx: ImessageAskContext): Promise<string> {
  return (await askForImessage(question, ctx)).text;
}
