/**
 * event_invite (intel/eventInvites.ts): for a show the owner holds tickets to, people he met at a similar event —
 * screenshot people first — never anyone who may already be going. Generator, delivery stale check, copy and the
 * "Wrong" feedback. Every name, performer, venue and id is invented; emails use example.com.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@yb/shared';
import { composeDigest, compositionCurrent } from '../../src/delivery/compose';
import { buildPacket } from '../../src/delivery/llmComposer';
import { groundingIssues } from '../../src/delivery/grounding';
import { digestCards } from '../../src/delivery/preview';
import { readDigestSelection, selectedItemById, targetOf } from '../../src/delivery/selection';
import { deliveryTick } from '../../src/delivery/send';
import { templateCopy } from '../../src/delivery/template';
import {
  EVENT_INVITE,
  eventInviteCandidates,
  eventInviteLinkIds,
  eventInviteStale,
  happeningOf,
  metRefOf,
  rejectEventInviteLinks,
  ticketedEvents,
} from '../../src/intel/eventInvites';
import { eventInviteGenerator, generators } from '../../src/intel/generators';
import { rejectMetAtLinks } from '../../src/intel/metAt/store';
import { withRun } from '../../src/journal/runs';
import { nullLogger } from '../../src/ops/logger';
import { applySuggestionFeedback, undoSuggestionFeedback } from '../../src/pipeline/suggestions/feedback';
import { allGenerators } from '../../src/pipeline/suggestions/registry';
import { attributeRewards, recordImpressions } from '../../src/pipeline/suggestions/rewards';
import { runSuggestionsStage } from '../../src/pipeline/suggestions/stage';
import { templateHeadline, templateOpeners, whySignals, whySummary, type TextInput } from '../../src/pipeline/suggestions/text';
import type { Candidate, CandidateGenerator, GeneratorContext } from '../../src/pipeline/suggestions/types';
import { settingsSnapshot, writeSettings } from '../../src/settings/registry';
import { seedIdentity, seedPerson } from '../helpers';
import { FakeOutboundSender, FakePushSender } from '../fakes/delivery';
import { FakeEgress, FakeLlmClient } from '../fakes/llm';
import { metAt, screenshotOf, ticketEvent, ticketOccasion, ticketParty } from './eventInviteWorld';
import { at, DAY, HOUR, intelWorld, NOW, occasion, TZ, type IntelWorld } from './world';

let w: IntelWorld;
/** People: Shay (screenshot), Tom, Uma qualify; Vic, Wes, Xan, Yo, Zed don't (see beforeEach). */
let shay: string, tom: string, uma: string, vic: string, wes: string, xan: string, yo: string, zed: string;
/** The show he holds tickets to (6 days out) and its ticket. */
let U: string, uTicket: string;
/** Past happenings: M1 the same band, M2 a similar band elsewhere, M3 a Partiful party, M4 a calendar gig. */
let m1: string, m2: string, m3: string, m4: string;
const links: Record<string, string> = {};

const ctx = (now = NOW): GeneratorContext => ({ db: w.db, now, timeZone: TZ, settings: settingsSnapshot(w.db), runId: null, log: nullLogger });
const candidates = (now = NOW) => eventInviteCandidates(w.db, now, TZ);
const forU = (now = NOW) => candidates(now).find((c) => c.links?.occasionId === U) ?? null;
const picks = (now = NOW) => forU(now)?.personIds ?? null;

/** The Partiful event's guest list as the refresh job leaves it (read 'ok' at `at`). */
function listRead(eventId: string, at = NOW, status = 'ok'): void {
  w.db.prepare(
    `INSERT INTO partiful_event_sync (event_id, guests_fetched_at, guests_status, updated_at)
     SELECT source_event_id, ?, ?, ? FROM events WHERE id = ?
     ON CONFLICT (event_id) DO UPDATE SET guests_fetched_at = excluded.guests_fetched_at, guests_status = excluded.guests_status`,
  ).run(at, status, at, eventId);
}

/** A show 'days' out with Velvet Static (the same band as U), holding by default. */
function show(days: number, o: { status?: string; sensitive?: boolean; title?: string } = {}): { occ: string; ticket: string } {
  const ticket = ticketEvent(w.db, { title: o.title ?? 'Velvet Static', start: at(days, 20), performers: ['Velvet Static'], genres: ['indie rock'], status: o.status });
  return { ticket, occ: ticketOccasion(w.db, ticket, { title: o.title ?? 'Velvet Static', start: at(days, 20), sensitive: o.sensitive }) };
}

beforeEach(() => {
  w = intelWorld();
  shay = w.person('Shay', 'Sorrel');
  tom = w.person('Tom', 'Tansy');
  uma = w.person('Uma', 'Umber');
  vic = w.person('Vic', 'Vetch');
  wes = w.person('Wes', 'Willow');
  xan = w.person('Xan', 'Yarrow');
  yo = w.person('Yo', 'Yew');
  zed = w.person('Zed', 'Zinnia');
  screenshotOf(w.db, shay);
  screenshotOf(w.db, xan);

  uTicket = ticketEvent(w.db, {
    title: 'Velvet Static',
    start: at(6, 20),
    performers: ['Velvet Static'],
    genres: ['indie rock', 'dream pop'],
    venue: 'Lantern Hall',
    venueKey: 'lantern hall',
  });
  U = ticketOccasion(w.db, uTicket, { title: 'Velvet Static', start: at(6, 20), venue: 'Lantern Hall' });

  const t1 = ticketEvent(w.db, { title: 'Velvet Static spring tour', start: at(-40, 21), performers: ['Velvet Static'], genres: ['indie rock'], status: 'gave_away' });
  m1 = ticketOccasion(w.db, t1, { title: 'Velvet Static spring tour', start: at(-40, 21) });
  const t2 = ticketEvent(w.db, { title: 'Glass Harbor', start: at(-20, 22), performers: ['Glass Harbor'], genres: ['indie rock', 'shoegaze'], venue: 'The Annex', venueKey: 'annex' });
  m2 = ticketOccasion(w.db, t2, { title: 'Glass Harbor', start: at(-20, 22), venue: 'The Annex' });
  m3 = w.partiful({ title: 'Rooftop birthday', start: at(-10, 20) });
  m4 = occasion(w.db, { title: 'Velvet Static live', start: at(-60, 20) });

  // Shay (screenshot) met at a similar band's show (sim 0.367: tier A only); Tom and Uma at the same band (sim 1).
  links.shay = metAt(w.db, shay, { occasionId: m2 }, { confidence: 0.85, signal: 'contact_screenshot' });
  links.tom = metAt(w.db, tom, { occasionId: m1 }, { confidence: 0.8 });
  links.uma = metAt(w.db, uma, { occasionId: m4 }, { confidence: 0.75, signal: 'instagram_follow' });
  // Vic: tier B needs sim ≥ 0.5; Wes: tier B needs conf ≥ 0.7; Xan (screenshot): a party is nothing like a concert;
  // Yo: a link under 0.6; Zed: a withdrawn link.
  links.vic = metAt(w.db, vic, { occasionId: m2 }, { confidence: 0.9 });
  links.wes = metAt(w.db, wes, { occasionId: m1 }, { confidence: 0.65 });
  links.xan = metAt(w.db, xan, { eventId: m3 }, { confidence: 0.9, signal: 'contact_screenshot' });
  links.yo = metAt(w.db, yo, { occasionId: m1 }, { confidence: 0.55 });
  links.zed = metAt(w.db, zed, { occasionId: m1 }, { confidence: 0.95, status: 'withdrawn' });
});

