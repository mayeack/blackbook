import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/http/app';
import type { PeoplePage, PersonDetail, SessionMessages, TimelinePage } from '../../src/routes/people';
import { identityValue, maskText } from '../../src/routes/people';
import { T0 } from '../helpers';
import { buildWorld, DAY, type World } from './world';

const appFor = (w: World) => createApp({ db: w.db, auth: { mode: 'dev-bypass', email: 'owner@example.com' } });

let w: World;
let app: ReturnType<typeof appFor>;
beforeEach(() => {
  w = buildWorld();
  app = appFor(w);
});

const get = async <T>(url: string, status = 200): Promise<T> => {
  const res = await request(app).get(url);
  expect(res.status, `${url} → ${res.text}`).toBe(status);
  return res.body as T;
};

/** Everything a hidden person could leak through: id, name parts, phone. */
const expectNoHidden = (body: unknown) => {
  const s = JSON.stringify(body);
  expect(s).not.toContain(w.hidden);
  expect(s).not.toContain('Halvard');
  expect(s).not.toContain('Hushwell');
  expect(s).not.toContain('5550109');
};

/** No raw phone numbers or emails anywhere in a list response. */
const expectNoRawContacts = (body: unknown) => {
  const s = JSON.stringify(body);
  expect(s).not.toMatch(/\+1555555\d{4}/);
  expect(s).not.toMatch(/[a-z.]+@example\.com/);
};

