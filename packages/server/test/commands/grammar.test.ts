import { describe, expect, it } from 'vitest';
import { parseCommand, selectionNums } from '../../src/commands/grammar';
import { resolveLogTime, resolveUntil } from '../../src/commands/time';

const TZ = 'America/Chicago';
// Wed 2026-10-14 08:30 CDT
const AT = Date.UTC(2026, 9, 14, 13, 30);
const DAY = 86_400_000;
const localMidnight = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 5, 0); // CDT = UTC−5

const clauses = (s: string) => parseCommand(s).clauses;

describe('grammar: item verbs', () => {
  it('done N, bare numbers, lists, ranges and "all"', () => {
    expect(clauses('done 2')).toEqual([{ verb: 'done', sel: { all: false, nums: [2] } }]);
    expect(clauses('2')).toEqual([{ verb: 'done', sel: { all: false, nums: [2] } }]);
    expect(clauses('Done 1, 3')).toEqual([{ verb: 'done', sel: { all: false, nums: [1, 3] } }]);
    expect(clauses('d 1-3')).toEqual([{ verb: 'done', sel: { all: false, nums: [1, 2, 3] } }]);
    expect(clauses('done all')).toEqual([{ verb: 'done', sel: { all: true } }]);
    expect(clauses('✅')).toEqual([{ verb: 'done', sel: null }]);
    expect(clauses('👍 2')).toEqual([{ verb: 'done', sel: { all: false, nums: [2] } }]);
    expect(clauses('done!')).toEqual([{ verb: 'done', sel: null }]);
    expect(parseCommand('1 3').bareNumbers).toEqual([1, 3]);
  });

  it('snooze with durations and dates; the trailing number of "2 weeks" belongs to the duration', () => {
    expect(clauses('snooze 1 2w')).toEqual([{ verb: 'snooze', sel: { all: false, nums: [1] }, dur: '2w' }]);
    expect(clauses('snooze 1 2 weeks')).toEqual([{ verb: 'snooze', sel: { all: false, nums: [1] }, dur: '2 weeks' }]);
    expect(clauses('s 3 until friday')).toEqual([{ verb: 'snooze', sel: { all: false, nums: [3] }, dur: 'until friday' }]);
    expect(clauses('later 2')).toEqual([{ verb: 'snooze', sel: { all: false, nums: [2] }, dur: null }]);
    expect(clauses('snooze 2 10/28')).toEqual([{ verb: 'snooze', sel: { all: false, nums: [2] }, dur: '10/28' }]);
  });

  it('several clauses in one message', () => {
    expect(clauses('done 2, snooze 1 2w · skip 3')).toEqual([
      { verb: 'done', sel: { all: false, nums: [2] } },
      { verb: 'snooze', sel: { all: false, nums: [1] }, dur: '2w' },
      { verb: 'skip', sel: { all: false, nums: [3] } },
    ]);
    expect(clauses('2 and skip 4')).toEqual([
      { verb: 'done', sel: { all: false, nums: [2] } },
      { verb: 'skip', sel: { all: false, nums: [4] } },
    ]);
    expect(clauses('skip 3 not interested; why 1')).toEqual([
      { verb: 'skip', sel: { all: false, nums: [3] } },
      { verb: 'why', n: 1 },
    ]);
  });

  it('wrong takes the rest as a note; why/draft take exactly one number', () => {
    expect(clauses('wrong 4 she moved to Denver, not Austin')).toEqual([
      { verb: 'wrong', sel: { all: false, nums: [4] }, note: 'she moved to Denver, not Austin' },
    ]);
    expect(clauses('why 2')).toEqual([{ verb: 'why', n: 2 }]);
    expect(clauses('draft 3')).toEqual([{ verb: 'draft', n: 3 }]);
    expect(parseCommand('why 2 3').kind).toBe('free');
    expect(parseCommand('why').kind).toBe('free');
  });

  it('one-letter verbs need numbers; plain words stay free text', () => {
    for (const s of ['s', 'x', 'no', 'd', 'did Sam move?', 'done with work for today', 'buy milk', 'call mom']) {
      expect(parseCommand(s).kind, s).toBe('free');
    }
    expect(parseCommand('did Sam move?').looksLikeQuestion).toBe(true);
    expect(parseCommand('who do I know in Austin').looksLikeQuestion).toBe(true);
    expect(parseCommand('buy milk').looksLikeQuestion).toBe(false);
  });

  it('numbers outside 1–20 are not items', () => {
    expect(parseCommand('2026').kind).toBe('free');
    expect(parseCommand('done 25').kind).toBe('free');
  });
});

