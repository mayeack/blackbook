/**
 * Circles are friend groups and shared interests, never one party's guest list or an event's name. Synthetic data
 * only (socialWorld): invented names, example.com, 555-01xx phones.
 */
import { uuidv7 } from '@yb/shared';
import { describe, expect, it } from 'vitest';
import { rebuildPartifulEdges } from '../../../src/adapters/partiful/edges';
import { withBatch } from '../../../src/journal/batch';
import { withRun } from '../../../src/journal/runs';
import { undoBatch } from '../../../src/journal/undo';
import { collectionDetail, deleteCollection, editMembers } from '../../../src/pipeline/circles/collections';
import { runCircles } from '../../../src/pipeline/circles/run';
import { FakeEgress, FakeLlmClient } from '../../fakes/llm';
import { DAY, NOW, socialWorld, type SocialWorld } from '../socialWorld';

/** A Partiful event `daysAgo` with everyone going (`hosts` as hosts). */
function party(w: SocialWorld, title: string, guests: string[], daysAgo: number, hosts: string[] = []): string {
  const id = uuidv7();
  w.db
    .prepare(`INSERT INTO events (id, source, source_event_id, title, starts_at, created_at, updated_at) VALUES (?, 'partiful', ?, ?, ?, ?, ?)`)
    .run(id, uuidv7(), title, NOW - daysAgo * DAY, NOW, NOW);
  const ins = w.db.prepare(
    `INSERT INTO event_attendees (id, event_id, person_id, status, role, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'partiful', ?, ?)`,
  );
  for (const g of guests) ins.run(uuidv7(), id, g, 'going', 'guest', NOW, NOW);
  for (const h of hosts) ins.run(uuidv7(), id, h, 'host', 'host', NOW, NOW);
  rebuildPartifulEdges(w.db, NOW);
  return id;
}

function interest(w: SocialWorld, personId: string, value: string, o: { status?: string; sensitive?: number } = {}): string {
  const id = uuidv7();
  w.db
    .prepare(
      `INSERT INTO facts (id, person_id, type, value, value_norm, sensitive, confidence, support, status, recorded_at, source, created_at, updated_at)
       VALUES (?, ?, 'interest', ?, ?, ?, 0.85, 2, ?, ?, 'test', ?, ?)`,
    )
    .run(id, personId, value, value.toLowerCase(), o.sensitive ?? 0, o.status ?? 'confirmed', NOW, NOW, NOW);
  return id;
}

interface CircleRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  signature: string | null;
}
const circles = (w: SocialWorld) => w.db.prepare(`SELECT id, name, kind, status, signature FROM circles ORDER BY name`).all() as CircleRow[];
const active = (w: SocialWorld) => circles(w).filter((c) => c.status === 'active');
const members = (w: SocialWorld, circleId: string) =>
  (w.db.prepare(`SELECT person_id FROM circle_members WHERE circle_id = ? AND excluded = 0`).pluck().all(circleId) as string[]).sort();
const basis = (w: SocialWorld, circleId: string) =>
  w.db.prepare(`SELECT json_extract(name_basis, '$.kind') FROM circle_auto_meta WHERE circle_id = ?`).pluck().get(circleId) as string;
const sorted = (xs: string[]) => [...xs].sort();

function guests(w: SocialWorld): string[] {
  return ['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fin'].map((f) => w.person(f, 'Guest'));
}