describe('who to bring', () => {
  it('screenshot people first (tier A, sim ≥ 0.35), then tier B (sim ≥ 0.5, conf ≥ 0.7) by score; at most 3', () => {
    const c = forU()!;
    expect(c.personIds).toEqual([shay, tom, uma]);
    expect(c).toMatchObject({
      kind: 'event_invite',
      subjectKey: `tkt:${uTicket}`,
      base: EVENT_INVITE.baseScreenshot,
      evidenceIds: [`occ:${U}`, `occ:${m2}`, `occ:${m1}`, `occ:${m4}`],
      expiresAt: at(6, 20),
      links: { occasionId: U, eventId: null },
      payload: {
        startsAt: at(6, 20),
        daysOut: 6,
        metRefs: [`o:${m2}`, `o:${m1}`, `o:${m4}`],
        metLinkIds: [links.shay, links.tom, links.uma],
        sims: [0.367, 1, 1],
        confs: [0.85, 0.8, 0.75],
        screenshot: [1, 0, 0],
      },
    });
    expect(c.timeCritical).toBeFalsy();
    expect(c.sensitive).toBeFalsy();
    // Payload: ids and numbers only.
    const json = JSON.stringify(c.payload);
    for (const s of ['Shay', 'Tom', 'Velvet', 'Glass', 'Lantern', 'Annex', 'Rooftop']) expect(json).not.toContain(s);
  });

  it('a fourth qualifying person is left out; without a screenshot person the base is 0.6', () => {
    const ana = w.person('Ana', 'Arbor');
    metAt(w.db, ana, { occasionId: m1 }, { confidence: 0.9 });
    expect(picks()).toEqual([shay, ana, tom]);
    w.db.prepare(`UPDATE contact_screenshots SET status = 'ambiguous'`).run();
    const c = forU()!;
    // Shay is tier B now: sim 0.367 < 0.5 → out.
    expect(c.personIds).toEqual([ana, tom, uma]);
    expect(c.base).toBe(EVENT_INVITE.base);
    expect(c.payload.screenshot).toEqual([0, 0, 0]);
  });

  it('a happening is never "similar" to itself, and a future met-at target never counts', () => {
    const ana = w.person('Ana', 'Arbor');
    metAt(w.db, ana, { occasionId: U }, { confidence: 0.95 });
    const later = show(10);
    const bo = w.person('Bo', 'Birch');
    metAt(w.db, bo, { occasionId: later.occ }, { confidence: 0.95 });
    expect(picks()).toEqual([shay, tom, uma]);
  });

  it('tier A needs only a 0.6 link (not 0.7); an IG profile showing ≥ 5k followers is no contact screenshot', () => {
    w.db.prepare('UPDATE person_met_at SET confidence = 0.62 WHERE id = ?').run(links.shay);
    expect(picks()).toEqual([shay, tom, uma]);
    expect(forU()!.payload.confs).toEqual([0.62, 0.8, 0.75]);
    w.db.prepare(`UPDATE contact_screenshots SET kind = 'instagram_profile', found = '{"followers":6200}' WHERE person_id = ?`).run(shay);
    expect(picks()).toEqual([tom, uma]);
  });

  it('a Partiful event met there (even one an occasion covers by now) counts: e: ref, event: evidence, named in copy', () => {
    const pty = w.partiful({ title: 'Pier Nine rooftop party', start: at(-12, 20), location: 'Pier Nine, Springfield' });
    const ana = w.person('Ana', 'Arbor');
    screenshotOf(w.db, ana);
    const link = metAt(w.db, ana, { eventId: pty }, { confidence: 0.8 });
    occasion(w.db, { title: 'Pier Nine rooftop party', start: at(-12, 20), eventId: pty });
    const t = ticketEvent(w.db, { title: 'Harbor Lights Dance Party', start: at(8, 21), category: 'party', venue: 'Pier Nine', venueKey: 'pier nine' });
    const occ = ticketOccasion(w.db, t, { title: 'Harbor Lights Dance Party', start: at(8, 21), venue: 'Pier Nine' });
    const c = candidates().find((x) => x.links?.occasionId === occ)!;
    // same category (party) + same venue: 0.45, a screenshot person (tier A)
    expect(c).toMatchObject({
      personIds: [ana],
      evidenceIds: [`occ:${occ}`, `event:${pty}`],
      payload: { metRefs: [`e:${pty}`], metLinkIds: [link], sims: [0.45], screenshot: [1], daysOut: 8 },
    });
    expect(metRefOf(w.db, ana, c.payload)).toBe(`e:${pty}`);
    expect(happeningOf(w.db, `e:${pty}`)?.title).toBe('Pier Nine rooftop party');
  });

  it('a met-at target merged since still resolves: copy names it, "Wrong" finds the link without its id', () => {
    const later = occasion(w.db, { title: 'Velvet Static spring tour (late show)', start: at(-40, 21) });
    w.db.prepare(`UPDATE occasions SET merged_into_id = ?, status = 'cancelled' WHERE id = ?`).run(later, m1);
    const c = forU()!;
    // The link row still says o:<m1>; the item names the survivor.
    expect(c.payload.metRefs).toEqual([`o:${m2}`, `o:${later}`, `o:${m4}`]);
    expect(metRefOf(w.db, tom, c.payload)).toBe(`o:${later}`);
    expect(metRefOf(w.db, tom, { ...c.payload, metLinkIds: [] })).toBe(`o:${later}`);
    expect(happeningOf(w.db, `o:${m1}`)?.title).toBe('Velvet Static spring tour (late show)');
    expect(eventInviteLinkIds(w.db, { personIds: [tom], payload: { metRefs: [`o:${later}`], metLinkIds: [] } })).toEqual([links.tom]);
    // Never another person's link, and nothing for an item naming several people.
    expect(eventInviteLinkIds(w.db, { personIds: [uma], payload: { metRefs: [`o:${later}`], metLinkIds: [] } })).toEqual([]);
    expect(eventInviteLinkIds(w.db, { personIds: [tom, uma], payload: c.payload })).toEqual([]);
  });

  it('nobody qualifies → no candidate; no met-at links at all → nothing', () => {
    w.db.prepare(`UPDATE person_met_at SET status = 'withdrawn' WHERE person_id IN (?, ?, ?)`).run(shay, tom, uma);
    expect(candidates()).toEqual([]);
    w.db.prepare(`DELETE FROM person_met_at`).run();
    expect(candidates()).toEqual([]);
  });

  it('is registered as the event_invite generator', async () => {
    expect(allGenerators().find((g) => g.kind === 'event_invite')).toBe(eventInviteGenerator);
    expect(generators).toContain(eventInviteGenerator);
    expect((await eventInviteGenerator.generate(ctx())).map((c) => c.subjectKey)).toEqual([`tkt:${uTicket}`]);
  });
});

