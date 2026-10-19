/**
 * Template copy: the deterministic composer that always runs (and the fallback for any item the LLM composer
 * can't ground). Per kind, a short action as the headline ("Check in with Sam R.") and one or two plain sentences
 * of context as the body ("It's been 6 weeks. You usually talk about once a week."), from the generator payload
 * plus a few local lookups (silence and usual gap, the occasion title and time, the circle name, the commitment's
 * due date). Names are first name + last initial; every dynamic fragment goes through safeFragment (no URLs,
 * phones, emails, amounts, long digit runs).
 */
import type { DB } from '../db/connection';
import type { SelectedItem } from './selection';
import { endSentence, humanDuration, humanEvery, peopleList, plural, safeFragment, shortDay, shortName, truncate, whenPhrase } from './text';

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

function commitmentOf(db: DB, item: SelectedItem): { what: string | null; owner: string; kind: string; dueAt: number | null } | null {
  if (!item.links.commitmentId) return null;
  const r = db.prepare('SELECT what, owner, kind, due_at, due_end, due_precision, sensitive FROM commitments WHERE id = ?').get(item.links.commitmentId) as
    | { what: string; owner: string; kind: string; due_at: number | null; due_end: number | null; due_precision: string | null; sensitive: number }
    | undefined;
  if (!r) return null;
  // A vague promise ("sometime") has no date to show.
  const vague = r.due_precision === 'vague' || r.due_precision === 'none';
  // A sensitive promise's text never goes into copy (the item is sensitive too; this is the belt to its braces).
  return { what: r.sensitive === 1 ? null : r.what, owner: r.owner, kind: r.kind, dueAt: vague ? null : (r.due_at ?? r.due_end) };
}

/** Commitment kinds one person owes the other (never worded as a shared plan). */
const ONE_SIDED = new Set(['send', 'call', 'intro', 'reply_later', 'favor']);

/** A fragment used mid-sentence ("Game night? is today") loses its trailing punctuation (an ellipsis stays). */
const mid = (s: string | null): string | null => (s ? s.replace(/[\s.!?,;:]+$/u, '') || null : null);
/** First letter upper-cased ("someone has been…" → "Someone has been…"). */
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** A commitment written as an action ("send the trail map") rather than a thing ("coffee at the usual place"). */
const ACTION_START =
  /^(?:send|call|text|email|introduce|intro|pay|return|book|share|check|ask|get|bring|give|make|find|buy|set|follow|reply|write|look|help|grab|visit|try|read|watch|order|fix|sign|pick|drop|lend|mail|post|schedule|invite|tell|show|confirm|let|connect|come|go|take|meet up|hang out)\b/i;

function debtAge(db: DB, item: SelectedItem, now: number): number | null {
  const fromPayload = num(pick(item.payload, 'ageD', 'age_d', 'waitingD', 'waiting_d', 'days'));
  if (fromPayload !== null) return fromPayload;
  const hours = num(pick(item.payload, 'ageH', 'age_h'));
  if (hours !== null) return hours / 24;
  if (!item.links.replyDebtId) return null;
  const at = db.prepare('SELECT asked_at FROM reply_debts WHERE id = ?').pluck().get(item.links.replyDebtId) as number | undefined;
  return at ? (now - at) / DAY : null;
}

