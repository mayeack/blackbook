/**
 * Records of the owner (identity/self.ts: me, merged into me, or still holding one of my handles) are never someone
 * else to the tie stats, suggestion generators, circles or intel. Invented names, 555-01xx numbers, example.com
 * addresses and Gmail addresses built at runtime only.
 */
import { describe, expect, it } from 'vitest';
import type { DB } from '../../src/db/connection';
import { mergePeople } from '../../src/identity/merge';
import { knownAttendees } from '../../src/intel/common';
import { introPeople } from '../../src/intel/intros';
import { invitePicks } from '../../src/intel/invites';
import { locationFacts } from '../../src/intel/trips';
import { circleActivity } from '../../src/pipeline/circles/generators';
import { memoryCandidates } from '../../src/pipeline/suggestions/gen/memory';
import { generators as defaultGenerators } from '../../src/pipeline/suggestions/generators';
import { runSuggestionsStage } from '../../src/pipeline/suggestions/stage';
import type { Candidate } from '../../src/pipeline/suggestions/types';
import { runTies } from '../../src/pipeline/ties/run';
import { newRun, seedIdentity, seedPerson } from '../helpers';
import { at, intelWorld, NOW as INTEL_NOW, occasion as intelOccasion } from '../intel/world';
import { DAY, NOW, socialWorld } from './socialWorld';
import { circle, fadingFriend, fixedGenerator, friend, occasion, setSetting, stats, suggestionsDb, T0 } from './suggestions/world';

const GMAIL = ['gmail', 'com'].join('.');

/** My Gmail address on me, and an alias of it (a +tag) on `personId`: that record is still mine. */
function strayOfMine(db: DB, me: string, personId: string): void {
  if (!db.prepare(`SELECT 1 FROM identities WHERE kind = 'email' AND key = ?`).get(`owner.example@${GMAIL}`)) {
    seedIdentity(db, me, 'email', `owner.example@${GMAIL}`, { match_method: 'seed' });
  }
  seedIdentity(db, personId, 'email', `owner.example+old${personId.slice(-4)}@${GMAIL}`);
}

const foldIntoMe = (db: DB, me: string, personId: string) =>
  mergePeople(db, { survivorId: me, mergedId: personId, method: 'user', runId: newRun(db, 'user'), actor: 'user', now: T0 });

describe('tie stats', () => {
  it('none for me, a record merged into me or a record holding my handle; an earlier row is removed', () => {
    const w = socialWorld();
    const stat = (id: string) => w.db.prepare('SELECT state FROM person_stats WHERE person_id = ?').get(id);
    const ava = w.person('Ava', 'Quill');
    const stray = w.person('Owner', 'Example');
    const old = w.person('Owner', 'Oldcard');
    for (const p of [ava, stray, old]) for (let i = 0; i < 20; i++) w.dmTouch(p, NOW - (40 + i) * DAY);
    runTies(w.db, { now: NOW, timeZone: 'UTC' });
    expect(stat(stray)).toBeDefined(); // not known to be mine yet

    strayOfMine(w.db, w.me, stray);
    foldIntoMe(w.db, w.me, old);
    const s = runTies(w.db, { now: NOW, timeZone: 'UTC' });
    expect(stat(ava)).toBeDefined();
    expect(stat(stray)).toBeUndefined();
    expect(stat(old)).toBeUndefined();
    expect(stat(w.me)).toBeUndefined();
    expect(s.people).toBe(1);
    expect(s.statsDeleted).toBe(2);
  });
});

