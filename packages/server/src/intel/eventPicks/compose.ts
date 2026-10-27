/**
 * The weekly event-picks texts (design docs/design/event-picks.md §7). Like the brief, one text per pick, written
 * like a person would text, each starting with the bot marker:
 *
 *   🅨 Event picks for this week: 4 ideas for your free nights (Tue, Thu, Fri, Sat).
 *
 *   🅨 1. Thu Oct 29 · Sample Band
 *   Example Hall, 10pm. Indie rock, like the shows you go to.
 *   Tickets: yeackbot.com/go/k3v9x2p1q7
 *
 *   🅨 🎲 4. Something different: Sat Oct 31 · Orcas vs Herons
 *   …
 *   Get tickets to any of these and I'll notice. Not your thing? yeackbot.com/picks
 *
 * Texts may only carry yeackbot.com links (delivery/types.ts checkOutboundText), so the ticket link is
 * yeackbot.com/go/<pick id>: the app counts the tap and redirects to the checked ticket page (routes/eventPicks.ts).
 * Everything from the web (title, venue, why) passes safeFragment (no URLs, emails, phones, @handles, money, long
 * digit runs) and is truncated; a text that still fails checkOutboundText falls back to a bare "N. <day>: details
 * at yeackbot.com/go/<id>". Pure functions.
 */
import { checkOutboundText } from '../../delivery/types';
import { BOT_MARKER, clockWords, endSentence, headerDate, safeFragment, truncate } from '../../delivery/text';

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
  /** 'calendar' = a listing from his Recurring Events calendar (texted with that label). */
  source?: 'web' | 'newsletter' | 'calendar';
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const dayWord = (date: string): string => DOW[new Date(`${date}T12:00:00Z`).getUTCDay()]!;

export function introText(picks: readonly PickText[], freeNights: readonly string[], note?: string | null): string {
  const nights = freeNights.map(dayWord);
  const ideas = picks.length === 1 ? '1 idea' : `${picks.length} ideas`;
  const where = nights.length && nights.length <= 7 ? ` (${nights.join(', ')})` : '';
  return `${BOT_MARKER} Event picks for this week: ${ideas} for your free nights${where}.${note ? ` ${note}` : ''}`;
}

export function pickText(p: PickText, last: boolean): string {
  const title = safeFragment(p.title, 60) ?? 'An event';
  const venue = safeFragment(p.venue, 40);
  const why = safeFragment(p.why, 100);
  const label = p.wildcard ? 'Something different: ' : p.source === 'calendar' ? 'On your Recurring Events calendar: ' : '';
  const head = `${p.wildcard ? '🎲 ' : ''}${p.ordinal}. ${label}${headerDate(p.localDate)} · ${title}`;
  const where = [venue, p.startTime ? clockWords(p.startTime) : null].filter(Boolean).join(', ');
  const body = [where ? endSentence(where) : null, why ? endSentence(truncate(why, 100)) : null].filter(Boolean).join(' ');
  const lines = [`${BOT_MARKER} ${head}`];
  if (body) lines.push(body);
  lines.push(p.hasLink ? `Tickets: ${goLink(p.id)}` : `Details: ${goLink(p.id)}`);
  if (last) lines.push('', `Get tickets to any of these and I'll notice. Not your thing? ${PICKS_LINK}`);
  const text = lines.join('\n');
  if (!checkOutboundText(text).length) return text;
  const bare = `${BOT_MARKER} ${p.ordinal}. ${headerDate(p.localDate)}: details at ${goLink(p.id)}`;
  return last ? `${bare}\n\nNot your thing? ${PICKS_LINK}` : bare;
}

/** Every text of one week's picks, in send order (intro first; `note` ends the intro, e.g. why it isn't an email). */
export function picksTexts(picks: readonly PickText[], freeNights: readonly string[], note?: string | null): string[] {
  if (!picks.length) return [];
  return [introText(picks, freeNights, note), ...picks.map((p, i) => pickText(p, i === picks.length - 1))];
}