/** Template copy for one item: a short action as the headline and a plain sentence of context as the body. */
export function templateCopy(item: SelectedItem, ctx: TemplateContext): ItemCopy {
  const names = item.people.map((p) => shortName(p) ?? 'someone');
  const who = names[0] ?? 'someone';
  const first = who.split(' ')[0]!;
  const p = item.payload;
  const st = statsOf(ctx.db, item.people[0]?.id);
  const silence = num(pick(p, 'silenceD', 'silence_d', 'silenceDays')) ?? st?.silence_d ?? null;
  const gap = num(pick(p, 'expectedGapD', 'expected_gap_d', 'usualGapD', 'gapD')) ?? st?.expected_gap_d ?? null;
  const quiet = humanDuration(silence);
  let headline: string;
  let body: string | null = null;

  switch (item.kind) {
    case 'reply_debt': {
      const age = debtAge(ctx.db, item, ctx.now);
      headline = `Reply to ${who}`;
      body = age !== null && age >= 1 ? `${first} has been waiting ${humanDuration(age)} for an answer.` : `${first} is waiting on an answer.`;
      break;
    }
    case 'pre_event_brief': {
      const occ = occasionOf(ctx.db, item);
      const title = occ?.sensitive ? null : safeFragment(occ?.title ?? str(p.title), 40);
      const when = occ?.startsAt ? whenPhrase(occ.startsAt, ctx.timeZone, ctx.now) : null;
      headline = mid(title) ? `${mid(title)} is ${when ?? 'coming up'}` : `You have something ${when ?? 'coming up'}`;
      body = names.length ? `${peopleList(names)} ${names.length > 1 ? 'are' : 'is'} going. There's a quick brief in the app.` : "There's a quick brief in the app.";
      break;
    }
    case 'commitment_due': {
      const c = commitmentOf(ctx.db, item);
      const what = mid(c ? safeFragment(c.what, 50) : safeFragment(str(p.what), 50));
      // The row's own date; the generator's payload date only without a row (it invents one for vague promises).
      const dueAt = c ? c.dueAt : p.precision === 'vague' || p.precision === 'none' ? null : num(p.dueAt);
      const due = dueAt ? shortDay(dueAt, ctx.timeZone, ctx.now) : null;
      const past = dueAt !== null && dueAt < ctx.now;
      const owner = c?.owner ?? str(p.owner) ?? 'me';
      const kind = c?.kind ?? str(p.commitmentKind) ?? 'other';
      // Who owes what decides the wording; "send the trail map" fits "you'd …", "the restaurant list" needs a colon.
      const verbLed = what !== null && ACTION_START.test(what);
      const shared = owner === 'both' || kind === 'meet' || kind === 'plan' || (!ONE_SIDED.has(kind) && what !== null && !verbLed);
      if (shared) {
        headline = what ? `Your plan with ${who}: ${what}` : `Follow up on your plans with ${who}`;
        body = due ? (past ? `That was planned for ${due}. Did it happen?` : `It's planned for ${due}.`) : null;
      } else if (owner === 'them') {
        headline = what ? (verbLed ? `${who} said they'd ${what}` : `${who} owes you: ${what}`) : `${who} owes you an update`;
        body = due && !past ? `It's due ${due}.` : `${endSentence(`Maybe check in with ${first}`)}${due ? ` It was due ${due}.` : ''}`;
      } else {
        headline = what ? (verbLed ? `You told ${who} you'd ${what}` : `Your promise to ${who}: ${what}`) : `Follow through on your promise to ${who}`;
        body = due ? (past ? `That was due ${due}.` : `It's due ${due}.`) : null;
      }
      break;
    }
    case 'event_followup': {
      const occ = occasionOf(ctx.db, item);
      const title = occ?.sensitive ? null : safeFragment(occ?.title ?? str(p.title), 40);
      const added = num(pick(p, 'newPeople', 'added', 'count'));
      if (names.length) {
        headline = `Follow up with ${peopleList(names)}`;
        body = title
          ? `${endSentence(`You saw ${names.length > 1 ? 'them' : first} at ${title}`)} A quick "great to see you" goes a long way.`
          : 'A quick "great to see you" goes a long way.';
      } else {
        headline = mid(title) ? `Follow up after ${mid(title)}` : 'Follow up after your event';
        body = added && added > 0 ? `You met ${plural(added, 'new person', 'new people')} there.` : null;
      }
      break;
    }
    case 'fading': {
      headline = `Check in with ${who}`;
      const every = humanEvery(gap);
      body = quiet ? `It's been ${quiet}.${every ? ` You usually talk ${every}.` : ''}` : null;
      break;
    }
    case 'cooling': {
      headline = `Catch up with ${who}`;
      body = `You two have been talking less lately.${quiet ? ` Last time was ${quiet} ago.` : ''}`;
      break;
    }
    case 'dormant': {
      headline = `Reconnect with ${who}?`;
      body = `You used to be close, but it's been ${quiet ?? 'a long time'}.`;
      break;
    }
    case 'travel_overlap': {
      const city = mid(safeFragment(str(pick(p, 'city', 'place', 'metro')), 30));
      const start = num(pick(p, 'startsAt', 'starts_at', 'start'));
      const when = start ? shortDay(start, ctx.timeZone, ctx.now) : null;
      if (p.inverse === true) {
        headline = `${who} will be in ${city ?? 'town'}${when ? ` from ${when}` : ' soon'}`;
        body = "Want to meet up while they're around?";
      } else {
        headline = `Your ${city ? `${city} ` : ''}trip starts ${when ?? 'soon'}`;
        body = names.length ? `${endSentence(`${peopleList(names)} ${names.length > 1 ? 'are' : 'is'} there`)} Worth a "want to meet up?"` : 'You know people there.';
      }
      break;
    }
    case 'intro': {
      headline = names.length >= 2 ? `Introduce ${names[0]} and ${names[1]}?` : `An intro for ${who}?`;
      const shared = num(p.sharedInterests);
      const sameMetro = p.sameMetro === true;
      body =
        shared && shared > 0
          ? `They have ${plural(shared, 'interest')} in common${sameMetro ? ' and live in the same area' : ''}.`
          : sameMetro
            ? 'They live in the same area and might get along.'
            : 'They might get along.';
      break;
    }
    case 'circle_neglect': {
      const name = circleName(ctx.db, item);
      const since = humanDuration(num(pick(p, 'sinceD', 'quietD', 'quiet_d', 'silenceD', 'days')));
      headline = p.checkin === true ? `Check in with ${name ?? 'one of your groups'}?` : `Make plans with ${name ?? 'one of your groups'}`;
      body = since ? `You haven't all been together in ${since}.` : "It's been a while since you all got together.";
      break;
    }
    case 'memory': {
      const occ = occasionOf(ctx.db, item);
      const title = occ?.sensitive ? null : safeFragment(occ?.title ?? str(p.title), 40);
      headline = title ? `A year ago today: ${title}` : `A year ago today with ${peopleList(names) || 'friends'}`;
      body = title && names.length ? `${endSentence(`With ${peopleList(names)}`)} Worth a throwback text?` : 'Worth a throwback text?';
      break;
    }
    case 'wildcard':
    default:
      headline = names.length ? `Say hi to ${peopleList(names)}?` : 'Try something new today';
      body = 'A random pick to shake things up.';
  }

  if (item.isWildcard) headline = `🎲 ${headline}`;
  return { headline: truncate(headline, 90), body: body ? truncate(cap(body), 240) : null, openers: [] };
}

/** Stand-in headline for sensitive items outside the web. */
export const SENSITIVE_LINE = 'Something personal';
/** Its second line. */
export const SENSITIVE_BODY = 'The details are in the app.';
