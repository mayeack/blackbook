/**
 * The weekly event picks as one email (owner request 2026-10-25: "send it to me over email every sunday evening";
 * delivery/email.ts sends it to his own Gmail). One message, everything in it:
 *
 *   Subject  Your week: 4 event picks (Mon Oct 26 – Sun Nov 1)
 *   intro    which nights are free;
 *   Picks    each: date · title, venue and time, the why, where it came from ("From a newsletter"), and
 *            "Get tickets" → https://yeackbot.com/go/<id> (the app counts the tap, a learning signal, then redirects
 *            to the checked ticket page; routes/eventPicks.ts);
 *   On your Recurring Events calendar   the best listings that fall when he's free (listings.ts);
 *   Last week   what the picks learned from: which he went to and how yeackbot knew (a ticket email, his calendar,
 *            a Partiful RSVP, his own answer), what he tapped, what he waved off;
 *   footer   how to answer (buy a ticket or put it on the calendar, or yeackbot.com/picks).
 * Text from the web and newsletters passes safeFragment (no URLs, emails, phones, @handles, money) and is HTML-escaped;
 * the only links are yeackbot.com ones. Pure functions.
 */
import type { EmailMessage } from '../../delivery/email';
import { clockWords, endSentence, headerDate, safeFragment, truncate } from '../../delivery/text';
import { goLink, PICKS_LINK } from './compose';
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

export interface LastWeek {
  sent: number;
  went: { title: string; how: string | null }[];
  tapped: number;
  notForMe: number;
}

