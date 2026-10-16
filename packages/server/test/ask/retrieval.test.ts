import { describe, expect, it } from 'vitest';
import { docNumber, ensureAskIndexes, FULL_EVERY_MS, keywords, trigramMatch, unicodeMatch } from '../../src/ask/fts';
import {
  createScope,
  graphNeighbors,
  listEvents,
  mentionedPeople,
  peopleInPlace,
  personDetail,
  placeNames,
  searchFacts,
  searchMessages,
  searchPeople,
} from '../../src/ask/retrieval';
import { rebuildPersonCanon } from '../../src/db/canon';
import { seedPerson } from '../helpers';
import { buildAskWorld, NOW } from './world';

const people = (o: Partial<Parameters<typeof searchPeople>[1]> = {}) => ({
  query: null,
  city: null,
  nearKm: null,
  circle: null,
  interest: null,
  employer: null,
  minStrength: null,
  limit: 10,
  ...o,
});
const msgs = (o: Partial<Parameters<typeof searchMessages>[1]> = {}) => ({ query: null, personId: null, convId: null, after: null, before: null, limit: 20, ...o });

describe('query builders', () => {
  it('quote terms (no FTS syntax injection), prefix long terms, trigram needs ≥ 3 chars', () => {
    expect(unicodeMatch(['ski', 'trip'], 'and')).toBe('"ski"* AND "trip"*');
    expect(unicodeMatch(['a"b'], 'or')).toBe('"a""b"*');
    expect(trigramMatch(['jo', 'rivera'])).toBe('"rivera"');
    expect(trigramMatch(['jo'])).toBeNull();
    expect(keywords('Who do I know in Austin who likes bouldering?')).toEqual(['austin', 'likes', 'bouldering']);
  });
});

describe('ask indexes', () => {
  it('index visible canonical people (with merged aliases and places), skip hidden, refresh incrementally', async () => {
    const w = buildAskWorld();
    const first = await ensureAskIndexes(w.db, NOW);
    expect(first.full).toBe(true);
    const ids = w.db.prepare('SELECT person_id FROM people_fts').pluck().all() as string[];
    expect(ids).toContain(w.sam);
    expect(ids).not.toContain(w.hidden);
    expect(ids).not.toContain(w.samDup);
    expect(ids).not.toContain(w.me);
    const hit = (q: string) => w.db.prepare('SELECT person_id FROM people_fts WHERE people_fts MATCH ?').pluck().all(q) as string[];
    expect(hit('"rivera"')).toEqual([w.sam]);
    expect(hit('"austin"').sort()).toEqual([w.excluded, w.jess, w.sam].sort());
    expect(hit('"northwind"')).toEqual([w.sam]);

    // A new person and a hide: picked up incrementally.
    const zoe = seedPerson(w.db, { first_name: 'Zoe', last_name: 'Quillfeather', display_name: 'Zoe Quillfeather', created_at: NOW, updated_at: NOW + 1000 });
    w.db.prepare('UPDATE people SET is_hidden = 1, updated_at = ? WHERE id = ?').run(NOW + 1000, w.avery);
    const second = await ensureAskIndexes(w.db, NOW + 2000);
    expect(second.full).toBe(false);
    expect(hit('"quillfeather"')).toEqual([zoe]);
    expect(hit('"quinn"')).toEqual([]);

    // A merge pointer flip is caught; a periodic full pass catches anything else.
    w.db.prepare(`UPDATE people SET status = 'merged', merged_into_id = ?, updated_at = ? WHERE id = ?`).run(w.sam, NOW + 3000, zoe);
    rebuildPersonCanon(w.db);
    await ensureAskIndexes(w.db, NOW + 4000);
    expect(hit('"quillfeather"')).toEqual([w.sam]);
    expect((await ensureAskIndexes(w.db, NOW + FULL_EVERY_MS + 5000)).full).toBe(true);
  });

  it('give events stable E numbers and index titles (never sensitive occasions)', async () => {
    const w = buildAskWorld();
    await ensureAskIndexes(w.db, NOW);
    const n = docNumber(w.db, 'occasion', w.occasions.friendsgiving);
    expect(docNumber(w.db, 'occasion', w.occasions.friendsgiving)).toBe(n);
    const rows = w.db.prepare(`SELECT rowid FROM ask_events_fts WHERE ask_events_fts MATCH '"potluck"'`).pluck().all();
    expect(rows).toEqual([n]);
    expect(w.db.prepare(`SELECT count(*) FROM ask_events_fts WHERE ask_events_fts MATCH '"dentist"'`).pluck().get()).toBe(0);
  });
});

