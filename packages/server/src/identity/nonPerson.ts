/**
 * People records that name a venue, brand, promoter or party series rather than a person: Partiful hosts like a
 * gallery or a wine brand, Instagram brand accounts. They stay kind 'person' (nothing here writes), so the people
 * list still has them; the network map leaves them out, because a venue that hosted twenty parties is the center
 * of every guest list and turns the map into one blob.
 *
 * Name rules, never structure: "hosted parties and never came as a guest" also catches friends who throw parties.
 *   any record     a venue/business word ("Gallery", "Hotel", "LLC", "Presents", "Club"), as a whole word
 *   only known through Partiful or Instagram (nothing from Contacts, Messages or WhatsApp; the owner saved those)
 *                  a weaker word ("Beach", "Music", "Squad", "Wine"), or no letters or digits at all (an emoji-only
 *                  handle)
 * Handle-style names ("j4ke", "@sam__k") and first names that are also words ("Bar", "Honey") are people. A
 * phone-number name (digits, no letters) is someone the owner texts and always stays.
 */
import type { DB } from '../db/connection';

const STRONG = new Set([
  'agency', 'bistro', 'brewery', 'brewing', 'cafe', 'cantina', 'club', 'collective', 'corp', 'distillery', 'entertainment', 'events',
  'festival', 'foundation', 'galerie', 'gallery', 'galleria', 'gmbh', 'hostel', 'hotel', 'inc', 'llc', 'lounge', 'ltd', 'magazine',
  'mezcal', 'motel', 'nightclub', 'podcast', 'presents', 'productions', 'radio', 'records', 'resort', 'restaurant', 'rooftop', 'studios',
  'taqueria', 'tequila', 'venue', 'vineyard', 'vineyards', 'winery',
]);

const WEAK = new Set([
  'afters', 'bakery', 'beach', 'boutique', 'coffee', 'collection', 'community', 'company', 'crew', 'experience', 'fest', 'fitness',
  'gang', 'group', 'gym', 'house', 'kitchen', 'label', 'market', 'media', 'music', 'nights', 'official', 'parties', 'party', 'salon',
  'series', 'shop', 'social', 'society', 'sound', 'sounds', 'spot', 'squad', 'store', 'studio', 'team', 'tour', 'wine', 'wines', 'yoga',
]);

const words = (name: string): string[] =>
  name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);

/** `curated`: the record has an identity from a source the owner keeps himself (Contacts, Messages, WhatsApp). */
export function looksLikeOrganization(name: string, curated: boolean): boolean {
  const ws = words(name);
  if (ws.some((w) => STRONG.has(w))) return true;
  if (curated) return false;
  if (!ws.length) return !/\p{Nd}/u.test(name);
  return ws.some((w) => WEAK.has(w));
}

/** Visible people whose name looks like an organization (see above). */
export function organizationPeople(db: DB): Set<string> {
  const rows = db
    .prepare(
      `SELECT pv.id, pv.display_name,
              coalesce(max(i.source NOT IN ('partiful','instagram')), 1) AS curated
       FROM person_visible pv
       LEFT JOIN person_canon q ON q.canonical_id = pv.id
       LEFT JOIN identities i ON i.person_id = q.person_id AND i.status IN ('active','superseded')
       GROUP BY pv.id`,
    )
    .all() as { id: string; display_name: string; curated: number }[];
  return new Set(rows.filter((r) => looksLikeOrganization(r.display_name, r.curated === 1)).map((r) => r.id));
}
