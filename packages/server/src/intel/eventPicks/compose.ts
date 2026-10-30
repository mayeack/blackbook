/**
 * The weekly event picks as ONE text, by day (the email's layout, delivered when the email can't be; owner
 * 2026-10-28: "Organize the email by day … Have 3-5 events per day where it looks like I am free … If it looks like I'm
 * busy … print the event"; and the brief's rule: everything in one text). Starts with the bot marker:
 *
 *   🅨 Event picks, Thu Oct 29 – Wed Nov 4
 *
 *   Thu Oct 29: busy (Dinner 7pm)
 *
 *   Mon Nov 2
 *   1. Sample Band · Example Hall, 10pm · yeackbot.com/go/k3v9x2p1q7
 *   2. 🎲 Orcas vs Herons · Example Arena · yeackbot.com/go/…
 *   3. Jazz night (Recurring Events) · Example Lounge, 7pm · yeackbot.com/go/…
 *
 * Texts may only carry yeackbot.com links (delivery/types.ts checkOutboundText), so each link is
 * yeackbot.com/go/<pick id>: the app counts the tap and redirects to the checked ticket page (routes/eventPicks.ts).
 * Everything from the web (title, venue) and his plans' titles pass safeFragment (no URLs, emails, phones, @handles,
 * money, long digit runs) and are truncated; a text that still fails checkOutboundText falls back to counts per day
 * and yeackbot.com/picks. Pure functions.
 */
import { checkOutboundText } from '../../delivery/types';
import { BOT_MARKER, clockWords, headerDate, safeFragment } from '../../delivery/text';

/** The page listing this week's picks (feedback buttons). */
export const PICKS_LINK = 'yeackbot.com/picks';
export const goLink = (id: string): string => `yeackbot.com/go/${id}`;

export interface PickText {
  id: string;
  ordinal: number;
  title: string;
  venue: string;
  localDate: string;
  startTime: string | null;
  why: string | null;
  wildcard: boolean;
  hasLink: boolean;
  /** 'calendar' = a listing from his Recurring Events calendar. */
  source?: 'web' | 'newsletter' | 'calendar';
}

/** One day of the week: a free day's picks, or a busy day's plans. */
export interface TextDay {
  date: string;
  free: boolean;
  plans: { title: string; time: string | null; away?: boolean }[];
  picks: PickText[];
}

/** "1. Sample Band · Example Hall, 10pm · yeackbot.com/go/…" */
export function pickLine(p: PickText): string {
  const title = safeFragment(p.title, 60) ?? 'An event';
  const venue = safeFragment(p.venue, 40);
  const where = [venue && venue !== '(unknown)' ? venue : null, p.startTime ? clockWords(p.startTime) : null].filter(Boolean).join(', ');
  const label = `${p.wildcard ? '🎲 ' : ''}${title}${p.source === 'calendar' ? ' (Recurring Events)' : ''}`;
  return [`${p.ordinal}. ${label}`, where || null, goLink(p.id)].filter(Boolean).join(' · ');
}

/** "busy (Dinner 7pm; Late set 11pm; +2 more)", or "away (Example Coast)" for a trip. */
export function busyLine(plans: TextDay['plans']): string {
  const list = plans
    .slice(0, 3)
    .map((x) => [safeFragment(x.title, 40), x.time && !x.away ? clockWords(x.time) : null].filter(Boolean).join(' '))
    .filter(Boolean);
  if (plans.length > 3) list.push(`+${plans.length - 3} more`);
  const word = plans.length && plans.every((x) => x.away) ? 'away' : 'busy';
  return list.length ? `${word} (${list.join('; ')})` : word;
}

/** The whole week in one text (see the header); `note` follows the first line (e.g. why it isn't an email). */
export function picksText(days: readonly TextDay[], week: { weekStart: string; windowEnd: string }, note?: string | null): string {
  const head = `${BOT_MARKER} Event picks, ${headerDate(week.weekStart)} – ${headerDate(week.windowEnd)}`;
  const blocks = days.map((d) => {
    if (!d.free) return `${headerDate(d.date)}: ${busyLine(d.plans)}`;
    if (!d.picks.length) return `${headerDate(d.date)}: free, nothing stood out`;
    return [headerDate(d.date), ...d.picks.map(pickLine)].join('\n');
  });
  const text = [note ? `${head}\n${note}` : head, ...blocks].join('\n\n');
  if (!checkOutboundText(text).length) return text;
  const bare = days.map((d) => `${headerDate(d.date)}: ${d.free ? `${d.picks.length} pick${d.picks.length === 1 ? '' : 's'}` : 'busy'}`);
  return [head, ...bare, `All of them: ${PICKS_LINK}`].join('\n');
}