describe('subjects', () => {
  it('holding tickets 1–21 local days out; today and day 22 are out', () => {
    const d0 = show(0);
    const d1 = show(1);
    const d21 = show(21);
    const d22 = show(22);
    const keys = candidates().map((c) => c.subjectKey);
    expect(keys).toEqual([`tkt:${d1.ticket}`, `tkt:${uTicket}`, `tkt:${d21.ticket}`]);
    expect(keys).not.toContain(`tkt:${d0.ticket}`);
    expect(keys).not.toContain(`tkt:${d22.ticket}`);
  });

  it('local days in the owner\'s zone: 11pm tonight there is today; 11:30pm on day 21 there is still in', () => {
    const LA = 'America/Los_Angeles';
    // NOW is 05:00 on Oct 14 in Los Angeles.
    const showAt = (start: number) => {
      const ticket = ticketEvent(w.db, { title: 'Velvet Static', start, performers: ['Velvet Static'], genres: ['indie rock'] });
      ticketOccasion(w.db, ticket, { title: 'Velvet Static', start });
      return ticket;
    };
    const tonight = showAt(Date.UTC(2026, 9, 15, 6, 0)); // Oct 14, 11pm there: day 0
    const tomorrow = showAt(Date.UTC(2026, 9, 15, 8, 0)); // Oct 15, 1am there: day 1
    const last = showAt(Date.UTC(2026, 10, 5, 7, 30)); // Nov 4, 11:30pm there (PST): day 21
    const out = eventInviteCandidates(w.db, NOW, LA);
    expect(out.map((c) => [c.subjectKey, c.payload.daysOut])).toEqual([
      [`tkt:${tomorrow}`, 1],
      [`tkt:${uTicket}`, 6],
      [`tkt:${last}`, 21],
    ]);
    expect(out.map((c) => c.subjectKey)).not.toContain(`tkt:${tonight}`);
    // In UTC the same shows fall on days 1 and 22.
    expect(candidates().map((c) => c.subjectKey)).toEqual([`tkt:${tonight}`, `tkt:${tomorrow}`, `tkt:${uTicket}`]);
  });

  it('only while holding: sold, given away, refunded, cancelled or unconfirmed tickets are no subject', () => {
    for (const status of ['sold', 'gave_away', 'refunded', 'cancelled', 'unconfirmed']) {
      w.db.prepare('UPDATE ticket_events SET status = ? WHERE id = ?').run(status, uTicket);
      expect([status, forU()]).toEqual([status, null]);
    }
    w.db.prepare(`UPDATE ticket_events SET status = 'holding' WHERE id = ?`).run(uTicket);
    expect(forU()).not.toBeNull();
  });

  it('never a sensitive, cancelled or non-social occasion', () => {
    for (const patch of ['sensitive = 1', `status = 'cancelled'`, 'is_social = 0']) {
      w.db.prepare(`UPDATE occasions SET ${patch} WHERE id = ?`).run(U);
      expect([patch, forU()]).toEqual([patch, null]);
      w.db.prepare(`UPDATE occasions SET sensitive = 0, status = 'active', is_social = 1 WHERE id = ?`).run(U);
    }
    expect(forU()).not.toBeNull();
  });

  it('the subject is the surviving ticket event, whatever id the occasion source still carries', () => {
    const survivor = ticketEvent(w.db, { title: 'Velvet Static', start: at(6, 20), performers: ['Velvet Static'], venueKey: 'lantern hall' });
    w.db.prepare('UPDATE ticket_events SET merged_into_id = ? WHERE id = ?').run(survivor, uTicket);
    expect(ticketedEvents(w.db, { startFrom: at(1, 0), startTo: at(22, 0) }).map((u) => u.ticketId)).toEqual([survivor]);
    expect(forU()!.subjectKey).toBe(`tkt:${survivor}`);
  });

  it('a show he hosts is party_invite’s, never an event_invite', () => {
    const hosted = w.partiful({ title: 'Velvet Static afterparty', start: at(6, 20), myRole: 'host' });
    listRead(hosted);
    w.db.prepare('UPDATE occasions SET event_id = ? WHERE id = ?').run(hosted, U);
    expect(forU()).toBeNull();
  });

  it('a linked Partiful event (on the occasion, or named in the ticket mail) needs a guest list read in full within the hour', () => {
    const pty = w.partiful({ title: 'Velvet Static pregame', start: at(6, 18), myRsvp: 'GOING' });
    w.db.prepare('UPDATE occasions SET event_id = ? WHERE id = ?').run(pty, U);
    expect(forU()).toBeNull();
    listRead(pty, NOW - 2 * HOUR);
    expect(forU()).toBeNull();
    listRead(pty, NOW - 10 * 60_000, 'error');
    expect(forU()).toBeNull();
    listRead(pty, NOW - 10 * 60_000);
    expect(forU()).not.toBeNull();
    // A Partiful link only the ticket mail carried counts the same.
    w.db.prepare('UPDATE occasions SET event_id = NULL WHERE id = ?').run(U);
    const other = w.partiful({ title: 'Lantern Hall meetup', start: at(6, 19) });
    const sourceId = w.db.prepare('SELECT source_event_id FROM events WHERE id = ?').pluck().get(other) as string;
    w.db.prepare('UPDATE ticket_events SET partiful_ids = ? WHERE id = ?').run(JSON.stringify([sourceId]), uTicket);
    expect(forU()).toBeNull();
    listRead(other);
    expect(forU()).not.toBeNull();
    // … and someone on that list is going.
    w.guest(other, tom, 'going');
    listRead(other);
    expect(picks()).toEqual([shay, uma]);
  });
});

