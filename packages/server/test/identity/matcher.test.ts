/**
 * Probabilistic matcher on synthetic people graphs (intelligence §1.5–1.6). Invented names, 555-01xx numbers and
 * example.com addresses only.
 */
import { describe, expect, it } from 'vitest';
import { episodeWriter } from '../../src/adapters/common/episodes';
import { canonicalId, rebuildPersonCanon } from '../../src/db/canon';
import { decide, describeEvidence, MAX_MERGES_PER_NIGHT, runMatcher } from '../../src/identity/matcher';
import { matcherJobs } from '../../src/identity/matcherJobs';
import { handleContainsName, namesCompatible, parseName, personName } from '../../src/identity/matcherNames';
import { loadBook } from '../../src/identity/matcherProfiles';
import { blockPairs, priorBits, probability, scorePair } from '../../src/identity/matcherScore';
import { undoBatch } from '../../src/journal/undo';
import { memDb, seedIdentity, seedPerson, T0 } from '../helpers';

type DB = ReturnType<typeof memDb>;
const DAY = 86_400_000;
const count = (db: DB, table: string, where = '1') => db.prepare(`SELECT count(*) FROM ${table} WHERE ${where}`).pluck().get() as number;
const phone = (n: number) => `+1212555${String(100 + n).padStart(4, '0')}`;
const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x]) as [string, string];
interface CandidateRow {
  status: string;
  p: number;
  score_bits: number;
  families: string[];
  guards_failed: string[];
  features: { bits: Record<string, number>; counts: Record<string, number> };
}
const candidate = (db: DB, x: string, y: string): CandidateRow | undefined => {
  const [a, b] = pair(x, y);
  const row = db.prepare('SELECT * FROM match_candidates WHERE a_id = ? AND b_id = ?').get(a, b) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    status: String(row.status),
    p: Number(row.p),
    score_bits: Number(row.score_bits),
    families: JSON.parse(String(row.families)) as string[],
    guards_failed: JSON.parse(String(row.guards_failed)) as string[],
    features: JSON.parse(String(row.features)) as CandidateRow['features'],
  };
};

/** An established contact (legacy-style, active) with a phone. */
function contact(db: DB, first: string, last: string, o: { phone?: string; extra?: Record<string, unknown> } = {}) {
  const id = seedPerson(db, { display_name: `${first} ${last}`, first_name: first, last_name: last, origin: 'legacy', ...o.extra });
  const ph = o.phone ? seedIdentity(db, id, 'phone', o.phone, { source: 'imessage' }) : null;
  return { id, phone: ph };
}

/** A provisional Instagram person as Beeper creates it: display name from fullName, no name fields. */
function igPerson(db: DB, display: string, username: string, extra: Record<string, unknown> = {}) {
  const id = seedPerson(db, { display_name: display, first_name: null, last_name: null, status: 'provisional', origin: 'beeper', ...extra });
  const ig = seedIdentity(db, id, 'instagram_username', username, { source: 'beeper' });
  return { id, ig };
}

let convN = 0;
/** A group conversation with these member identities (all active). */
function group(db: DB, identityIds: string[], o: { active?: boolean } = {}) {
  const w = episodeWriter(db, { now: T0 });
  const conv = w.upsertConversation({ source: 'whatsapp', sourceConvId: `g${++convN}`, kind: 'group' }).id;
  for (const i of identityIds) w.upsertMember(conv, i, { source: 'roster', at: T0, isActive: o.active ?? true });
  return conv;
}

/** "Jake"-style pair: a contact and an IG person whose handle contains the name, in 2 shared groups. */
function strongPair(db: DB, first: string, last: string, n: number, o: { contactExtra?: Record<string, unknown>; igExtra?: Record<string, unknown> } = {}) {
  const a = contact(db, first, last, { phone: phone(n), extra: o.contactExtra });
  const b = igPerson(db, `${first} ${last}`, `${first}${last}${n}`.toLowerCase(), o.igExtra);
  group(db, [a.phone!, b.ig]);
  group(db, [a.phone!, b.ig]);
  return { a, b };
}

