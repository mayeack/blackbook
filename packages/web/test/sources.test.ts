import { describe, expect, it } from 'vitest';
import type { GoogleStatusView, IdentityView, SourceView } from '../src/api/types';
import { accountSubtitle, confidenceTone, orderAccounts } from '../src/lib/accounts';
import { channelOf, channelsOf, identityNetwork, sourceCardLabel, sourceShort, sourceStatus, treatmentLabel } from '../src/lib/labels';
import { calendarSummary, cardStatus, countRows, fixCopy, GOOGLE_CONNECT_URL, googleFix, hasData, sourceCardId, sourceIssues } from '../src/lib/sources';

const card = (o: Partial<SourceView> = {}): SourceView => ({
  source: 'whatsapp',
  status: 'unknown',
  lastOkAt: null,
  newestDataAt: null,
  checkedAt: null,
  lastError: null,
  details: null,
  cursors: [],
  cursorCount: 0,
  messages: null,
  counts: {},
  configured: true,
  fix: null,
  ...o,
});

const google = (o: Partial<GoogleStatusView> = {}): GoogleStatusView => ({
  configured: true,
  secretsAvailable: true,
  connected: true,
  needsReconnect: false,
  account: null,
  calendars: [],
  treatments: ['attending', 'excluded'],
  lastSyncAt: null,
  ...o,
});