describe('never anyone already going (when in doubt, they stay out)', () => {
  let ana: string;
  beforeEach(() => {
    ana = w.person('Ana', 'Arbor');
    metAt(w.db, ana, { occasionId: m1 }, { confidence: 0.9 });
    expect(picks()).toEqual([shay, ana, tom]);
  });
  const without = () => [shay, tom, uma];

  const cases: [string, () => void][] = [
    ['an attendee row on U in any status (even declined)', () => w.attendee(U, ana, { status: 'declined', source: 'user' })],
    ['an attendee row on an occasion merged into U', () => {
      const dupe = occasion(w.db, { title: 'Velvet Static', start: at(6, 20) });
      w.db.prepare(`UPDATE occasions SET merged_into_id = ?, status = 'cancelled' WHERE id = ?`).run(U, dupe);
      w.attendee(dupe, ana, { status: 'going' });
    }],
    ['holding a ticket he transferred to her (named on the transfer email)', () => ticketParty(w.db, uTicket, { name: 'Ana Arbor' })],
    ['a transfer to her email address', () => {
      seedIdentity(w.db, ana, 'email', 'ana.arbor@example.com');
      ticketParty(w.db, uTicket, { name: null, emailKey: 'ana.arbor@example.com' });
    }],
    ['a first name alone, when that is all the email gave', () => ticketParty(w.db, uTicket, { name: 'Ana', direction: 'received_from' })],
    ['a nickname of her first name alone', () => ticketParty(w.db, uTicket, { name: 'Anna' })],
    ['a first name alone beside an email we can’t place', () => ticketParty(w.db, uTicket, { name: 'Ana', emailKey: 'a.smith@example.com' })],
    ['her first name and last initial', () => ticketParty(w.db, uTicket, { name: 'Ana A.' })],
    ['a counterparty found only through its message', () => ticketParty(w.db, uTicket, { name: 'Ana Arbor', viaMessageOnly: true })],
    ['a resolved counterparty on another order that night at the same venue', () => {
      const other = ticketEvent(w.db, { title: 'Velvet Static (late show)', start: at(6, 23), localDate: new Date(at(6, 20)).toISOString().slice(0, 10), venueKey: 'lantern hall', status: 'gave_away' });
      ticketParty(w.db, other, { name: 'A.', personId: ana });
    }],
    ['a counterparty on an order merged into U’s ticket', () => {
      const old = ticketEvent(w.db, { title: 'Velvet Static', start: at(6, 20), mergedInto: uTicket });
      ticketParty(w.db, old, { name: 'Ana Arbor' });
    }],
    ['an open maybe-match of a resolved counterparty', () => {
      const other = seedPerson(w.db, { display_name: 'A. Arbor-Smith', first_name: 'A.', last_name: 'Arbor-Smith', status: 'roster_only' });
      ticketParty(w.db, uTicket, { name: 'A. Arbor-Smith', personId: other });
      const [a, b] = ana < other ? [ana, other] : [other, ana];
      w.db.prepare(`INSERT INTO match_candidates (a_id, b_id, score_bits, p, status, created_at, updated_at) VALUES (?, ?, 9, 0.8, 'pending', ?, ?)`).run(a, b, NOW, NOW);
    }],
    ['a calendar invitee by email', () => {
      seedIdentity(w.db, ana, 'email', 'ana.arbor@example.com');
      const cal = uuidv7();
      const attendees = [
        { email: 'owner@example.com', self: true, organizer: false },
        { email: 'ana.arbor@example.com', name: null, self: false, organizer: false },
      ];
      w.db.prepare(
        `INSERT INTO calendar_events (id, calendar_id, google_event_id, summary, starts_at, ends_at, self_organizer, attendees, ingested_at, updated_at)
         VALUES (?, 'personal@example.com', ?, 'Velvet Static', ?, ?, 0, ?, ?, ?)`,
      ).run(cal, `g${cal.slice(-12)}`, at(6, 20), at(6, 23), JSON.stringify(attendees), NOW, NOW);
      w.db.prepare(`INSERT INTO occasion_sources (occasion_id, source, source_ref, role, created_at) VALUES (?, 'calendar', ?, 'primary', ?)`).run(U, cal, NOW);
    }],
    ['a name on the linked Partiful list (SMS invite, no account)', () => {
      const pty = w.partiful({ title: 'Velvet Static pregame', start: at(6, 18) });
      listRead(pty);
      w.db.prepare('UPDATE occasions SET event_id = ? WHERE id = ?').run(pty, U);
      w.db.prepare(`INSERT INTO partiful_guest_names (event_id, name, status, updated_at) VALUES (?, 'Ana Arbor', 'invited', ?)`).run(pty, NOW);
    }],
    ['hidden', () => w.db.prepare('UPDATE people SET is_hidden = 1 WHERE id = ?').run(ana)],
    ['roster-only', () => w.db.prepare(`UPDATE people SET status = 'roster_only' WHERE id = ?`).run(ana)],
    ['muted for event invites', () => w.db.prepare(`INSERT INTO learner_person_state (person_id, muted_kinds, updated_at) VALUES (?, '["event_invite"]', ?)`).run(ana, NOW)],
    ['muted entirely', () => w.db.prepare(`INSERT INTO learner_person_state (person_id, muted, updated_at) VALUES (?, 1, ?)`).run(ana, NOW)],
    ['resting after ignored suggestions', () => w.db.prepare(`INSERT INTO learner_person_state (person_id, consecutive_ignores, cooldown_until, updated_at) VALUES (?, 2, ?, ?)`).run(ana, NOW + 5 * DAY, NOW)],
  ];
  for (const [label, arrange] of cases) {
    it(label, () => {
      arrange();
      expect(picks()).toEqual(without());
    });
  }

  for (const resolved of [false, true]) {
    it(`a full-name counterparty (${resolved ? 'resolved to another record' : 'unresolved'}) keeps out a record with only that first name`, () => {
      // Bea is known by her first name alone (an Instagram acquaintance): nothing tells her apart from "Bea Quill".
      const bea = seedPerson(w.db, { display_name: 'Bea', first_name: 'Bea', last_name: null });
      metAt(w.db, bea, { occasionId: m1 }, { confidence: 0.95 });
      const birch = w.person('Bea', 'Birch');
      metAt(w.db, birch, { occasionId: m1 }, { confidence: 0.92 });
      expect(picks()).toEqual([shay, bea, birch]);
      const other = resolved ? seedPerson(w.db, { display_name: 'Bea Quill', first_name: 'Bea', last_name: 'Quill' }) : null;
      ticketParty(w.db, uTicket, { name: 'Bea Quill', personId: other });
      // Bea Birch has another family name: still in.
      expect(picks()).toEqual([shay, birch, ana]);
    });
  }

  it('a different first name, another family name, or a past rest period never keeps her out', () => {
    ticketParty(w.db, uTicket, { name: 'Bo' });
    ticketParty(w.db, uTicket, { name: 'Ana Birch' });
    ticketParty(w.db, uTicket, { name: 'Ana B.' });
    ticketParty(w.db, uTicket, { emailKey: 'someone.else@example.com' });
    w.db.prepare(`INSERT INTO learner_person_state (person_id, consecutive_ignores, cooldown_until, updated_at) VALUES (?, 1, ?, ?)`).run(ana, NOW - DAY, NOW);
    // A counterparty of another show on another date is not this show.
    const other = ticketEvent(w.db, { title: 'Glass Harbor', start: at(9, 20), venueKey: 'lantern hall' });
    ticketParty(w.db, other, { name: 'Ana Arbor' });
    expect(picks()).toEqual([shay, ana, tom]);
  });
});

