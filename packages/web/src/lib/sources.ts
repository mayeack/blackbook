/**
 * Sources-screen wording: the status pill, the count rows and the "how to fix" box for each fix kind the server
 * picks (routes/sources.ts). The Google Calendar card also folds in /google/status, which knows more than the
 * health row (connected or not, needs reconnecting).
 */
import type { GoogleStatusView, SourceCounts, SourceFix, SourceView } from '../api/types';
import { plural } from './format';
import { sourceStatus } from './labels';

export const GOOGLE_CONNECT_URL = '/api/v1/google/connect';

/** The card has seen anything at all: a report, a cursor, messages or counted rows. */
export function hasData(s: SourceView): boolean {
  return s.lastOkAt != null || s.messages != null || s.cursorCount > 0 || Object.values(s.counts ?? {}).some((n) => (n ?? 0) > 0);
}

/** Pill text and tone; a source that never reported and holds nothing is "Not set up" rather than "No report yet". */
export function cardStatus(s: SourceView): { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' } {
  if (s.status === 'unknown' && !hasData(s)) return { label: 'Not set up', tone: 'neutral' };
  return sourceStatus(s.status);
}

const COUNT_ROWS: { key: keyof SourceCounts; label: string }[] = [
  { key: 'people', label: 'People' },
  { key: 'conversations', label: 'Chats' },
  { key: 'identities', label: 'Linked accounts' },
  { key: 'contactCards', label: 'Contact cards' },
  { key: 'events', label: 'Events' },
  { key: 'upcomingEvents', label: 'Upcoming' },
  { key: 'guests', label: 'Guest entries' },
  { key: 'calendars', label: 'Calendars' },
  { key: 'calendarEvents', label: 'Calendar events' },
  { key: 'occasions', label: 'Get-togethers' },
  { key: 'calls', label: 'Calls' },
];

/** The count rows to show, in a fixed order (zeroes and absent keys left out). */
export function countRows(counts: SourceCounts | undefined): { label: string; value: string }[] {
  if (!counts) return [];
  return COUNT_ROWS.filter((r) => (counts[r.key] ?? 0) > 0).map((r) => ({ label: r.label, value: counts[r.key]!.toLocaleString() }));
}

export interface FixCopy {
  title: string;
  body: string;
  /** A navigation (full page load), e.g. the Google consent flow. */
  action?: { label: string; href: string };
  /** A path to show in monospace. */
  folder?: string;
}

export function fixCopy(fix: SourceFix): FixCopy {
  switch (fix.kind) {
    case 'connect_google':
      return {
        title: 'Connect Google Calendar',
        body: 'yeackbot reads your calendars (read-only, never writes) to see who you spent time with.',
        action: { label: 'Connect Google Calendar', href: GOOGLE_CONNECT_URL },
      };
    case 'google_not_configured':
      return {
        title: 'Google sign-in isn’t set up yet',
        body: 'Create a Google OAuth web client with the calendar.readonly scope, add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server’s .env, and restart yeackbot. Then connect here.',
      };
    case 'google_secrets_missing':
      return {
        title: 'Set SECRETS_KEY before connecting Google',
        body: 'yeackbot stores the Google token encrypted with SECRETS_KEY. Add it to the server’s .env (32 random bytes, base64), restart yeackbot, then connect.',
      };
    case 'sign_in_partiful':
      return {
        title: 'Sign in to Partiful in the sandbox browser',
        body: 'Open the sandbox browser and sign in at partiful.com. The next nightly sync picks up the session; yeackbot only reads your events and guest lists.',
      };
    case 'link_whatsapp':
      return {
        title: 'Link WhatsApp for Mac',
        body: 'Install WhatsApp for Mac and link it to your phone (WhatsApp → Settings → Linked devices). The Mac helper reads its local copy every 30 minutes.',
      };
    case 'beeper_disconnected':
      return {
        title: 'Beeper account disconnected',
        body: 'Open Beeper Desktop and reconnect your Instagram account, then check that the Desktop API is still on. yeackbot only reads Instagram DMs.',
      };
    case 'beeper_setup':
      return {
        title: 'Connect Instagram through Beeper',
        body: 'In Beeper Desktop, add your Instagram account and turn on the Desktop API. yeackbot reads Instagram DMs only and never sends.',
      };
    case 'drop_instagram_export':
      return {
        title: 'Drop your Instagram export zip into the imports folder',
        body: 'In Instagram, request “Download your information” (JSON, messages and followers). When the zip arrives, drop it into this folder; it is imported automatically.',
        folder: fix.folder ?? '~/Yeackbot Imports',
      };
    case 'allow_contacts':
      return {
        title: 'Allow Contacts for the Mac helper',
        body: 'In System Settings → Privacy & Security → Contacts, turn on the yeackbot Mac helper. yeackbot never changes your contacts.',
      };
    case 'collector_setup':
      return {
        title: 'Check the Mac helper',
        body: 'The yeackbot Mac helper reads iMessage and the call log on this Mac. Make sure it is running and has Full Disk Access.',
      };
    case 'contract_broken':
      return {
        title: 'This source changed shape',
        body: 'yeackbot paused reading it rather than guess. Nothing was lost; it resumes once the adapter is updated.',
      };
  }
}

/** The Google card's fix once /google/status is known; the health row's fix otherwise. */
export function googleFix(serverFix: SourceFix | null | undefined, g: GoogleStatusView | undefined): SourceFix | null {
  if (!g) return serverFix ?? null;
  if (!g.configured) return { kind: 'google_not_configured' };
  if (!g.connected) return g.secretsAvailable ? { kind: 'connect_google' } : { kind: 'google_secrets_missing' };
  return serverFix && serverFix.kind !== 'connect_google' && serverFix.kind !== 'google_not_configured' ? serverFix : null;
}

/** "3 calendars · 2 excluded" for the Google card's summary line. */
export function calendarSummary(g: GoogleStatusView): string {
  const excluded = g.calendars.filter((c) => c.treatment === 'excluded').length;
  const parts = [plural(g.calendars.length, 'calendar')];
  if (excluded) parts.push(`${excluded} excluded`);
  return parts.join(' · ');
}
