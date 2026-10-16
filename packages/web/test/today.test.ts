import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActivityBatch, Alert, TodayDigest } from '@yb/shared';
import {
  cardActions,
  collapseBulk,
  deliveryLine,
  factorText,
  familyOf,
  filterBatches,
  isOpen,
  kindLabel,
  loopsLine,
  pickedDateUntil,
  resolvedLabel,
  skipReasonLabel,
  snoozeUntil,
  sortAlerts,
  tomorrowInput,
  wildcardLabel,
} from '../src/pages/today/logic';

// Nothing in these tests may reach the network.
beforeAll(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('network disabled in tests')));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const digest = (o: Partial<TodayDigest> = {}): TodayDigest => ({
  id: 'd1',
  localDate: '2026-10-14',
  status: 'sent',
  itemCap: 4,
  composedAt: 1,
  sentAt: 1000,
  pushSentAt: 1000,
  imessage: 'sent',
  push: 'sent',
  skipReason: null,
  ...o,
});
const t = () => '8:00';

let seq = 0;
const batch = (o: Partial<ActivityBatch> = {}): ActivityBatch => ({
  id: `b${++seq}`,
  seq,
  kind: 'fact',
  title: 'Learned something',
  subjectPersonId: null,
  confidence: null,
  actor: 'agent',
  undoable: true,
  createdAt: 1,
  undoneAt: null,
  undoneByBatchId: null,
  revertsBatchId: null,
  changeCount: 1,
  ...o,
});
const roster = (name: string, source = 'whatsapp', o: Partial<ActivityBatch> = {}) =>
  batch({ kind: 'create_person', title: `Noted ${name} from ${source} (not yet a contact)`, ...o });

describe('Today delivery line', () => {
  it('sent on both channels reads like the spec', () => {
    expect(deliveryLine(digest(), t)).toEqual({ text: 'Sent 8:00 via iMessage ✓ · push ✓', tone: 'ok' });
  });

  it('texting off (the shipped default) still shows a sent push', () => {
    expect(deliveryLine(digest({ imessage: 'disabled', push: 'sent', sentAt: null }), t).text).toBe('Sent 8:00 via push ✓ · texting off');
  });

  it('a failed channel warns; not-configured push is left out', () => {
    expect(deliveryLine(digest({ imessage: 'failed', push: 'not_configured' }), t)).toEqual({ text: 'Sent 8:00 · iMessage ✗', tone: 'warn' });
  });

  it('skipped, composing, failed, ready and none', () => {
    expect(deliveryLine(digest({ status: 'skipped', skipReason: 'quiet_hours' }), t)).toEqual({ text: 'Not sent · quiet hours', tone: 'warn' });
    expect(deliveryLine(digest({ status: 'skipped', skipReason: 'disabled' }), t).tone).toBe('muted');
    expect(deliveryLine(digest({ status: 'composing' }), t).text).toMatch(/Composing/);
    expect(deliveryLine(digest({ status: 'failed' }), t).tone).toBe('bad');
    expect(deliveryLine(digest({ status: 'ready', imessage: 'pending', push: 'disabled' }), t).text).toBe('Ready · iMessage pending');
    expect(deliveryLine(digest({ status: 'fallback_sent' }), t).text).toMatch(/basic version$/);
    expect(deliveryLine(null, t)).toEqual({ text: 'No brief yet today', tone: 'muted' });
  });

  it('unknown skip reasons are humanized', () => {
    expect(skipReasonLabel('some_new_reason')).toBe('some new reason');
    expect(skipReasonLabel(null)).toBe('not sent');
  });
});

describe('Today labels and card state', () => {
  it('kind and wildcard labels', () => {
    expect(kindLabel('reply_debt')).toBe('Reply owed');
    expect(kindLabel('brand_new_kind')).toBe('Brand new kind');
    expect(wildcardLabel('memory')).toBe('On this day');
    expect(wildcardLabel(null)).toBe('Shake things up');
  });

  it('open vs resolved statuses', () => {
    expect(isOpen({ status: 'delivered' })).toBe(true);
    expect(isOpen({ status: 'selected' })).toBe(true);
    expect(resolvedLabel('done')).toBe('Done');
    expect(resolvedLabel('dismissed')).toBe('Skipped');
    expect(isOpen({ status: 'snoozed' })).toBe(false);
  });

  it('cards offer the server’s actions, else the standard five', () => {
    expect([...cardActions({ actions: [] })]).toEqual(['done', 'snooze', 'skip', 'wrong', 'why']);
    expect([...cardActions({ actions: ['done', 'mute'] })]).toEqual(['done', 'mute']);
  });

  it('ranker factors', () => {
    expect(factorText(1.32)).toEqual({ text: '×1.32', dir: 'up' });
    expect(factorText(0.5).dir).toBe('down');
    expect(factorText(1.01).dir).toBe('flat');
  });
});