describe('circles from Partiful events', () => {
  it("one party's guest list never becomes a circle; people who keep turning up together do, not named after the party", async () => {
    const w = socialWorld();
    const g = guests(w);
    party(w, 'Summer Bash 🔥', g, 40);
    const once = await runCircles(w.db, { now: NOW });
    expect(once.stats).toMatchObject({ communities: 0, created: 0 });
    expect(circles(w)).toEqual([]);

    party(w, 'Summer Bash 🔥', g, 10);
    const twice = await runCircles(w.db, { now: NOW + DAY });
    expect(twice.stats).toMatchObject({ communities: 1, created: 1 });
    const [c] = active(w);
    expect(c!.name).toBe('Ana, Ben & Cy +3');
    expect(c!.name).not.toMatch(/bash/i);
    expect(basis(w, c!.id)).toBe('members');
    expect(members(w, c!.id)).toEqual(sorted(g));
  });

  it('the LLM never sees event titles: only a count of shared gatherings', async () => {
    const w = socialWorld();
    const g = guests(w);
    party(w, 'Summer Bash 🔥', g, 40);
    party(w, 'Rooftop Rave', g, 10);
    const llm = new FakeLlmClient().on('circle_name', { json: { name: 'Party regulars', emoji: '🎉', description: 'Friends who keep turning up at the same parties', conf: 0.8 } });
    await runCircles(w.db, { now: NOW, llm, egress: new FakeEgress() });
    expect(llm.calls).toHaveLength(1);
    const text = llm.calls[0]!.userText;
    expect(text).not.toMatch(/Summer Bash|Rooftop Rave/i);
    expect(text).toContain('2 events or get-togethers where several of them were together');
    expect(llm.calls[0]!.system).toContain('never the name of one party or event');
    expect(active(w).map((c) => c.name)).toEqual(['Party regulars']);
  });

  it("a group chat titled like a Partiful event doesn't lend its name; a real group chat does", async () => {
    const w = socialWorld();
    const g = guests(w);
    party(w, 'Rooftop Rave', g, 40);
    party(w, 'Rooftop Rave', g, 10);
    w.group('rooftop rave!!', g);
    await runCircles(w.db, { now: NOW });
    expect(active(w).map((c) => c.name)).toEqual(['Ana, Ben & Cy +3']);

    const w2 = socialWorld();
    const g2 = guests(w2);
    party(w2, 'Rooftop Rave', g2, 40);
    party(w2, 'Rooftop Rave', g2, 10);
    w2.group('Saturday crew', g2);
    await runCircles(w2.db, { now: NOW });
    expect(active(w2).map((c) => c.name)).toEqual(['Saturday crew']);
  });

  it('an interest most of the group shares names it', async () => {
    const w = socialWorld();
    const g = guests(w);
    party(w, 'Summer Bash 🔥', g, 40);
    party(w, 'Summer Bash 🔥', g, 10);
    for (const p of g.slice(0, 4)) interest(w, p, 'rock climbing');
    const r = await runCircles(w.db, { now: NOW });
    // the four climbers are mostly this friend group: no separate interest circle
    expect(r.stats).toMatchObject({ created: 1, interests: 0 });
    const [c] = active(w);
    expect(c!.name).toBe('Rock climbing crew');
    expect(basis(w, c!.id)).toBe('interest');
  });

  it("Partiful organizer accounts (hosts known only through Partiful) never join or name a circle", async () => {
    const w = socialWorld();
    // created first, so it would lead a members-based name if it were a member
    const venue = w.person('Aardvark', 'Lounge', { status: 'provisional' });
    const g = guests(w);
    w.db.prepare(`UPDATE identities SET kind = 'partiful_user', source = 'partiful' WHERE person_id = ?`).run(venue);
    // a friend who hosts but is also known from texting stays in
    const friend = w.person('Abe', 'Host');
    party(w, 'Lantern Walk', g, 40, [venue, friend]);
    party(w, 'Lantern Walk', g, 10, [venue, friend]);
    await runCircles(w.db, { now: NOW });
    const [c] = active(w);
    expect(members(w, c!.id)).toEqual(sorted([...g, friend]));
    expect(c!.name).toBe('Ana, Ben & Cy +4');
    expect(w.db.prepare('SELECT count(*) FROM circle_suggestions WHERE person_id = ?').pluck().get(venue)).toBe(0);
  });
});

