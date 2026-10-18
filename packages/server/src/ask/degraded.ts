/**
 * The retrieval-only answer (no LLM: no API key, Claude turned off, budget spent, egress refused, API down).
 * A plain local search over the same indexes the tools use; nothing leaves the Mac. Citations are built from the
 * rows found, so they are valid by construction.
 */
import type { LlmUnavailableReason } from '../llm/types';
import { openLoops } from '../pipeline/obligations';
import { maskText } from '../routes/people';
import { factLabel } from './citations';
import { keywords } from './fts';
import { eventRef, factRef, messageRef } from './refs';
import { listEvents, mentionedPeople, searchFacts, searchMessages, searchPeople, summarize, visiblePerson, type AskScope, type PersonRow, type PersonSummary } from './retrieval';

export type DegradedReason = LlmUnavailableReason | 'refused_tools' | 'tool_limit' | 'internal';

export const NEEDS_KEY_MESSAGE = 'Ask needs the Anthropic API key to write answers (ANTHROPIC_API_KEY isn’t set on the server yet).';

const LEAD: Record<DegradedReason, string> = {
  no_key: NEEDS_KEY_MESSAGE,
  disabled: 'Claude is turned off in Settings, so Ask can’t write an answer.',
  budget_daily: 'Today’s Claude budget is used up, so Ask can’t write an answer until tomorrow.',
  budget_monthly: 'This month’s Claude budget is used up, so Ask can’t write an answer.',
  budget_backfill: 'The Claude budget is used up, so Ask can’t write an answer.',
  egress_blocked: 'This question couldn’t be sent to Claude safely, so Ask didn’t send it.',
  excluded: 'This question touches people you excluded from Claude, so Ask didn’t send it.',
  rate_limited: 'Claude is busy right now.',
  api_error: 'Claude isn’t reachable right now.',
  aborted: 'The question was cancelled.',
  prompt_too_large: 'This question needs more context than Ask sends at once; try narrowing it.',
  refused_tools: 'Claude couldn’t finish this one.',
  tool_limit: 'Ask ran out of searches before finishing.',
  internal: 'Ask hit a problem writing the answer.',
};

export function degradedLead(reason: DegradedReason): string {
  return LEAD[reason];
}

/** "in Austin", "near San Francisco", "from Boston" → the place. */
export function placeInQuestion(q: string): string | null {
  const m = /\b(?:in|near|around|from)\s+((?:[\p{Lu}][\p{L}.'’-]+)(?:\s+[\p{Lu}][\p{L}.'’-]+){0,2})/u.exec(q);
  return m ? m[1]!.replace(/[.?!,]+$/, '') : null;
}

