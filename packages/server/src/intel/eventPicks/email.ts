/**
 * The weekly event picks as one email (owner requests 2026-10-25: "send it to me over email every sunday evening";
 * 2026-10-28: "Organize the email by day … Have 3-5 events per day where it looks like I am free … If it looks like
 * I'm busy (have a calendar event in the evening), print the event"; no front matter, no footer). delivery/email.ts
 * sends it to his own Gmail. One message, a section per day of the week:
 *
 *   Subject   Your week: 9 event picks (Mon Oct 26 – Sun Nov 1)
 *   free day  its picks in time order, each: title (🎲 for the wildcard), venue and time, the why, where it came from
 *             ("From one of your newsletters", "On your Recurring Events calendar"), and "Get tickets on dice.fm →"
 *             to https://yeackbot.com/go/<id> (the app counts the tap, a learning signal, then redirects to the checked
 *             page; routes/eventPicks.ts). A free day with nothing found says so;
 *   busy day  the plans that fill his evening ("Dinner · 7pm"), from his own calendar, Partiful, tickets or a trip;
 *   last week what the picks learned from: which he went to and how yeackbot knew (a ticket email, his calendar, a
 *             Partiful RSVP, his own answer), what he tapped, what he waved off. Only from the second week.
 * Text from the web and newsletters passes safeFragment (no URLs, emails, phones, @handles, money); everything is
 * HTML-escaped; the only links are yeackbot.com ones. Pure functions.
 */
import type { EmailMessage } from '../../delivery/email';
import { clockWords, endSentence, headerDate, safeFragment, truncate } from '../../delivery/text';
import { goLink } from './compose';
import type { PickSource } from './rank';

export interface EmailPick {
  id: string;
  title: string;
  venue: string;
  localDate: string;
  startTime: string | null;
  why: string | null;
  wildcard: boolean;
  hasLink: boolean;
  /** The site the ticket link goes to ("dice.fm"), for the button. */
  ticketHost: string | null;
  source: PickSource;
}

/** One day of the week: a free day's picks (time order), or the plans that make it busy. */
export interface EmailDay {
  date: string;
  free: boolean;
  /** away = a trip or flight ("Away: …"); otherwise a plan ("Busy: …"). */
  plans: { title: string; time: string | null; away?: boolean }[];
  picks: EmailPick[];
}

export interface LastWeek {
  sent: number;
  went: { title: string; how: string | null }[];
  tapped: number;
  notForMe: number;
}