describe('retrieval', () => {
  it('search_people by city: current facts only, hidden never, excluded-from-Claude only locally', async () => {
    const w = buildAskWorld();
    await ensureAskIndexes(w.db, NOW);
    const model = createScope(w.db, { now: NOW, forModel: true });
    const local = createScope(w.db, { now: NOW, forModel: false });
    const inAustin = searchPeople(model, people({ city: 'austin' })).map((p) => p.id);
    expect(inAustin).toEqual([w.sam, w.jess]);
    expect(searchPeople(local, people({ city: 'Austin' })).map((p) => p.id)).toEqual([w.excluded, w.sam, w.jess]);
    expect(searchPeople(model, people({ city: 'Denver' }))).toEqual([]);
    expect([...peopleInPlace(model, 'NYC', 50)]).toEqual([w.avery]);
    expect(placeNames('sf', null)).toContain('san francisco');
  });

  it('search_people: name, interest (merged-away facts count), employer, circle, strength; summaries skip sensitive facts', async () => {
    const w = buildAskWorld();
    await ensureAskIndexes(w.db, NOW);
    const s = createScope(w.db, { now: NOW, forModel: true });
    expect(searchPeople(s, people({ query: 'Rivera' })).map((p) => p.id)).toEqual([w.sam]);
    const boulder = searchPeople(s, people({ interest: 'bouldering' }));
    expect(boulder.map((p) => p.id)).toEqual([w.sam]);
    expect(boulder[0]!.facts.map((f) => f.value)).toContain('bouldering');
    expect(boulder[0]!.facts.map((f) => f.value)).not.toContain('starting therapy');
    expect(boulder[0]).toMatchObject({ city: 'Austin', strength: 72, circles: ['Climbing crew'] });
    expect(searchPeople(s, people({ employer: 'acme' })).map((p) => p.id)).toEqual([w.jess]);
    expect(searchPeople(s, people({ circle: 'climbing' })).map((p) => p.id)).toEqual([w.sam, w.jess]);
    expect(searchPeople(s, people({ minStrength: 60 })).map((p) => p.id)).toEqual([w.sam]);
    expect(searchPeople(s, people({ city: 'Austin', minStrength: 0.6 })).map((p) => p.id)).toEqual([w.sam]);
    expect(searchPeople(s, people()).map((p) => p.id)).toEqual([w.sam, w.jess, w.avery]);
  });

  it('search_facts never returns sensitive facts or hidden people', () => {
    const w = buildAskWorld();
    const s = createScope(w.db, { now: NOW, forModel: true });
    expect(searchFacts(s, { query: 'therapy', cat: null, limit: 10 })).toEqual([]);
    const austin = searchFacts(s, { query: 'austin', cat: null, limit: 10 });
    expect(austin.map((f) => f.personId).sort()).toEqual([w.jess, w.sam].sort());
    expect(searchFacts(s, { query: null, cat: 'employer', limit: 10 }).map((f) => f.value)).toEqual(['Acme Robotics']);
  });

  it('search_messages: non-service, hidden senders and DMs dropped, excluded only for the model, filters work', () => {
    const w = buildAskWorld();
    const s = createScope(w.db, { now: NOW, forModel: true });
    const ids = searchMessages(s, msgs({ query: 'bouldering' })).map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining([w.msgs.samTea, w.msgs.mine, w.msgs.climbRopes, w.msgs.injection]));
    expect(ids).not.toContain(w.msgs.hiddenSays);
    expect(ids).not.toContain(w.msgs.hiddenDmMsg);
    expect(ids).not.toContain(w.msgs.selfMsg);
    expect(ids).not.toContain(w.msgs.excludedMsg);
    const local = createScope(w.db, { now: NOW, forModel: false });
    expect(searchMessages(local, msgs({ query: 'bouldering' })).map((m) => m.id)).toContain(w.msgs.excludedMsg);
    // Person scope: their DMs (mine included) and what they posted in groups.
    const withSam = searchMessages(s, msgs({ personId: w.sam })).map((m) => m.id);
    expect(withSam.sort()).toEqual([w.msgs.samTea, w.msgs.samPhoneMsg, w.msgs.mine, w.msgs.injection].sort());
    expect(searchMessages(s, msgs({ query: 'ropes', after: NOW }))).toEqual([]);
    expect(searchMessages(s, msgs({ query: 'ropes' }))[0]).toMatchObject({ id: w.msgs.climbRopes, conv: { kind: 'group', title: 'Climbing crew' } });
    expect(searchMessages(s, msgs({ query: 'snorkel' }))).toEqual([]);
  });

  it('get_person: identity kinds only, no sensitive facts, recent snippets; hidden → null', () => {
    const w = buildAskWorld();
    const s = createScope(w.db, { now: NOW, forModel: true });
    const d = personDetail(s, w.samDup)!;
    expect(d.summary.id).toBe(w.sam);
    expect(d.identityKinds.map((k) => k.kind).sort()).toEqual(['Instagram', 'email', 'phone']);
    expect(JSON.stringify(d.identityKinds)).not.toContain('555');
    expect(d.facts.map((f) => f.value)).not.toContain('starting therapy');
    expect(d.recent.length).toBeGreaterThan(0);
    expect(d.stats).toMatchObject({ strength: 72, state: 'steady' });
    expect(personDetail(s, w.hidden)).toBeNull();
    expect(personDetail(s, w.excluded)).toBeNull();
  });

  it('graph_neighbors falls back to edge_evidence and never shows hidden people', () => {
    const w = buildAskWorld();
    const s = createScope(w.db, { now: NOW, forModel: true });
    const n = graphNeighbors(s, w.sam, { minStrength: 0.15, types: null, limit: 10 })!;
    expect(n.map((x) => x.person.id)).toEqual([w.jess]);
    expect(n[0]).toMatchObject({ tier: 'know', evidence: [{ type: 'co_group', count: 1, conversations: ['Climbing crew'] }] });
    expect(graphNeighbors(s, w.sam, { minStrength: 0.15, types: ['co_attend'], limit: 10 })).toEqual([]);
  });

  it('list_events: title search, attendee filter, dates; sensitive occasions never', async () => {
    const w = buildAskWorld();
    await ensureAskIndexes(w.db, NOW);
    const s = createScope(w.db, { now: NOW, forModel: true });
    const all = listEvents(s, { query: null, personId: null, after: null, before: null, limit: 20 });
    expect(all.map((e) => e.id)).toEqual([w.partiful, w.occasions.friendsgiving]);
    const fg = listEvents(s, { query: 'potluck', personId: null, after: null, before: null, limit: 20 });
    expect(fg.map((e) => e.id)).toEqual([w.occasions.friendsgiving]);
    expect(fg[0]!.attendees.map((p) => p.id).sort()).toEqual([w.jess, w.sam].sort());
    expect(listEvents(s, { query: null, personId: w.avery, after: null, before: null, limit: 20 }).map((e) => e.id)).toEqual([w.partiful]);
    expect(listEvents(s, { query: null, personId: null, after: NOW, before: null, limit: 20 }).map((e) => e.id)).toEqual([w.partiful]);
    expect(listEvents(s, { query: 'dentist', personId: null, after: null, before: null, limit: 20 })).toEqual([]);
  });

  it('mentionedPeople finds full names and first names, never hidden people', () => {
    const w = buildAskWorld();
    const s = createScope(w.db, { now: NOW, forModel: true });
    expect(mentionedPeople(s, 'Does Sam Rivera know Halvard or Jess?').map((p) => p.id)).toEqual([w.sam, w.jess]);
  });
});
