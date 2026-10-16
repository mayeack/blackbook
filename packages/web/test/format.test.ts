import { describe, expect, it } from 'vitest';
import { hueFor, initials, plural, relativeDay, roleLine } from '../src/lib/format';
import { identityKindLabel, matchMethodLabel, sourceLabel, sourceStatus } from '../src/lib/labels';
import { mergeGroups } from '../src/lib/activity';

const DAY = 86_400_000;

describe('format helpers', () => {
  it('relativeDay', () => {
    const now = new Date(2026, 9, 14, 12).getTime();
    expect(relativeDay(now - 60_000, now)).toBe('today');
    expect(relativeDay(now - DAY, now)).toBe('yesterday');
    expect(relativeDay(now - 41 * DAY, now)).toBe('41d ago');
    expect(relativeDay(now - 120 * DAY, now)).toBe('4mo ago');
    expect(relativeDay(now - 3 * 365 * DAY, now)).toBe('3y ago');
    expect(relativeDay(now + 3 * DAY, now)).toBe('in 3d');
  });

  it('initials handle single names, diacritics and punctuation', () => {
    expect(initials('Alice Avery')).toBe('AA');
    expect(initials('Cher')).toBe('C');
    expect(initials('émile ébert')).toBe('ÉÉ');
    expect(initials('(unnamed)')).toBe('U');
    expect(initials('  ')).toBe('?');
  });

  it('hueFor is stable and in range', () => {
    expect(hueFor('abc')).toBe(hueFor('abc'));
    for (const id of ['a', 'b', '0198f0a2-0000-7000-8000-000000000001']) {
      expect(hueFor(id)).toBeGreaterThanOrEqual(0);
      expect(hueFor(id)).toBeLessThan(360);
    }
  });

  it('roleLine and plural', () => {
    expect(roleLine('Engineer', 'Acme')).toBe('Engineer @ Acme');
    expect(roleLine(null, 'Acme')).toBe('Acme');
    expect(roleLine(null, null)).toBeNull();
    expect(plural(1, 'person', 'people')).toBe('1 person');
    expect(plural(1327, 'person', 'people')).toBe(`${(1327).toLocaleString()} people`);
  });

  it('labels fall back to a humanized value', () => {
    expect(sourceLabel('imessage')).toBe('iMessage');
    expect(sourceLabel('some_new_source')).toBe('Some new source');
    expect(identityKindLabel('instagram_username')).toBe('Instagram');
    expect(matchMethodLabel('llm_tiebreak')).toBe('AI tie-break');
    expect(sourceStatus('auth_required')).toEqual({ label: 'Needs you', tone: 'bad' });
  });
});

describe('activity grouping', () => {
  const run = (id: string) => ({ id, kind: 'nightly', status: 'ok', startedAt: 0, finishedAt: 1, undoneAt: null });
  const batch = (id: string) =>
    ({
      id,
      seq: 1,
      kind: 'merge',
      title: id,
      subjectPersonId: null,
      confidence: null,
      actor: 'agent',
      undoable: true,
      createdAt: 0,
      undoneAt: null,
      undoneByBatchId: null,
      revertsBatchId: null,
      changeCount: 1,
    }) as const;

  it('joins a run split across page boundaries', () => {
    const merged = mergeGroups([
      { run: run('r1'), batches: [batch('a')] },
      { run: run('r1'), batches: [batch('b')] },
      { run: run('r2'), batches: [batch('c')] },
    ]);
    expect(merged.map((g) => [g.run.id, g.batches.map((b) => b.id)])).toEqual([
      ['r1', ['a', 'b']],
      ['r2', ['c']],
    ]);
  });
});