export interface PicksEmailInput {
  weekStart: string;
  windowEnd: string;
  days: readonly EmailDay[];
  lastWeek: LastWeek | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const url = (path: string) => `https://${path}`;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** How yeackbot knew he went, for the "Last week" line. */
export const HOW_LABEL: Readonly<Record<string, string>> = {
  ticket: 'a ticket in your email',
  calendar: 'on your calendar',
  partiful: 'your Partiful RSVP',
  owner: 'you said so',
};

const SOURCE_LABEL: Readonly<Record<PickSource, string | null>> = {
  web: null,
  newsletter: 'From one of your newsletters',
  calendar: 'On your Recurring Events calendar',
};

export const NOTHING_FOUND = 'Free, but nothing stood out.';
/** A busy day lists this many plans, then "and N more". */
export const MAX_PLANS = 4;

export function emailSubject(i: Pick<PicksEmailInput, 'weekStart' | 'windowEnd' | 'days'>): string {
  const n = i.days.reduce((a, d) => a + d.picks.length, 0);
  return `Your week: ${plural(n, 'event pick')} (${headerDate(i.weekStart)} – ${headerDate(i.windowEnd)})`;
}

interface Lines {
  head: string;
  where: string | null;
  why: string | null;
  from: string | null;
  link: { href: string; label: string };
}

function lines(p: EmailPick): Lines {
  // Listings are his own calendar's words; web and newsletter text is filtered like the texts.
  const listing = p.source === 'calendar';
  const title = (listing ? truncate(p.title, 80) : safeFragment(p.title, 80)) ?? 'An event';
  const venue = listing ? truncate(p.venue, 60) : safeFragment(p.venue, 60);
  const where = [venue && venue !== '(unknown)' ? venue : null, p.startTime ? clockWords(p.startTime) : null].filter(Boolean).join(', ') || null;
  const why = safeFragment(p.why, 120);
  const label = p.hasLink ? (p.ticketHost ? `Get tickets on ${p.ticketHost}` : 'Get tickets') : 'Details';
  return {
    head: `${p.wildcard ? '🎲 Something different: ' : ''}${title}`,
    where,
    why: why ? endSentence(truncate(why, 120)) : null,
    from: SOURCE_LABEL[p.source],
    link: { href: url(goLink(p.id)), label },
  };
}

/** "Busy: Dinner · 7pm" / "Away: Example Coast" (his own calendar's words, one line). */
export const planLine = (p: EmailDay['plans'][number]): string =>
  `${p.away ? 'Away' : 'Busy'}: ${[truncate(p.title.replace(/\s+/g, ' '), 80), p.time && !p.away ? clockWords(p.time) : null].filter(Boolean).join(' · ')}`;

/** A busy day's lines: up to MAX_PLANS plans, then "and N more"; "Busy" when nothing has a title. */
export function planLines(plans: EmailDay['plans']): string[] {
  if (!plans.length) return ['Busy'];
  const shown = plans.slice(0, MAX_PLANS).map(planLine);
  return plans.length > MAX_PLANS ? [...shown, `and ${plans.length - MAX_PLANS} more`] : shown;
}

export function lastWeekLine(w: LastWeek | null): string | null {
  if (!w || !w.sent) return null;
  const went = w.went.slice(0, 3).map((g) => `${safeFragment(g.title, 50) ?? 'one'}${g.how ? ` (${g.how})` : ''}`);
  const parts: string[] = [];
  if (went.length) parts.push(`you went to ${went.join(', ')}`);
  if (w.tapped) parts.push(`you looked at ${plural(w.tapped, 'other')}`);
  if (w.notForMe) parts.push(`${plural(w.notForMe, 'was', 'were')} not for you`);
  if (!parts.length) return `Last week: none of the ${plural(w.sent, 'pick')} landed, so this week tries a few different things.`;
  return `Last week: ${parts.join('; ')}. This week leans that way.`;
}

export function picksEmailText(i: PicksEmailInput): string {
  const out: string[] = [];
  for (const d of i.days) {
    out.push(headerDate(d.date).toUpperCase());
    if (!d.free) out.push(...planLines(d.plans));
    else if (!d.picks.length) out.push(NOTHING_FOUND);
    for (const p of d.free ? d.picks : []) {
      const l = lines(p);
      out.push('', l.head);
      if (l.where) out.push(l.where);
      if (l.why) out.push(l.why);
      if (l.from) out.push(l.from);
      out.push(`${l.link.label}: ${l.link.href}`);
    }
    out.push('');
  }
  const last = lastWeekLine(i.lastWeek);
  if (last) out.push(last);
  return out.join('\n').trimEnd();
}

const C = { text: '#1d1d1f', muted: '#6e6e73', line: '#e5e5ea', accent: '#0a66c2', bg: '#ffffff', chip: '#f2f2f7' };

function itemHtml(l: Lines): string {
  const meta = [l.where, l.why].filter(Boolean).map((x) => `<div style="color:${C.muted};font-size:14px;line-height:20px">${esc(x!)}</div>`).join('');
  const from = l.from ? `<div style="display:inline-block;margin-top:6px;padding:2px 8px;border-radius:10px;background:${C.chip};color:${C.muted};font-size:12px">${esc(l.from)}</div>` : '';
  return (
    `<tr><td style="padding:12px 0 12px 0;border-top:1px solid ${C.line}">` +
    `<div style="font-size:16px;line-height:22px;font-weight:600;color:${C.text}">${esc(l.head)}</div>${meta}${from}` +
    `<div style="margin-top:8px"><a href="${esc(l.link.href)}" style="color:${C.accent};font-size:14px;font-weight:600;text-decoration:none">${esc(l.link.label)} →</a></div>` +
    `</td></tr>`
  );
}

const muted = (text: string) => `<tr><td style="padding:6px 0 4px;color:${C.muted};font-size:14px;line-height:20px">${esc(text)}</td></tr>`;

function dayHtml(d: EmailDay): string {
  const head = `<tr><td style="padding:24px 0 6px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:${C.text};font-weight:700">${esc(headerDate(d.date))}</td></tr>`;
  if (!d.free) return head + planLines(d.plans).map(muted).join('');
  if (!d.picks.length) return head + muted(NOTHING_FOUND);
  return head + d.picks.map((p) => itemHtml(lines(p))).join('');
}

export function picksEmailHtml(i: PicksEmailInput): string {
  const last = lastWeekLine(i.lastWeek);
  const lastHtml = last ? `<tr><td style="padding:24px 0 0;border-top:1px solid ${C.line};color:${C.text};font-size:14px;line-height:20px">${esc(last)}</td></tr>` : '';
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>` +
    `<body style="margin:0;padding:0;background:${C.bg}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:16px 16px 24px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">` +
    `${i.days.map(dayHtml).join('')}${lastHtml}` +
    `</table></td></tr></table></body></html>`
  );
}

export function picksEmail(i: PicksEmailInput): EmailMessage {
  return { subject: emailSubject(i), text: picksEmailText(i), html: picksEmailHtml(i), tag: 'event-picks' };
}