/** "who's into X", "who likes X", "who plays X" → X. */
export function interestInQuestion(q: string): string | null {
  const m = /\b(?:into|likes?|loves?|plays?|enjoys?|interested in)\s+([\p{L}\p{N}][\p{L}\p{N} '’-]{1,40}?)(?:[?.!,]|$)/iu.exec(q);
  return m ? m[1]!.trim() : null;
}

/**
 * "Who do I know in London?", "who's into climbing", "anyone at Acme?": the answer is a list of people, so the plain
 * search lists only people (never the events, reservations or messages that merely mention the words).
 */
export function asksForPeople(q: string): boolean {
  return /^\s*(?:who(?:m|se)?\b|(?:do|does) (?:i|we) know (?:any|some)(?:one|body)\b|(?:any|some)(?:one|body)\b|(?:which|what) (?:people|friends|contacts)\b|(?:list|show)(?: me)? (?:all )?(?:the )?(?:people|friends|contacts|everyone)\b)/i.test(q);
}

/** Questions a plain read of the stats and loops can answer without Claude (the suggested prompts among them). */
export type DegradedIntent = 'fading' | 'closest' | 'promises' | null;

export function intentOf(q: string): DegradedIntent {
  const s = q.toLowerCase();
  if (/\b(haven['’]?t|have not|not)\s+(talked|spoken|texted|seen)\b|\bin a while\b|\blost touch\b|\bdrift(ing|ed)?\b|\bfading\b|\bneglect/.test(s)) return 'fading';
  if (/\bclosest\b|\bclose friends?\b|\bbest friends?\b|\btalk to (the )?most\b/.test(s)) return 'closest';
  if (/\bpromis(e|ed|es)\b|\bi owe\b|\bowe (people|anyone|someone)\b|\bcommit(ted|ments?)\b|\bsaid i['’]?d\b|\breply to\b|\bwaiting on me\b/.test(s)) return 'promises';
  return null;
}

const DAY = 86_400_000;

/** The deterministic lines for an intent (people come through person_visible; LLM exclusions don't apply locally). */
function intentLines(scope: AskScope, intent: Exclude<DegradedIntent, null>, displayName: (p: PersonRow) => string, limit: number): { lines: string[]; people: PersonRow[] } {
  const lines: string[] = [];
  const people: PersonRow[] = [];
  const push = (id: string, text: (name: string) => string) => {
    const p = visiblePerson(scope, id);
    if (!p || people.some((x) => x.id === p.id)) return;
    people.push(p);
    lines.push(text(displayName(p)));
  };
  if (intent === 'fading' || intent === 'closest') {
    const rows = scope.db
      .prepare(
        intent === 'fading'
          ? `SELECT s.person_id, s.silence_d, s.expected_gap_d, s.state FROM person_stats s JOIN person_visible v ON v.id = s.person_id
             WHERE s.state IN ('fading','dormant','cooling') AND s.fading_suppressed = 0
             ORDER BY CASE s.state WHEN 'fading' THEN 0 WHEN 'cooling' THEN 1 ELSE 2 END, coalesce(s.historical_strength, 0) DESC LIMIT ?`
          : `SELECT s.person_id, s.silence_d, s.expected_gap_d, s.state FROM person_stats s JOIN person_visible v ON v.id = s.person_id
             WHERE s.tie_strength IS NOT NULL ORDER BY s.tie_strength DESC LIMIT ?`,
      )
      .all(limit * 2) as { person_id: string; silence_d: number | null; expected_gap_d: number | null; state: string | null }[];
    for (const r of rows) {
      if (people.length >= limit) break;
      const quiet = r.silence_d != null ? `quiet ${Math.round(r.silence_d)}d` : null;
      const usual = r.expected_gap_d != null ? `usually ~${Math.round(r.expected_gap_d)}d` : null;
      const bits = intent === 'fading' ? [quiet, usual].filter(Boolean).join(' · ') : [r.state, quiet ? quiet.replace('quiet', 'last') : null].filter(Boolean).join(' · ');
      push(r.person_id, (n) => `- ${n}${bits ? ` — ${bits}` : ''}`);
    }
    return { lines, people };
  }
  const loops = openLoops(scope.db, { now: scope.now, timeZone: scope.tz, limit });
  for (const l of loops.commitments) {
    if (people.length >= limit) break;
    push(l.person.id, (n) => `- ${n} — you promised: ${maskText(l.title)}`);
  }
  for (const d of loops.replyDebts) {
    if (lines.length >= limit) break;
    const days = Math.max(0, Math.round((scope.now - d.since) / DAY));
    const p = visiblePerson(scope, d.person.id);
    if (!p) continue;
    if (!people.some((x) => x.id === p.id)) people.push(p);
    lines.push(`- ${displayName(p)} — waiting on your reply, ${days}d`);
  }
  return { lines, people };
}

export interface DegradedResult {
  answer: string;
  cited: string[];
  people: PersonRow[];
}

/** A plain-search answer. `displayName` is channel-specific (full name on the web, "Sam R." over iMessage). */
export function degradedAnswer(
  scope: AskScope,
  question: string,
  reason: DegradedReason,
  o: { channel: 'web' | 'imessage'; displayName: (p: PersonRow) => string; found?: PersonSummary[] },
): DegradedResult {
  const lead = degradedLead(reason);
  const intent = o.found?.length ? null : intentOf(question);
  if (intent) {
    const r = intentLines(scope, intent, o.displayName, o.channel === 'web' ? 10 : 5);
    if (r.lines.length) {
      const head = intent === 'fading' ? 'People you’ve gone quiet with' : intent === 'closest' ? 'Your strongest ties right now' : 'Open promises and replies';
      return { answer: `${lead} ${head}, from your stats:\n${r.lines.join('\n')}`, cited: [], people: r.people };
    }
  }
  const kws = keywords(question);
  const place = placeInQuestion(question);
  const interest = interestInQuestion(question);
  const peopleOnly = asksForPeople(question);
  // Each line carries the citation ids it uses, so ids of lines cut by the cap aren't cited.
  let ids: string[] = [];
  const cite = (id: string) => {
    ids.push(id);
    return `[${id}]`;
  };
  const lines: { text: string; ids: string[] }[] = [];
  const line = (text: string) => {
    lines.push({ text, ids });
    ids = [];
  };

  let people: PersonSummary[] = o.found?.length ? o.found.slice(0, 6) : [];
  if (!people.length) {
    const named = mentionedPeople(scope, question);
    if (place || interest) people = searchPeople(scope, { query: null, city: place, nearKm: null, circle: null, interest, employer: null, minStrength: null, limit: 6 });
    if (!people.length && named.length) people = summarize(scope, named.map((p) => p.id)).slice(0, 6);
    if (!people.length && kws.length) people = searchPeople(scope, { query: kws.join(' '), city: null, nearKm: null, circle: null, interest: null, employer: null, minStrength: null, limit: 6 });
  }
  const facts = kws.length ? searchFacts(scope, { query: kws.join(' '), cat: null, limit: 4 }) : [];
  const messages = kws.length && o.channel === 'web' && !peopleOnly ? searchMessages(scope, { query: kws.join(' '), personId: null, convId: null, after: null, before: null, limit: 3 }) : [];
  const events = kws.length && !peopleOnly ? listEvents(scope, { query: kws.join(' '), personId: null, after: null, before: null, limit: 3 }) : [];

  for (const p of people) {
    const top = p.facts[0];
    // "London · London¹": a top fact that only repeats the city is shown once, cited on the web only (over iMessage
    // its footnote would just say the same thing again).
    const dup = !!top && !!p.city && sameText(top.value, p.city);
    const city = p.city && dup && o.channel === 'web' ? `${p.city} ${cite(factRef(top.seq))}` : p.city;
    const fact = top && !dup ? `${top.value} ${cite(factRef(top.seq))}` : null;
    const bits = [city, fact].filter(Boolean);
    line(`- ${o.displayName(p.person)}${bits.length ? ` — ${bits.join(' · ')}` : ''}`);
  }
  // A people answer lists each person once.
  const listed = new Set(people.map((x) => x.person.id));
  for (const f of facts) {
    const p = visiblePerson(scope, f.personId);
    if (!p || people.some((x) => x.facts[0]?.seq === f.seq)) continue;
    if (peopleOnly && listed.has(p.id)) continue;
    listed.add(p.id);
    line(`- ${factLabel(scope, f, p).replace(/^[^—]+—/, `${o.displayName(p)} —`)} ${cite(factRef(f.seq))}`);
  }
  for (const m of messages) {
    const who = m.fromMe ? 'You' : o.displayName(m.sender!);
    const quote = maskText(m.snippet).slice(0, 100);
    line(`- ${who}: “${quote}” ${cite(messageRef(m.id))}`);
  }
  for (const e of events) line(`- ${maskText(e.title ?? 'Event')} ${cite(eventRef(e.n))}`);

  const kept = lines.slice(0, o.channel === 'web' ? 12 : 6);
  const cited = [...new Set(kept.flatMap((l) => l.ids))];
  const found = [
    ...people.map((p) => p.person),
    ...facts.map((f) => visiblePerson(scope, f.personId)).filter((p): p is PersonRow => !!p),
    // message senders get person chips too
    ...messages.map((m) => (m.fromMe ? null : m.sender)).filter((p): p is PersonRow => !!p),
  ].filter((p, i, xs) => xs.findIndex((x) => x.id === p.id) === i);
  const answer = kept.length
    ? `${lead} Here’s ${peopleOnly ? 'who' : 'what'} a plain search found:\n${kept.map((l) => l.text).join('\n')}`
    : `${lead} A plain search found ${peopleOnly ? 'nobody' : 'nothing'} for that.`;
  return { answer, cited, people: found };
}

/** Case, accents, punctuation and a trailing ", UK"-style qualifier aside, the same place or phrase. */
function sameText(a: string, b: string): boolean {
  const head = (s: string) =>
    s
      .split(',')[0]!
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  return !!head(a) && head(a) === head(b);
}