describe('names', () => {
  it('parses, compares and finds names inside handles', () => {
    expect(parseName('Jake Miller (climbing)')).toEqual({ first: 'jake', last: 'miller' });
    expect(parseName('Zoë')).toEqual({ first: 'zoe', last: '' });
    expect(personName({ display_name: '(212) •••-••34', first_name: null, last_name: null })).toBeNull();
    expect(personName({ display_name: '@quiet.one', first_name: null, last_name: null })).toBeNull();
    expect(namesCompatible({ first: 'mike', last: 'stone' }, { first: 'michael', last: 'stone' })).toBe(true);
    expect(namesCompatible({ first: 'ava', last: 'stone' }, { first: 'leo', last: 'marsh' })).toBe(false);
    expect(namesCompatible({ first: 'ava', last: 's' }, { first: 'ava', last: 'stone' })).toBe(true);
    expect(handleContainsName('jakemiller92', { first: 'jake', last: 'miller' })).toBe(true);
    expect(handleContainsName('jakem.climbs', { first: 'jake', last: 'miller' })).toBe(true);
    expect(handleContainsName('jmiller', { first: 'jake', last: 'miller' })).toBe(false);
  });

  it('decide(): name-only never merges (G1), guards block, low scores separate', () => {
    expect(decide({ p: 0.995, pRaw: 0.995, families: ['name'] }, [])).toEqual({ decision: 'possible_duplicate', guards: ['G1'] });
    expect(decide({ p: 0.995, pRaw: 0.995, families: ['name', 'handle'] }, [])).toEqual({ decision: 'merge', guards: [] });
    expect(decide({ p: 0.995, pRaw: 0.995, families: ['handle', 'graph'] }, [])).toMatchObject({ decision: 'merge' });
    expect(decide({ p: 0.9, pRaw: 0.9, families: ['name', 'graph'] }, [])).toEqual({ decision: 'possible_duplicate', guards: [] });
    expect(decide({ p: 0.995, pRaw: 0.995, families: ['name', 'graph'] }, ['G4'])).toEqual({ decision: 'blocked', guards: ['G4'] });
    expect(decide({ p: 1e-6, pRaw: 0.99, families: ['name', 'graph'] }, ['G2'])).toEqual({ decision: 'blocked', guards: ['G2'] });
    expect(decide({ p: 0.5, pRaw: 0.5, families: ['name'] }, [])).toMatchObject({ decision: 'separate' });
    expect(priorBits(2)).toBe(-10);
    expect(priorBits(100_000)).toBeLessThan(-10);
  });
});