describe('interest circles', () => {
  it('one circle per shared interest, kept by its signature as people come and go; the owner’s edits stick', async () => {
    const w = socialWorld();
    const skiers = ['Kim', 'Lou', 'Max', 'Ned'].map((f) => w.person(f, 'Ski'));
    for (const p of skiers) interest(w, p, 'skiing');
    const maybe = w.person('Oli', 'Ski');
    interest(w, maybe, 'skiing', { status: 'candidate' });
    const private_ = w.person('Pat', 'Ski');
    interest(w, private_, 'skiing', { sensitive: 1 });
    const r = await runCircles(w.db, { now: NOW });
    expect(r.stats).toMatchObject({ communities: 0, interests: 1, created: 1, llmNamed: 0 });
    const [c] = active(w);
    expect(c).toMatchObject({ name: 'Skiing', kind: 'auto', signature: 'interest:skiing' });
    expect(members(w, c!.id)).toEqual(sorted(skiers));
    expect(basis(w, c!.id)).toBe('interest');

    // a new skier joins, one retracts the interest, the owner removes another: same circle, no rename
    const quinn = w.person('Quinn', 'Ski');
    interest(w, quinn, 'skiing');
    w.db.prepare(`UPDATE facts SET retracted_at = ? WHERE person_id = ?`).run(NOW, skiers[3]);
    editMembers(w.db, 'circle', c!.id, { add: [], remove: [skiers[2]!] }, NOW);
    const again = await runCircles(w.db, { now: NOW + 7 * DAY, llm: new FakeLlmClient(), egress: new FakeEgress() });
    expect(again.stats).toMatchObject({ created: 0, updated: 1, membersAdded: 1, membersDropped: 1, llmNamed: 0 });
    expect(active(w).map((x) => x.id)).toEqual([c!.id]);
    expect(members(w, c!.id)).toEqual(sorted([skiers[0]!, skiers[1]!, quinn]));

    // deleted by the owner: never comes back, under any id
    deleteCollection(w.db, 'circle', c!.id, NOW);
    const after = await runCircles(w.db, { now: NOW + 14 * DAY });
    expect(after.stats).toMatchObject({ created: 0, leftAlone: 1 });
    expect(active(w)).toEqual([]);
  });

  it("an interest the owner already has a circle for feeds that circle's suggested additions", async () => {
    const w = socialWorld();
    const runners = ['Rae', 'Sol', 'Tad'].map((f) => w.person(f, 'Run'));
    for (const p of runners) interest(w, p, 'Running');
    const mine = uuidv7();
    w.db.prepare(`INSERT INTO circles (id, name, kind, locked, status, created_at, updated_at) VALUES (?, 'Running', 'user', 1, 'active', ?, ?)`).run(mine, NOW, NOW);
    w.db
      .prepare(`INSERT INTO circle_members (circle_id, person_id, origin, created_at, updated_at) VALUES (?, ?, 'legacy', ?, ?)`)
      .run(mine, runners[0], NOW, NOW);
    const r = await runCircles(w.db, { now: NOW });
    expect(r.stats).toMatchObject({ created: 0, userMatches: 1 });
    expect(active(w).map((c) => c.name)).toEqual(['Running']);
    const d = collectionDetail(w.db, 'circle', mine, NOW);
    expect(d.suggestedAdditions.map((s) => [s.person.id, s.reason])).toEqual(
      sorted([runners[1]!, runners[2]!]).map((id) => [id, 'Shares this interest']),
    );
  });
});

