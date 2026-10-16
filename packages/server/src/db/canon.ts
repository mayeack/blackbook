import type { DB } from './connection';
import { tx } from './tx';

export class CanonCycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`merged_into_id cycle among ${cycle.length} people`);
    this.name = 'CanonCycleError';
  }
}

/** Resolves every person to the root of its merged_into_id chain; throws CanonCycleError on a cycle. */
export function computeCanon(pointers: Map<string, string | null>): Map<string, string> {
  const canon = new Map<string, string>();
  for (const start of pointers.keys()) {
    if (canon.has(start)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur = start;
    let root: string | undefined;
    for (;;) {
      const known = canon.get(cur);
      if (known) {
        root = known;
        break;
      }
      if (onPath.has(cur)) throw new CanonCycleError(path.slice(path.indexOf(cur)));
      path.push(cur);
      onPath.add(cur);
      const next = pointers.get(cur);
      // A dangling pointer (FKs make this unreachable) stops at the last existing person.
      if (!next || !pointers.has(next)) {
        root = cur;
        break;
      }
      cur = next;
    }
    for (const id of path) canon.set(id, root);
  }
  return canon;
}

/**
 * Rebuilds person_canon (derived) from people.merged_into_id. A few thousand rows: cheap enough to rebuild in
 * full after every merge or unmerge. Leaves the table untouched if a cycle exists.
 */
export function rebuildPersonCanon(db: DB): { people: number; merged: number } {
  const rows = db.prepare('SELECT id, merged_into_id FROM people').all() as { id: string; merged_into_id: string | null }[];
  const canon = computeCanon(new Map(rows.map((r) => [r.id, r.merged_into_id])));
  tx(db, () => {
    db.prepare('DELETE FROM person_canon').run();
    const ins = db.prepare('INSERT INTO person_canon (person_id, canonical_id) VALUES (?, ?)');
    for (const [id, root] of canon) ins.run(id, root);
  });
  let merged = 0;
  for (const [id, root] of canon) if (id !== root) merged++;
  return { people: canon.size, merged };
}

/** Canonical id for one person, following pointers directly (doesn't depend on person_canon being fresh). */
export function canonicalId(db: DB, personId: string): string {
  const get = db.prepare('SELECT merged_into_id FROM people WHERE id = ?');
  const seen = new Set<string>();
  let cur = personId;
  for (;;) {
    if (seen.has(cur)) throw new CanonCycleError([...seen]);
    seen.add(cur);
    const row = get.get(cur) as { merged_into_id: string | null } | undefined;
    if (!row) throw new Error(`unknown person ${personId}`);
    if (!row.merged_into_id) return cur;
    cur = row.merged_into_id;
  }
}

/** Every permanent person id whose chain ends at `canonical` (including itself). */
export function canonicalMembers(db: DB, canonical: string): string[] {
  const out = [canonical];
  const children = db.prepare('SELECT id FROM people WHERE merged_into_id = ?').pluck();
  for (let i = 0; i < out.length; i++) out.push(...(children.all(out[i]) as string[]));
  return out;
}
