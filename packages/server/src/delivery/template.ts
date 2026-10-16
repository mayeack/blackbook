/**
 * Template copy: the deterministic composer that always runs (and the fallback for any item the LLM composer
 * can't ground). One headline per kind from the generator payload plus a few local lookups (silence and usual gap,
 * the occasion title and time, the circle name, the commitment's due date). Names are first name + last initial;
 * every dynamic fragment goes through safeFragment (no URLs, phones, emails, amounts, long digit runs).
 */
import type { DB } from '../db/connection';
import type { SelectedItem } from './selection';
import { days, nameList, safeFragment, shortDay, shortName, shortTime, truncate } from './text';

export interface TemplateContext {
  db: DB;
  now: number;
  timeZone: string;
}

export interface ItemCopy {
  /** ≤90 chars. */
  headline: string;
  /** ≤240 chars, or null. */
  body: string | null;
  /** ≤2 drafts, each ≤160 chars (copy-only; never sent to anyone but the owner). */
  openers: string[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
/** The first payload key present (generators name things differently). */
const pick = (p: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (p[k] !== undefined && p[k] !== null) return p[k];
  return undefined;
};

const DAY = 86_400_000;

interface Stats {
  silence_d: number | null;
  expected_gap_d: number | null;
  last_at: number | null;
}

function statsOf(db: DB, personId: string | undefined): Stats | null {
  if (!personId) return null;
  return (db.prepare('SELECT silence_d, expected_gap_d, last_at FROM person_stats WHERE person_id = ?').get(personId) as Stats | undefined) ?? null;
}

function occasionOf(db: DB, item: SelectedItem): { title: string | null; startsAt: number | null; sensitive: boolean } | null {
  if (item.links.occasionId) {
    const r = db.prepare('SELECT title, starts_at, sensitive FROM occasions WHERE id = ?').get(item.links.occasionId) as
      | { title: string | null; starts_at: number; sensitive: number }
      | undefined;
    if (r) return { title: r.title, startsAt: r.starts_at, sensitive: r.sensitive === 1 };
  }
  if (item.links.eventId) {
    const r = db.prepare('SELECT title, starts_at FROM events WHERE id = ?').get(item.links.eventId) as { title: string | null; starts_at: number | null } | undefined;
    if (r) return { title: r.title, startsAt: r.starts_at, sensitive: false };
  }
  return null;
}

function circleName(db: DB, item: SelectedItem): string | null {
  const id = item.links.circleId;
  if (!id) return safeFragment(str(item.payload.circleName), 30);
  const n = db.prepare(`SELECT name FROM circles WHERE id = ? AND status = 'active'`).pluck().get(id) as string | undefined;
  return safeFragment(n ?? str(item.payload.circleName), 30);
}

function commitmentOf(db: DB, item: SelectedItem): { what: string | null; owner: string; dueAt: number | null } | null {
  if (!item.links.commitmentId) return null;
  const r = db.prepare('SELECT what, owner, due_at, due_end, sensitive FROM commitments WHERE id = ?').get(item.links.commitmentId) as
    | { what: string; owner: string; due_at: number | null; due_end: number | null; sensitive: number }
    | undefined;
  // A sensitive promise's text never goes into copy (the item is sensitive too; this is the belt to its braces).
  return r ? { what: r.sensitive === 1 ? null : r.what, owner: r.owner, dueAt: r.due_at ?? r.due_end } : null;
}

function debtAge(db: DB, item: SelectedItem, now: number): number | null {
  const fromPayload = num(pick(item.payload, 'ageD', 'age_d', 'waitingD', 'waiting_d', 'days'));
  if (fromPayload !== null) return fromPayload;
  const hours = num(pick(item.payload, 'ageH', 'age_h'));
  if (hours !== null) return hours / 24;
  if (!item.links.replyDebtId) return null;
  const at = db.prepare('SELECT asked_at FROM reply_debts WHERE id = ?').pluck().get(item.links.replyDebtId) as number | undefined;
  return at ? (now - at) / DAY : null;
}

/** Template copy for one item (web headline/body; the iMessage line is derived from the headline). */
export function templateCopy(item: SelectedItem, ctx: TemplateContext): ItemCopy {
  const names = item.people.map((p) => shortName(p) ?? 'someone');
  const who = names[0] ?? 'someone';
  const p = item.payload;
  const st = statsOf(ctx.db, item.people[0]?.id);
  const silence = num(pick(p, 'silenceD', 'silence_d', 'silenceDays')) ?? st?.silence_d ?? null;
  const gap = num(pick(p, 'expectedGapD', 'expected_gap_d', 'usualGapD', 'gapD')) ?? st?.expected_gap_d ?? null;
  let headline: string;
  let body: string | null = null;

  switch (item.kind) {
    case 'reply_debt': {
      const age = days(debtAge(ctx.db, item, ctx.now));
      headline = `${who} · waiting on your reply${age ? `, ${age}` : ''}`;
      break;
    }
    case 'pre_event_brief': {
      const occ = occasionOf(ctx.db, item);
      const title = occ?.sensitive ? null : safeFragment(occ?.title ?? str(p.title), 32);
      const when = occ?.startsAt ? `${shortDay(occ.startsAt, ctx.timeZone, ctx.now)} ${shortTime(occ.startsAt, ctx.timeZone)}` : null;
      const withWho = names.length ? ` · ${nameList(names)}` : '';
      headline = `${title ?? 'Event'}${when ? ` ${when}` : ''} · brief ready${withWho}`;
      break;
    }
    case 'commitment_due': {
      const c = commitmentOf(ctx.db, item);
      const what = c ? safeFragment(c.what, 36) : safeFragment(str(p.what), 36);
      const due = c?.dueAt ? shortDay(c.dueAt, ctx.timeZone, ctx.now) : null;
      const theirs = c?.owner === 'them';
      headline = what
        ? `${who} · ${theirs ? "said they'd" : "you said you'd"} ${what}${due ? ` (${due})` : ''}`
        : `${who} · ${theirs ? 'they promised something' : 'a promise is due'}${due ? ` (${due})` : ''}`;
      break;
    }
    case 'event_followup': {
      const occ = occasionOf(ctx.db, item);
      const title = occ?.sensitive ? null : safeFragment(occ?.title ?? str(p.title), 30);
      const added = num(pick(p, 'newPeople', 'added', 'count'));
      headline =
        added && added > 0 && names.length === 0
          ? `${added} new from ${title ? `"${title}"` : 'an event'} · say hi?`
          : `Follow up with ${nameList(names) || 'people you met'}${title ? ` after "${title}"` : ''}`;
      break;
    }
    case 'fading': {
      const s = days(silence);
      const g = days(gap);
      headline = `${who} · quiet ${s ?? 'a while'}${g ? ` (usually ~${g})` : ''}`;
      break;
    }
    case 'cooling': {
      const s = days(silence);
      headline = `${who} · cooling off${s ? `, quiet ${s}` : ''}`;
      break;
    }
    case 'dormant': {
      const s = days(silence);
      headline = `${who} · quiet ${s ?? 'a long time'} · once close`;
      break;
    }
    case 'travel_overlap': {
      const city = safeFragment(str(pick(p, 'city', 'place', 'metro')), 24);
      const start = num(pick(p, 'startsAt', 'starts_at', 'start'));
      const when = start ? shortDay(start, ctx.timeZone, ctx.now) : null;
      headline = names.length
        ? `${nameList(names)} · ${city ? `in ${city}` : 'nearby'}${when ? ` from ${when}` : ''}`
        : `Trip${city ? ` to ${city}` : ''}${when ? ` ${when}` : ''} · people you know there`;
      break;
    }
    case 'intro': {
      headline = names.length >= 2 ? `Intro ${names[0]} ↔ ${names[1]}?` : `An intro for ${who}?`;
      break;
    }
    case 'circle_neglect': {
      const name = circleName(ctx.db, item);
      const quiet = days(num(pick(p, 'quietD', 'quiet_d', 'silenceD', 'days')));
      headline = `${name ?? 'A circle'} · no plans${quiet ? ` in ${quiet}` : ' in a while'}`;
      break;
    }
    case 'memory': {
      const occ = occasionOf(ctx.db, item);
      const title = occ?.sensitive ? null : safeFragment(occ?.title ?? str(p.title), 30);
      headline = `A year ago: ${title ? `"${title}"` : 'a day together'}${names.length ? ` with ${nameList(names)}` : ''}`;
      break;
    }
    case 'wildcard':
    default:
      headline = names.length ? `${nameList(names)} · say hi?` : 'Something new to try';
  }

  if (item.isWildcard) headline = `🎲 ${headline}`;
  if (item.kind === 'fading' && gap && silence) body = `Usually you talk every ~${Math.round(gap)} days; it's been ${Math.round(silence)}.`;
  return { headline: truncate(headline, 90), body: body ? truncate(body, 240) : null, openers: [] };
}

/** "something personal" stand-in for sensitive items outside the web. */
export const SENSITIVE_LINE = 'Something personal — open the app';