describe('circles named after an event, from before', () => {
  /** An auto circle as the old naming left it: named after an event, the agent's own creation. */
  function legacyEventCircle(w: SocialWorld, name: string, people: string[]): string {
    const id = uuidv7();
    withRun(w.db, 'weekly', (runId) =>
      withBatch(w.db, { runId, kind: 'circle', title: 'Created an auto circle', actor: 'agent' }, (t) => {
        t.insert('circles', { id, name, kind: 'auto', locked: 0, status: 'active' });
        for (const p of people) t.insert('circle_members', { circle_id: id, person_id: p, origin: 'auto', excluded: 0, score: 0.5 });
      }),
    );
    w.db
      .prepare(
        `INSERT INTO circle_auto_meta (circle_id, named_by, name_basis, core_size, created_at, updated_at) VALUES (?, 'rule', ?, ?, ?, ?)`,
      )
      .run(id, JSON.stringify({ kind: 'event', ref: `event:${uuidv7()}` }), people.length, NOW, NOW);
    return id;
  }

  it('renames one the detection still finds, retires the rest (undoable), and leaves the ones the owner touched', async () => {
    const w = socialWorld();
    const g = guests(w);
    party(w, 'Summer Bash 🔥', g, 40);
    party(w, 'Summer Bash 🔥', g, 10);
    w.group('Saturday crew', g);
    const found = legacyEventCircle(w, 'Summer Bash 🔥', g);
    const gone = ['Uma', 'Vic', 'Wes'].map((f) => w.person(f, 'Gone'));
    const stale = legacyEventCircle(w, 'Taco Tuesday crew', gone);
    const kept = ['Xan', 'Yul', 'Zed', 'Ida'].map((f) => w.person(f, 'Kept'));
    const touched = legacyEventCircle(w, 'Lantern Walk crew', kept);
    editMembers(w.db, 'circle', touched, { add: [], remove: [kept[3]!] }, NOW);

    const r = await runCircles(w.db, { now: NOW + DAY });
    expect(r.stats).toMatchObject({ created: 0, renamed: 1, retired: 1 });
    const byId = new Map(circles(w).map((c) => [c.id, c]));
    expect(byId.get(found)).toMatchObject({ name: 'Saturday crew', status: 'active' });
    expect(basis(w, found)).toBe('group');
    expect(byId.get(stale)).toMatchObject({ name: 'Taco Tuesday crew', status: 'retracted' });
    expect(byId.get(touched)).toMatchObject({ name: 'Lantern Walk crew', status: 'active' });
    const titles = w.db.prepare(`SELECT title FROM change_batches WHERE actor = 'agent' AND created_at = ? ORDER BY seq`).pluck().all(NOW + DAY);
    expect(titles).toEqual(['Renamed an auto circle that was named after an event', 'Retired an auto circle that was named after an event']);

    // the owner undoes the retirement: it stays, and the next pass leaves it alone
    const retire = w.db.prepare(`SELECT id FROM change_batches WHERE title LIKE 'Retired%'`).pluck().get() as string;
    undoBatch(w.db, retire, { now: NOW + 2 * DAY });
    expect(circles(w).find((c) => c.id === stale)!.status).toBe('active');
    const next = await runCircles(w.db, { now: NOW + 8 * DAY });
    expect(next.stats).toMatchObject({ renamed: 0, retired: 0 });
    expect(circles(w).find((c) => c.id === stale)!.status).toBe('active');
    expect(members(w, stale)).toEqual(sorted(gone));
  });

  it("a circle the agent retired doesn't keep that group from becoming a circle later", async () => {
    const w = socialWorld();
    const g = guests(w);
    const stale = legacyEventCircle(w, 'Summer Bash 🔥', g);
    await runCircles(w.db, { now: NOW });
    expect(circles(w).find((c) => c.id === stale)!.status).toBe('retracted');

    party(w, 'Summer Bash 🔥', g, 40);
    party(w, 'Summer Bash 🔥', g, 10);
    w.group('Saturday crew', g);
    const r = await runCircles(w.db, { now: NOW + 7 * DAY });
    expect(r.stats).toMatchObject({ created: 1, leftAlone: 0 });
    expect(active(w).map((c) => c.name)).toEqual(['Saturday crew']);
    expect(active(w)[0]!.id).not.toBe(stale);
  });
});
