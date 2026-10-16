/**
 * Response shapes for the read APIs (packages/server/src/routes/{people,sources}.ts). They mirror the server's
 * exported interfaces; activity/undo/me come from @yb/shared. Move these into @yb/shared/api when it grows zod
 * schemas for them. Events and Google Calendar shapes are the client's view models: lib/events.ts normalizes
 * whatever routes/{events,google}.ts send into them.
 */
export type { ActivityBatch, ActivityPage, ActivityRun, Me, UndoResult } from '@yb/shared';

export type PeopleSort = 'last' | 'recent' | 'added';
/** 'provisional': a new handle not yet confirmed as someone known ("New people"). */
export type PersonStatus = 'active' | 'provisional';

export interface PersonListItem {
  id: string;
  displayName: string;
  status: PersonStatus;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  jobTitle: string | null;
  handle: string | null;
  isPriority: boolean;
  lastAt: number | null;
  state: string | null;
  sources: string[];
  createdAt: number;
}

export interface PeoplePage {
  items: PersonListItem[];
  total: number;
  nextCursor: string | null;
}

export interface IdentityView {
  id: string;
  kind: string;
  source: string;
  matchMethod: string;
  confidence: number;
  verified: boolean;
  shared: boolean;
  status: string;
  label: string | null;
  displayName: string | null;
  value: string;
  masked: boolean;
  revealable: boolean;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  createdAt: number;
}

export interface PersonDetail {
  id: string;
  displayName: string;
  status: PersonStatus;
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  company: string | null;
  jobTitle: string | null;
  isPriority: boolean;
  createdAt: number;
  updatedAt: number;
  locations: string[];
  tags: string[];
  stats: {
    lastAt: number | null;
    state: string | null;
    expectedGapD: number | null;
    silenceD: number | null;
    tieStrength: number | null;
    fadingSuppressed: boolean;
  } | null;
  identities: IdentityView[];
  mergedCount: number;
}

/** Settings → Hidden: the only place hidden people are listed. */
export interface HiddenPerson {
  id: string;
  displayName: string;
  company: string | null;
}

export interface HiddenPage {
  items: HiddenPerson[];
}

export interface RevealedIdentity {
  id: string;
  kind: string;
  value: string;
}

export interface SessionItem {
  type: 'session';
  id: string;
  conversationId: string;
  source: string;
  /** imessage | whatsapp | instagram (Beeper and the export) | … */
  channel: string;
  conversationKind: string;
  title: string | null;
  memberCount: number | null;
  startedAt: number;
  endedAt: number;
  msgCount: number;
  fromMe: number;
  fromThem: number;
  initiatedByMe: boolean;
}

export interface InteractionItem {
  type: 'interaction';
  id: string;
  kind: string;
  channel: string | null;
  title: string | null;
  startedAt: number;
  endedAt: number | null;
  occasionId?: string | null;
  eventId?: string | null;
}

export type TimelineItem = SessionItem | InteractionItem;

export interface TimelinePage {
  items: TimelineItem[];
  nextCursor: string | null;
  /** The person's channels (for the source filter); absent from older servers. */
  channels?: string[];
}

export interface SessionMessage {
  id: number;
  sentAt: number;
  isFromMe: boolean;
  kind: string;
  text: string | null;
  hasAttachments: boolean;
  edited: boolean;
  retracted: boolean;
  sender: { personId: string | null; label: string | null } | null;
  reactions: { emoji: string; count: number }[];
}

export interface SessionMessages {
  sessionId: string;
  conversationId: string;
  source: string;
  title: string | null;
  messages: SessionMessage[];
  truncated: boolean;
}

export type SourceStatus = 'ok' | 'stale' | 'error' | 'auth_required' | 'contract_broken' | 'disabled' | 'unknown';

export interface SourceCounts {
  conversations?: number;
  people?: number;
  identities?: number;
  events?: number;
  upcomingEvents?: number;
  guests?: number;
  calendars?: number;
  calendarEvents?: number;
  occasions?: number;
  contactCards?: number;
}

/** The server's fix kinds, plus 'google_secrets_missing', which the client derives from /google/status. */
export type SourceFixKind =
  | 'connect_google'
  | 'google_not_configured'
  | 'google_secrets_missing'
  | 'sign_in_partiful'
  | 'link_whatsapp'
  | 'beeper_disconnected'
  | 'beeper_setup'
  | 'drop_instagram_export'
  | 'allow_contacts'
  | 'collector_setup'
  | 'contract_broken';

export interface SourceFix {
  kind: SourceFixKind;
  folder?: string;
}

export interface SourceView {
  source: string;
  status: SourceStatus;
  lastOkAt: number | null;
  newestDataAt: number | null;
  checkedAt: number | null;
  lastError: string | null;
  details: unknown;
  cursors: { scope: string; cursor: string; highWaterAt: number | null; updatedAt: number }[];
  cursorCount: number;
  messages: { total: number; last24h: number; last7d: number; oldestAt: number | null; newestAt: number | null } | null;
  counts?: SourceCounts;
  configured?: boolean;
  fix?: SourceFix | null;
}

export interface SourcesView {
  sources: SourceView[];
  generatedAt: number;
}

// ---------------------------------------------------------------------------------------------- events

export type EventsWhen = 'upcoming' | 'past';

/** How sure yeackbot is that someone was there: ≥0.75 counts; 0.5–0.75 is shown as "possible", never counted. */
export type AttendeeTier = 'confirmed' | 'maybe' | 'possible' | 'declined';

export interface AttendeeView {
  /** A visible person (links to /p/:id); null for a guest yeackbot can't place (masked label only). */
  personId: string | null;
  name: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
  role: string | null;
  /** calendar | partiful | inference | llm | user | legacy */
  source: string;
  confidence: number;
  evidenceCount: number;
  tier: AttendeeTier;
}

export interface OccasionSummary {
  id: string;
  title: string | null;
  kind: string | null;
  startsAt: number | null;
  endsAt: number | null;
  allDay: boolean;
  venue: string | null;
  /** calendar | partiful | … */
  sources: string[];
  myRsvp: string | null;
  attendees: AttendeeView[];
  /** Total attendees (the card may carry only the first few). */
  attendeeCount: number;
  possibleCount: number;
  evidenceCount: number;
  sensitive: boolean;
}

export interface OccasionDetail extends OccasionSummary {
  /** https only (the Partiful page or the calendar entry). */
  url: string | null;
  /** Calendar names the occasion was merged from. */
  calendars: string[];
}

export interface EventsPage {
  items: OccasionSummary[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------------------------- Google Calendar

export interface GoogleCalendarView {
  id: string;
  name: string;
  treatment: string;
  primary: boolean;
  /** Synced events in this calendar (null when the server doesn't say). */
  events: number | null;
}

export interface GoogleStatusView {
  /** The OAuth client exists on the server. */
  configured: boolean;
  /** SECRETS_KEY is set, so a refresh token can be stored (connecting fails without it). */
  secretsAvailable: boolean;
  connected: boolean;
  /** Connected once, but the refresh token stopped working. */
  needsReconnect: boolean;
  account: string | null;
  calendars: GoogleCalendarView[];
  /** Treatments the server accepts (defaults when it doesn't say). */
  treatments: string[];
  lastSyncAt: number | null;
}
