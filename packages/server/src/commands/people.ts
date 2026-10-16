/**
 * Who a `log:` names. Local and deterministic: visible people only (person_visible: never hidden, merged-away,
 * roster-only or service rows), first name / nickname match (with nickname families: "Sam" ↔ Samuel/Samantha),
 * narrowed by a following last initial or last name. Exact first-name matches beat nickname-family matches.
 * One candidate = resolved; several = ambiguous ("Sam R. or Sam K.? reply 1/2"); ranked by priority, then
 * most recent contact.
 */
import { canonicalFirstNames, normalizeNamePart } from '@yb/shared';
import type { DB } from '../db/connection';
import { shortName } from './text';

export interface PersonLite {
  id: string;
  first: string | null;
  last: string | null;
  nickname: string | null;
  display: string;
  company: string | null;
  priority: boolean;
  lastAt: number | null;
}

export interface Mention {
  /** As typed ("Sam", "sam r"). */
  surface: string;
  start: number;
  end: number;
  /** Ranked best first. */
  candidates: PersonLite[];
}

export function loadPeople(db: DB): PersonLite[] {
  const rows = db
    .prepare(
      `SELECT pv.id, pv.first_name, pv.last_name, pv.nickname, pv.display_name, pv.company, pv.is_priority,
              (SELECT last_at FROM person_stats ps WHERE ps.person_id = pv.id) AS last_at
       FROM person_visible pv`,
    )
    .all() as {
    id: string;
    first_name: string | null;
    last_name: string | null;
    nickname: string | null;
    display_name: string;
    company: string | null;
    is_priority: number;
    last_at: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    first: r.first_name,
    last: r.last_name,
    nickname: r.nickname,
    display: r.display_name,
    company: r.company,
    priority: r.is_priority === 1,
    lastAt: r.last_at,
  }));
}

export const labelOf = (p: PersonLite): string => shortName({ first_name: p.first, last_name: p.last, display_name: p.display });

/** Distinct labels for clarification options: "Sam R." unless two collide, then the full last name, then company. */
export function distinctLabels(options: PersonLite[]): string[] {
  const short = options.map(labelOf);
  return options.map((p, i) => {
    if (short.filter((s) => s === short[i]).length === 1) return short[i]!;
    const full = [p.first, p.last].filter(Boolean).join(' ') || p.display;
    const fulls = options.map((o) => [o.first, o.last].filter(Boolean).join(' ') || o.display);
    if (fulls.filter((f) => f === full).length === 1) return full;
    return p.company ? `${full} (${p.company})` : `${full} #${i + 1}`;
  });
}

