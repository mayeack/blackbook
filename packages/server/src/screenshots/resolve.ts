/**
 * Who a contact screenshot shows (design §3 "Resolve", review amendments [shots]), decided deterministically from
 * the identifiers extract.ts found; no name matching, no LLM:
 *   1. phones, emails and Instagram handles (service keys — short codes, noreply mail, toll-free numbers — dropped)
 *      → their identities → canonical people (person_canon). A Gmail address also matches its dot/+tag variants.
 *   2. Identifiers that are the owner's (identity/self.ts selfRefs, or an identity on me) are set aside; when nothing
 *      else is left, or the screen is a one-person card / profile, the screenshot is 'self'.
 *   3. Exactly one person → 'linked' (a roster-only person is brought forward to provisional: the owner kept their
 *      contact on purpose). Several different people → 'ambiguous'. A service, suppressed or non-person record →
 *      'ambiguous' (nothing to link to).
 *   4. Nobody → a new provisional person through identity/external.ts attachExternalIdentity (source 'screenshot',
 *      carrying the name), but only for a contact_card / instagram_profile / social_profile showing ≤ 1 distinct
 *      phone, ≤ 1 email and ≤ 1 handle; the other identifiers join the new person as same-screen evidence.
 *      Anything else with identifiers is 'ambiguous'. An identifier whose identity was detached (an undone run, an
 *      unlink) is 'ambiguous' too: it is never re-attached to the person it was taken from.
 * Every write is journaled through the caller's ResolveContext (one 'import' run per gphotos pass). Nothing here
 * logs or returns names or identifiers.
 */
import { emailMatchKey } from '@yb/shared';
import { canonicalId } from '../db/canon';
import type { DB } from '../db/connection';
import { withBatch } from '../journal/batch';
import { attachExternalIdentity, personOfIdentity, type ExternalKind } from '../identity/external';
import type { ResolveContext } from '../identity/resolver';
import { selfRefs } from '../identity/self';
import { classifyIdentity, isTollFree } from '../identity/service';
import type { ExtractedContact, ShotKind } from './extract';

export type ScreenshotVia = 'phone' | 'email' | 'instagram_username';

export type ScreenshotResolution =
  | { status: 'linked'; personId: string; created: boolean; via: ScreenshotVia }
  | { status: 'ambiguous'; reason: 'several_people' | 'not_a_person' | 'not_a_card' | 'too_many_identifiers' | 'unlinked' }
  | { status: 'self' }
  | { status: 'no_contact' };

interface Ref {
  kind: ScreenshotVia;
  key: string;
}

/** Screens that show one person's own details: the only ones a new person may come from. */
const CARD_KINDS: ReadonlySet<ShotKind> = new Set(['contact_card', 'instagram_profile', 'social_profile']);

interface PersonRow {
  id: string;
  display_name: string;
  kind: string;
  status: string;
}

const personRow = (db: DB, id: string) =>
  db.prepare('SELECT id, display_name, kind, status FROM people WHERE id = ?').get(id) as PersonRow | undefined;

const identityStatus = (db: DB, id: string) => db.prepare('SELECT status FROM identities WHERE id = ?').pluck().get(id) as string | undefined;

function refsOf(ex: ExtractedContact): Ref[] {
  const out: Ref[] = [];
  for (const key of ex.phones) if (!isTollFree(key) && !classifyIdentity({ kind: 'phone', key })) out.push({ kind: 'phone', key });
  for (const key of ex.emails) if (!classifyIdentity({ kind: 'email', key })) out.push({ kind: 'email', key });
  for (const key of ex.handles) out.push({ kind: 'instagram_username', key });
  return out;
}

const GMAIL = /@(gmail|googlemail)\.com$/;

/** Canonical people holding this identifier (detached identities never count). */
function peopleFor(db: DB, r: Ref): string[] {
  let personIds: string[];
  if (r.kind === 'instagram_username') {
    // Like commands/screenshot.ts byHandle, but every match: a username identity, or an Instagram/Beeper identity
    // whose raw value is the @handle.
    personIds = db
      .prepare(
        `SELECT DISTINCT person_id FROM identities
         WHERE status <> 'detached' AND ((kind = 'instagram_username' AND key = @h)
            OR (kind IN ('instagram_username','instagram_id','instagram_name','beeper_user') AND lower(raw) IN (@h, '@' || @h)))`,
      )
      .pluck()
      .all({ h: r.key }) as string[];
  } else if (r.kind === 'email' && GMAIL.test(r.key)) {
    const want = emailMatchKey(r.key);
    const rows = db
      .prepare(
        `SELECT person_id, key FROM identities WHERE status <> 'detached' AND kind = 'email'
           AND substr(key, instr(key, '@') + 1) IN ('gmail.com', 'googlemail.com')`,
      )
      .all() as { person_id: string; key: string }[];
    personIds = rows.filter((x) => emailMatchKey(x.key) === want).map((x) => x.person_id);
  } else {
    personIds = db
      .prepare(`SELECT DISTINCT person_id FROM identities WHERE status <> 'detached' AND kind = ? AND key = ?`)
      .pluck()
      .all(r.kind, r.key) as string[];
  }
  return [...new Set(personIds.map((p) => canonicalId(db, p)))];
}

