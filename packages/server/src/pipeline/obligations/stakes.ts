/**
 * How much a promise matters (owner feedback 2026-10-25: "Focus on important things. Bringing tomatoes isn't
 * important"):
 *   high    money, housing, work, legal or travel bookings, an introduction, something someone is counting on
 *   normal  everything else, most plans to meet up included
 *   low     small logistics around a plan: bring the tomatoes, wear the costume, arrive at 11, order food, an errand
 * The obligations extraction labels every new commitment (schema `stakes`); rows from before it have none and get
 * the conservative guess below. Low-stakes promises stay on the person page, in event briefs and in Ask, but never
 * take a digest slot or Today's preview (generators.ts, loops.ts).
 */
import type { CommitmentKind } from './commitments';

export const STAKES = ['low', 'normal', 'high'] as const;
export type Stakes = (typeof STAKES)[number];

const RANK: Record<Stakes, number> = { low: 0, normal: 1, high: 2 };
export const isStakes = (v: unknown): v is Stakes => typeof v === 'string' && (STAKES as readonly string[]).includes(v);
/** The more important of two labels (a repeat never demotes a promise once judged important). */
export const higherStakes = (a: Stakes, b: Stakes): Stakes => (RANK[a] >= RANK[b] ? a : b);

// A small task led by its verb: "bring tomatoes", "get a broom", "wear a parrot outfit", "arrive around 11:10".
const SMALL_TASK = /^(?:bring|carry|grab|buy|pick up some|save(?: up)?|wear|order|arrive|dress up|get (?:a|an|some)\b)/i;
const HIGH_STAKES =
  /\$\s?\d|\b(?:pay|paid|payment|rent|deposit|fee|invoice|reimburse|venmo|loan|owe[sd]?|lease|landlord|notice|reference|contract|visa|passport|job|interview|flight|hotel|book(?:ed|ing)?)\b/i;
const NEVER_SMALL: ReadonlySet<CommitmentKind> = new Set(['meet', 'call', 'intro', 'reply_later']);

/** The guess for a commitment the extraction never labeled: money/housing/bookings high, a small task low. */
export function guessStakes(what: string, kind: CommitmentKind): Stakes {
  const w = what.trim();
  if (HIGH_STAKES.test(w)) return 'high';
  if (!NEVER_SMALL.has(kind) && SMALL_TASK.test(w)) return 'low';
  return 'normal';
}

/** A commitment row's stakes: its label, else the guess. */
export const stakesOf = (c: { stakes?: string | null; what: string; kind: CommitmentKind }): Stakes => (isStakes(c.stakes) ? c.stakes : guessStakes(c.what, c.kind));