describe('source cards', () => {
  it('status pill: Healthy / Stale / Error / Needs you / Disabled; never-run and empty is "Not set up"', () => {
    expect(cardStatus(card({ status: 'ok', lastOkAt: 1 }))).toEqual({ label: 'Healthy', tone: 'ok' });
    expect(cardStatus(card({ status: 'stale' })).label).toBe('Stale');
    expect(cardStatus(card({ status: 'error' })).label).toBe('Error');
    expect(cardStatus(card({ status: 'contract_broken' }))).toEqual({ label: 'Error', tone: 'bad' });
    expect(cardStatus(card({ status: 'auth_required' }))).toEqual({ label: 'Needs you', tone: 'bad' });
    expect(cardStatus(card({ status: 'disabled' })).label).toBe('Disabled');
    expect(cardStatus(card())).toEqual({ label: 'Not set up', tone: 'neutral' });
    expect(cardStatus(card({ counts: { people: 3 } })).label).toBe('No report yet');
    expect(sourceStatus('auth_required')).toEqual({ label: 'Needs you', tone: 'bad' });
  });

  it('hasData looks at reports, cursors, messages and counts', () => {
    expect(hasData(card())).toBe(false);
    expect(hasData(card({ counts: { people: 0 } }))).toBe(false);
    expect(hasData(card({ cursorCount: 1 }))).toBe(true);
    expect(hasData(card({ lastOkAt: 1 }))).toBe(true);
    // Older servers send no counts at all.
    expect(hasData(card({ counts: undefined, messages: { total: 1, last24h: 0, last7d: 0, oldestAt: 1, newestAt: 1 } }))).toBe(true);
  });

  it('count rows in a fixed order, zeroes left out', () => {
    expect(countRows({ guests: 1200, events: 30, people: 0, upcomingEvents: 2 })).toEqual([
      { label: 'Events', value: '30' },
      { label: 'Upcoming', value: '2' },
      { label: 'Guest entries', value: (1200).toLocaleString() },
    ]);
    expect(countRows(undefined)).toEqual([]);
  });

  it('fix copy for every kind; Google connect navigates to the consent flow; the folder is shown', () => {
    const kinds = [
      'connect_google',
      'google_not_configured',
      'google_secrets_missing',
      'sign_in_partiful',
      'link_whatsapp',
      'beeper_disconnected',
      'beeper_setup',
      'drop_instagram_export',
      'allow_contacts',
      'collector_setup',
      'contract_broken',
    ] as const;
    for (const kind of kinds) {
      const c = fixCopy({ kind });
      expect(c.title.length, kind).toBeGreaterThan(5);
      expect(c.body.length, kind).toBeGreaterThan(20);
    }
    expect(fixCopy({ kind: 'connect_google' }).action).toEqual({ label: 'Connect Google Calendar', href: GOOGLE_CONNECT_URL });
    expect(GOOGLE_CONNECT_URL).toBe('/api/v1/google/connect');
    expect(fixCopy({ kind: 'sign_in_partiful' }).title).toBe('Sign in to Partiful in the sandbox browser');
    expect(fixCopy({ kind: 'link_whatsapp' }).title).toBe('Link WhatsApp for Mac');
    expect(fixCopy({ kind: 'beeper_disconnected' }).title).toBe('Beeper account disconnected');
    expect(fixCopy({ kind: 'drop_instagram_export', folder: '~/Yeackbot Imports' }).folder).toBe('~/Yeackbot Imports');
    expect(fixCopy({ kind: 'drop_instagram_export' }).folder).toBe('~/Yeackbot Imports');
  });

  it('the Google card trusts /google/status over the health row', () => {
    expect(googleFix({ kind: 'google_not_configured' }, undefined)).toEqual({ kind: 'google_not_configured' });
    expect(googleFix(null, undefined)).toBeNull();
    expect(googleFix({ kind: 'connect_google' }, google({ configured: false, connected: false }))).toEqual({ kind: 'google_not_configured' });
    expect(googleFix(null, google({ connected: false }))).toEqual({ kind: 'connect_google' });
    // Connecting would fail without SECRETS_KEY (the token is stored encrypted): say so instead.
    expect(googleFix(null, google({ connected: false, secretsAvailable: false }))).toEqual({ kind: 'google_secrets_missing' });
    expect(googleFix({ kind: 'connect_google' }, google())).toBeNull();
    expect(googleFix({ kind: 'contract_broken' }, google())).toEqual({ kind: 'contract_broken' });
    expect(
      calendarSummary(
        google({
          calendars: [
            { id: 'a', name: 'A', treatment: 'attending', primary: true, events: 3 },
            { id: 'b', name: 'B', treatment: 'excluded', primary: false, events: null },
          ],
        }),
      ),
    ).toBe('2 calendars · 1 excluded');
    expect(treatmentLabel('candidate')).toBe('Candidate only');
    expect(treatmentLabel('some_new')).toBe('Some new');
  });

  it('Today lists only broken sources: Needs you / changed shape first, then errors and quiet ones in card order', () => {
    const issues = sourceIssues([
      card({ source: 'imessage', status: 'ok', lastOkAt: 5 }),
      card({ source: 'whatsapp', status: 'stale', lastOkAt: 3, lastError: 'Open WhatsApp for Mac (it has to keep running to receive messages)' }),
      card({ source: 'beeper', status: 'auth_required', fix: { kind: 'beeper_disconnected' } }),
      card({ source: 'instagram_dyi', status: 'unknown', fix: { kind: 'drop_instagram_export' } }),
      card({ source: 'partiful', status: 'error', lastOkAt: 2, lastError: 'Partiful kept answering with server errors; the next run retries' }),
      card({ source: 'gcal', status: 'auth_required', fix: { kind: 'connect_google' } }),
      card({ source: 'gmail', status: 'disabled', lastError: 'Gmail is not connected.', fix: { kind: 'connect_gmail' } }),
      card({ source: 'calls', status: 'contract_broken', fix: { kind: 'contract_broken' } }),
    ]);
    expect(issues).toEqual([
      { source: 'beeper', label: 'Instagram (Beeper)', severity: 'critical', message: 'Beeper account disconnected', lastOkAt: null },
      // A connect fix on a broken source is a reconnect.
      { source: 'gcal', label: 'Google Calendar', severity: 'critical', message: 'Reconnect Google Calendar', lastOkAt: null },
      { source: 'calls', label: 'Phone & FaceTime calls', severity: 'critical', message: 'This source changed shape', lastOkAt: null },
      {
        source: 'whatsapp',
        label: 'WhatsApp',
        severity: 'warning',
        message: 'Open WhatsApp for Mac (it has to keep running to receive messages)',
        lastOkAt: 3,
      },
      // The bold source name isn't repeated.
      { source: 'partiful', label: 'Partiful', severity: 'warning', message: 'Kept answering with server errors; the next run retries', lastOkAt: 2 },
    ]);
    // Without a fix or an error, the status says what's wrong.
    expect(sourceIssues([card({ status: 'stale' })])[0]!.message).toBe('No new data lately.');
    expect(sourceIssues([card({ status: 'error' })])[0]!.message).toBe('Its last check failed.');
    expect(sourceIssues([card({ status: 'ok' }), card({ status: 'disabled' }), card()])).toEqual([]);
    expect(sourceCardId('partiful')).toBe('source-partiful');
  });

  it('card labels and tiles', () => {
    expect(sourceCardLabel('beeper')).toBe('Instagram (Beeper)');
    expect(sourceCardLabel('instagram_dyi')).toBe('Instagram export');
    expect(sourceCardLabel('gcal')).toBe('Google Calendar');
    expect(sourceCardLabel('addressbook')).toBe('Contacts');
    expect(sourceCardLabel('imessage')).toBe('iMessage');
    expect(sourceShort(channelOf('beeper'))).toBe('IG');
  });
});

