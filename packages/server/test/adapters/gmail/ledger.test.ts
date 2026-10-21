/**
 * The ticket ledger (adapters/gmail/ledger.ts) through the consumer's apply (parse.ts applyTicketParse): one row per
 * real event from many mails, the quantity state machine by flow class (orders counted once per order ref, transfers
 * out / in / back, resale pairing, secondary-market pairing, forwarded orders, refunds, unknown quantities), the
 * status order (cancelled unless a later change, refunded, sold, gave_away, holding, unconfirmed), event changes,
 * deterministic years and zones, pointer merges, orphans, counterparty resolution and re-apply idempotence.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TicketRefs } from '../../../src/adapters/gmail/clean';
import { computeLedger, deleteGmailData, survivingTicketEvent, type QtyMsg } from '../../../src/adapters/gmail/ledger';
import { applyTicketParse, failTicketParse } from '../../../src/adapters/gmail/parse';
import type { TicketEmail } from '../../../src/adapters/gmail/prompt';
import type { DB } from '../../../src/db/connection';
import { writeSettings } from '../../../src/settings/registry';
import { memDb, seedIdentity, seedPerson } from '../../helpers';
import { addr } from './fakeGmail';

const NY = 'America/New_York';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 21, 16);
const at = (y: number, mo: number, d: number, h = 15) => Date.UTC(y, mo - 1, d, h);
const VID = 'ticketmaster:0b00abcd12345678';

let db: DB;
let seq = 0;
beforeEach(() => {
  db = memDb();
  seq = 0;
});

interface Seed {
  at: number;
  vendor?: string | null;
  refs?: TicketRefs;
  party?: { direction: 'sent_to' | 'received_from'; name?: string | null; emailKey?: string | null; quantity?: number | null };
}

/** A candidate mail as the gmail job leaves it (fetched, masked, queued). */
function mail(s: Seed): string {
  const id = `18a${String(++seq).padStart(13, '0')}`;
  db.prepare(
    `INSERT INTO gmail_messages (gmail_id, thread_id, internal_at, from_domain, vendor, subject, triage, parse_status, refs, clean_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'subject', 'candidate', 'queued', ?, ?, ?, ?)`,
  ).run(id, `t${id}`, s.at, s.vendor === null ? 'example.com' : 'tickets.example', s.vendor === undefined ? 'ticketmaster' : s.vendor, JSON.stringify(s.refs ?? {}), JSON.stringify({ s: 'subject', t: 'text' }), NOW, NOW);
  if (s.party) {
    db.prepare(`INSERT INTO ticket_parties (gmail_id, direction, name, email_key, quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      s.party.direction,
      s.party.name ?? null,
      s.party.emailKey ?? null,
      s.party.quantity ?? null,
      NOW,
      NOW,
    );
  }
  return id;
}

const ans = (o: Partial<TicketEmail> = {}): TicketEmail => ({
  kind: 'order',
  title: 'Lumen Arcade',
  performers: ['Lumen Arcade'],
  category: 'concert',
  genres: ['synthpop', 'indie'],
  venue: 'The Copper Hall',
  city: 'Springfield',
  start_local: '2026-11-07T20:00',
  end_local: null,
  timezone: NY,
  quantity: 2,
  ...o,
});

const apply = (id: string, v: TicketEmail) => applyTicketParse(db, `gmail:${id}`, v, { now: NOW, ownerTz: NY });
/** Seeds a mail and applies an answer to it. */
const got = (s: Seed, v: Partial<TicketEmail> = {}) => {
  const id = mail(s);
  expect(apply(id, ans(v))).toBe('applied');
  return id;
};

interface EventRow {
  id: string;
  title: string;
  status: string;
  held: number | null;
  qty_bought: number;
  qty_received: number;
  qty_sent: number;
  qty_sold: number;
  qty_refunded: number;
  emails: number;
  local_date: string;
  starts_at: number;
  ends_at: number;
  tz: string | null;
  performers: string;
  genres: string;
  vendor_event_ids: string;
  partiful_ids: string;
  merged_into_id: string | null;
  venue_key: string | null;
  category: string;
}
const live = () => db.prepare('SELECT * FROM ticket_events WHERE merged_into_id IS NULL ORDER BY starts_at, id').all() as EventRow[];
const only = () => {
  const rows = live();
  expect(rows).toHaveLength(1);
  return rows[0]!;
};
const counts = (e: EventRow) => ({ bought: e.qty_bought, received: e.qty_received, sent: e.qty_sent, sold: e.qty_sold, refunded: e.qty_refunded, held: e.held, status: e.status });

describe('one row per event', () => {
  it('order + delivery + reminder (and a recommendation-free vendor id) are one event; the order is counted once', () => {
    got({ at: at(2026, 10, 1), refs: { vendorEventId: VID, orderRef: '12-34567/NY' } });
    got({ at: at(2026, 10, 1, 16), refs: { vendorEventId: VID, orderRef: '12-34567/NY' } }, { quantity: 2 }); // "order received" + "order confirmed"
    got({ at: at(2026, 10, 20), refs: { vendorEventId: VID, pkpass: 2, qty: 2, qtySource: 'pkpass' } }, { kind: 'delivery' });
    got({ at: at(2026, 11, 6), vendor: null, refs: {} }, { kind: 'reminder', title: 'Lumen Arcade: Night Signals Tour', quantity: null });
    const e = only();
    expect(counts(e)).toEqual({ bought: 2, received: 0, sent: 0, sold: 0, refunded: 0, held: 2, status: 'holding' });
    expect(e).toMatchObject({ emails: 4, local_date: '2026-11-07', tz: NY, title: 'Lumen Arcade', category: 'concert', venue_key: 'copper hall' });
    expect(JSON.parse(e.vendor_event_ids)).toEqual([VID]);
    expect(JSON.parse(e.genres)).toEqual(['indie', 'synthpop']);
    expect(e.starts_at).toBe(Date.UTC(2026, 10, 8, 1));
    expect(e.ends_at - e.starts_at).toBe(4 * HOUR);
  });

  it('two orders without a ref are two orders; two mails of one ref take the max quantity', () => {
    got({ at: at(2026, 10, 1) }, { quantity: 2 });
    got({ at: at(2026, 10, 3) }, { quantity: 1 });
    expect(counts(only())).toMatchObject({ bought: 3, held: 3, status: 'holding' });
    db = memDb();
    got({ at: at(2026, 10, 1), refs: { orderRef: 'R1' } }, { quantity: 2 });
    got({ at: at(2026, 10, 1, 17), refs: { orderRef: 'R1' } }, { quantity: 4 });
    expect(counts(only())).toMatchObject({ bought: 4, held: 4 });
  });

  it('deterministic counts win over the model (JSON-LD seats, passes, seat lines)', () => {
    got({ at: at(2026, 10, 1), refs: { qty: 4, qtySource: 'json_ld_seats' } }, { quantity: 2 });
    expect(counts(only())).toMatchObject({ bought: 4 });
  });

  it('two separate orders for different days of one festival stay two rows; a multi-day pass spans its days', () => {
    const fest = { category: 'festival' as const, title: 'Harbor Lights Festival', performers: ['Lumen Arcade', 'Halcy Drift'] };
    got({ at: at(2026, 9, 1), refs: { vendorEventId: 'axs:777001' } }, { ...fest, start_local: '2026-11-06T12:00', quantity: 1 });
    got({ at: at(2026, 9, 2), refs: { vendorEventId: 'axs:777001' } }, { ...fest, start_local: '2026-11-08T12:00', quantity: 1 });
    expect(live().map((e) => e.local_date)).toEqual(['2026-11-06', '2026-11-08']);
    // A reminder for the Sunday joins the Sunday row only.
    got({ at: at(2026, 11, 7), refs: { vendorEventId: 'axs:777001' } }, { ...fest, kind: 'reminder', start_local: '2026-11-08T12:00', quantity: null });
    expect(live().map((e) => e.emails)).toEqual([1, 2]);
    db = memDb();
    got({ at: at(2026, 9, 1), refs: { vendorEventId: 'axs:777002' } }, { ...fest, start_local: '2026-11-06T12:00', end_local: '2026-11-08T23:00', quantity: 2 });
    got({ at: at(2026, 10, 1), refs: { vendorEventId: 'axs:777002' } }, { ...fest, kind: 'delivery', start_local: '2026-11-07T12:00', quantity: 2 });
    const e = only();
    expect(e.local_date).toBe('2026-11-06');
    expect(new Date(e.ends_at).toISOString()).toBe('2026-11-09T04:00:00.000Z');
  });

  it('a strong key and a date match that point at two rows merge them (the younger into the older)', () => {
    const a = got({ at: at(2026, 10, 1), refs: { orderRef: 'R9' } }, { title: 'Night Signals Tour', performers: [], timezone: null });
    const b = got({ at: at(2026, 10, 2), refs: { vendorEventId: VID } }, { title: 'Lumen Arcade', performers: ['Lumen Arcade'], quantity: null, kind: 'delivery' });
    expect(live()).toHaveLength(2);
    got({ at: at(2026, 10, 5), refs: { orderRef: 'R9', vendorEventId: VID } }, { kind: 'reminder', quantity: null });
    const e = only();
    expect(e.emails).toBe(3);
    const ids = db.prepare('SELECT DISTINCT ticket_event_id FROM gmail_messages WHERE gmail_id IN (?, ?)').pluck().all(a, b);
    expect(ids).toEqual([e.id]);
    const merged = db.prepare('SELECT id FROM ticket_events WHERE merged_into_id = ?').pluck().all(e.id) as string[];
    expect(merged).toHaveLength(1);
    expect(survivingTicketEvent(db, merged[0]!)).toBe(e.id);
    expect(counts(e)).toMatchObject({ bought: 2, status: 'holding' });
  });

  it('a merge keeps the oldest row (the id occasions already point at), whichever rule found it', () => {
    const a = got({ at: at(2026, 10, 1) }, { quantity: 2 }); // no key: "Lumen Arcade" on Nov 7
    got({ at: at(2026, 10, 2), refs: { vendorEventId: VID } }, { kind: 'delivery', title: 'Night Signals Tour', performers: [], timezone: null, quantity: 2 });
    expect(live()).toHaveLength(2);
    const older = db.prepare('SELECT ticket_event_id FROM gmail_messages WHERE gmail_id = ?').pluck().get(a) as string;
    // The key points at the younger row, the date and title at the older one.
    got({ at: at(2026, 10, 5), refs: { vendorEventId: VID } }, { kind: 'reminder', quantity: null });
    expect(only().id).toBe(older);
    expect(db.prepare('SELECT count(*) FROM ticket_events WHERE merged_into_id = ?').pluck().get(older)).toBe(1);
  });

  it('a mail without a date joins by ref, or waits as an orphan until its event appears', () => {
    const refund = got({ at: at(2026, 10, 10), refs: { orderRef: 'R2' } }, { kind: 'refund', start_local: null, quantity: null, title: null, performers: [] });
    expect(live()).toHaveLength(0);
    expect(db.prepare('SELECT ticket_event_id FROM gmail_messages WHERE gmail_id = ?').pluck().get(refund)).toBeNull();
    got({ at: at(2026, 10, 1), refs: { orderRef: 'R2' } }, { quantity: 2 });
    expect(counts(only())).toMatchObject({ bought: 2, refunded: 2, status: 'refunded', held: 0 });
  });

  it('marketing / not_ticket answers clear the excerpt and never make an event; a lone reminder is unconfirmed', () => {
    const m = got({ at: at(2026, 10, 1) }, { kind: 'marketing', title: null });
    expect(db.prepare('SELECT parse_status, clean_text, ticket_event_id FROM gmail_messages WHERE gmail_id = ?').get(m)).toEqual({ parse_status: 'not_ticket', clean_text: null, ticket_event_id: null });
    expect(live()).toHaveLength(0);
    got({ at: at(2026, 11, 6) }, { kind: 'reminder', quantity: null });
    expect(counts(only())).toMatchObject({ status: 'unconfirmed', bought: 0 });
  });

  it('a delivery or wallet pass without an order in the mailbox proves a ticket', () => {
    got({ at: at(2026, 10, 20), refs: { pkpass: 2, qty: 2, qtySource: 'pkpass' } }, { kind: 'delivery', quantity: null });
    expect(counts(only())).toMatchObject({ bought: 2, held: 2, status: 'holding' });
  });

  it('a failed parse is final and clears the excerpt', () => {
    const id = mail({ at: at(2026, 10, 1) });
    failTicketParse(db, `gmail:${id}`, 'refused', NOW);
    expect(db.prepare('SELECT parse_status, error_class, clean_text FROM gmail_messages WHERE gmail_id = ?').get(id)).toEqual({ parse_status: 'failed', error_class: 'refused', clean_text: null });
  });
});

describe('transfers, resale, refunds, cancellation', () => {
  it('transfer out to friends: held drops, then gave_away; an accepted notice moves nothing; a transfer back returns one', () => {
    got({ at: at(2026, 10, 1), refs: { orderRef: 'R1' } }, { quantity: 4 });
    got({ at: at(2026, 10, 2), party: { direction: 'sent_to', name: 'Dana Reyes', quantity: 2 } }, { kind: 'transfer_out', quantity: null });
    expect(counts(only())).toMatchObject({ bought: 4, sent: 2, held: 2, status: 'holding' });
    got({ at: at(2026, 10, 3), party: { direction: 'sent_to', name: 'Dana Reyes' } }, { kind: 'transfer_accepted', quantity: 2 });
    expect(counts(only())).toMatchObject({ sent: 2, held: 2 });
    got({ at: at(2026, 10, 4) }, { kind: 'transfer_out', quantity: 2 });
    expect(counts(only())).toMatchObject({ sent: 4, held: 0, status: 'gave_away' });
    got({ at: at(2026, 10, 5) }, { kind: 'transfer_back', quantity: 1 });
    expect(counts(only())).toMatchObject({ sent: 3, held: 1, status: 'holding' });
  });

  it('transfer in: someone sent the owner tickets', () => {
    got({ at: at(2026, 10, 2), party: { direction: 'received_from', name: 'Rowan Quill' } }, { kind: 'transfer_in', quantity: 2 });
    expect(counts(only())).toEqual({ bought: 0, received: 2, sent: 0, sold: 0, refunded: 0, held: 2, status: 'holding' });
  });

  it('one incoming transfer is counted once: its offer and the owner’s own acceptance (read as transfer_in) are one inflow', () => {
    got({ at: at(2026, 10, 2), party: { direction: 'received_from', name: 'Rowan Quill' } }, { kind: 'transfer_in', quantity: 2 });
    // "You've accepted 2 tickets from Rowan — you're all set" (transfer_accepted by the prompt; a model may still say transfer_in).
    got({ at: at(2026, 10, 3), party: { direction: 'received_from', name: 'Rowan' } }, { kind: 'transfer_in', quantity: 2 });
    expect(counts(only())).toMatchObject({ received: 2, held: 2, status: 'holding' });
    got({ at: at(2026, 10, 5), party: { direction: 'sent_to', name: 'Dana Reyes' } }, { kind: 'transfer_out', quantity: 2 });
    expect(counts(only())).toEqual({ bought: 0, received: 2, sent: 2, sold: 0, refunded: 0, held: 0, status: 'gave_away' });
  });

  it('transfers in from two different people are two inflows', () => {
    got({ at: at(2026, 10, 2), party: { direction: 'received_from', name: 'Rowan Quill' } }, { kind: 'transfer_in', quantity: 2 });
    got({ at: at(2026, 10, 3), party: { direction: 'received_from', name: 'Kit Morrow' } }, { kind: 'transfer_in', quantity: 1 });
    expect(counts(only())).toMatchObject({ received: 3, held: 3, status: 'holding' });
  });

  it('resale: listed counts nothing; sold + its delivery transfer to a stranger is one outflow → sold', () => {
    got({ at: at(2026, 10, 1) }, { quantity: 2 });
    got({ at: at(2026, 10, 5) }, { kind: 'resale_listed', quantity: 2 });
    expect(counts(only())).toMatchObject({ held: 2, status: 'holding' });
    got({ at: at(2026, 10, 9) }, { kind: 'resale_sold', quantity: 2 });
    got({ at: at(2026, 10, 10), party: { direction: 'sent_to', name: 'Buyer Unknown' } }, { kind: 'transfer_out', quantity: 2 });
    expect(counts(only())).toMatchObject({ sold: 2, sent: 0, held: 0, status: 'sold' });
  });

  it('a transfer to a known person after a sale is not the sale’s delivery', () => {
    const p = seedPerson(db, { display_name: 'Dana Reyes', first_name: 'Dana', last_name: 'Reyes', status: 'active' });
    got({ at: at(2026, 10, 1) }, { quantity: 4 });
    got({ at: at(2026, 10, 9) }, { kind: 'resale_sold', quantity: 2 });
    got({ at: at(2026, 10, 10), party: { direction: 'sent_to', name: 'Dana Reyes' } }, { kind: 'transfer_out', quantity: 2 });
    expect(counts(only())).toMatchObject({ sold: 2, sent: 2, held: 0, status: 'sold' });
    expect(db.prepare('SELECT person_id FROM ticket_parties').pluck().get()).toBe(p);
  });

  it('a secondary-market order and the seller’s transfer within 14 days are one inflow; an order forwarded by a friend is a transfer in of 1', () => {
    got({ at: at(2026, 10, 1), vendor: 'stubhub' }, { quantity: 2 });
    got({ at: at(2026, 10, 3), vendor: 'stubhub' }, { kind: 'transfer_in', quantity: 2 });
    expect(counts(only())).toMatchObject({ bought: 2, received: 0, held: 2 });
    db = memDb();
    got({ at: at(2026, 10, 1), vendor: null, refs: { forwarded: true, orderRef: 'AB-1234' } }, { quantity: 4 });
    expect(counts(only())).toMatchObject({ bought: 0, received: 1, held: 1, status: 'holding' });
  });

  it('refunds: a null refund refunds its whole order; a partial one leaves the rest held', () => {
    got({ at: at(2026, 10, 1), refs: { orderRef: 'R1' } }, { quantity: 3 });
    got({ at: at(2026, 10, 9), refs: { orderRef: 'R1' } }, { kind: 'refund', quantity: 1 });
    expect(counts(only())).toMatchObject({ refunded: 1, held: 2, status: 'holding' });
    got({ at: at(2026, 10, 10), refs: { orderRef: 'R1' } }, { kind: 'refund', quantity: null });
    expect(counts(only())).toMatchObject({ refunded: 4, held: 0, status: 'refunded' });
  });

  it('cancellation wins, unless a later change, delivery or reminder says the event goes on', () => {
    got({ at: at(2026, 10, 1), refs: { vendorEventId: VID } }, { quantity: 2 });
    got({ at: at(2026, 10, 10), refs: { vendorEventId: VID } }, { kind: 'event_cancelled', quantity: null });
    expect(counts(only()).status).toBe('cancelled');
    got({ at: at(2026, 10, 12), refs: { vendorEventId: VID } }, { kind: 'event_changed', start_local: '2026-11-14T20:00', quantity: null });
    const e = only();
    expect(counts(e).status).toBe('holding');
    expect(e.local_date).toBe('2026-11-14');
  });

  it('event_changed moves the start (even with no key: by title, to the earlier event)', () => {
    got({ at: at(2026, 10, 1) }, { quantity: 2 });
    got({ at: at(2026, 10, 15), vendor: null }, { kind: 'event_changed', start_local: '2026-11-21T19:30', quantity: null });
    const e = only();
    expect(e).toMatchObject({ local_date: '2026-11-21', status: 'holding', emails: 2 });
    expect(e.starts_at).toBe(Date.UTC(2026, 10, 22, 0, 30));
    // A reminder for the new date joins; one still naming the old date can't move it back.
    got({ at: at(2026, 11, 20) }, { kind: 'reminder', start_local: '2026-11-21T19:30', quantity: null });
    expect(only().emails).toBe(3);
  });

  it('results apply in any order: a change notice placed before the mails it moves still makes one event', () => {
    // With a key (the backfill parses newest first, so the change usually lands first).
    got({ at: at(2026, 10, 12), refs: { vendorEventId: VID } }, { kind: 'event_changed', start_local: '2026-11-14T20:00', quantity: null });
    got({ at: at(2026, 10, 1), refs: { vendorEventId: VID, orderRef: 'R1' } }, { quantity: 2 });
    got({ at: at(2026, 10, 2), refs: { vendorEventId: VID } }, { kind: 'delivery', quantity: 2 });
    expect(only()).toMatchObject({ local_date: '2026-11-14', emails: 3, status: 'holding', qty_bought: 2, held: 2 });
    // Without one: by title, when the event's pre-change mails name the same old date (or there are none yet).
    db = memDb();
    got({ at: at(2026, 10, 12), vendor: null }, { kind: 'event_changed', start_local: '2026-11-21T19:30', quantity: null });
    got({ at: at(2026, 10, 1) }, { quantity: 2 });
    got({ at: at(2026, 10, 2) }, { kind: 'delivery', quantity: 2 });
    expect(only()).toMatchObject({ local_date: '2026-11-21', emails: 3, status: 'holding', qty_bought: 2 });
  });

  it('a keyless change notice placed first never pulls in another date of the same show', () => {
    got({ at: at(2026, 10, 20), vendor: null }, { kind: 'event_changed', start_local: '2026-12-12T20:00', quantity: null });
    got({ at: at(2026, 10, 10) }, { start_local: '2026-12-05T20:00', quantity: 2 }); // the moved show's order (old date)
    got({ at: at(2026, 10, 5) }, { start_local: '2026-11-07T20:00', quantity: 1 }); // the same show a month earlier
    expect(live().map((e) => [e.local_date, e.qty_bought, e.emails])).toEqual([
      ['2026-11-07', 1, 1],
      ['2026-12-12', 2, 2],
    ]);
  });

  it('a null quantity is unknown: outflows reaching it keep holding with held NULL', () => {
    got({ at: at(2026, 10, 1) }, { quantity: null });
    expect(counts(only())).toMatchObject({ bought: 1, held: 1, status: 'holding' });
    got({ at: at(2026, 10, 2) }, { kind: 'transfer_out', quantity: 2 });
    expect(counts(only())).toMatchObject({ sent: 2, held: null, status: 'holding' });
  });
});

describe('dates and zones on the ledger', () => {
  it('year inference near New Year and the owner’s zone as a flagged guess', () => {
    got({ at: at(2026, 12, 20), refs: { weekdays: { '01-09': 6 } } }, { start_local: '2026-01-09T20:00', timezone: null });
    const e = only();
    expect(e).toMatchObject({ local_date: '2027-01-09', tz: null });
    expect(e.starts_at).toBe(Date.UTC(2027, 0, 10, 1));
    const parsed = JSON.parse(db.prepare('SELECT parsed FROM gmail_messages').pluck().get() as string) as { year_fixed: boolean; tz: string | null };
    expect(parsed).toMatchObject({ year_fixed: true, tz: null });
  });

  it('without a zone from the model, the settings zone is used (and the row says it was guessed)', () => {
    writeSettings(db, { tz: 'America/Chicago' }, { actor: 'user', now: NOW });
    const id = mail({ at: at(2026, 10, 1) });
    expect(applyTicketParse(db, `gmail:${id}`, ans({ timezone: null }), { now: NOW })).toBe('applied');
    expect(only()).toMatchObject({ tz: null, local_date: '2026-11-07', starts_at: Date.UTC(2026, 10, 8, 2) });
  });

  it('a known zone wins over a guessed one: the start is never one zone’s wall clock labelled as another', () => {
    // The order names the venue's zone; the reminder doesn't, so its 20:00 is read in the owner's (earlier).
    got({ at: at(2026, 10, 1) }, { timezone: 'America/Los_Angeles' });
    got({ at: at(2026, 11, 6) }, { kind: 'reminder', timezone: null, quantity: null });
    const e = only();
    expect(e).toMatchObject({ tz: 'America/Los_Angeles', local_date: '2026-11-07', emails: 2 });
    expect(e.starts_at).toBe(Date.UTC(2026, 10, 8, 4)); // 20:00 PT
    expect(e.ends_at - e.starts_at).toBe(4 * HOUR);
  });

  it('JSON-LD startDate wins over the model', () => {
    got({ at: at(2026, 10, 1), refs: { jsonLd: { name: 'Lumen Arcade', startDate: '2026-11-07T21:00:00-05:00', endDate: null, venue: null, city: null, performers: [] } } }, { start_local: '2026-11-08T19:00' });
    expect(only()).toMatchObject({ local_date: '2026-11-07', starts_at: Date.UTC(2026, 10, 8, 2) });
  });

  it('guessed zones never join on the ±3 h venue rule; title or performer on the local date still does', () => {
    got({ at: at(2026, 10, 1) }, { title: 'Night Signals', performers: ['Halcy Drift'], timezone: null });
    got({ at: at(2026, 10, 2) }, { title: 'Lumen Arcade', performers: ['Lumen Arcade'], timezone: null, start_local: '2026-11-07T21:00' });
    expect(live()).toHaveLength(2);
    db = memDb();
    got({ at: at(2026, 10, 1) }, { title: 'Night Signals', performers: ['Halcy Drift'] });
    got({ at: at(2026, 10, 2) }, { title: 'Lumen Arcade', performers: ['Lumen Arcade'], start_local: '2026-11-07T21:00' });
    expect(live()).toHaveLength(1);
  });
});

describe('counterparties', () => {
  it('resolve by the Gmail-folded email key, else a unique full name; never hidden people or the owner', () => {
    const dana = seedPerson(db, { display_name: 'Dana Reyes', first_name: 'Dana', last_name: 'Reyes', status: 'active' });
    seedIdentity(db, dana, 'email', addr('dana.reyes', 'gmail.com'));
    const kit = seedPerson(db, { display_name: 'Kit Morrow', first_name: 'Kit', last_name: 'Morrow', status: 'roster_only' });
    seedPerson(db, { display_name: 'Ash Lane', first_name: 'Ash', last_name: 'Lane', status: 'active' });
    seedPerson(db, { display_name: 'Ash Lane', first_name: 'Ash', last_name: 'Lane', status: 'active' });
    seedPerson(db, { display_name: 'Lee Hidden', first_name: 'Lee', last_name: 'Hidden', status: 'active', is_hidden: 1 });
    got({ at: at(2026, 10, 1) }, { quantity: 8 });
    const sent = (name: string | null, emailKey: string | null, day: number) => got({ at: at(2026, 10, day), party: { direction: 'sent_to', name, emailKey } }, { kind: 'transfer_out', quantity: 1 });
    const a = sent('D. Reyes', addr('danareyes', 'gmail.com'), 2);
    const b = sent('Kit Morrow', null, 3);
    const c = sent('Ash Lane', null, 4);
    const d = sent('Lee Hidden', null, 5);
    const person = (id: string) => db.prepare('SELECT person_id, ticket_event_id FROM ticket_parties WHERE gmail_id = ?').get(id) as { person_id: string | null; ticket_event_id: string };
    expect(person(a).person_id).toBe(dana);
    expect(person(b).person_id).toBe(kit);
    expect(person(c).person_id).toBeNull();
    expect(person(d).person_id).toBeNull();
    expect(person(a).ticket_event_id).toBe(only().id);
  });
});

describe('idempotence and disconnect', () => {
  it('re-applying every answer leaves the ledger byte-identical', () => {
    const script: [Seed, Partial<TicketEmail>][] = [
      [{ at: at(2026, 10, 1), refs: { orderRef: 'R1', vendorEventId: VID } }, { quantity: 4 }],
      [{ at: at(2026, 10, 2), party: { direction: 'sent_to', name: 'Dana Reyes', quantity: 2 } }, { kind: 'transfer_out', quantity: null }],
      [{ at: at(2026, 10, 9), refs: { vendorEventId: VID } }, { kind: 'resale_sold', quantity: 1 }],
      [{ at: at(2026, 10, 12), refs: { vendorEventId: VID } }, { kind: 'event_changed', start_local: '2026-11-14T20:00', quantity: null }],
    ];
    const ids = script.map(([s, v]) => got(s, v));
    const snapshot = () => JSON.stringify([db.prepare('SELECT * FROM ticket_events ORDER BY id').all(), db.prepare('SELECT * FROM ticket_parties ORDER BY gmail_id').all(), db.prepare('SELECT gmail_id, parse_status, parsed, ticket_event_id FROM gmail_messages ORDER BY gmail_id').all()]);
    const before = snapshot();
    ids.forEach((id, i) => expect(apply(id, ans(script[i]![1]))).toBe('applied'));
    expect(snapshot()).toBe(before);
    expect(counts(only())).toMatchObject({ bought: 4, sent: 2, sold: 1, held: 1, status: 'holding' });
  });

  it('an unknown subject or a non-candidate is rejected', () => {
    expect(applyTicketParse(db, 'gmail:nope', ans(), { now: NOW, ownerTz: NY })).toBe('rejected');
    expect(applyTicketParse(db, 'occ:x', ans(), { now: NOW, ownerTz: NY })).toBe('rejected');
  });

  it('deleteGmailData removes events (merged ones too), messages and parties', () => {
    got({ at: at(2026, 10, 1), refs: { orderRef: 'R9' } }, { title: 'Night Signals Tour', performers: [], timezone: null });
    got({ at: at(2026, 10, 2), refs: { vendorEventId: VID } }, { kind: 'delivery' });
    got({ at: at(2026, 10, 5), refs: { orderRef: 'R9', vendorEventId: VID }, party: { direction: 'sent_to', name: 'Dana Reyes' } }, { kind: 'transfer_out' });
    expect(deleteGmailData(db)).toEqual({ messages: 3, events: 2, parties: 1, requests: 0 });
  });
});

describe('computeLedger (pure)', () => {
  const m = (o: Partial<QtyMsg> & Pick<QtyMsg, 'kind'>): QtyMsg => ({ id: `m${++seq}`, at: at(2026, 10, 1) + seq * HOUR, qty: null, orderRef: null, vendor: 'ticketmaster', forwarded: false, pkpass: 0, toKnownPerson: false, ...o });

  it('a transfer after a sale outside 14 days, or larger than the sale, is its own outflow', () => {
    const order = m({ kind: 'order', qty: 4 });
    const sold = m({ kind: 'resale_sold', qty: 1 });
    const late = m({ kind: 'transfer_out', qty: 1, at: sold.at + 15 * DAY });
    expect(computeLedger([order, sold, late])).toMatchObject({ sold: 1, sent: 1, held: 2 });
    const big = m({ kind: 'transfer_out', qty: 2, at: sold.at + DAY });
    expect(computeLedger([order, sold, big])).toMatchObject({ sold: 1, sent: 2, held: 1 });
  });

  it('a secondary order absorbs at most its own quantity of transfers in', () => {
    const order = m({ kind: 'order', qty: 2, vendor: 'seatgeek' });
    const t1 = m({ kind: 'transfer_in', qty: 2, at: order.at + DAY });
    const t2 = m({ kind: 'transfer_in', qty: 2, at: order.at + 2 * DAY });
    expect(computeLedger([order, t1, t2])).toMatchObject({ bought: 2, received: 2, held: 4 });
  });

  it('a secondary order or a sale of unknown size takes the size of the transfer that carries it out', () => {
    const order = m({ kind: 'order', qty: null, vendor: 'seatgeek' });
    const tin = m({ kind: 'transfer_in', qty: 3, at: order.at + DAY });
    expect(computeLedger([order, tin])).toMatchObject({ bought: 3, received: 0, held: 3, status: 'holding' });
    const buy = m({ kind: 'order', qty: 4 });
    const sale = m({ kind: 'resale_sold', qty: null, at: buy.at + DAY });
    const tout = m({ kind: 'transfer_out', qty: 2, at: sale.at + DAY });
    expect(computeLedger([buy, sale, tout])).toMatchObject({ sold: 2, sent: 0, held: 2, status: 'holding' });
    // A transfer to a known person is never the sale's delivery.
    expect(computeLedger([buy, sale, { ...tout, toKnownPerson: true }])).toMatchObject({ sold: 1, sent: 2, held: 1 });
  });

  it('transfers in from one counterparty, or in one thread, are one inflow (the max); different ones add up', () => {
    const rowan = (email: string | null = null) => ({ person: null, email, first: 'rowan' });
    const offer = m({ kind: 'transfer_in', qty: 2, from: rowan(), thread: 't1' });
    const accepted = m({ kind: 'transfer_in', qty: 2, from: rowan(addr('rowan.quill', 'example.com')), thread: 't2' });
    const nudge = m({ kind: 'transfer_in', qty: null, thread: 't1' });
    const other = m({ kind: 'transfer_in', qty: 1, from: { person: null, email: null, first: 'kit' }, thread: 't3' });
    expect(computeLedger([offer, accepted, nudge])).toMatchObject({ received: 2, held: 2, status: 'holding' });
    expect(computeLedger([offer, accepted, nudge, other])).toMatchObject({ received: 3, held: 3 });
    expect(computeLedger([offer, accepted, m({ kind: 'transfer_out', qty: 2 })])).toMatchObject({ received: 2, sent: 2, held: 0, status: 'gave_away' });
    // The same first name at two different addresses (or two different people in the book) is two transfers.
    const namesake = m({ kind: 'transfer_in', qty: 1, from: rowan(addr('rowan.k', 'example.com')), thread: 't4' });
    expect(computeLedger([accepted, namesake])).toMatchObject({ received: 3 });
  });

  it('nothing but a resale listing or an accepted notice is unconfirmed; an outflow alone is gave_away / sold', () => {
    expect(computeLedger([m({ kind: 'resale_listed', qty: 2 })]).status).toBe('unconfirmed');
    expect(computeLedger([m({ kind: 'transfer_accepted', qty: 2 })]).status).toBe('unconfirmed');
    expect(computeLedger([m({ kind: 'transfer_out', qty: 2 })])).toMatchObject({ status: 'gave_away', held: 0 });
    expect(computeLedger([m({ kind: 'resale_sold', qty: null })])).toMatchObject({ status: 'sold', sold: 1 });
  });

  it('a cancellation followed only by a refund stays cancelled; one followed by a delivery does not', () => {
    const order = m({ kind: 'order', qty: 2 });
    const cancel = m({ kind: 'event_cancelled' });
    expect(computeLedger([order, cancel, m({ kind: 'refund' })]).status).toBe('cancelled');
    expect(computeLedger([order, cancel, m({ kind: 'delivery' })]).status).toBe('holding');
    // Order matters: a reminder from before the cancellation doesn't revive it.
    expect(computeLedger([order, m({ kind: 'reminder' }), m({ kind: 'event_cancelled' })]).status).toBe('cancelled');
  });
});
