/**
 * Answers that list people ("who do I know in London?", "who's into climbing?"), on every channel: one line per
 * person with that person's details on the same line, never a summary sentence plus a separate list of sources.
 *
 *   model text   "- P1a — lives in London [F2c]"            (the shape the system prompt asks for)
 *   rows         the person + the line's detail, plus city, circles and last contact from the profile
 *   answer text  "- Sam Rivera — lives in London [F2c] · Music, Skiing circles · last contact Oct 3"
 *
 * The web renders the rows as a table (ask_turns.people_list); iMessage texts the lines without footnotes. The
 * plain-search fallback (degraded.ts) builds the same rows, so every path answers in one shape.
 */
import type { AskPeopleList, AskPeopleRow } from '@yb/shared';
import { maskText } from '../routes/people';
import { personChips, shortDate } from './citations';
import { summarize, type AskScope, type PersonRow } from './retrieval';

/** At most this many rows (search_people returns ≤ 20). */
export const MAX_LISTED = 25;

/**
 * "Who do I know in London?", "who's into climbing", "anyone at Acme?": the answer is a list of people, so the plain
 * search lists only people (never the events, reservations or messages that merely mention the words).
 */
export function asksForPeople(q: string): boolean {
  return /^\s*(?:who(?:m|se)?\b|(?:do|does) (?:i|we) know (?:any|some)(?:one|body)\b|(?:any|some)(?:one|body)\b|(?:which|what) (?:people|friends|contacts)\b|(?:list|show)(?: me)? (?:all )?(?:the )?(?:people|friends|contacts|everyone)\b)/i.test(q);
}

/** One person in a people answer: `detail` is display text (names, not tokens) with citation ids inline. */
export interface ListedPerson {
  person: PersonRow;
  detail: string;
}

export interface PeopleAnswer {
  intro: string;
  people: ListedPerson[];
  note: string;
}

const BULLET = String.raw`(?:[-*•]|\d{1,2}[.)])`;
/**
 * "- P1a — lives in London [F2c]", "• P1a: …", "1. **P1a** – …", "- P1a [P1a] - …": the person token first, then
 * a dash or colon and the detail. "- P1a and P2b went…" (no separator) is prose, not a person line.
 */
const PERSON_LINE = new RegExp(String.raw`^\s*(?:${BULLET}\s+)?(?:\*\*)?(P[0-9a-z]{1,10})(?:\*\*)?((?:\s*\[[^\]\n]{1,40}\])*)\s*(?:—|–|:|-(?=\s))\s*(.*)$`);
const BULLET_LINE = new RegExp(String.raw`^\s*${BULLET}\s+\S`);

/**
 * Splits a model answer (person tokens intact, citations validated) into the intro, one entry per person line and
 * whatever follows. Null when it isn't a list of people: no person lines, a bullet that isn't one, or a single
 * line answering something other than a "who" question. `display` de-tokenizes a fragment for display.
 */
export function peopleLinesOf(
  text: string,
  o: { person: (token: string) => PersonRow | null; display: (fragment: string) => string; peopleQuestion: boolean },
): PeopleAnswer | null {
  const intro: string[] = [];
  const note: string[] = [];
  const people: ListedPerson[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = PERSON_LINE.exec(line);
    const person = m ? o.person(m[1]!) : null;
    if (!m || !person) {
      if (BULLET_LINE.test(line)) return null;
      (people.length ? note : intro).push(line);
      continue;
    }
    // A citation written between the token and the dash moves to the end of the detail ("P1a [F2c] — x" → "x [F2c]");
    // the person's own [P1a] goes (the row is the person).
    const cites = (m[2] ?? '').replace(new RegExp(String.raw`\s*\[${m[1]}\]`, 'g'), '').trim();
    const detail = o.display([m[3]!.trim(), cites].filter(Boolean).join(' ')).trim();
    const same = people.find((x) => x.person.id === person.id);
    if (same) same.detail = [same.detail, detail].filter(Boolean).join(' · ');
    else people.push({ person, detail });
  }
  if (!people.length || (!o.peopleQuestion && people.length < 2)) return null;
  return { intro: o.display(intro.join(' ')).trim(), people: people.slice(0, MAX_LISTED), note: o.display(note.join('\n')).trim() };
}

const lower = (s: string) => s.toLocaleLowerCase('en-US');

/** "Music, Skiing circles" (left out when the detail already names one of them). */
function circlesBit(circles: string[], detail: string): string | null {
  if (!circles.length || circles.some((c) => lower(detail).includes(lower(c)))) return null;
  return `${circles.join(', ')} circle${circles.length === 1 ? '' : 's'}`;
}

/** "last contact Oct 3" (left out when the detail already says how long it's been). */
function lastBit(scope: AskScope, lastAt: number | null, detail: string): string | null {
  if (lastAt == null || /\b(?:last|quiet)\b/i.test(detail)) return null;
  return `last contact ${shortDate(lastAt, scope.now, scope.tz)}`;
}

/** One answer line: "- Sam Rivera — lives in Austin [F2c] · Climbing crew circle · last contact Oct 3". */
export function personLine(scope: AskScope, name: string, row: Pick<AskPeopleRow, 'detail' | 'circles' | 'lastContactAt'>): string {
  const bits = [row.detail, circlesBit(row.circles, row.detail), lastBit(scope, row.lastContactAt, row.detail)].filter(Boolean);
  return `- ${name}${bits.length ? ` — ${bits.join(' · ')}` : ''}`;
}

/**
 * The structured list (person chips plus city, circles and last contact from the profile) and the answer text
 * with one line per person. Only visible people get a row; null when none is left. `displayName` is the channel's
 * name for a person (full name on the web, "Sam R." over iMessage).
 */
export function buildPeopleList(scope: AskScope, a: PeopleAnswer, displayName: (p: PersonRow) => string): { list: AskPeopleList; text: string } | null {
  const people = a.people.slice(0, MAX_LISTED);
  const chips = new Map(personChips(scope, people.map((x) => x.person), MAX_LISTED).map((c) => [c.id, c]));
  const summaries = new Map(summarize(scope, [...chips.keys()]).map((s) => [s.id, s]));
  const rows: AskPeopleRow[] = [];
  const lines: string[] = [];
  for (const x of people) {
    const chip = chips.get(x.person.id);
    if (!chip) continue;
    const s = summaries.get(x.person.id);
    const row: AskPeopleRow = {
      person: chip,
      detail: x.detail,
      city: s?.city ? maskText(s.city) : null,
      circles: (s?.circles ?? []).map((c) => maskText(c)),
      lastContactAt: s?.lastAt ?? null,
    };
    rows.push(row);
    lines.push(personLine(scope, displayName(x.person), row));
  }
  if (!rows.length) return null;
  const text = [a.intro, lines.join('\n'), a.note ? `\n${a.note}` : ''].filter(Boolean).join('\n');
  return { list: { intro: a.intro, rows, note: a.note }, text };
}