describe('suggestions stage', () => {
  it('never suggests a record of mine, and strips me from a multi-person item', async () => {
    const db = suggestionsDb();
    setSetting(db, 'learner.enabled', false);
    const me = seedPerson(db, { kind: 'me', display_name: 'Me', first_name: null, last_name: null, origin: 'system' });
    const bram = fadingFriend(db, 'Bram', 'Ostrow');
    const stray = fadingFriend(db, 'Owner', 'Example');
    strayOfMine(db, me, stray.id);
    const old = fadingFriend(db, 'Owner', 'Oldcard');
    foldIntoMe(db, me, old.id);
    const memory = (subjectKey: string, personIds: string[]): Candidate => ({
      kind: 'memory',
      personIds,
      subjectKey,
      base: 0.9,
      evidenceIds: [],
      expiresAt: null,
      payload: {},
    });
    const memories = fixedGenerator('memory', () => [memory('occ:with-me-second', [bram.id, stray.id]), memory('occ:about-me', [stray.id, bram.id])]);
    const r = await runSuggestionsStage(db, {
      now: T0,
      seed: 7,
      generators: [...defaultGenerators.filter((g) => g.kind !== 'memory'), memories],
      wildcardSources: [],
    });
    expect(r.status).toBe('ok');
    const rows = db.prepare('SELECT kind, person_id, person_ids, subject_key FROM suggestions').all() as {
      kind: string;
      person_id: string | null;
      person_ids: string;
      subject_key: string;
    }[];
    expect(rows.filter((x) => x.kind === 'fading').map((x) => x.person_id)).toEqual([bram.id]);
    const mine = new Set([me, stray.id, old.id]);
    expect(rows.some((x) => (JSON.parse(x.person_ids) as string[]).some((id) => mine.has(id)))).toBe(false);
    expect(rows.find((x) => x.subject_key === 'occ:with-me-second')?.person_ids).toBe(JSON.stringify([bram.id]));
    expect(rows.find((x) => x.subject_key === 'occ:about-me')).toBeUndefined();
  });

  it('memories and circle activity leave records of mine out', () => {
    const db = suggestionsDb();
    const me = seedPerson(db, { kind: 'me', display_name: 'Me', first_name: null, last_name: null, origin: 'system' });
    const ava = friend(db, 'Ava', 'Quill');
    const bo = friend(db, 'Bo', 'Rook');
    const stray = friend(db, 'Owner', 'Example');
    strayOfMine(db, me, stray.id);
    for (const [p, tie] of [[ava.id, 50], [bo.id, 40], [stray.id, 90]] as const) stats(db, p, { tie, historical: 60, lastAt: T0 - 50 * DAY, expectedGapD: 7 });

    occasion(db, T0 - 365 * DAY, [stray.id, ava.id]);
    expect(memoryCandidates(db, T0, 'UTC').map((c) => c.personIds)).toEqual([[ava.id]]);

    const c = circle(db, 'Climbing crew', [ava.id, bo.id, stray.id]);
    const activity = circleActivity(db).find((a) => a.circleId === c)!;
    expect(activity.memberCount).toBe(2);
    expect(activity.topMemberIds).toEqual([ava.id, bo.id]);
  });
});

describe('intel', () => {
  it('attendees, intro candidates and location facts skip records of mine', () => {
    const w = intelWorld();
    const ava = w.person('Ava', 'Quill', { tie: 80, historical: 80 });
    const stray = w.person('Owner', 'Example', { tie: 90, historical: 90 });
    strayOfMine(w.db, w.me, stray);
    const picnic = intelOccasion(w.db, { title: 'Rooftop picnic', start: at(0) });
    w.attendee(picnic, ava);
    w.attendee(picnic, stray);
    expect(knownAttendees(w.db, { type: 'occasion', id: picnic }).map((a) => a.personId)).toEqual([ava]);
    expect(introPeople(w.db, INTEL_NOW).map((p) => p.id)).toEqual([ava]);
    w.fact(ava, 'home_location', 'Austin, TX', { source: 'legacy' });
    w.fact(stray, 'home_location', 'Austin, TX', { source: 'legacy' });
    expect(locationFacts(w.db).map((f) => f.personId)).toEqual([ava]);
  });

  it('party invites never pick a record of mine, even one in the Party invites circle', () => {
    const w = intelWorld();
    const ava = w.person('Ava', 'Quill', { tie: 80, historical: 80 });
    const stray = w.person('Owner', 'Example', { tie: 95, historical: 95 });
    strayOfMine(w.db, w.me, stray);
    const party = intelOccasion(w.db, { title: 'Game night', start: at(5) });
    const picks = invitePicks(w.db, { type: 'occasion', id: party, eventId: null }, { preferred: new Set([stray, ava]), records: new Map(), now: INTEL_NOW });
    expect(picks.map((p) => p.personId)).toEqual([ava]);
  });
});
