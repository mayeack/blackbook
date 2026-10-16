/**
 * Response shapes for the read APIs (packages/server/src/routes/{people,sources}.ts). They mirror the server's
 * exported interfaces; activity/undo/me come from @yb/shared. Move these into @yb/shared/api when it grows zod
 * schemas for them.
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
}

export type TimelineItem = SessionItem | InteractionItem;

export interface TimelinePage {
  items: TimelineItem[];
  nextCursor: string | null;
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
}

export interface SourcesView {
  sources: SourceView[];
  generatedAt: number;
}
