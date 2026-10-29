/**
 * The weekly event-picks text (design docs/design/event-picks.md §7), used when the picks go out over iMessage
 * (events.channel 'text', or the email couldn't be sent). Like the brief since #84, ONE TEXT for the whole week
 * (owner, 2026-10-25: "always include everything you want me to see … in the text"), every pick with its details and
 * ticket link, a blank line between them, starting with the bot marker:
 *
 *   🅨 Event picks for this week: 4 ideas for your free nights (Tue, Thu, Fri, Sat).
 *
 *   1. Thu Oct 29 · Sample Band
 *   Example Hall, 10pm. Indie rock, like the shows you go to.
 *   Tickets: yeackbot.com/go/k3v9x2p1q7
 *
 *   🎲 4. Something different: Sat Oct 31 · Orcas vs Herons
 *   …
 *
 *   Get tickets to any of these and I'll notice. Not your thing? yeackbot.com/picks
 *
 * Texts may only carry yeackbot.com links (delivery/types.ts checkOutboundText), so the ticket link is
 * yeackbot.com/go/<pick id>: the app counts the tap and redirects to the checked ticket page (routes/eventPicks.ts).
 * Everything from the web (title, venue, why) passes safeFragment (no URLs, emails, phones, @handles, money, long
 * digit runs) and is truncated; a pick whose lines still fail checkOutboundText falls back to a bare "N. <day>:
 * details at yeackbot.com/go/<id>", and a text that fails as a whole to the count and the picks page. Pure functions.
 */
import { checkOutboundText } from '../../delivery/types';
import { BOT_MARKER, clockWords, endSentence, headerDate, safeFragment, truncate } from '../../delivery/text';

/** The page listing this week's picks (feedback buttons). */
export const PICKS_LINK = 'yeackbot.com/picks';
export const goLink = (id: string): string => `yeackbot.com/go/${id}`;
export const PICKS_CLOSING = `Get tickets to any of these and I'll notice. Not your thing? ${PICKS_LINK}`;

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
  /** 'calendar' = a listing from his Recurring Events calendar (texted with that label). */
  source?: 'web' | 'newsletter' | 'calendar';
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const dayWord = (date: string): string => DOW[new Date(`${date}T12:00:00Z`).getUTCDay()]!;

const ideas = (n: number): string => (n === 1 ? '1 idea' : `${n} ideas`);

/** The first line (no marker): how many picks, for which free nights; `note` says why it isn't an email. */
export function introLine(picks: readonly PickText[], freeNights: readonly string[], note?: string | null): string {
  const nights = freeNights.map(dayWord);
  const where = nights.length && nights.length <= 7 ? ` (${nights.join(', ')})` : '';
  return `Event picks for this week: ${ideas(picks.length)} for your free nights${where}.${note ? ` ${note}` : ''}`;
}

/** One pick's lines (no marker, no blank line): the numbered headline, where and when plus why, the ticket link. */
export function pickLines(p: PickText): string[] {
  const title = safeFragment(p.title, 60) ?? 'An event';
  const venue = safeFragment(p.venue, 40);
  const why = safeFragment(p.why, 100);
  const label = p.wildcard ? 'Something different: ' : p.source === 'calendar' ? 'On your Recurring Events calendar: ' : '';
  const head = `${p.wildcard ? '🎲 ' : ''}${p.ordinal}. ${label}${headerDate(p.localDate)} · ${title}`;
  const where = [venue, p.startTime ? clockWords(p.startTime) : null].filter(Boolean).join(', ');
  const body = [where ? endSentence(where) : null, why ? endSentence(truncate(why, 100)) : null].filter(Boolean).join(' ');
  const lines = [head, ...(body ? [body] : []), p.hasLink ? `Tickets: ${goLink(p.id)}` : `Details: ${goLink(p.id)}`];
  // Each pick is checked on its own, so one bad fragment from the web never costs the others their details.
  if (!checkOutboundText(`${BOT_MARKER} ${lines.join('\n')}`).length) return lines;
  return [`${p.ordinal}. ${headerDate(p.localDate)}: details at ${goLink(p.id)}`];
}

/** The whole week as one text (null when there are no picks). */
export function picksText(picks: readonly PickText[], freeNights: readonly string[], note?: string | null): string | null {
  if (!picks.length) return null;
  const blocks = picks.flatMap((p) => ['', ...pickLines(p)]);
  const text = `${BOT_MARKER} ${[introLine(picks, freeNights, note), ...blocks, '', PICKS_CLOSING].join('\n')}`;
  if (!checkOutboundText(text).length) return text;
  return `${BOT_MARKER} Event picks for this week: ${ideas(picks.length)}. They're all at ${PICKS_LINK}`;
}