const rank = (a: PersonLite, b: PersonLite) => Number(b.priority) - Number(a.priority) || (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.id.localeCompare(b.id);

/** Words that start a lowercase name mention ("coffee with sam"). Capitalized words need no connector. */
const CONNECTORS = new Set(['with', 'w', 'w/', 'and', '&', 'met', 'saw', 'called', 'call', 'texted', 'visited', 'from', 'for', 'to', 'plus', '+', 'ran', 'into', 'hung', 'out', 'grabbed', 'had', 'caught']);
/** Common words that are also first names; never a mention as the first word of a log ("Will call …"). */
const LEADING_STOP = new Set([
  'will', 'may', 'june', 'april', 'august', 'rose', 'art', 'bill', 'mark', 'pat', 'sue', 'sky', 'summer', 'grace', 'hope', 'joy',
  'faith', 'dawn', 'ray', 'jack', 'chase', 'drew', 'hunter', 'max', 'gene', 'frank', 'rich', 'sunny', 'love', 'just', 'got', 'had',
]);
/** Never names, whatever their case. */
const NEVER = new Set([
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'he', 'she', 'they', 'them', 'his', 'her', 'their', 'the', 'a', 'an', 'at', 'in', 'on',
  'coffee', 'lunch', 'dinner', 'breakfast', 'brunch', 'drinks', 'drink', 'beer', 'beers', 'call', 'party', 'today', 'tonight',
  'yesterday', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'mon', 'tue', 'wed',
  'thu', 'fri', 'sat', 'sun', 'january', 'february', 'march', 'september', 'october', 'november', 'december', 'jan', 'feb',
  'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'log', 'yb', 'mom', 'dad',
]);

interface Word {
  text: string;
  norm: string;
  start: number;
  end: number;
  capital: boolean;
}

function words(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(/w\/|[\p{L}][\p{L}'’.-]*/gu)) {
    const raw = m[0].replace(/(?:['’]s|['’])$/i, '').replace(/[.-]+$/, '');
    if (!raw) continue;
    out.push({ text: raw, norm: normalizeNamePart(raw), start: m.index!, end: m.index! + raw.length, capital: /^\p{Lu}/u.test(raw) });
  }
  return out;
}

class PeopleIndex {
  private readonly exact = new Map<string, PersonLite[]>();
  private readonly family = new Map<string, PersonLite[]>();
  private readonly displayFull = new Map<string, PersonLite[]>();

  constructor(readonly people: PersonLite[]) {
    const add = (m: Map<string, PersonLite[]>, k: string, p: PersonLite) => {
      if (!k) return;
      const list = m.get(k) ?? [];
      if (!list.includes(p)) list.push(p);
      m.set(k, list);
    };
    for (const p of people) {
      const first = normalizeNamePart(p.first);
      const nick = normalizeNamePart(p.nickname);
      const displayWords = normalizeNamePart(p.display).split(' ').filter(Boolean);
      const lead = first || (displayWords.length === 1 ? displayWords[0]! : '');
      add(this.exact, lead, p);
      add(this.exact, nick, p);
      for (const c of first ? canonicalFirstNames(first) : []) add(this.family, c, p);
      if (displayWords.length >= 2) add(this.displayFull, displayWords.slice(0, 2).join(' '), p);
      if (!first && displayWords.length >= 2) add(this.exact, displayWords[0]!, p);
    }
  }

  /** People a first-name token may stand for: exact first/nick matches, else the nickname family. */
  byFirst(norm: string): PersonLite[] {
    const exact = this.exact.get(norm);
    if (exact?.length) return exact;
    const out = new Set<PersonLite>();
    for (const c of canonicalFirstNames(norm)) for (const p of this.family.get(c) ?? []) out.add(p);
    return [...out];
  }

  byFull(first: string, last: string): PersonLite[] {
    return this.displayFull.get(`${first} ${last}`) ?? [];
  }
}

const lastNorm = (p: PersonLite): string => {
  const l = normalizeNamePart(p.last);
  if (l) return l;
  const w = normalizeNamePart(p.display).split(' ');
  return w.length >= 2 ? w[w.length - 1]! : '';
};

/** Narrows first-name matches with the next word (an initial or a last name). Null = the word isn't a surname. */
function narrow(cands: PersonLite[], next: Word | undefined): PersonLite[] | null {
  if (!next) return null;
  if (/^\p{L}$/u.test(next.text) || /^\p{L}\.$/u.test(next.text)) {
    const ini = next.norm[0]!;
    const hit = cands.filter((p) => lastNorm(p).startsWith(ini));
    return hit.length ? hit : null;
  }
  if (!next.capital) return null;
  const hit = cands.filter((p) => {
    const l = lastNorm(p);
    return !!l && (l === next.norm || l.split(' ').includes(next.norm));
  });
  return hit.length ? hit : null;
}

/** Person mentions in a log text, left to right. */
export function findMentions(text: string, people: PersonLite[] | PeopleIndex): Mention[] {
  const index = people instanceof PeopleIndex ? people : new PeopleIndex(people);
  const ws = words(text);
  const out: Mention[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    if (NEVER.has(w.norm) || w.norm.length < 2) continue;
    const prev = ws[i - 1];
    const connected = !!prev && CONNECTORS.has(prev.norm.replace(/\/$/, '/'));
    if (!w.capital && !connected) continue;
    if (i === 0 && LEADING_STOP.has(w.norm)) continue;
    let cands = index.byFirst(w.norm);
    let end = w.end;
    const next = ws[i + 1];
    if (next) {
      const full = index.byFull(w.norm, next.norm);
      const narrowed = cands.length ? narrow(cands, next) : null;
      if (narrowed) {
        cands = narrowed;
        end = next.end;
        i++;
      } else if (full.length) {
        cands = full;
        end = next.end;
        i++;
      }
    }
    if (!cands.length) continue;
    const ranked = [...cands].sort(rank);
    const surface = text.slice(w.start, end);
    const dup = out.find((m) => m.candidates.length === ranked.length && m.candidates.every((c, k) => c.id === ranked[k]!.id));
    if (dup) continue;
    out.push({ surface, start: w.start, end, candidates: ranked });
  }
  return out;
}

/** People a free surface string ("Sam R.", from the intent parser) may be. */
export function resolveSurface(surface: string, people: PersonLite[]): PersonLite[] {
  const ms = findMentions(surface.replace(/^\p{Ll}/u, (c) => c.toUpperCase()), people);
  return ms[0]?.candidates ?? [];
}

/** Top candidates for the intent parser: everyone any word of the text may name (≤8, ranked). */
export function intentCandidates(text: string, people: PersonLite[], limit = 8): PersonLite[] {
  const index = new PeopleIndex(people);
  const seen = new Map<string, PersonLite>();
  for (const w of words(text)) {
    if (NEVER.has(w.norm) || w.norm.length < 2) continue;
    for (const p of index.byFirst(w.norm)) seen.set(p.id, p);
  }
  return [...seen.values()].sort(rank).slice(0, limit);
}

export { PeopleIndex };