describe('Snooze dates', () => {
  const at = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h, 30).getTime();
  const day = (ms: number) => {
    const d = new Date(ms);
    return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
  };

  it('1w / 2w land on that local day’s midnight', () => {
    expect(day(snoozeUntil('1w', at(2026, 10, 14)))).toEqual([2026, 10, 21, 0, 0]);
    expect(day(snoozeUntil('2w', at(2026, 10, 14)))).toEqual([2026, 10, 28, 0, 0]);
  });

  it('1m clamps to the end of a shorter month', () => {
    expect(day(snoozeUntil('1m', at(2026, 1, 31)))).toEqual([2026, 2, 28, 0, 0]);
    expect(day(snoozeUntil('1m', at(2028, 1, 31)))).toEqual([2028, 2, 29, 0, 0]);
    expect(day(snoozeUntil('1m', at(2026, 12, 15)))).toEqual([2027, 1, 15, 0, 0]);
  });

  it('a picked date must be a real day after today', () => {
    const now = at(2026, 10, 14);
    expect(pickedDateUntil('2026-10-20', now)).toBe(new Date(2026, 9, 20).getTime());
    expect(pickedDateUntil('2026-10-14', now)).toBeNull();
    expect(pickedDateUntil('2026-02-30', now)).toBeNull();
    expect(pickedDateUntil('soon', now)).toBeNull();
    expect(tomorrowInput(at(2026, 12, 31))).toBe('2027-01-01');
  });
});

describe('Alerts and loops', () => {
  const alert = (id: string, severity: Alert['severity'], openedAt: number, resolvedAt: number | null = null): Alert => ({
    id,
    source: 'whatsapp',
    severity,
    message: 'quiet',
    openedAt,
    lastNotifiedAt: null,
    resolvedAt,
    href: '/sources',
  });

  it('most severe first, newest first, resolved dropped', () => {
    const out = sortAlerts([alert('a', 'info', 5), alert('b', 'critical', 1), alert('c', 'warning', 3), alert('d', 'warning', 4), alert('e', 'critical', 9, 10)]);
    expect(out.map((a) => a.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('the strip line', () => {
    expect(loopsLine({ replyDebts: 2, commitments: 1, waitingOn: 0 })).toBe('2 replies owed · 1 promise');
    expect(loopsLine({ replyDebts: 1, commitments: 0, waitingOn: 3 })).toBe('1 reply owed · waiting on 3');
    expect(loopsLine({ replyDebts: 0, commitments: 0, waitingOn: 0 })).toBeNull();
  });
});

describe('Activity feed collapse and filters', () => {
  it('collapses roster-only creations into one row at the first one, keeping order', () => {
    const merge = batch({ kind: 'merge', title: 'Merged two records' });
    const rs = [roster('Avery Q.'), roster('Blake R.', 'imessage'), roster('Casey S.')];
    const fact = batch({ kind: 'fact', title: 'Likes climbing' });
    const rows = collapseBulk([merge, rs[0]!, fact, rs[1]!, rs[2]!]);
    expect(rows.map((r) => r.type)).toEqual(['batch', 'bulk', 'batch']);
    const bulk = rows[1]!;
    expect(bulk.type === 'bulk' && bulk.batches.map((b) => b.id)).toEqual(rs.map((b) => b.id));
    expect(bulk.type === 'bulk' && bulk.label).toBe('Noted 3 people from iMessage, WhatsApp (not contacts yet)');
  });

  it('leaves a few roster-only rows alone and counts undone ones', () => {
    expect(collapseBulk([roster('Avery Q.'), roster('Blake R.')]).every((r) => r.type === 'batch')).toBe(true);
    const rows = collapseBulk([roster('A'), roster('B', 'whatsapp', { undoneAt: 5 }), roster('C')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type === 'bulk' && rows[0]!.undone).toBe(1);
  });

  it('collapses service-sender filings separately', () => {
    const svc = (n: string) => batch({ kind: 'create_person', title: `Filed ${n} as a service sender (short code)` });
    const rows = collapseBulk([svc('12345'), roster('A'), svc('Shop'), roster('B'), svc('Bank'), roster('C')]);
    expect(rows.map((r) => (r.type === 'bulk' ? r.key : 'batch'))).toEqual(['service', 'roster']);
  });

  it('never collapses provisional people or user changes', () => {
    const real = () => batch({ kind: 'create_person', title: 'New person Avery Q. from whatsapp' });
    const mine = () => batch({ kind: 'person_update', title: 'Noted A from you (not yet a contact)', actor: 'user' });
    expect(collapseBulk([real(), real(), real(), mine(), mine(), mine()]).every((r) => r.type === 'batch')).toBe(true);
  });

  it('families for filter chips', () => {
    expect(familyOf('merge')).toBe('merges');
    expect(familyOf('attach_identity')).toBe('links');
    expect(familyOf('fact')).toBe('facts');
    expect(familyOf('edge_label')).toBe('edges');
    expect(familyOf('circle')).toBe('circles');
    expect(familyOf('create_person')).toBe('people');
    expect(familyOf('setting')).toBe('other');
    const all = [batch({ kind: 'merge' }), batch({ kind: 'fact' }), batch({ kind: 'setting' })];
    expect(filterBatches(all, new Set())).toHaveLength(3);
    expect(filterBatches(all, new Set(['merges', 'facts'])).map((b) => b.kind)).toEqual(['merge', 'fact']);
  });
});
