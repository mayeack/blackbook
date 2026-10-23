/**
 * Event similarity (intel/similarity.ts): categories from titles, folding, the sim(M, U) weights, the title IDF and
 * the feature readers. Every performer, venue and title is invented.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  categoryFromTitle,
  features,
  featuresOf,
  genreKey,
  jaccard,
  performerKey,
  sharedPerformer,
  SIM,
  similarity,
  similarityParts,
  survivorOccasion,
  survivorTicket,
  ticketEventsOf,
  titleCorpus,
  titleIdf,
} from '../../src/intel/similarity';
import { ticketEvent, ticketOccasion } from './eventInviteWorld';
import { at, DAY, intelWorld, NOW, occasion, type IntelWorld } from './world';

let w: IntelWorld;
beforeEach(() => {
  w = intelWorld();
});

describe('categories and folding', () => {
  it('a title names the kind of event (first rule wins); nothing to go on is null', () => {
    const table: [string, string | null][] = [
      ['Lantern Fest 2026', 'festival'],
      ['Harbor Music Festival', 'festival'],
      ['Stand-up night with Kit', 'comedy'],
      ['Improv jam', 'comedy'],
      ['DJ set at the Annex', 'club'],
      ['Warehouse party', 'club'],
      ['Techno till late', 'club'],
      ['Broadway matinee', 'theater'],
      ['The Opera', 'theater'],
      ['Orcas vs Herons', 'sports'],
      ['Hockey night', 'sports'],
      ['Fireside talk', 'talk'],
      ['Book launch', 'talk'],
      ['Velvet Static live', 'concert'],
      ['Spring tour', 'concert'],
      ['Album release show', 'concert'],
      ['Rooftop birthday', 'party'],
      ['Game night', 'party'],
      ['Dinner with Sam', null],
      ['Coffee', null],
      ['', null],
    ];
    for (const [title, cat] of table) expect([title, categoryFromTitle(title)]).toEqual([title, cat]);
    expect(categoryFromTitle(null)).toBeNull();
  });

  it('performers and genres fold case, accents, punctuation, "&" and a leading "the"', () => {
    expect(performerKey('The Velvet Static')).toBe('velvet static');
    expect(performerKey('Café  Orbit!')).toBe('cafe orbit');
    expect(performerKey('Kit & the Moths')).toBe('kit and the moths');
    expect(genreKey('Hip-Hop')).toBe(genreKey('hip hop'));
    expect(genreKey('Indie  Rock')).toBe('indie rock');
  });

  it("features: a ticket category wins, 'other' falls back to the title, unknown is null", () => {
    expect(features({ category: 'comedy', titles: ['Velvet Static live'] }).category).toBe('comedy');
    expect(features({ category: 'other', titles: ['Velvet Static live'] }).category).toBe('concert');
    expect(features({ category: 'other', titles: ['Dinner'] }).category).toBeNull();
    expect(features({ category: 'bogus', titles: [] }).category).toBeNull();
    expect(features({ venue: 'The Lantern Hall, 1 Main St, Springfield' }).venueKey).toBe('lantern hall');
    expect(features({ venueKey: 'given key', venue: 'Somewhere Else' }).venueKey).toBe('given key');
  });
});

describe('sim(M, U)', () => {
  const U = features({ category: 'concert', performers: ['Velvet Static'], genres: ['indie rock', 'dream pop'], venueKey: 'lantern hall', titles: ['Velvet Static'] });

  it('a shared performer is 1; so is a performer the other title names as a whole phrase', () => {
    expect(similarity(features({ category: 'festival', performers: ['the velvet static', 'Glass Harbor'], titles: ['Lantern Fest'] }), U)).toBe(1);
    expect(similarity(features({ titles: ['Velvet Static live at the Annex'] }), U)).toBe(1);
    // a partial word is not the band; a too-short or generic performer never matches a title
    expect(sharedPerformer(features({ titles: ['Velvet Statics reunion'] }), U)).toBe(false);
    expect(sharedPerformer(features({ performers: ['Kit'] }), features({ titles: ['Kit and friends'] }))).toBe(false);
    expect(sharedPerformer(features({ performers: ['Live'] }), features({ titles: ['Live tonight'] }))).toBe(false);
  });

  it('otherwise 0.35·genres + 0.25·category + 0.2·venue + 0.2·title', () => {
    const table: [string, Parameters<typeof features>[0], number][] = [
      ['same category only', { category: 'concert', titles: ['Glass Harbor'] }, 0.25],
      ['category + venue', { category: 'concert', venueKey: 'lantern hall', titles: ['Glass Harbor'] }, 0.45],
      ['half the genres + category', { category: 'concert', genres: ['Indie Rock', 'house'], titles: ['Glass Harbor'] }, 0.35 * (1 / 3) + 0.25],
      ['all genres + category + venue', { category: 'concert', genres: ['dream pop', 'indie-rock'], venueKey: 'lantern hall', titles: ['Glass Harbor'] }, 0.8],
      ['a party at the same venue', { category: 'party', venueKey: 'lantern hall', titles: ['Rooftop birthday'] }, 0.2],
      ["'other' is never the same category", { category: 'other', titles: ['Glass Harbor'] }, 0],
      ['nothing in common', { category: 'comedy', venueKey: 'the annex', titles: ['Kit Moth'] }, 0],
    ];
    for (const [label, m, expected] of table) expect([label, similarity(features(m), U)]).toEqual([label, Math.round(expected * 1000) / 1000]);
    // venues: unknown on both sides is not "the same venue"
    expect(similarityParts(features({ titles: ['A'] }), features({ titles: ['B'] })).venue).toBe(false);
    expect(SIM.genre + SIM.category + SIM.venue + SIM.title).toBeCloseTo(1);
  });

  it('title tokens: IDF-weighted Jaccard, a rare shared word counts more than a common one', () => {
    const idf = titleIdf([['velvet', 'static'], ['velvet', 'night'], ['velvet', 'morning'], ['moth', 'night'], ['glass']]);
    expect(idf.get('velvet')!).toBeLessThan(idf.get('static')!);
    const m = (t: string) => features({ titles: [t] });
    const rare = similarityParts(m('Static Bloom'), m('Static Velvet'), idf).title;
    const common = similarityParts(m('Velvet Bloom'), m('Static Velvet'), idf).title;
    expect(rare).toBeGreaterThan(common);
    expect(similarityParts(m('Static Velvet'), m('Velvet Static'), idf).title).toBe(1);
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
  });
});

describe('readers', () => {
  it('a ticket occasion reads its surviving ticket events: category, performers, genres, venue key, titles', () => {
    const t1 = ticketEvent(w.db, { title: 'Velvet Static', start: at(6, 20), performers: ['Velvet Static'], genres: ['Indie Rock'], venue: 'Lantern Hall', venueKey: 'lantern hall' });
    // an order the ledger later merged into t1 still points the occasion at the survivor
    const old = ticketEvent(w.db, { title: 'Velvet Static (early show)', start: at(6, 20), mergedInto: t1, genres: ['dream pop'] });
    expect(survivorTicket(w.db, old)).toBe(t1);
    const occ = ticketOccasion(w.db, old, { title: 'Velvet Static', start: at(6, 20) });
    expect(ticketEventsOf(w.db, occ).map((t) => t.id)).toEqual([t1]);
    expect(featuresOf(w.db, { type: 'occasion', id: occ })).toMatchObject({
      category: 'concert',
      performers: ['velvet static'],
      genres: ['indie rock'],
      venueKey: 'lantern hall',
      titleTokens: expect.arrayContaining(['velvet', 'static']),
    });
  });

  it('a Partiful event (or an occasion linked to one) is a party; a calendar occasion goes by its title; merged → survivor', () => {
    const pty = w.partiful({ title: 'Rooftop hang', start: at(-10, 20), location: 'Pier Nine, Springfield' });
    expect(featuresOf(w.db, { type: 'event', id: pty })).toMatchObject({ category: 'party', venueKey: 'pier nine' });
    const linked = occasion(w.db, { title: 'Hang', start: at(-10, 20), eventId: pty });
    expect(featuresOf(w.db, { type: 'occasion', id: linked })!.category).toBe('party');
    const cal = occasion(w.db, { title: 'Glass Harbor live', start: at(-5, 20), venue: 'The Annex' });
    expect(featuresOf(w.db, { type: 'occasion', id: cal })).toMatchObject({ category: 'concert', venueKey: 'annex' });
    const dupe = occasion(w.db, { title: 'Glass Harbor', start: at(-5, 20) });
    w.db.prepare(`UPDATE occasions SET merged_into_id = ?, status = 'cancelled' WHERE id = ?`).run(cal, dupe);
    expect(survivorOccasion(w.db, dupe)).toBe(cal);
    expect(featuresOf(w.db, { type: 'occasion', id: dupe })!.venueKey).toBe('annex');
    expect(featuresOf(w.db, { type: 'occasion', id: 'missing' })).toBeNull();
    expect(featuresOf(w.db, { type: 'event', id: 'missing' })).toBeNull();
  });

  it('the title corpus: live social, non-sensitive occasions and uncovered Partiful events in the window', () => {
    occasion(w.db, { title: 'Velvet Static live', start: at(-30) });
    occasion(w.db, { title: 'Therapy session', start: at(-20), sensitive: true });
    occasion(w.db, { title: 'Quarterly review', start: at(-20), kind: 'work' });
    occasion(w.db, { title: 'Ancient picnic', start: NOW - 4 * 365 * DAY });
    w.partiful({ title: 'Moth costume party', start: at(-40) });
    const docs = titleCorpus(w.db, NOW);
    expect(docs).toEqual(expect.arrayContaining([expect.arrayContaining(['velvet', 'static']), expect.arrayContaining(['moth', 'costume'])]));
    expect(docs.flat()).not.toContain('therapy');
    expect(docs.flat()).not.toContain('quarterly');
    expect(docs.flat()).not.toContain('ancient');
  });
});