/** Out of the background: a roster-only person the owner screenshotted becomes provisional (journaled). */
function bringForward(ctx: ResolveContext, p: PersonRow): void {
  if (p.status !== 'roster_only') return;
  withBatch(
    ctx.db,
    {
      runId: ctx.runId(),
      kind: 'person_update',
      title: `Showing ${p.display_name} (you saved their contact in a screenshot)`,
      subjectPersonId: p.id,
      actor: ctx.actor ?? 'agent',
    },
    (t) => t.update('people', { id: p.id }, { status: 'provisional' }),
    { now: ctx.now },
  );
}

const linkable = (p: PersonRow | undefined): p is PersonRow => !!p && p.kind === 'person' && p.status !== 'service' && p.status !== 'suppressed';

/** Resolves one screenshot's identifiers to a person (journaled writes in ctx's run; joins the caller's transaction). */
export function resolveScreenshot(ctx: ResolveContext, ex: ExtractedContact, o: { at?: number | null } = {}): ScreenshotResolution {
  const db = ctx.db;
  const refs = refsOf(ex);
  if (!refs.length) return { status: 'no_contact' };
  const self = selfRefs(db);
  const others: Ref[] = [];
  const matched = new Map<string, ScreenshotVia>();
  let sawSelf = false;
  for (const r of refs) {
    if ((r.kind === 'phone' || r.kind === 'email') && self.isMine(r.kind, r.key)) {
      sawSelf = true;
      continue;
    }
    const people = peopleFor(db, r);
    const notMe = people.filter((id) => personRow(db, id)?.kind !== 'me');
    if (people.length && !notMe.length) {
      sawSelf = true;
      continue;
    }
    others.push(r);
    for (const id of notMe) if (!matched.has(id)) matched.set(id, r.kind);
  }
  // A one-person screen (card, profile) showing any identifier of the owner's is the owner's own.
  if (sawSelf && (CARD_KINDS.has(ex.kind) || !others.length)) return { status: 'self' };
  if (!others.length) return { status: 'no_contact' };
  if (matched.size > 1) return { status: 'ambiguous', reason: 'several_people' };
  if (matched.size === 1) {
    const [id, via] = [...matched][0]!;
    const p = personRow(db, id);
    if (!linkable(p)) return { status: 'ambiguous', reason: 'not_a_person' };
    bringForward(ctx, p);
    return { status: 'linked', personId: p.id, created: false, via };
  }
  // Nobody holds any of them: a new person, only from a one-person screen with one of each identifier at most.
  if (!CARD_KINDS.has(ex.kind)) return { status: 'ambiguous', reason: 'not_a_card' };
  const count = (k: ScreenshotVia) => others.filter((r) => r.kind === k).length;
  if (count('phone') > 1 || count('email') > 1 || count('instagram_username') > 1) return { status: 'ambiguous', reason: 'too_many_identifiers' };
  const order: ScreenshotVia[] = ex.kind === 'instagram_profile' ? ['instagram_username', 'phone', 'email'] : ['phone', 'email', 'instagram_username'];
  const sorted = [...others].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const first = sorted[0]!;
  const at = o.at ?? ctx.now;
  const input = (r: Ref) => ({
    kind: r.kind as ExternalKind,
    key: r.key,
    raw: r.kind === 'instagram_username' ? `@${r.key}` : r.key,
    displayName: ex.name,
    source: 'screenshot',
    at,
  });
  const identityId = attachExternalIdentity(ctx, { ...input(first), signals: { qualifies: true } });
  // attachExternalIdentity hands back a detached identity untouched: its person is the one it was taken from.
  if (identityId && identityStatus(db, identityId) === 'detached') return { status: 'ambiguous', reason: 'unlinked' };
  const owner = identityId ? personOfIdentity(db, identityId) : null;
  const p = owner ? personRow(db, canonicalId(db, owner)) : undefined;
  if (p?.kind === 'me') return { status: 'self' };
  if (!linkable(p)) return { status: 'ambiguous', reason: 'not_a_person' };
  for (const r of sorted.slice(1)) attachExternalIdentity(ctx, { ...input(r), personId: p.id });
  return { status: 'linked', personId: p.id, created: true, via: first.kind };
}