export interface PicksEmailInput {
  weekStart: string;
  windowEnd: string;
  freeNights: readonly string[];
  picks: readonly EmailPick[];
  listings: readonly EmailPick[];
  lastWeek: LastWeek | null;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const dayWord = (date: string): string => DOW[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
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

const SOURCE_LABEL: Readonly<Record<PickSource, string | null>> = { web: null, newsletter: 'From one of your newsletters', calendar: null };

export function emailSubject(i: Pick<PicksEmailInput, 'weekStart' | 'windowEnd' | 'picks' | 'listings'>): string {
  const n = i.picks.length + i.listings.length;
  return `Your week: ${plural(n, 'event pick')} (${headerDate(i.weekStart)} – ${headerDate(i.windowEnd)})`;
}

interface Lines {
  head: string;
  where: string | null;
  why: string | null;
  from: string | null;
  link: { href: string; label: string };
}

function lines(p: EmailPick, ordinal: number, listing: boolean): Lines {
  // Listings are his own calendar's words; web and newsletter text is filtered like the texts.
  const title = (listing ? truncate(p.title, 80) : safeFragment(p.title, 80)) ?? 'An event';
  const venue = listing ? truncate(p.venue, 60) : safeFragment(p.venue, 60);
  const where = [venue && venue !== '(unknown)' ? venue : null, p.startTime ? clockWords(p.startTime) : null].filter(Boolean).join(', ') || null;
  const why = safeFragment(p.why, 120);
  const head = `${p.wildcard ? '🎲 Something different: ' : ''}${headerDate(p.localDate)} · ${title}`;
  const label = p.hasLink ? (p.ticketHost ? `Get tickets on ${p.ticketHost}` : 'Get tickets') : 'Details';
  return { head: listing ? head : `${ordinal}. ${head}`, where, why: why ? endSentence(truncate(why, 120)) : null, from: SOURCE_LABEL[p.source], link: { href: url(goLink(p.id)), label } };
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

const FOOTER = `Going to one? Buy the ticket or put it on your calendar and I'll notice. Not your thing? Tell me at ${PICKS_LINK}`;

export function picksEmailText(i: PicksEmailInput): string {
  const nights = i.freeNights.map(dayWord);
  const out = [`Your free nights this week: ${nights.length ? nights.join(', ') : 'none'}.`, ''];
  if (i.picks.length) {
    out.push('PICKS', '');
    i.picks.forEach((p, n) => {
      const l = lines(p, n + 1, false);
      out.push(l.head);
      if (l.where) out.push(l.where);
      if (l.why) out.push(l.why);
      if (l.from) out.push(l.from);
      out.push(`${l.link.label}: ${l.link.href}`, '');
    });
  }
  if (i.listings.length) {
    out.push('ON YOUR RECURRING EVENTS CALENDAR', '');
    for (const p of i.listings) {
      const l = lines(p, 0, true);
      out.push(l.head);
      if (l.where) out.push(l.where);
      if (l.why) out.push(l.why);
      out.push(`${l.link.label}: ${l.link.href}`, '');
    }
  }
  const last = lastWeekLine(i.lastWeek);
  if (last) out.push(last, '');
  out.push(FOOTER.replace(PICKS_LINK, url(PICKS_LINK)), '', '— yeackbot');
  return out.join('\n');
}

const C = { text: '#1d1d1f', muted: '#6e6e73', line: '#e5e5ea', accent: '#0a66c2', bg: '#ffffff', chip: '#f2f2f7' };

function itemHtml(l: Lines): string {
  const meta = [l.where, l.why].filter(Boolean).map((x) => `<div style="color:${C.muted};font-size:14px;line-height:20px">${esc(x!)}</div>`).join('');
  const from = l.from ? `<div style="display:inline-block;margin-top:6px;padding:2px 8px;border-radius:10px;background:${C.chip};color:${C.muted};font-size:12px">${esc(l.from)}</div>` : '';
  return (
    `<tr><td style="padding:14px 0;border-top:1px solid ${C.line}">` +
    `<div style="font-size:16px;line-height:22px;font-weight:600;color:${C.text}">${esc(l.head)}</div>${meta}${from}` +
    `<div style="margin-top:8px"><a href="${esc(l.link.href)}" style="color:${C.accent};font-size:14px;font-weight:600;text-decoration:none">${esc(l.link.label)} →</a></div>` +
    `</td></tr>`
  );
}

const section = (title: string, rows: string) =>
  `<tr><td style="padding:22px 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${C.muted};font-weight:600">${esc(title)}</td></tr>${rows}`;

export function picksEmailHtml(i: PicksEmailInput): string {
  const nights = i.freeNights.map(dayWord);
  const intro = `Your free nights this week: ${nights.length ? nights.join(', ') : 'none'}.`;
  const picks = i.picks.length ? section('Picks', i.picks.map((p, n) => itemHtml(lines(p, n + 1, false))).join('')) : '';
  const listings = i.listings.length ? section('On your Recurring Events calendar', i.listings.map((p) => itemHtml(lines(p, 0, true))).join('')) : '';
  const last = lastWeekLine(i.lastWeek);
  const lastHtml = last ? `<tr><td style="padding:18px 0 0;border-top:1px solid ${C.line};color:${C.text};font-size:14px;line-height:20px">${esc(last)}</td></tr>` : '';
  const footer =
    `<tr><td style="padding:18px 0 0;color:${C.muted};font-size:13px;line-height:19px">Going to one? Buy the ticket or put it on your calendar and I'll notice. ` +
    `Not your thing? <a href="${url(PICKS_LINK)}" style="color:${C.accent}">Tell me</a>.<br>— yeackbot</td></tr>`;
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>` +
    `<body style="margin:0;padding:0;background:${C.bg}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:24px 16px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">` +
    `<tr><td style="font-size:22px;line-height:28px;font-weight:700;color:${C.text}">Your week</td></tr>` +
    `<tr><td style="padding-top:6px;font-size:15px;line-height:21px;color:${C.text}">${esc(intro)}</td></tr>` +
    `${picks}${listings}${lastHtml}${footer}` +
    `</table></td></tr></table></body></html>`
  );
}

export function picksEmail(i: PicksEmailInput): EmailMessage {
  return { subject: emailSubject(i), text: picksEmailText(i), html: picksEmailHtml(i), tag: 'event-picks' };
}