describe('GET /api/v1/people', () => {
  it('lists visible people by last name A–Z (locale-aware), first name tiebreak, blank last names last', async () => {
    const page = await get<PeoplePage>('/api/v1/people');
    expect(page.items.map((p) => p.displayName)).toEqual(['Alice Avery', 'Bea Brook', 'Émile Ébert', 'Pat Provo', 'zed zane', 'Cher']);
    expect(page.total).toBe(6);
    expect(page.nextCursor).toBeNull();
    const alice = page.items[0]!;
    expect(alice).toMatchObject({ id: w.alice, company: 'Acme Robotics', handle: '@alice.avery', isPriority: false });
    // Sources come through canon: the merged-away record's identity counts too.
    expect(alice.sources).toEqual(['addressbook', 'imessage', 'instagram']);
    expect(page.items.find((p) => p.id === w.zed)?.isPriority).toBe(true);
  });

  it('never returns hidden, merged-away, roster-only, service or "me" people, nor raw phones/emails', async () => {
    const extra = (status: string) =>
      w.db.prepare(`INSERT INTO people (id, display_name, status, origin, created_at, updated_at) VALUES (?, ?, ?, 'test', ?, ?)`)
        .run(`01a13ba4-0000-7000-8000-00000000000${status.length}`, `Quinn ${status}`, status, T0, T0);
    for (const status of ['roster_only', 'service', 'suppressed']) extra(status);
    const page = await get<PeoplePage>('/api/v1/people?limit=500');
    const ids = page.items.map((p) => p.id);
    for (const id of [w.hidden, w.aliceDup, w.me]) expect(ids).not.toContain(id);
    expect(page.items.map((p) => p.displayName).filter((n) => n.startsWith('Quinn'))).toEqual([]);
    expectNoHidden(page);
    expectNoRawContacts(page);
  });

  it('includes provisional people ("New people") with their status; status=new and status=known filter', async () => {
    const all = await get<PeoplePage>('/api/v1/people');
    expect(all.items.find((p) => p.id === w.provisional)).toMatchObject({ displayName: 'Pat Provo', status: 'provisional' });
    expect(all.items.find((p) => p.id === w.alice)?.status).toBe('active');
    const fresh = await get<PeoplePage>('/api/v1/people?status=new');
    expect(fresh.items.map((p) => p.id)).toEqual([w.provisional]);
    expect(fresh.total).toBe(1);
    const known = await get<PeoplePage>('/api/v1/people?status=known');
    expect(known.items.map((p) => p.id)).not.toContain(w.provisional);
    expect(known.total).toBe(5);
    expect((await get<PeoplePage>('/api/v1/people?status=new&q=provo')).items.map((p) => p.id)).toEqual([w.provisional]);
    expect((await get<PeoplePage>('/api/v1/people?status=new&q=alice')).items).toEqual([]);
    await get('/api/v1/people?status=hidden', 400);
  });

  it('searches names, company and usernames; hidden people never match', async () => {
    const names = async (q: string) =>
      (await get<PeoplePage>(`/api/v1/people?q=${encodeURIComponent(q)}`)).items.map((p) => p.displayName);
    expect(await names('ali')).toEqual(['Alice Avery']);
    expect(await names('acme')).toEqual(['Alice Avery']);
    expect(await names('@alice.avery')).toEqual(['Alice Avery']);
    expect(await names('bea brook')).toEqual(['Bea Brook']);
    expect(await names('ZANE')).toEqual(['zed zane']);
    expect(await names('%')).toEqual([]);
    expect(await names('Provo')).toEqual(['Pat Provo']);
    for (const q of ['Halvard', 'hush']) {
      const page = await get<PeoplePage>(`/api/v1/people?q=${q}`);
      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
    }
  });

  it('pages with an opaque cursor that reproduces the full order', async () => {
    const full = (await get<PeoplePage>('/api/v1/people')).items.map((p) => p.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/v1/people?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page: PeoplePage = await get<PeoplePage>(url);
      seen.push(...page.items.map((p) => p.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual(full);
    expect(pages).toBe(3);
  });

  it('rejects a cursor from another sort and garbage cursors', async () => {
    const first = await get<PeoplePage>('/api/v1/people?limit=1');
    const res = await request(app).get(`/api/v1/people?sort=added&cursor=${first.nextCursor}`);
    expect(res.status).toBe(400);
    expect((await request(app).get('/api/v1/people?cursor=not-a-cursor')).status).toBe(400);
    expect((await request(app).get('/api/v1/people?sort=fancy')).status).toBe(400);
  });

  it('sorts by recent contact (never-contacted last) and by date added', async () => {
    const stat = w.db.prepare('INSERT INTO person_stats (person_id, last_at, state, computed_at) VALUES (?, ?, ?, ?)');
    stat.run(w.bea, T0 + 5 * DAY, 'steady', T0);
    stat.run(w.zed, T0 + 9 * DAY, 'strong', T0);
    stat.run(w.hidden, T0 + 20 * DAY, 'strong', T0);
    const recent = await get<PeoplePage>('/api/v1/people?sort=recent');
    expect(recent.items.map((p) => p.id)).toEqual([w.zed, w.bea, w.alice, w.emile, w.provisional, w.cher]);
    expect(recent.items[0]).toMatchObject({ lastAt: T0 + 9 * DAY, state: 'strong' });
    expectNoHidden(recent);

    const added = await get<PeoplePage>('/api/v1/people?sort=added');
    expect(added.items.map((p) => p.id)).toEqual([w.provisional, w.cher, w.zed, w.emile, w.bea, w.alice]);
  });

  it('scores everyone 1–10 and sorts closest first (most recent contact, then name, within a score)', async () => {
    const stat = w.db.prepare('INSERT INTO person_stats (person_id, last_at, tie_strength, historical_strength, state, computed_at) VALUES (?, ?, ?, ?, ?, ?)');
    stat.run(w.zed, T0 + 9 * DAY, 85, 90, 'strong', T0); // 10
    stat.run(w.bea, T0 + 5 * DAY, 3, 70, 'dormant', T0); // an old friend gone quiet: H/2 = 35 → 6
    stat.run(w.emile, T0 + 2 * DAY, 41, 30, 'steady', T0); // 7
    stat.run(w.hidden, T0 + 20 * DAY, 99, 99, 'strong', T0);
    const close = await get<PeoplePage>('/api/v1/people?sort=close');
    expect(close.items.map((p) => [p.id, p.closeness])).toEqual([
      [w.zed, 10],
      [w.emile, 7],
      [w.bea, 6],
      [w.alice, 2],
      [w.provisional, 2],
      [w.cher, 2],
    ]);
    expectNoHidden(close);
    const page1 = await get<PeoplePage>('/api/v1/people?sort=close&limit=2');
    const page2 = await get<PeoplePage>(`/api/v1/people?sort=close&limit=2&cursor=${page1.nextCursor}`);
    expect([...page1.items, ...page2.items].map((p) => p.id)).toEqual([w.zed, w.emile, w.bea, w.alice]);
    expect((await get<PersonDetail>(`/api/v1/people/${w.bea}`)).closeness).toBe(6);
    expect((await get<PersonDetail>(`/api/v1/people/${w.cher}`)).closeness).toBe(2);
  });
});

describe('GET /api/v1/people/:id', () => {
  it('returns header fields and linked accounts gathered through canon (phones in full, emails masked)', async () => {
    const p = await get<PersonDetail>(`/api/v1/people/${w.alice}`);
    expect(p).toMatchObject({ id: w.alice, displayName: 'Alice Avery', company: 'Acme Robotics', jobTitle: 'Engineer', mergedCount: 1 });
    const byKind = Object.fromEntries(p.identities.map((i) => [i.id, i]));
    expect(byKind[w.ids.alicePhone]).toMatchObject({
      kind: 'phone',
      value: '(555) 555-0101',
      masked: false,
      revealable: false,
      source: 'addressbook',
      matchMethod: 'addressbook',
      label: 'mobile',
    });
    expect(byKind[w.ids.aliceEmail]).toMatchObject({ kind: 'email', value: 'a•••@example.com', masked: true, revealable: true });
    expect(byKind[w.ids.aliceIg]).toMatchObject({ value: '@alice.avery', masked: false, revealable: false, confidence: 0.9 });
    // The merged-away record's email is a linked account of the survivor.
    expect(byKind[w.ids.aliceDupEmail]).toMatchObject({ value: 'a•••@example.com', source: 'imessage' });
    expect(p.identities[0]!.kind).toBe('phone');
    expectNoRawContacts(p);
    expectNoHidden(p);
  });

  it('resolves a merged-away id to its survivor', async () => {
    const p = await get<PersonDetail>(`/api/v1/people/${w.aliceDup}`);
    expect(p.id).toBe(w.alice);
  });

  it('opens a provisional person (status provisional)', async () => {
    const p = await get<PersonDetail>(`/api/v1/people/${w.provisional}`);
    expect(p).toMatchObject({ id: w.provisional, displayName: 'Pat Provo', status: 'provisional' });
    await get<TimelinePage>(`/api/v1/people/${w.provisional}/timeline`);
  });

  it('404s hidden, roster-only, "me" and unknown people; 400s malformed ids', async () => {
    w.db.prepare(`UPDATE people SET status = 'roster_only' WHERE id = ?`).run(w.bea);
    for (const id of [w.hidden, w.bea, w.me, '01a13ba4-0000-7000-8000-000000000000']) {
      const res = await request(app).get(`/api/v1/people/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expectNoHidden(res.body);
    }
    expect((await request(app).get('/api/v1/people/nope')).status).toBe(400);
  });

  it('reveals one full value on request, only for that visible person', async () => {
    const r = await get<{ value: string; kind: string }>(`/api/v1/people/${w.alice}/identities/${w.ids.alicePhone}/reveal`);
    expect(r).toEqual({ id: w.ids.alicePhone, kind: 'phone', value: '+15555550101' });
    expect((await request(app).get(`/api/v1/people/${w.alice}/identities/${w.ids.alicePhone}/reveal`)).headers['cache-control']).toBe('no-store');
    // not revealable (a username), someone else's identity, a hidden person's identity
    await get(`/api/v1/people/${w.alice}/identities/${w.ids.aliceIg}/reveal`, 404);
    await get(`/api/v1/people/${w.alice}/identities/${w.ids.beaPhone}/reveal`, 404);
    await get(`/api/v1/people/${w.alice}/identities/${w.ids.hiddenPhone}/reveal`, 404);
    await get(`/api/v1/people/${w.hidden}/identities/${w.ids.hiddenPhone}/reveal`, 404);
  });
});

describe('GET /api/v1/people/:id/timeline', () => {
  it('merges sessions and non-session interactions newest first, only from the person’s conversations', async () => {
    const t = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline`);
    expect(t.items.map((i) => i.id)).toEqual([w.callId, w.sessions.group, w.sessions.dm]);
    expect(t.nextCursor).toBeNull();
    const [call, group, dm] = t.items;
    expect(call).toMatchObject({ type: 'interaction', kind: 'call', channel: 'phone', startedAt: T0 + 2 * DAY });
    expect(group).toMatchObject({ type: 'session', title: 'Climbing crew', conversationKind: 'group', msgCount: 3, fromMe: 1, fromThem: 1, source: 'imessage' });
    expect(dm).toMatchObject({ type: 'session', title: null, conversationKind: 'direct', msgCount: 2, fromMe: 1, fromThem: 1, initiatedByMe: false });
    expectNoHidden(t);
  });

  it('pages by cursor and filters by source', async () => {
    const one = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline?limit=1`);
    expect(one.items.map((i) => i.id)).toEqual([w.callId]);
    const two = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline?limit=1&cursor=${encodeURIComponent(one.nextCursor!)}`);
    expect(two.items.map((i) => i.id)).toEqual([w.sessions.group]);
    const imessage = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline?source=imessage`);
    expect(imessage.items.map((i) => i.id)).toEqual([w.sessions.group, w.sessions.dm]);
    expect((await request(app).get(`/api/v1/people/${w.alice}/timeline?cursor=bad`)).status).toBe(400);
  });

  it('respects group membership windows (left before the session → not shown)', async () => {
    w.db.prepare('UPDATE conversation_members SET left_at = ? WHERE identity_id = ?').run(T0 + DAY - 1, w.ids.aliceEmail);
    // She posted in the group, so the sender route still links the conversation without a window.
    const t = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline`);
    expect(t.items.map((i) => i.id)).toContain(w.sessions.group);
    w.db.prepare('UPDATE messages SET sender_identity_id = NULL, is_from_me = 1 WHERE sender_identity_id = ?').run(w.ids.aliceEmail);
    const after = await get<TimelinePage>(`/api/v1/people/${w.alice}/timeline`);
    expect(after.items.map((i) => i.id)).not.toContain(w.sessions.group);
  });

  it('404s for hidden people', async () => {
    const res = await request(app).get(`/api/v1/people/${w.hidden}/timeline`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/people/:id/sessions/:sessionId/messages', () => {
  it('returns the session’s messages with reactions; a hidden sender has no name or link', async () => {
    const s = await get<SessionMessages>(`/api/v1/people/${w.alice}/sessions/${w.sessions.group}/messages`);
    expect(s).toMatchObject({ sessionId: w.sessions.group, title: 'Climbing crew', source: 'imessage', truncated: false });
    expect(s.messages.map((m) => m.text)).toEqual(['who has the ropes?', 'I have two', 'great, bring both']);
    const [fromAlice, fromHidden, fromMe] = s.messages;
    expect(fromAlice!.sender).toEqual({ personId: w.alice, label: 'Alice Avery' });
    expect(fromAlice!.reactions).toEqual([{ emoji: '❤️', count: 1 }]);
    expect(fromHidden!.sender).toEqual({ personId: null, label: null });
    expect(fromMe).toMatchObject({ isFromMe: true, sender: null });
    expectNoHidden(s);
  });

  it('labels non-visible, non-hidden senders by their identity; provisional senders link', async () => {
    w.db.prepare('UPDATE messages SET sender_identity_id = ? WHERE text = ?').run(w.ids.provisionalPhone, 'I have two');
    const url = `/api/v1/people/${w.alice}/sessions/${w.sessions.group}/messages`;
    expect((await get<SessionMessages>(url)).messages[1]!.sender).toEqual({ personId: w.provisional, label: 'Pat Provo' });
    w.db.prepare(`UPDATE people SET status = 'roster_only' WHERE id = ?`).run(w.provisional);
    expect((await get<SessionMessages>(url)).messages[1]!.sender).toEqual({ personId: null, label: '(555) 555-0110' });
  });

  it('only opens sessions on this person’s timeline', async () => {
    await get(`/api/v1/people/${w.alice}/sessions/${w.sessions.beaOnly}/messages`, 404);
    await get(`/api/v1/people/${w.bea}/sessions/${w.sessions.beaOnly}/messages`, 200);
    await get(`/api/v1/people/${w.hidden}/sessions/${w.sessions.group}/messages`, 404);
    await get(`/api/v1/people/${w.alice}/sessions/no-such-session/messages`, 404);
  });
});

describe('masking helpers', () => {
  it('shows phones and handles in full; masks emails and opaque ids', () => {
    expect(identityValue('phone', '+15555550123')).toEqual({ value: '(555) 555-0123', masked: false });
    expect(identityValue('phone', '+442079460958').value).toBe('+44 20 7946 0958');
    expect(identityValue('phone', 'raw:12345').value).toBe('12345');
    expect(identityValue('email', 'someone@example.com')).toEqual({ value: 's•••@example.com', masked: true });
    expect(identityValue('whatsapp_jid', '15555550123@s.whatsapp.test')).toEqual({ value: '(555) 555-0123', masked: false });
    expect(identityValue('instagram_id', '1234567890').value).toBe('Instagram ID ••7890');
    expect(identityValue('x_username', '@handle').value).toBe('@handle');
    expect(maskText('Call +1 555 555 0123 or mail a.b@example.com')).toBe('Call (555) •••-••23 or mail a•••@example.com');
    expect(maskText('Room 42')).toBe('Room 42');
  });
});