describe('the suggestions stage and delivery', () => {
  async function stage(gens: CandidateGenerator[] = [eventInviteGenerator]) {
    const r = await runSuggestionsStage(w.db, { now: NOW, seed: 3, generators: gens, wildcardSources: [] });
    expect(r.status).toBe('ok');
    const id = w.db.prepare(`SELECT id FROM suggestions WHERE kind = 'event_invite' ORDER BY created_at, id LIMIT 1`).pluck().get() as string;
    return { r, id };
  }
  const selection = (now: number) => readDigestSelection(w.db, { localDate: '2026-10-14', now })!;
  const itemFor = (now: number) => selection(now).items.find((i) => i.kind === 'event_invite');

  it('stores the item linked to the occasion; Today deep-links to the event', async () => {
    const { r, id } = await stage();
    expect(r.selectedIds).toContain(id);
    expect(w.db.prepare('SELECT occasion_id, event_id, person_ids, dedupe_key, expires_at FROM suggestions WHERE id = ?').get(id)).toEqual({
      occasion_id: U,
      event_id: null,
      person_ids: JSON.stringify([shay, tom, uma]),
      dedupe_key: `event_invite:tkt:${uTicket}`,
      expires_at: at(6, 20),
    });
    const item = itemFor(NOW + HOUR)!;
    expect(targetOf(item)).toEqual({ type: 'event', id: U, otherId: null, href: `/e/${U}` });
  });

  it('before it goes out: people who joined since drop out; all of them, or tickets no longer held, drop the item', async () => {
    await stage();
    expect(itemFor(NOW + HOUR)!.people.map((p) => p.id)).toEqual([shay, tom, uma]);
    // Tom got a ticket from the owner (a transfer email), Shay RSVPd on the occasion.
    ticketParty(w.db, uTicket, { name: 'Tom Tansy' });
    w.attendee(U, shay, { status: 'going', source: 'user' });
    expect(itemFor(NOW + HOUR)!.people.map((p) => p.id)).toEqual([uma]);
    expect(eventInviteStale(w.db, { occasionId: U, eventId: null, personIds: [shay, tom, uma] }, NOW + HOUR)).toEqual({ stale: false, drop: new Set([shay, tom]) });
    w.attendee(U, uma, { status: 'maybe', source: 'user' });
    expect(itemFor(NOW + HOUR)).toBeUndefined();
    expect(selection(NOW + HOUR).droppedStale).toBe(1);
  });

  it('someone whose met-at link he has marked wrong since (on their page) drops out', async () => {
    await stage();
    withRun(w.db, 'user', (runId) => rejectMetAtLinks(w.db, [links.tom!], { runId, actor: 'user', now: NOW + 30 * 60_000 }));
    expect(itemFor(NOW + HOUR)!.people.map((p) => p.id)).toEqual([shay, uma]);
  });

  it('the whole item goes once the tickets are sold, the occasion is gone or sensitive', async () => {
    await stage();
    expect(itemFor(NOW + HOUR)).toBeTruthy();
    w.db.prepare(`UPDATE ticket_events SET status = 'sold' WHERE id = ?`).run(uTicket);
    expect(itemFor(NOW + HOUR)).toBeUndefined();
    expect(eventInviteStale(w.db, { occasionId: U, eventId: null, personIds: [shay] }, NOW + HOUR).stale).toBe(true);
    w.db.prepare(`UPDATE ticket_events SET status = 'holding' WHERE id = ?`).run(uTicket);
    w.db.prepare('UPDATE occasions SET sensitive = 1 WHERE id = ?').run(U);
    expect(itemFor(NOW + HOUR)).toBeUndefined();
    expect(eventInviteStale(w.db, { occasionId: null, eventId: null, personIds: [shay] }, NOW).stale).toBe(true);
    expect(eventInviteStale(w.db, { occasionId: 'missing', eventId: null, personIds: [shay] }, NOW).stale).toBe(true);
  });

  it('one item by id as of now ("more"): never a show whose tickets are gone, never someone who joined since', async () => {
    const { id } = await stage();
    expect(selectedItemById(w.db, id, 4, NOW + HOUR)!.people.map((p) => p.id)).toEqual([shay, tom, uma]);
    ticketParty(w.db, uTicket, { name: 'Tom Tansy' });
    expect(selectedItemById(w.db, id, 4, NOW + HOUR)!.people.map((p) => p.id)).toEqual([shay, uma]);
    w.db.prepare(`UPDATE ticket_events SET status = 'sold' WHERE id = ?`).run(uTicket);
    expect(selectedItemById(w.db, id, 4, NOW + HOUR)).toBeNull();
  });

  describe('someone who joins after the brief was composed', () => {
    const MIN = 60_000;
    const services = () => ({ llm: new FakeLlmClient({ configured: false }), egress: new FakeEgress() });
    const linkStatus = (linkId: string) => w.db.prepare('SELECT status FROM person_met_at WHERE id = ?').pluck().get(linkId);
    /** Only Shay and Tom qualify; the brief (template copy) names both. */
    async function composed(): Promise<string> {
      w.db.prepare(`UPDATE person_met_at SET status = 'withdrawn' WHERE id = ?`).run(links.uma);
      const { id } = await stage();
      const c = await composeDigest(w.db, services(), { localDate: '2026-10-14', now: NOW + 10 * MIN, useLlm: false });
      expect(c!.items.find((i) => i.suggestionId === id)!.headline).toBe('Invite Shay S. and Tom T. to Velvet Static?');
      return id;
    }
    /** Today's brief goes out (its time set to 12:30). */
    async function send(at: number): Promise<FakeOutboundSender> {
      writeSettings(w.db, { 'digest.enabled': true, 'digest.time': '12:30', 'digest.catch_up_until': '14:00', self_handles: ['owner@example.com'] }, { actor: 'user', allowInternal: true });
      const outbound = new FakeOutboundSender({ db: w.db, now: () => at, selfHandle: 'owner@example.com' });
      expect((await deliveryTick({ db: w.db, services: { ...services(), outbound }, push: new FakePushSender(), now: () => at })).imessage).toBe('sent');
      return outbound;
    }
    const card = async (id: string, now: number) => (await digestCards(w.db, services(), { localDate: '2026-10-14', now })).find((c) => c.suggestionId === id);

    it('before it goes out: it is recomposed, so the text names only the rest', async () => {
      const id = await composed();
      ticketParty(w.db, uTicket, { name: 'Tom Tansy' });
      expect(compositionCurrent(selection(NOW + 20 * MIN))).toBe(false);
      expect(await card(id, NOW + 20 * MIN)).toMatchObject({ headline: 'Invite Shay S. to Velvet Static?', people: [expect.objectContaining({ id: shay })] });
      const text = (await send(NOW + 30 * MIN)).sent.map((m) => m.text).join('\n');
      expect(text).toContain('Invite Shay S. to Velvet Static?');
      expect(text).not.toContain('Tom');
    });

    it('after it went out: the card names only the rest (template copy); the texts stay as they were sent', async () => {
      const id = await composed();
      await send(NOW + 30 * MIN);
      ticketParty(w.db, uTicket, { name: 'Tom Tansy' });
      expect(await card(id, NOW + HOUR)).toMatchObject({
        headline: 'Invite Shay S. to Velvet Static?',
        body: 'You have tickets to Velvet Static on Oct 20. You met Shay at Glass Harbor.',
        copy: 'template',
        people: [expect.objectContaining({ id: shay })],
      });
      expect(w.db.prepare(`SELECT imessage_text FROM digests WHERE local_date = '2026-10-14'`).pluck().get()).toContain('Invite Shay S. and Tom T. to Velvet Static?');
    });

    it('"Wrong" on that card acts on the one person it shows; a reply to the text that named both only rests them', async () => {
      const id = await composed();
      await send(NOW + 30 * MIN);
      ticketParty(w.db, uTicket, { name: 'Tom Tansy' });
      expect((await applySuggestionFeedback(w.db, id, { action: 'wrong' }, { channel: 'imessage', now: NOW + HOUR })).batchId).toBeNull();
      expect([linkStatus(links.shay!), linkStatus(links.tom!)]).toEqual(['active', 'active']);
      const fb = w.db.prepare(`SELECT id FROM feedback WHERE suggestion_id = ? AND action = 'wrong'`).pluck().get(id) as string;
      undoSuggestionFeedback(w.db, fb, { now: NOW + HOUR + MIN, channel: 'imessage' });
      expect((await applySuggestionFeedback(w.db, id, { action: 'wrong' }, { channel: 'web', now: NOW + 2 * HOUR })).batchId).not.toBeNull();
      expect([linkStatus(links.shay!), linkStatus(links.tom!)]).toEqual(['rejected', 'active']);
    });
  });

  it('a linked Partiful list that goes stale before the send drops the item', async () => {
    const pty = w.partiful({ title: 'Velvet Static pregame', start: at(6, 18) });
    listRead(pty, NOW - 10 * 60_000);
    w.db.prepare('UPDATE occasions SET event_id = ? WHERE id = ?').run(pty, U);
    await stage();
    expect(itemFor(NOW + 10 * 60_000)).toBeTruthy();
    expect(itemFor(NOW + 55 * 60_000)).toBeUndefined();
  });

  it('acting: a message to one of them, or one of them joining the event, within 7 days', async () => {
    const { id } = await stage();
    recordImpressions(w.db, [id], { now: NOW, channel: 'web' });
    w.attendee(U, uma, { status: 'going', source: 'inference' });
    w.db.prepare('UPDATE event_attendees SET created_at = ? WHERE occasion_id = ? AND person_id = ?').run(NOW + 2 * HOUR, U, uma);
    const out = await attributeRewards(w.db, { now: NOW + 3 * HOUR });
    expect(out.stats).toMatchObject({ acted: 1 });
    expect(w.db.prepare('SELECT status, rank_details FROM suggestions WHERE id = ?').get(id)).toMatchObject({
      status: 'done',
      rank_details: expect.stringContaining('"actedVia":"guest_list"'),
    });
  });
});

