/**
 * "This person" in a command's screenshot (intent ref IMG). The model only reads the profile's username and display
 * name; who that is gets decided here, deterministically:
 *   1. a username → the identity keyed by it (instagram_username), or any Instagram/Beeper identity whose raw value
 *      is that @handle → its person (canonical); a suppressed person (an undone earlier add) is revived;
 *   2. no username → a unique visible person whose first + last name equal the display name;
 *   3. a username nobody has → a new person with that instagram_username identity, through identity/external.ts (one
 *      journaled create_person batch in the command's run, so `undo` suppresses it). The matcher can merge it with a
 *      contact later like any other new identity.
 * Whoever it resolves to is someone the owner asked about by name, so a person in the background (roster-only:
 * closeness 1, never shown) is brought forward as provisional — shown and suggestable — in the same run.
 * Nothing here logs names or handles.
 */
import { normalizeNamePart } from '@yb/shared';
import { canonicalId } from '../db/canon';
import { withBatch } from '../journal/batch';
import { attachExternalIdentity, personOfIdentity } from '../identity/external';
import type { ResolveContext } from '../identity/resolver';
import type { ImageProfile } from './intent';
import type { PersonLite } from './people';

export type ScreenshotPerson =
  | { ok: true; personId: string; created: boolean }
  | { ok: false; reason: 'unreadable' | 'ambiguous' | 'service' };

interface PersonRow {
  id: string;
  display_name: string;
  kind: string;
  status: string;
}

const personRow = (ctx: ResolveContext, id: string) =>
  ctx.db.prepare('SELECT id, display_name, kind, status FROM people WHERE id = ?').get(id) as PersonRow | undefined;

/** You asked about them by text: out of the background (closeness ≥ 2), journaled in the command's run. */
function bringForward(ctx: ResolveContext, p: PersonRow): void {
  if (p.status !== 'roster_only') return;
  withBatch(
    ctx.db,
    { runId: ctx.runId(), kind: 'person_update', title: `Showing ${p.display_name} (you asked about them by text)`, subjectPersonId: p.id, actor: ctx.actor ?? 'user' },
    (t) => t.update('people', { id: p.id }, { status: 'provisional' }),
    { now: ctx.now },
  );
}

const nameKey = (s: string): string =>
  s
    .split(/\s+/)
    .map((w) => normalizeNamePart(w.replace(/[^\p{L}\p{N}'’-]+/gu, '')))
    .filter(Boolean)
    .join(' ');

function byHandle(ctx: ResolveContext, handle: string): string | null {
  const identityId = ctx.db
    .prepare(
      `SELECT id FROM identities
       WHERE status <> 'detached' AND ((kind = 'instagram_username' AND key = @h)
          OR (kind IN ('instagram_username','instagram_id','instagram_name','beeper_user') AND lower(raw) IN (@h, '@' || @h)))
       ORDER BY kind = 'instagram_username' DESC, status = 'active' DESC LIMIT 1`,
    )
    .pluck()
    .get({ h: handle }) as string | undefined;
  const person = identityId ? personOfIdentity(ctx.db, identityId) : null;
  return person ? canonicalId(ctx.db, person) : null;
}

function byName(name: string, people: readonly PersonLite[]): PersonLite[] | null {
  const key = nameKey(name);
  if (!key.includes(' ')) return null; // a first name alone is never enough
  return people.filter((p) => p.first && p.last && nameKey(`${p.first} ${p.last}`) === key);
}

export function resolveScreenshotPerson(ctx: ResolveContext, profile: ImageProfile, people: readonly PersonLite[]): ScreenshotPerson {
  if (profile.handle) {
    const found = byHandle(ctx, profile.handle);
    if (found) {
      const p = personRow(ctx, found);
      if (!p) return { ok: false, reason: 'unreadable' };
      if (p.status === 'service' || (p.kind !== 'person' && p.kind !== 'me')) return { ok: false, reason: 'service' };
      if (p.status === 'suppressed') {
        withBatch(
          ctx.db,
          { runId: ctx.runId(), kind: 'person_update', title: `Brought back ${p.display_name} (screenshot)`, subjectPersonId: p.id, actor: ctx.actor ?? 'user' },
          (t) => t.update('people', { id: p.id }, { status: 'provisional' }),
          { now: ctx.now },
        );
      } else bringForward(ctx, p);
      return { ok: true, personId: p.id, created: false };
    }
    const identityId = attachExternalIdentity(ctx, {
      kind: 'instagram_username',
      key: profile.handle,
      raw: `@${profile.handle}`,
      displayName: profile.name,
      nameSource: 'beeper',
      source: 'screenshot',
    });
    const personId = identityId ? personOfIdentity(ctx.db, identityId) : null;
    const p = personId ? personRow(ctx, canonicalId(ctx.db, personId)) : undefined;
    if (!p) return { ok: false, reason: 'unreadable' };
    if (p.status === 'service') return { ok: false, reason: 'service' };
    bringForward(ctx, p);
    return { ok: true, personId: p.id, created: true };
  }
  const named = profile.name ? byName(profile.name, people) : null;
  if (!named?.length) return { ok: false, reason: 'unreadable' };
  if (named.length > 1) return { ok: false, reason: 'ambiguous' };
  const p = named[0]!;
  return { ok: true, personId: p.id, created: false };
}