describe('channels', () => {
  it('Beeper and the export are Instagram; badges dedupe in a fixed order', () => {
    expect(channelOf('beeper')).toBe('instagram');
    expect(channelOf('instagram_dyi')).toBe('instagram');
    expect(channelOf('gcal')).toBe('calendar');
    expect(channelOf('whatsapp')).toBe('whatsapp');
    expect(channelsOf(['instagram', 'beeper', 'imessage', 'addressbook', 'whatsapp', 'legacy'])).toEqual([
      'addressbook',
      'imessage',
      'whatsapp',
      'instagram',
      'legacy',
    ]);
  });
});

describe('linked accounts', () => {
  const ident = (o: Partial<IdentityView>): IdentityView => ({
    id: Math.random().toString(36),
    kind: 'phone',
    source: 'imessage',
    matchMethod: 'deterministic',
    confidence: 1,
    verified: false,
    shared: false,
    status: 'active',
    label: null,
    displayName: null,
    value: '(555) •••-••01',
    masked: true,
    revealable: true,
    firstSeenAt: null,
    lastSeenAt: null,
    createdAt: 0,
    ...o,
  });

  it('badges by network: WhatsApp, Instagram (also via Beeper), Partiful, Contacts', () => {
    expect(identityNetwork('whatsapp_lid', 'whatsapp')).toBe('whatsapp');
    expect(identityNetwork('instagram_id', 'beeper')).toBe('instagram');
    expect(identityNetwork('beeper_user', 'beeper')).toBe('instagram');
    expect(identityNetwork('partiful_user', 'partiful')).toBe('partiful');
    expect(identityNetwork('addressbook_id', 'addressbook')).toBe('addressbook');
    expect(identityNetwork('something_new', 'beeper')).toBe('instagram');
  });

  it('subtitle: kind, "via" only when it adds something, method; shared and status', () => {
    expect(accountSubtitle(ident({ kind: 'instagram_username', source: 'beeper', value: '@someone' }))).toBe('Instagram · via Beeper · same identifier');
    // The masked value already says what it is.
    expect(accountSubtitle(ident({ kind: 'whatsapp_lid', source: 'whatsapp', value: 'WhatsApp ID ••2345' }))).toBe('same identifier');
    expect(accountSubtitle(ident({ kind: 'instagram_id', source: 'beeper', value: 'Instagram ID ••0001' }))).toBe('via Beeper · same identifier');
    expect(accountSubtitle(ident({ kind: 'phone', source: 'addressbook', matchMethod: 'addressbook', label: 'mobile' }))).toBe(
      'Phone (mobile) · via Contacts · from your contacts',
    );
    expect(accountSubtitle(ident({ kind: 'partiful_user', source: 'partiful', matchMethod: 'probabilistic', shared: true }))).toBe(
      'Partiful · likely match · shared',
    );
  });

  it('confidence tones and network grouping', () => {
    expect(confidenceTone(0.95)).toBe('conf-high');
    expect(confidenceTone(0.8)).toBe('conf-mid');
    expect(confidenceTone(0.6)).toBe('conf-low');
    const list = [
      ident({ id: 'ig', kind: 'instagram_username', source: 'beeper' }),
      ident({ id: 'wa', kind: 'whatsapp_jid', source: 'whatsapp' }),
      ident({ id: 'ph', kind: 'phone' }),
      ident({ id: 'pf', kind: 'partiful_user', source: 'partiful' }),
      ident({ id: 'ab', kind: 'addressbook_id', source: 'addressbook' }),
      ident({ id: 'em', kind: 'email' }),
    ];
    expect(orderAccounts(list).map((i) => i.id)).toEqual(['ph', 'em', 'ab', 'wa', 'ig', 'pf']);
  });
});