describe('copy', () => {
  /** One stage run per test (the stage runs once a day): stores the candidates, returns their suggestion ids. */
  async function storeCandidates(...cs: Candidate[]): Promise<string[]> {
    await runSuggestionsStage(w.db, { now: NOW, seed: 3, generators: [{ kind: 'event_invite', generate: () => cs }], wildcardSources: [] });
    return cs.map((c) => w.db.prepare('SELECT id FROM suggestions WHERE dedupe_key = ?').pluck().get(`event_invite:${c.subjectKey}`) as string);
  }
  const storeCandidate = async (c: Candidate): Promise<string> => (await storeCandidates(c))[0]!;
  const one = (c: Candidate, i: number, subjectKey = `${c.subjectKey}:${i}`): Candidate => ({
    ...c,
    subjectKey,
    personIds: [c.personIds[i]!],
    payload: Object.fromEntries(Object.entries(c.payload).map(([k, v]) => [k, Array.isArray(v) ? [v[i]] : v])) as Candidate['payload'],
  });

  it('template: names the show, the day and where the first person was met; no ids leak', async () => {
    const c = forU()!;
    const id = await storeCandidate(c);
    const copy = templateCopy(selectedItemById(w.db, id, 1)!, { db: w.db, now: NOW, timeZone: TZ });
    expect(copy).toEqual({
      headline: 'Invite Shay S., Tom T. and 1 other to Velvet Static?',
      body: 'You have tickets to Velvet Static on Oct 20. You met Shay at Glass Harbor.',
      openers: [],
    });
    const text = JSON.stringify(copy);
    for (const x of [U, uTicket, m2, links.shay!]) expect(text).not.toContain(x);
  });

  it('template: "them" when everyone met at the same place; a sensitive or gone met-at event is never named', async () => {
    const ana = w.person('Ana', 'Arbor');
    metAt(w.db, ana, { occasionId: m1 }, { confidence: 0.9 });
    const c = forU()!;
    expect(c.personIds).toEqual([shay, ana, tom]);
    const pair: Candidate = {
      ...c,
      subjectKey: `${c.subjectKey}:pair`,
      personIds: [ana, tom],
      payload: { ...c.payload, metRefs: [`o:${m1}`], metLinkIds: [], sims: [1, 1], confs: [0.9, 0.8], screenshot: [0, 0] },
    };
    const [pairId, shayOnly] = await storeCandidates(pair, one(c, 0));
    expect(templateCopy(selectedItemById(w.db, pairId!, 1)!, { db: w.db, now: NOW, timeZone: TZ }).body).toBe(
      'You have tickets to Velvet Static on Oct 20. You met them at Velvet Static spring tour.',
    );
    w.db.prepare('UPDATE occasions SET sensitive = 1 WHERE id = ?').run(m2);
    expect(templateCopy(selectedItemById(w.db, shayOnly!, 1)!, { db: w.db, now: NOW, timeZone: TZ })).toEqual({
      headline: 'Invite Shay S. to Velvet Static?',
      body: 'You have tickets to Velvet Static on Oct 20. You met Shay at a similar event.',
      openers: [],
    });
  });

  it('history headline, "Why this?" and template openers', () => {
    const t = (names: string[], payload: Record<string, unknown>): TextInput => ({
      kind: 'event_invite',
      isWildcard: false,
      wildcardGenerator: null,
      names,
      firstNames: names.map((n) => n.split(' ')[0]!),
      circleName: null,
      payload,
    });
    const two = t(['Shay S.', 'Tom T.'], { daysOut: 6, sims: [0.367, 1], screenshot: [1, 0] });
    expect(templateHeadline(two)).toBe('Invite to a show · Shay S. and Tom T.');
    expect(whySummary(two)).toBe('You have tickets to something in 6 days, and you met Shay S. and Tom T. at a similar event. You saved one of their contacts from screenshots.');
    expect(whySummary(t(['Shay S.'], { daysOut: 1, screenshot: [1] }))).toBe(
      'You have tickets to something in 1 day, and you met Shay S. at a similar event. You saved their contact from a screenshot.',
    );
    expect(whySummary(t(['Tom T.'], {}))).toBe('You have tickets to something soon, and you met Tom T. at a similar event.');
    expect(whySignals(two.payload)).toEqual([
      { label: 'Starts in', value: '6 days' },
      { label: 'Like where you met', value: '100% similar' },
    ]);
    for (const o of templateOpeners(two)) {
      expect(o).toMatch(/^(Hey )?Shay/);
      expect(o.length).toBeLessThanOrEqual(160);
    }
  });

  it('the composer packet names where each person was met, so copy naming it passes grounding', async () => {
    const id = await storeCandidate(forU()!);
    const item = selectedItemById(w.db, id, 1)!;
    const tpl = templateCopy(item, { db: w.db, now: NOW, timeZone: TZ });
    const egress = new FakeEgress();
    const { sections } = buildPacket(w.db, egress, [item], new Map([[id, tpl]]), { localDate: '2026-10-14', now: NOW, timeZone: TZ, excludedConversationIds: new Set() });
    const text = sections.map((s) => s.text).join('\n');
    const [ps, pt] = [egress.tokenFor(shay), egress.tokenFor(tom)];
    expect(text).toContain('kind: event invite (the owner has tickets to a show or event soon;');
    expect(text).toContain(`met: ${ps} at Glass Harbor · Sep 24`);
    expect(text).toContain(`met: ${pt} at Velvet Static spring tour · Sep 4`);
    expect(text).toMatch(/event: Velvet Static · Oct 20 8pm · the owner has tickets/);
    const out = { n: 1, headline: `Invite ${ps} to Velvet Static`, body: `You have tickets on Oct 20. You met ${ps} at Glass Harbor.`, openers: [], cites: [] };
    expect(groundingIssues(out, { text, refIds: new Set() })).toEqual([]);
    // An invented place fails.
    expect(groundingIssues({ ...out, body: `You met ${ps} at Copper Mill.` }, { text, refIds: new Set() })).not.toEqual([]);
  });
});