describe('scoring', () => {
  it('two John Smiths with nothing else: ≈1.6 bits, p≈0.75, name family only → never merged', () => {
    const db = memDb();
    const a = contact(db, 'John', 'Smith', { phone: phone(1) });
    const b = seedPerson(db, { display_name: 'John Smith', first_name: null, last_name: null, status: 'provisional', origin: 'imessage' });
    seedIdentity(db, b, 'email', 'jsmith.blue@example.com');
    const book = loadBook(db);
    const s = scorePair(book, book.profiles.get(a.id)!, book.profiles.get(b)!, priorBits(book.profiles.size));
    expect(s.scoreBits).toBeCloseTo(1.55, 1);
    expect(s.p).toBeGreaterThan(0.7);
    expect(s.p).toBeLessThan(0.8);
    expect(s.families).toEqual(['name']);

    const stats = runMatcher(db, { now: T0 });
    expect(stats.merged).toBe(0);
    expect(count(db, 'merges')).toBe(0);
    expect(candidate(db, a.id, b)).toMatchObject({ status: 'possible_duplicate', families: ['name'] });
    // Every night re-scores it; still never merged.
    runMatcher(db, { now: T0 + DAY });
    expect(count(db, 'merges')).toBe(0);
    expect(candidate(db, a.id, b)?.status).toBe('possible_duplicate');
  });

  it('a name recurring in the book is weaker evidence', () => {
    const db = memDb();
    const a = contact(db, 'Ari', 'Vantor');
    const b = igPerson(db, 'Ari Vantor', 'arivantor');
    const base = loadBook(db);
    const before = scorePair(base, base.profiles.get(a.id)!, base.profiles.get(b.id)!, -10).bits.first!;
    for (let i = 0; i < 20; i++) contact(db, 'Ari', `Other${'abcdefghijklmnopqrstu'[i]}son`);
    const book = loadBook(db);
    const after = scorePair(book, book.profiles.get(a.id)!, book.profiles.get(b.id)!, -10).bits.first!;
    expect(after).toBeLessThan(before);
  });

  it('blocking finds handle, shared-group and name pairs, but not unrelated people', () => {
    const db = memDb();
    const { a, b } = strongPair(db, 'Jake', 'Miller', 1);
    const c = contact(db, 'Nell', 'Orchard', { phone: phone(2) });
    const pairs = blockPairs(loadBook(db)).map(([x, y]) => `${x}|${y}`);
    expect(pairs).toContain(pair(a.id, b.id).join('|'));
    expect(pairs.some((p) => p.includes(c.id))).toBe(false);
  });
});