describe('grammar: other commands', () => {
  it('undo (only the last command), pause/resume/more/help/status', () => {
    expect(clauses('undo')).toEqual([{ verb: 'undo', target: null }]);
    expect(clauses('undo last')).toEqual([{ verb: 'undo', target: null }]);
    expect(clauses('undo 3')).toEqual([{ verb: 'undo', target: '3' }]);
    expect(clauses('pause')).toEqual([{ verb: 'pause', dur: null }]);
    expect(clauses('pause 2w')).toEqual([{ verb: 'pause', dur: '2w' }]);
    expect(clauses('resume')).toEqual([{ verb: 'resume' }]);
    expect(clauses('more')).toEqual([{ verb: 'more' }]);
    expect(clauses('help')).toEqual([{ verb: 'help' }]);
    expect(clauses('help?')).toEqual([{ verb: 'help' }]);
    expect(clauses('status')).toEqual([{ verb: 'status' }]);
  });

  it('log: and ? are always accepted; "log text" without a colon is a gated command', () => {
    const log = parseCommand('log: coffee with Sam');
    expect(log).toMatchObject({ kind: 'commands', alwaysAccepted: true, clauses: [{ verb: 'log', text: 'coffee with Sam', explicit: true }] });
    expect(parseCommand('L: drinks w/ Priya').clauses).toEqual([{ verb: 'log', text: 'drinks w/ Priya', explicit: true }]);
    expect(parseCommand('log coffee with Sam')).toMatchObject({ alwaysAccepted: false, clauses: [{ verb: 'log', explicit: false }] });
    const ask = parseCommand('? who do I know in Austin');
    expect(ask).toMatchObject({ alwaysAccepted: true, clauses: [{ verb: 'ask', question: 'who do I know in Austin' }] });
    expect(parseCommand('?').clauses).toEqual([{ verb: 'help' }]);
    expect(parseCommand('log:').kind).toBe('free');
  });

  it('a "yb" prefix addresses the bot explicitly', () => {
    expect(parseCommand('yb done 2')).toMatchObject({ yb: true, kind: 'commands', clauses: [{ verb: 'done' }] });
    expect(parseCommand('YB: coffee with Sam was great')).toMatchObject({ yb: true, kind: 'free', body: 'coffee with Sam was great' });
    expect(parseCommand('yb')).toMatchObject({ yb: true, clauses: [{ verb: 'help' }] });
    expect(parseCommand('ybx done 2').yb).toBe(false);
    expect(parseCommand('   ').kind).toBe('empty');
  });

  it('selectionNums expands "all" to the open items', () => {
    expect(selectionNums({ all: true }, [1, 3])).toEqual([1, 3]);
    expect(selectionNums({ all: false, nums: [2] }, [1, 3])).toEqual([2]);
  });
});

describe('durations and dates', () => {
  it('relative durations from the command time', () => {
    expect(resolveUntil('2w', AT, TZ)).toBe(AT + 14 * DAY);
    expect(resolveUntil('10d', AT, TZ)).toBe(AT + 10 * DAY);
    expect(resolveUntil('a week', AT, TZ)).toBe(AT + 7 * DAY);
    expect(resolveUntil(null, AT, TZ)).toBe(AT + 7 * DAY);
    expect(resolveUntil('1m', AT, TZ)).toBe(Date.UTC(2026, 10, 14, 14, 30)); // Nov 14 08:30 CST (DST ended)
  });

  it('days and dates resolve to the start of that local day', () => {
    expect(resolveUntil('tomorrow', AT, TZ)).toBe(localMidnight(2026, 10, 15));
    expect(resolveUntil('next week', AT, TZ)).toBe(localMidnight(2026, 10, 19)); // Monday
    expect(resolveUntil('until friday', AT, TZ)).toBe(localMidnight(2026, 10, 16));
    expect(resolveUntil('oct 28', AT, TZ)).toBe(localMidnight(2026, 10, 28));
    expect(resolveUntil('10/28', AT, TZ)).toBe(localMidnight(2026, 10, 28));
  });

  it('nonsense and far-future specs are rejected', () => {
    expect(resolveUntil('banana', AT, TZ)).toBeNull();
    expect(resolveUntil('900d', AT, TZ)).toBeNull();
    expect(resolveUntil('oct 28 and also whatever else', AT, TZ)).toBeNull();
  });

  it('log dates resolve backwards; plans in the future are not logs', () => {
    expect(resolveLogTime('coffee with Sam', AT, TZ)).toEqual({ at: AT, date: '2026-10-14' });
    expect(resolveLogTime('dinner with Sam yesterday', AT, TZ).date).toBe('2026-10-13');
    expect(resolveLogTime('drinks last friday', AT, TZ).date).toBe('2026-10-09');
    expect(resolveLogTime('lunch next month', AT, TZ).date).toBe('2026-10-14');
  });
});
