/**
 * Suggestion copy outside the brief ("Why this?", the history list, the learner's person label) names people the
 * brief's way: "First L.", or the full last name when that reads as the owner's own or as the other person of the
 * same suggestion. Every name here is invented.
 */
import { describe, expect, it } from 'vitest';
import { whyThis } from '../../../src/pipeline/suggestions/feedback';
import { generators as defaultGenerators } from '../../../src/pipeline/suggestions/generators';
import { runSuggestionsStage } from '../../../src/pipeline/suggestions/stage';
import { listSuggestions } from '../../../src/pipeline/suggestions/why';
import type { DB } from '../../../src/db/connection';
import { seedIdentity, seedPerson } from '../../helpers';
import { fadingFriend, fixedGenerator, friend, setSetting, suggestionRow, suggestionsDb, T0 } from './world';

function seedOwner(db: DB, fullName: string): void {
  const me = seedPerson(db, { display_name: 'Me', first_name: null, last_name: null, kind: 'me', origin: 'system' });
  seedIdentity(db, me, 'addressbook_id', 'card-owner', { display_name: fullName, source: 'addressbook', match_method: 'addressbook' });
}

async function rankFading(db: DB): Promise<string> {
  const r = await runSuggestionsStage(db, { now: T0, seed: 5, generators: defaultGenerators.filter((g) => g.kind === 'fading'), wildcardSources: [] });
  return r.selectedIds.find((id) => suggestionRow(db, id).kind === 'fading')!;
}

const personLabel = (db: DB, id: string) =>
  (JSON.parse(suggestionRow(db, id).learned_factors as string) as { details: { arm: string; label: string }[] }).details.find((d) => d.arm === 'person')!.label;

describe('suggestion names', () => {
  it('unchanged default: "First L." everywhere', async () => {
    const db = suggestionsDb();
    setSetting(db, 'learner.enabled', false);
    seedOwner(db, 'Rowan Teller');
    fadingFriend(db, 'Bram', 'Ostrow');
    const id = await rankFading(db);
    expect(whyThis(db, id).summary).toBe('Bram O. has been quiet 60 days, about 6× your usual ~10-day gap.');
    expect(personLabel(db, id)).toBe('Bram O.');
  });

  it('a friend whose short name is the owner’s own is named in full: why, history headline, person label', async () => {
    const db = suggestionsDb();
    setSetting(db, 'learner.enabled', false);
    seedOwner(db, 'Bram Oakes');
    fadingFriend(db, 'Bram', 'Ostrow');
    const id = await rankFading(db);
    expect(whyThis(db, id).summary).toBe('Bram Ostrow has been quiet 60 days, about 6× your usual ~10-day gap.');
    expect(personLabel(db, id)).toBe('Bram Ostrow');
    expect(listSuggestions(db, { status: 'all', limit: 10 }).items.find((s) => s.id === id)!.headline).toBe('Bram Ostrow · quiet 60d (usually ~10d)');
  });

  it('two people of one suggestion with the same short name are both named in full', async () => {
    const db = suggestionsDb();
    seedOwner(db, 'Rowan Teller');
    const a = friend(db, 'Sam', 'Rivera');
    const b = friend(db, 'Sam', 'Reyes');
    const c = friend(db, 'Cleo', 'Marsh');
    const intro = fixedGenerator('intro', () => [
      { kind: 'intro', personIds: [a.id, b.id], subjectKey: `${a.id}|${b.id}`, base: 0.9, evidenceIds: [], expiresAt: null, payload: {} },
      { kind: 'intro', personIds: [a.id, c.id], subjectKey: `${a.id}|${c.id}`, base: 0.5, evidenceIds: [], expiresAt: null, payload: {} },
    ]);
    await runSuggestionsStage(db, { now: T0, seed: 5, generators: [intro], wildcardSources: [] });
    const headlines = listSuggestions(db, { status: 'all', kind: 'intro', limit: 10 }).items.map((s) => s.headline);
    expect(headlines.sort()).toEqual(['Intro Sam R. ↔ Cleo M.?', 'Intro Sam Rivera ↔ Sam Reyes?']);
  });
});