describe('runMatcher', () => {
  it('handle + shared groups merge (probabilistic, journaled, evidence without handles)', () => {
    const db = memDb();
    const { a, b } = strongPair(db, 'Jake', 'Miller', 1);
    const stats = runMatcher(db, { now: T0 });
    expect(stats.merged).toBe(1);
    expect(canonicalId(db, b.id)).toBe(a.id);
    const m = db.prepare('SELECT survivor_id, merged_id, method, score, evidence, batch_id FROM merges').get() as Record<string, unknown>;
    expect(m).toMatchObject({ survivor_id: a.id, merged_id: b.id, method: 'probabilistic' });
    expect(Number(m.score)).toBeGreaterThan(0.98);
    const evidence = JSON.parse(String(m.evidence)) as { families: string[]; counts: { shared_groups: number } };
    expect(evidence.families).toEqual(['name', 'handle', 'graph']);
    expect(evidence.counts.shared_groups).toBe(2);
    expect(String(m.evidence)).not.toContain('jakemiller');
    const batch = db.prepare('SELECT kind, title, actor FROM change_batches WHERE id = ?').get(m.batch_id) as Record<string, string>;
    expect(batch).toMatchObject({ kind: 'merge', actor: 'agent' });
    expect(batch.title).toMatch(/^Merged Jake Miller into Jake Miller \(1\.00: name \+ IG handle \+ 2 shared groups\)$/);
    expect(candidate(db, a.id, b.id)).toMatchObject({ status: 'merged' });
    expect(db.prepare(`SELECT kind, status FROM runs`).get()).toEqual({ kind: 'nightly', status: 'ok' });
    // Idempotent: the next night finds nothing to do.
    expect(runMatcher(db, { now: T0 + DAY }).merged).toBe(0);
    expect(count(db, 'merges')).toBe(1);
  });

  it('co-presence is a hard veto (G2): two IG usernames active in one thread', () => {
    const db = memDb();
    const { a, b } = strongPair(db, 'Jake', 'Miller', 1);
    const aIg = seedIdentity(db, a.id, 'instagram_username', 'jake.alt.account');
    group(db, [aIg, b.ig]);
    const stats = runMatcher(db, { now: T0 });
    expect(stats.merged).toBe(0);
    const c = candidate(db, a.id, b.id)!;
    expect(c).toMatchObject({ status: 'blocked', guards_failed: ['G2'] });
    expect(c.features.bits.co_presence).toBe(-20);
    expect(Number(c.p)).toBeLessThan(0.01);
  });

  it('a member who left the thread is not co-present', () => {
    const db = memDb();
    const { a, b } = strongPair(db, 'Jake', 'Miller', 1);
    const aIg = seedIdentity(db, a.id, 'instagram_username', 'jake.alt.account');
    const conv = group(db, [b.ig]);
    episodeWriter(db, { now: T0 }).upsertMember(conv, aIg, { source: 'roster', at: T0, isActive: false });
    expect(runMatcher(db, { now: T0 }).merged).toBe(1);
  });

  it('G3: do_not_merge is respected transitively (through earlier merges and within one night)', () => {
    const db = memDb();
    // X–Y were split by the user; Y has since been merged into Z. X vs Z must stay apart.
    const { a: x, b: z } = strongPair(db, 'Wren', 'Halloway', 1);
    const y = seedPerson(db, { display_name: 'Wren H', first_name: 'Wren', last_name: 'H', status: 'merged', merged_into_id: z.id });
    rebuildPersonCanon(db);
    const [lo, hi] = pair(x.id, y);
    db.prepare(`INSERT INTO do_not_merge (a_id, b_id, reason, source, created_at) VALUES (?, ?, 'test', 'user', ?)`).run(lo, hi, T0);
    expect(runMatcher(db, { now: T0 }).merged).toBe(0);
    expect(candidate(db, x.id, z.id)).toMatchObject({ status: 'blocked', guards_failed: ['G3'] });

    // Within one night: A~B and B~C are both strong, DNM(A, C). The better pair merges; the other is blocked.
    const db2 = memDb();
    const A = contact(db2, 'Tamsin', 'Quarrel', { phone: phone(10) });
    const B = igPerson(db2, 'Tamsin Quarrel', 'tamsinquarrel');
    const C = igPerson(db2, 'Tamsin Quarrel', 'tamsin.quarrel.art');
    const cPhone = seedIdentity(db2, C.id, 'email', 'tq.art@example.com');
    for (let i = 0; i < 3; i++) group(db2, [A.phone!, B.ig]);
    group(db2, [B.ig, cPhone]);
    group(db2, [B.ig, cPhone]);
    const [p, q] = pair(A.id, C.id);
    db2.prepare(`INSERT INTO do_not_merge (a_id, b_id, reason, source, created_at) VALUES (?, ?, 'test', 'undo', ?)`).run(p, q, T0);
    runMatcher(db2, { now: T0 });
    expect(canonicalId(db2, B.id)).toBe(A.id);
    expect(canonicalId(db2, C.id)).toBe(C.id);
    expect(count(db2, 'merges')).toBe(1);
    expect(candidate(db2, B.id, C.id)).toMatchObject({ status: 'blocked' });
    expect(candidate(db2, B.id, C.id)!.guards_failed).toContain('G3');
  });

  it('G4: two different Contacts cards are never merged probabilistically', () => {
    const db = memDb();
    const { a, b } = strongPair(db, 'Juno', 'Ashcombe', 1);
    seedIdentity(db, a.id, 'addressbook_id', 'card-a');
    seedIdentity(db, b.id, 'addressbook_id', 'card-b');
    expect(runMatcher(db, { now: T0 }).merged).toBe(0);
    expect(candidate(db, a.id, b.id)).toMatchObject({ status: 'blocked', guards_failed: ['G4'] });
  });

  it('G5: cluster sanity (identity counts and names across the merged cluster)', () => {
    const db = memDb();
    const { a, b } = strongPair(db, 'Orrin', 'Vale', 1);
    for (let i = 2; i <= 4; i++) seedIdentity(db, a.id, 'phone', phone(i));
    seedIdentity(db, b.id, 'phone', phone(5));
    expect(runMatcher(db, { now: T0 }).merged).toBe(0);
    expect(candidate(db, a.id, b.id)).toMatchObject({ status: 'blocked', guards_failed: ['G5'] });

    // A member already merged into one side whose name conflicts with the other side.
    const db2 = memDb();
    const p = strongPair(db2, 'Orrin', 'Vale', 1);
    seedPerson(db2, { display_name: 'Pell Darrow', first_name: 'Pell', last_name: 'Darrow', status: 'merged', merged_into_id: p.b.id });
    rebuildPersonCanon(db2);
    expect(runMatcher(db2, { now: T0 }).merged).toBe(0);
    expect(candidate(db2, p.a.id, p.b.id)!.guards_failed).toEqual(['G5']);
  });

  it('G6: at most 25 merges a night, the rest held with an alert, merged the next night', () => {
    const db = memDb();
    const syl = ['ka', 'lo', 'mi', 'ru', 'te', 'vo', 'zi', 'ne', 'pa', 'so'];
    const name = (i: number, salt: number) => {
      const s = syl[(i + salt) % 10]! + syl[(Math.floor(i / 10) + salt * 3) % 10]! + (salt ? 'ndor' : 'x');
      return s[0]!.toUpperCase() + s.slice(1);
    };
    const pairs = Array.from({ length: 28 }, (_, i) => strongPair(db, name(i, 0), name(i, 1), i + 1));
    const night1 = runMatcher(db, { now: T0 });
    expect(night1.merged).toBe(MAX_MERGES_PER_NIGHT);
    expect(night1.held).toBe(3);
    expect(count(db, 'match_candidates', `status = 'held'`)).toBe(3);
    expect(db.prepare(`SELECT source, severity, message FROM alerts WHERE resolved_at IS NULL`).get()).toEqual({
      source: 'identity-match',
      severity: 'warning',
      message: '3 likely duplicate merges held for review (nightly limit 25)',
    });
    // A manual re-run the same night stays inside the cap.
    expect(runMatcher(db, { now: T0 + 60_000 }).merged).toBe(0);
    const night2 = runMatcher(db, { now: T0 + DAY + 60_000 });
    expect(night2).toMatchObject({ merged: 3, held: 0 });
    expect(pairs.every((p) => canonicalId(db, p.b.id) === p.a.id)).toBe(true);
    expect(count(db, 'alerts', 'resolved_at IS NULL')).toBe(0);
  });

  it('G7: a priority/hidden person is never absorbed; two of them never merge', () => {
    const db = memDb();
    const { a, b } = strongPair(db, 'Vesper', 'Kilbride', 1, { igExtra: { is_priority: 1 } });
    expect(runMatcher(db, { now: T0 }).merged).toBe(1);
    expect(canonicalId(db, a.id)).toBe(b.id);
    expect(db.prepare('SELECT survivor_id FROM merges').pluck().get()).toBe(b.id);

    const db2 = memDb();
    const p = strongPair(db2, 'Vesper', 'Kilbride', 1, { contactExtra: { is_hidden: 1 }, igExtra: { is_priority: 1 } });
    expect(runMatcher(db2, { now: T0 }).merged).toBe(0);
    expect(candidate(db2, p.a.id, p.b.id)).toMatchObject({ status: 'blocked', guards_failed: ['G7'] });
  });

  it('two active phones texting me in the same month cost 6 bits', () => {
    const db = memDb();
    const { a, b } = strongPair(db, 'Lark', 'Penhallow', 1);
    const bPhone = seedIdentity(db, b.id, 'phone', phone(2));
    const w = episodeWriter(db, { now: T0 });
    for (const [ident, src] of [[a.phone!, 'dm-a'], [bPhone, 'dm-b']] as const) {
      const conv = w.upsertConversation({ source: 'imessage', sourceConvId: src, kind: 'direct' }).id;
      w.upsertMember(conv, ident, { source: 'sender', at: T0 });
      w.upsertMessage({ source: 'imessage', sourceMsgId: `${src}-1`, conversationId: conv, senderIdentityId: ident, isFromMe: false, sentAt: T0 - 5 * DAY, kind: 'text', text: 'synthetic' });
    }
    const book = loadBook(db);
    const s = scorePair(book, book.profiles.get(a.id)!, book.profiles.get(b.id)!, -10);
    expect(s.bits.two_phones).toBe(-6);
    expect(s.p).toBeCloseTo(probability(s.scoreBits), 6);
  });

  it('undoing a probabilistic merge writes do_not_merge, so the next night never re-merges', () => {
    const db = memDb();
    const { a, b } = strongPair(db, 'Calder', 'Brightwater', 1);
    runMatcher(db, { now: T0 });
    const batchId = db.prepare(`SELECT batch_id FROM merges WHERE method = 'probabilistic'`).pluck().get() as string;
    undoBatch(db, batchId, { now: T0 + 3_600_000 });
    expect(canonicalId(db, b.id)).toBe(b.id);
    expect(count(db, 'do_not_merge', `source = 'undo'`)).toBe(1);

    const night2 = runMatcher(db, { now: T0 + DAY });
    expect(night2.merged).toBe(0);
    expect(canonicalId(db, b.id)).toBe(b.id);
    expect(candidate(db, a.id, b.id)).toMatchObject({ status: 'blocked', guards_failed: ['G3'] });
    expect(count(db, 'merges', 'undone_at IS NULL')).toBe(0);
  });

  it('a dismissed candidate is never merged and stays dismissed', () => {
    const db = memDb();
    const { a, b } = strongPair(db, 'Ansel', 'Morrowby', 1);
    const [lo, hi] = pair(a.id, b.id);
    db.prepare(
      `INSERT INTO match_candidates (a_id, b_id, score_bits, p, status, created_at, updated_at) VALUES (?, ?, 0, 0.5, 'dismissed', ?, ?)`,
    ).run(lo, hi, T0, T0);
    expect(runMatcher(db, { now: T0 }).merged).toBe(0);
    expect(candidate(db, a.id, b.id)?.status).toBe('dismissed');
  });

  it('closes candidates that stop being proposed', () => {
    const db = memDb();
    const a = contact(db, 'John', 'Smith', { phone: phone(1) });
    const b = seedPerson(db, { display_name: 'John Smith', first_name: null, last_name: null, status: 'provisional', origin: 'imessage' });
    runMatcher(db, { now: T0 });
    expect(candidate(db, a.id, b)?.status).toBe('possible_duplicate');
    db.prepare(`UPDATE people SET display_name = 'Nell Orchard' WHERE id = ?`).run(b);
    expect(runMatcher(db, { now: T0 + DAY }).closed).toBe(1);
    expect(candidate(db, a.id, b)?.status).toBe('separate');
  });

  it('describes evidence with counts only', () => {
    const db = memDb();
    const { a, b } = strongPair(db, 'Jake', 'Miller', 1);
    const book = loadBook(db);
    expect(describeEvidence(scorePair(book, book.profiles.get(a.id)!, book.profiles.get(b.id)!, -10))).toBe('name + IG handle + 2 shared groups');
  });
});

describe('identity-match job', () => {
  it('runs nightly at 02:45, exclusive, with count stats', async () => {
    const [job] = matcherJobs({});
    expect(job).toMatchObject({ name: 'identity-match', schedule: { kind: 'daily', at: '02:45' }, exclusive: true });
    const db = memDb();
    strongPair(db, 'Jake', 'Miller', 1);
    const ctl = new AbortController();
    const out = await job!.run({ db, jobRunId: 1, trigger: 'manual', now: () => T0, log: { info() {}, warn() {}, error() {}, debug() {} } as never, signal: ctl.signal });
    expect(out).toMatchObject({ status: 'ok', stats: { merged: 1, people: 2 } });
  });
});
