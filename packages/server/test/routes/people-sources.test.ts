/**
 * People API with the new sources: WhatsApp / Instagram (Beeper, export) / Partiful / Contacts identities on the
 * person page, per-channel session badges and filters on the timeline, get-together links, masked list handles.
 * Synthetic data only (555-01xx, example.com, invented names).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuidv7 } from '@yb/shared';
import { createApp } from '../../src/http/app';
import type { PeoplePage, PersonDetail, TimelinePage } from '../../src/routes/people';
import { channelOf, identityValue } from '../../src/routes/people';
import { rebuildCallInteractions } from '../../src/adapters/calls/interactions';
import { seedIdentity, T0 } from '../helpers';
import { buildWorld, DAY, MIN, type World } from './world';

let w: World;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  w = buildWorld();
  app = createApp({ db: w.db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });
});

const get = async <T>(url: string, status = 200): Promise<T> => {
  const res = await request(app).get(url);
  expect(res.status, `${url} → ${res.text}`).toBe(status);
  return res.body as T;
};

/** A DM on another source with one session, from `identityId`. */
function dm(source: string, identityId: string, at: number): string {
  const conv = uuidv7();
  w.db
    .prepare(`INSERT INTO conversations (id, source, source_conv_id, kind, created_at, updated_at) VALUES (?, ?, ?, 'direct', ?, ?)`)
    .run(conv, source, conv, T0, T0);
  w.db
    .prepare(`INSERT INTO conversation_members (conversation_id, identity_id, source, first_seen_at, last_seen_at) VALUES (?, ?, 'roster', ?, ?)`)
    .run(conv, identityId, T0, T0);
  const msg = Number(
    w.db
      .prepare(
        `INSERT INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text, ingested_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, 'text', 'hi', ?, ?)`,
      )
      .run(source, uuidv7(), conv, identityId, at, T0, T0).lastInsertRowid,
  );
  const session = uuidv7();
  w.db
    .prepare(
      `INSERT INTO sessions (id, conversation_id, started_at, ended_at, first_msg, last_msg, msg_count, initiated_by_me) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
    )
    .run(session, conv, at, at, msg, msg);
  return session;
}

describe('linked accounts from the new sources', () => {
  it('shows WhatsApp, Instagram, Partiful and Contacts identities (a WhatsApp number in full, ids masked), with source, method and confidence', async () => {
    const wa = seedIdentity(w.db, w.alice, 'whatsapp_jid', '15555550101@s.whatsapp.test', { source: 'whatsapp', match_method: 'deterministic' });
    const lid = seedIdentity(w.db, w.alice, 'whatsapp_lid', '123456789012345@lid', { source: 'whatsapp', match_method: 'deterministic' });
    const igId = seedIdentity(w.db, w.alice, 'instagram_id', '17841400000000001', { source: 'beeper', match_method: 'deterministic' });
    const igName = seedIdentity(w.db, w.alice, 'instagram_name', 'ig_dyi:thread-42:Alice A.', {
      source: 'instagram_dyi',
      match_method: 'probabilistic',
      confidence: 0.6,
    });
    const pf = seedIdentity(w.db, w.alice, 'partiful_user', 'pfUserSynthetic01', { source: 'partiful', match_method: 'deterministic' });
    const card = seedIdentity(w.db, w.alice, 'addressbook_id', 'AB-CARD-0001:ABPerson', { source: 'addressbook', match_method: 'addressbook' });

    const p = await get<PersonDetail>(`/api/v1/people/${w.alice}`);
    const byId = Object.fromEntries(p.identities.map((i) => [i.id, i]));
    expect(byId[wa]).toMatchObject({ kind: 'whatsapp_jid', source: 'whatsapp', value: '(555) 555-0101', masked: false, revealable: false });
    expect(byId[lid]).toMatchObject({ value: 'WhatsApp ID ••2345', masked: true });
    expect(byId[igId]).toMatchObject({ source: 'beeper', value: 'Instagram ID ••0001', masked: true });
    expect(byId[igName]).toMatchObject({ value: 'Alice A.', masked: false, matchMethod: 'probabilistic', confidence: 0.6 });
    expect(byId[pf]).toMatchObject({ value: 'Partiful ID ••ic01', masked: true, revealable: true });
    expect(byId[card]).toMatchObject({ value: 'Contacts card', masked: true, revealable: false });
    const s = JSON.stringify(p);
    for (const raw of ['@s.whatsapp.test', '123456789012345', '17841400000000001', 'thread-42', 'pfUserSynthetic01', 'AB-CARD-0001']) expect(s).not.toContain(raw);
  });

  it('identityValue: export names drop the thread key; LIDs and Beeper ids stay opaque', () => {
    expect(identityValue('instagram_name', 'ig_dyi:t1:Zoë: the artist').value).toBe('Zoë: the artist');
    expect(identityValue('instagram_name', 'Plain Name').value).toBe('Plain Name');
    expect(identityValue('instagram_name', 'ig_dyi:t1:').value).toBe('Instagram name');
    expect(identityValue('beeper_user', '@someone:beeper.local').value).toBe('Beeper ID ••ocal');
  });
});

describe('list handles', () => {
  it('fall back to the phone number (in full) or a masked email when there is no username', async () => {
    const page = await get<PeoplePage>('/api/v1/people');
    const by = Object.fromEntries(page.items.map((p) => [p.id, p]));
    expect(by[w.alice]!.handle).toBe('@alice.avery');
    expect(by[w.bea]!.handle).toBe('(555) 555-0102');
    expect(by[w.provisional]!.handle).toBe('(555) 555-0110');
    expect(by[w.cher]!.handle).toBeNull();
    seedIdentity(w.db, w.cher, 'whatsapp_jid', '15555550112@s.whatsapp.test', { source: 'whatsapp' });
    const again = await get<PeoplePage>('/api/v1/people');
    expect(again.items.find((p) => p.id === w.cher)!.handle).toBe('(555) 555-0112');
    expect(JSON.stringify(again)).not.toMatch(/\+1555555\d{4}|@s\.whatsapp/);
  });
});

describe('timeline channels', () => {
  it('badges each session with its channel and lists the person’s channels in a fixed order', async () => {
    const wa = seedIdentity(w.db, w.alice, 'whatsapp_jid', '15555550101@s.whatsapp.test', { source: 'whatsapp' });
    const ig = seedIdentity(w.db, w.alice, 'instagram_id', '17841400000000001', { source: 'beeper' });
    const waSession = dm('whatsapp', wa, T0 + 3 * DAY);
    const igSession = dm('beeper', ig, T0 + 4 * DAY);
    const exportSession = dm('instagram_dyi', ig, T0 - 30 * DAY);

    const t = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline`);
    expect(t.channels).toEqual(['imessage', 'whatsapp', 'instagram']);
    const channelById = Object.fromEntries(t.items.filter((i) => i.type === 'session').map((i) => [i.id, i.type === 'session' ? i.channel : '']));
    expect(channelById).toMatchObject({ [waSession]: 'whatsapp', [igSession]: 'instagram', [exportSession]: 'instagram', [w.sessions.dm]: 'imessage' });

    // ?source=instagram matches Beeper and the export; a raw source still filters exactly.
    const insta = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline?source=instagram`);
    expect(insta.items.map((i) => i.id)).toEqual([igSession, exportSession]);
    const beeperOnly = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline?source=beeper`);
    expect(beeperOnly.items.map((i) => i.id)).toEqual([igSession]);
    const whatsapp = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline?source=whatsapp`);
    expect(whatsapp.items.map((i) => i.id)).toEqual([waSession]);

    // Bea only has iMessage.
    expect((await get<TimelinePage>(`/api/v1/people/${w.bea}/timeline`)).channels).toEqual(['imessage']);
    expect(channelOf('ig_dyi')).toBe('instagram');
    expect(channelOf('whatsapp')).toBe('whatsapp');
  });

  it('links get-togethers to their occasion or event; sensitive occasions get neither title nor link', async () => {
    const occ = (id: string, title: string, sensitive: 0 | 1) =>
      w.db
        .prepare(`INSERT INTO occasions (id, kind, title, starts_at, sensitive, created_at, updated_at) VALUES (?, 'social', ?, ?, ?, ?, ?)`)
        .run(id, title, T0 + 5 * DAY, sensitive, T0, T0);
    const dinner = uuidv7();
    const appt = uuidv7();
    occ(dinner, 'Dinner at Example Bistro', 0);
    occ(appt, 'Checkup', 1);
    w.db
      .prepare(`INSERT INTO events (id, source, source_event_id, title, starts_at, created_at, updated_at) VALUES ('ev-1', 'partiful', 'pf-1', 'Rooftop party', ?, ?, ?)`)
      .run(T0 + 6 * DAY, T0, T0);
    const inter = w.db.prepare(
      `INSERT INTO interactions (id, person_id, kind, occasion_id, event_id, started_at, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'derived', ?, ?)`,
    );
    const i1 = uuidv7();
    const i2 = uuidv7();
    const i3 = uuidv7();
    inter.run(i1, w.alice, 'occasion', dinner, null, T0 + 5 * DAY, T0, T0);
    inter.run(i2, w.alice, 'occasion', appt, null, T0 + 5 * DAY + MIN, T0, T0);
    inter.run(i3, w.aliceDup, 'event', null, 'ev-1', T0 + 6 * DAY, T0, T0);

    const t = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline`);
    const by = Object.fromEntries(t.items.map((i) => [i.id, i]));
    expect(by[i1]).toMatchObject({ type: 'interaction', kind: 'occasion', title: 'Dinner at Example Bistro', occasionId: dinner, eventId: null });
    // Sensitive: no title and no link (routes/events.ts never serves it).
    expect(by[i2]).toMatchObject({ title: null, occasionId: null });
    expect(by[i3]).toMatchObject({ kind: 'event', title: 'Rooftop party', eventId: 'ev-1', occasionId: null });
    expect(JSON.stringify(t)).not.toContain('Checkup');
  });

  it("blanks a hidden person's name in an occasion title, as the Events screen does", async () => {
    const dinner = uuidv7();
    w.db
      .prepare(`INSERT INTO occasions (id, kind, title, starts_at, created_at, updated_at) VALUES (?, 'social', ?, ?, ?, ?)`)
      .run(dinner, 'Dinner w/ Alice & Halvard Hushwell', T0 + 5 * DAY, T0, T0);
    const i = uuidv7();
    w.db
      .prepare(`INSERT INTO interactions (id, person_id, kind, occasion_id, started_at, origin, created_at, updated_at) VALUES (?, ?, 'occasion', ?, ?, 'derived', ?, ?)`)
      .run(i, w.alice, dinner, T0 + 5 * DAY, T0, T0);
    const t = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline`);
    expect(t.items.find((x) => x.id === i)).toMatchObject({ title: 'Dinner w/ Alice & … …', occasionId: dinner });
    expect(JSON.stringify(t)).not.toMatch(/Halvard|Hushwell/);
  });
});

describe('calls on the timeline', () => {
  /** A call-log row with its handles, as adapters/calls/ingest.ts stores it. */
  function logCall(at: number, handles: [string, string][], o: { service?: string; answered?: 0 | 1; outgoing?: 0 | 1; durationMs?: number } = {}) {
    const id = uuidv7();
    w.db
      .prepare(
        `INSERT INTO calls (id, source_uid, source_rowid, started_at, duration_ms, service, outgoing, answered, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, id, at, o.durationMs ?? 0, o.service ?? 'phone', o.outgoing ?? 0, o.answered ?? 1, T0, T0);
    for (const [kind, key] of handles) w.db.prepare('INSERT INTO call_handles (call_id, kind, key) VALUES (?, ?, ?)').run(id, kind, key);
    return id;
  }

  it('shows answered and missed calls once each, with phone and FaceTime as channels and filters', async () => {
    const answered = logCall(T0 + 3 * DAY, [['phone', '+15555550101']]);
    const missed = logCall(T0 + 4 * DAY, [['phone', '+15555550101']], { answered: 0 });
    const facetime = logCall(T0 + 5 * DAY, [['email', 'alice@example.com']], { service: 'facetime_video', outgoing: 1, durationMs: 12 * MIN });
    const beas = logCall(T0 + 6 * DAY, [['phone', '+15555550102']]);
    const stranger = logCall(T0 + 7 * DAY, [['phone', '+15555550199']]);
    // The derived interactions of the answered calls must not show a second time.
    expect(rebuildCallInteractions(w.db, T0).upserted).toBe(3);

    const t = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline`);
    const ids = t.items.map((i) => i.id);
    expect(ids.slice(0, 3)).toEqual([facetime, missed, answered]);
    expect(ids).not.toContain(beas);
    expect(ids).not.toContain(stranger);
    // The owner's own logged call (no call log row) is still there.
    expect(ids).toContain(w.callId);
    expect(t.items.filter((i) => i.type === 'interaction' && i.kind === 'call')).toHaveLength(1);
    expect(t.channels).toEqual(['imessage', 'phone', 'facetime']);

    const [ft, miss, ans] = t.items;
    expect(ft).toEqual({ type: 'call', id: facetime, channel: 'facetime', service: 'facetime_video', startedAt: T0 + 5 * DAY, endedAt: T0 + 5 * DAY + 12 * MIN, outgoing: true, answered: true });
    expect(miss).toMatchObject({ type: 'call', channel: 'phone', service: 'phone', endedAt: null, outgoing: false, answered: false });
    expect(ans).toMatchObject({ type: 'call', answered: true });

    const onlyFacetime = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline?source=facetime`);
    expect(onlyFacetime.items.map((i) => i.id)).toEqual([facetime]);
    const page1 = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline?limit=2`);
    const page2 = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`);
    expect([...page1.items, ...page2.items].map((i) => i.id)).toEqual(ids.slice(0, 4));
    // Bea only has the phone channel besides iMessage; a hidden person's calls never reach anyone's page.
    expect((await get<TimelinePage>(`/api/v1/people/${w.bea}/timeline`)).channels).toEqual(['imessage', 'phone']);
    expect(JSON.stringify(t)).not.toContain('+1555555');
  });
});