describe('"Wrong"', () => {
  async function stored(c: Candidate): Promise<string> {
    await runSuggestionsStage(w.db, { now: NOW, seed: 3, generators: [{ kind: 'event_invite', generate: () => [c] }], wildcardSources: [] });
    return w.db.prepare('SELECT id FROM suggestions WHERE dedupe_key = ?').pluck().get(`event_invite:${c.subjectKey}`) as string;
  }
  const status = (linkId: string) => w.db.prepare('SELECT status FROM person_met_at WHERE id = ?').pluck().get(linkId);

  it('on a one-person item rejects the met-at link behind it (journaled, undoable)', async () => {
    const c = forU()!;
    const id = await stored({ ...c, personIds: [tom], payload: { ...c.payload, metRefs: [`o:${m1}`], metLinkIds: [links.tom!], sims: [1], confs: [0.8], screenshot: [0] } });
    const res = await applySuggestionFeedback(w.db, id, { action: 'wrong' }, { channel: 'web', now: NOW + HOUR });
    expect(res.status).toBe('wrong');
    expect(res.batchId).not.toBeNull();
    expect(status(links.tom!)).toBe('rejected');
    expect(w.db.prepare('SELECT kind, actor FROM change_batches WHERE id = ?').get(res.batchId)).toEqual({ kind: 'met_at', actor: 'user' });
    // Others' links are untouched.
    expect([status(links.shay!), status(links.uma!), status(links.wes!)]).toEqual(['active', 'active', 'active']);
    // The next night Tom is no longer suggested for it.
    expect(picks(NOW + DAY)).not.toContain(tom);
    // Undo restores the link.
    const fb = w.db.prepare(`SELECT id FROM feedback WHERE suggestion_id = ? AND action = 'wrong'`).pluck().get(id) as string;
    undoSuggestionFeedback(w.db, fb, { now: NOW + 2 * HOUR, channel: 'web' });
    expect(status(links.tom!)).toBe('active');
  });

  it('finds the link by its target when the payload has no link id', async () => {
    const c = forU()!;
    const id = await stored({ ...c, personIds: [uma], payload: { ...c.payload, metRefs: [`o:${m4}`], metLinkIds: [], sims: [1], confs: [0.75], screenshot: [0] } });
    await applySuggestionFeedback(w.db, id, { action: 'wrong' }, { channel: 'imessage', now: NOW + HOUR });
    expect(status(links.uma!)).toBe('rejected');
  });

  it('a link the met-at run withdrew in the meantime still becomes a sticky rejection', async () => {
    const c = forU()!;
    const id = await stored({ ...c, personIds: [tom], payload: { ...c.payload, metRefs: [`o:${m1}`], metLinkIds: [links.tom!], sims: [1], confs: [0.8], screenshot: [0] } });
    w.db.prepare(`UPDATE person_met_at SET status = 'withdrawn' WHERE id = ?`).run(links.tom);
    await applySuggestionFeedback(w.db, id, { action: 'wrong' }, { channel: 'web', now: NOW + HOUR });
    expect(status(links.tom!)).toBe('rejected');
  });

  it('nothing left to reject: no journal run is opened, only the cooldown applies', async () => {
    const c = forU()!;
    const id = await stored({ ...c, personIds: [tom], payload: { ...c.payload, metRefs: [`o:${m1}`], metLinkIds: [links.tom!], sims: [1], confs: [0.8], screenshot: [0] } });
    w.db.prepare(`UPDATE person_met_at SET status = 'rejected' WHERE id = ?`).run(links.tom);
    const runs = () => w.db.prepare('SELECT count(*) FROM runs').pluck().get() as number;
    const before = runs();
    const res = await applySuggestionFeedback(w.db, id, { action: 'wrong' }, { channel: 'web', now: NOW + HOUR });
    expect(res).toMatchObject({ status: 'wrong', batchId: null });
    expect(runs()).toBe(before);
  });

  it('on an item with several people only the normal cooldown applies: no link is rejected', async () => {
    const id = await stored(forU()!);
    const res = await applySuggestionFeedback(w.db, id, { action: 'wrong' }, { channel: 'web', now: NOW + HOUR });
    expect(res.status).toBe('wrong');
    expect(res.batchId).toBeNull();
    expect([status(links.shay!), status(links.tom!), status(links.uma!)]).toEqual(['active', 'active', 'active']);
  });

  it('rejects what was shown: once selected, the nightly run never swaps an item’s people or met-at links', async () => {
    // Night 1: only Tom qualifies; the item naming him goes out.
    w.db.prepare(`UPDATE person_met_at SET status = 'withdrawn' WHERE id IN (?, ?)`).run(links.shay, links.uma);
    await runSuggestionsStage(w.db, { now: NOW, seed: 3, generators: [eventInviteGenerator], wildcardSources: [] });
    const id = w.db.prepare(`SELECT id FROM suggestions WHERE kind = 'event_invite'`).pluck().get() as string;
    const shown = () => {
      const r = w.db.prepare('SELECT person_id, person_ids, signals FROM suggestions WHERE id = ?').get(id) as { person_id: string; person_ids: string; signals: string };
      return { personId: r.person_id, personIds: JSON.parse(r.person_ids) as string[], metLinkIds: (JSON.parse(r.signals) as { metLinkIds: string[] }).metLinkIds };
    };
    expect(shown()).toEqual({ personId: tom, personIds: [tom], metLinkIds: [links.tom] });
    w.db.prepare(`UPDATE suggestions SET status = 'delivered', delivered_at = ? WHERE id = ?`).run(NOW + HOUR, id);
    // Night 2: the met-at run withdrew Tom's link and found Uma's again; the same show is emitted for Uma.
    w.db.prepare(`UPDATE person_met_at SET status = 'withdrawn' WHERE id = ?`).run(links.tom);
    w.db.prepare(`UPDATE person_met_at SET status = 'active' WHERE id = ?`).run(links.uma);
    expect(picks(NOW + DAY)).toEqual([uma]);
    await runSuggestionsStage(w.db, { now: NOW + DAY, seed: 3, generators: [eventInviteGenerator], wildcardSources: [] });
    expect(shown()).toEqual({ personId: tom, personIds: [tom], metLinkIds: [links.tom] });
    expect(w.db.prepare('SELECT count(*) FROM suggestions WHERE kind = ? AND status IN (?, ?, ?, ?)').pluck().get('event_invite', 'candidate', 'selected', 'delivered', 'snoozed')).toBe(1);
    // "wrong 1" to yesterday's text about Tom: Tom's link, never Uma's.
    await applySuggestionFeedback(w.db, id, { action: 'wrong' }, { channel: 'imessage', now: NOW + DAY + HOUR });
    expect([status(links.tom!), status(links.uma!)]).toEqual(['rejected', 'active']);
  });

  it('a candidate not shown yet is still refreshed, and so is a party invite once shown', async () => {
    const c = forU()!;
    const gen = (cs: Candidate[]): CandidateGenerator[] => [{ kind: cs[0]!.kind, generate: () => cs }];
    const none = { rank: () => ({ selected: [], wildcard: null, seed: 3, cap: 4, considered: {} }) };
    const run = (now: number, cs: Candidate[]) => runSuggestionsStage(w.db, { now, seed: 3, generators: gen(cs), wildcardSources: [], ranker: none });
    const personIds = (kind: string) => JSON.parse(w.db.prepare('SELECT person_ids FROM suggestions WHERE kind = ?').pluck().get(kind) as string) as string[];
    await run(NOW, [{ ...c, personIds: [tom], payload: { ...c.payload, metLinkIds: [links.tom!] } }]);
    await run(NOW + DAY, [{ ...c, personIds: [uma], payload: { ...c.payload, metLinkIds: [links.uma!] } }]);
    expect(personIds('event_invite')).toEqual([uma]);
    const party: Candidate = { kind: 'party_invite', personIds: [tom], subjectKey: 'event:party-1', base: 0.6, evidenceIds: [], expiresAt: null, payload: {} };
    await run(NOW + 2 * DAY, [party]);
    w.db.prepare(`UPDATE suggestions SET status = 'delivered', delivered_at = ? WHERE kind = 'party_invite'`).run(NOW + 2 * DAY + HOUR);
    await run(NOW + 3 * DAY, [{ ...party, personIds: [uma] }]);
    expect(personIds('party_invite')).toEqual([uma]);
  });

  it('rejectEventInviteLinks: exactly one person, only that person’s links, reports the batches it wrote', () => {
    const payload = { metRefs: [`o:${m1}`], metLinkIds: [links.tom!, links.shay!] };
    withRun(w.db, 'user', (runId) => {
      expect(rejectEventInviteLinks(w.db, { personIds: [tom, uma], payload }, { runId, now: NOW })).toEqual({ rejected: 0, batchIds: [] });
      const r = rejectEventInviteLinks(w.db, { personIds: [tom], payload }, { runId, now: NOW });
      expect(r.rejected).toBe(1);
      expect(r.batchIds).toHaveLength(1);
      // Shay's link id in the payload is not Tom's: untouched.
      expect(status(links.shay!)).toBe('active');
      expect(rejectEventInviteLinks(w.db, { personIds: [tom], payload }, { runId, now: NOW })).toEqual({ rejected: 0, batchIds: [] });
    });
  });
});
