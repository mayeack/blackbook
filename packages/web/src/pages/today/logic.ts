/**
 * Today screen logic (pure, unit-tested in test/today.test.ts): the delivery-status line, snooze dates, labels,
 * alert order, the open-loops strip line and the activity feed's bulk collapse + filter families.
 */
import type {
  ActivityBatch,
  Alert,
  AlertSeverity,
  ChannelDelivery,
  DigestAction,
  DigestItem,
  LearnedFactor,
  OpenLoopCounts,
  SuggestionKind,
  SuggestionStatus,
  TodayDigest,
  WildcardGenerator,
} from '@yb/shared';
import { humanize, sourceLabel } from '../../lib/labels';

export const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------- delivery line

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

const SKIP_REASONS: Record<string, string> = {
  disabled: 'the daily text is off',
  paused: 'paused',
  empty: 'nothing worth sending',
  quiet_hours: 'quiet hours',
  catch_up_passed: 'the Mac was asleep past catch-up time',
  llm_unavailable: 'Claude was unavailable',
  already_sent: 'already sent',
  no_self_handle: 'your own handle isn’t set up',
  collector_unavailable: 'the Mac helper isn’t running',
  partial: 'some texts are still on the way',
};
export const skipReasonLabel = (r: string | null) => (r ? (SKIP_REASONS[r] ?? humanize(r).toLowerCase()) : 'not sent');

function channelPart(name: 'iMessage' | 'push', s: ChannelDelivery): string | null {
  switch (s) {
    case 'sent':
      return `${name} ✓`;
    case 'failed':
      return `${name} ✗`;
    case 'pending':
      return `${name} pending`;
    case 'skipped':
      return `${name} skipped`;
    case 'disabled':
      return name === 'iMessage' ? 'texting off' : null;
    case 'not_configured':
      return name === 'iMessage' ? 'texting not set up' : null;
  }
}

/** "Sent 8:00 via iMessage ✓ · push ✓", "Not sent · quiet hours", "Composing today’s brief…". */
export function deliveryLine(d: TodayDigest | null, fmtTime: (ms: number) => string): { text: string; tone: Tone } {
  if (!d) return { text: 'No brief yet today', tone: 'muted' };
  const channels: [ChannelDelivery, string | null][] = [
    [d.imessage, channelPart('iMessage', d.imessage)],
    [d.push, channelPart('push', d.push)],
  ];
  const parts = channels.map(([, p]) => p).filter((p): p is string => p != null);
  // "via" names the channels that delivered; the others follow ("Sent 8:00 via push ✓ · texting off").
  const delivered = channels.filter(([st, p]) => st === 'sent' && p != null).map(([, p]) => p!);
  const rest = channels.filter(([st, p]) => st !== 'sent' && p != null).map(([, p]) => p!);
  const failed = d.imessage === 'failed' || d.push === 'failed';
  switch (d.status) {
    case 'composing':
      return { text: 'Composing today’s brief…', tone: 'muted' };
    case 'failed':
      return { text: 'Today’s brief failed · see Sources', tone: 'bad' };
    case 'skipped':
      return { text: `Not sent · ${skipReasonLabel(d.skipReason)}`, tone: d.skipReason === 'disabled' || d.skipReason === 'empty' ? 'muted' : 'warn' };
    case 'ready':
      return { text: parts.length ? `Ready · ${parts.join(' · ')}` : 'Ready', tone: 'muted' };
    case 'sent':
    case 'fallback_sent': {
      const at = d.sentAt ?? d.pushSentAt;
      const head = at != null ? `Sent ${fmtTime(at)}` : 'Sent';
      const tail = d.status === 'fallback_sent' ? ' · basic version' : '';
      const via = delivered.length ? ` via ${delivered.join(' · ')}` : '';
      const others = rest.length ? ` · ${rest.join(' · ')}` : '';
      const partial = d.skipReason === 'partial' ? ` · ${skipReasonLabel('partial')}` : '';
      return { text: `${head}${via}${others}${partial}${tail}`, tone: failed ? 'warn' : partial ? 'muted' : 'ok' };
    }
  }
}

// ---------------------------------------------------------------------------------------------- labels

const KIND_LABELS: Record<SuggestionKind, string> = {
  reply_debt: 'Reply owed',
  pre_event_brief: 'Event soon',
  commitment_due: 'Promise due',
  event_followup: 'Follow up',
  party_invite: 'Invite',
  fading: 'Fading',
  travel_overlap: 'Travel',
  cooling: 'Cooling',
  intro: 'Intro',
  circle_neglect: 'Circle',
  dormant: 'Dormant',
  memory: 'On this day',
  wildcard: 'Wildcard',
};
export const kindLabel = (k: string) => KIND_LABELS[k as SuggestionKind] ?? humanize(k);

const WILDCARD_LABELS: Record<WildcardGenerator, string> = {
  dormant_close: 'Once close',
  unseen_kind: 'Something different',
  memory: 'On this day',
  intro_pair: 'Intro idea',
  circle_checkin: 'Circle check-in',
};
export const wildcardLabel = (g: string | null) => (g ? (WILDCARD_LABELS[g as WildcardGenerator] ?? humanize(g)) : 'Shake things up');

const STATUS_LABELS: Partial<Record<SuggestionStatus, string>> = {
  done: 'Done',
  snoozed: 'Snoozed',
  dismissed: 'Skipped',
  wrong: 'Marked wrong',
  expired: 'Expired',
  superseded: 'Replaced',
  ignored: 'Ignored',
};
/** Null while the card is still open (candidate / selected / delivered). */
export const resolvedLabel = (s: SuggestionStatus): string | null => STATUS_LABELS[s] ?? null;
export const isOpen = (i: Pick<DigestItem, 'status'>) => resolvedLabel(i.status) == null;

const DEFAULT_ACTIONS: DigestAction[] = ['done', 'snooze', 'skip', 'wrong', 'why'];
/** The buttons a card offers (the server's list; the standard five when it sends none). */
export const cardActions = (i: Pick<DigestItem, 'actions'>): Set<DigestAction> => new Set(i.actions.length ? i.actions : DEFAULT_ACTIONS);

// ---------------------------------------------------------------------------------------------- snooze

export type SnoozeChoice = '1w' | '2w' | '1m';
export const SNOOZE_CHOICES: { id: SnoozeChoice; label: string }[] = [
  { id: '1w', label: '1 week' },
  { id: '2w', label: '2 weeks' },
  { id: '1m', label: '1 month' },
];

const startOfLocalDay = (d: Date) => {
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Snoozed items come back with the nightly run of that local day (its midnight). 1m on Jan 31 → Feb 28/29. */
export function snoozeUntil(choice: SnoozeChoice, now = Date.now()): number {
  const d = new Date(now);
  if (choice === '1m') {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  } else {
    d.setDate(d.getDate() + (choice === '1w' ? 7 : 14));
  }
  return startOfLocalDay(d);
}

/** `YYYY-MM-DD` (an <input type=date> value) → that local day's midnight; null unless it is after today. */
export function pickedDateUntil(value: string, now = Date.now()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  const at = startOfLocalDay(d);
  return at > startOfLocalDay(new Date(now)) ? at : null;
}

/** `YYYY-MM-DD` of the local day after `now` (the date picker's min). */
export function tomorrowInput(now = Date.now()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------------------------------------- why this

const ARM_LABELS: Record<LearnedFactor['arm'], string> = {
  kind: 'This kind',
  bucket: 'Kind × closeness',
  circle: 'Kind × circle',
  person: 'This person',
  wildcard: 'Wildcard type',
};
export const armLabel = (a: string) => ARM_LABELS[a as LearnedFactor['arm']] ?? humanize(a);

/** "×1.32 ↑" for a ranker multiplier (1 = no effect). */
export function factorText(value: number): { text: string; dir: 'up' | 'down' | 'flat' } {
  const dir = value > 1.04 ? 'up' : value < 0.96 ? 'down' : 'flat';
  return { text: `×${value.toFixed(2)}`, dir };
}

// ---------------------------------------------------------------------------------------------- alerts & loops

const ALERT_SOURCES: Record<string, string> = {
  llm: 'Claude',
  pipeline: 'Nightly run',
  delivery: 'Delivery',
  collector: 'Mac helper',
  push: 'Push',
  digest: 'Brief',
};
/** Who an alert is about ("Claude", "WhatsApp", "Mac helper"). */
export const alertSourceLabel = (s: string) => ALERT_SOURCES[s] ?? sourceLabel(s);

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
/** Open alerts, most severe first, newest first within a severity. */
export function sortAlerts(alerts: readonly Alert[]): Alert[] {
  return alerts
    .filter((a) => a.resolvedAt == null)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.openedAt - a.openedAt);
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/** "2 replies owed · 1 promise · waiting on 1" (null when there's nothing open). */
export function loopsLine(c: OpenLoopCounts): string | null {
  const parts: string[] = [];
  if (c.replyDebts) parts.push(n(c.replyDebts, 'reply owed', 'replies owed'));
  if (c.commitments) parts.push(n(c.commitments, 'promise', 'promises'));
  if (c.waitingOn) parts.push(`waiting on ${c.waitingOn}`);
  return parts.length ? parts.join(' · ') : null;
}

// ---------------------------------------------------------------------------------------------- activity feed

export type Family = 'merges' | 'links' | 'facts' | 'edges' | 'circles' | 'people' | 'other';
export const FAMILY_FILTERS: { id: Exclude<Family, 'other'>; label: string }[] = [
  { id: 'merges', label: 'Merges' },
  { id: 'links', label: 'Links' },
  { id: 'facts', label: 'Facts' },
  { id: 'edges', label: 'Connections' },
  { id: 'circles', label: 'Circles' },
  { id: 'people', label: 'New people' },
];

/** Which filter chip a change batch belongs to. */
export function familyOf(kind: string): Family {
  if (kind.includes('merge') || kind === 'split') return 'merges';
  if (kind === 'attach_identity' || kind.includes('link') || kind.includes('identity')) return 'links';
  if (kind.includes('fact')) return 'facts';
  if (kind.includes('edge') || kind.includes('relationship')) return 'edges';
  if (kind.includes('circle')) return 'circles';
  if (kind === 'create_person') return 'people';
  return 'other';
}

/** A roster-only creation: someone seen only in a group roster ("Noted <name> from <source> (not yet a contact)"). */
const ROSTER_ONLY = /^Noted .+ from (.+?) \(not yet a contact\)\s*$/;
/** Automatic service-sender filings ("Filed <name> as a service sender (…)"). */
const SERVICE = /^Filed .+ as a service sender\b/;

interface BulkRule {
  key: 'roster' | 'service';
  match: (b: ActivityBatch) => string | false;
  label: (count: number, sources: string[]) => string;
}

const BULK_RULES: BulkRule[] = [
  {
    key: 'roster',
    match: (b) => {
      if (b.kind !== 'create_person') return false;
      const m = ROSTER_ONLY.exec(b.title);
      return m ? m[1]! : false;
    },
    label: (count, sources) =>
      `Noted ${count.toLocaleString()} people${sources.length ? ` from ${sources.map(sourceLabel).join(', ')}` : ''} (not contacts yet)`,
  },
  {
    key: 'service',
    match: (b) => (SERVICE.test(b.title) ? '' : false),
    label: (count) => `Filed ${count.toLocaleString()} service senders (codes, shops, alerts)`,
  },
];

export type FeedRow =
  | { type: 'batch'; batch: ActivityBatch }
  | { type: 'bulk'; key: string; label: string; batches: ActivityBatch[]; undone: number };

/**
 * One run's batches as feed rows. Bulk agent creations (roster-only people, service senders) collapse into one
 * expandable row at the position of their first change once there are at least `min` of them; everything else stays
 * one row per change, in order.
 */
export function collapseBulk(batches: readonly ActivityBatch[], min = 3): FeedRow[] {
  const groups = new Map<string, { rule: BulkRule; batches: ActivityBatch[]; sources: Set<string> }>();
  const ruleOf = new Map<string, BulkRule>();
  for (const b of batches) {
    for (const rule of BULK_RULES) {
      const m = rule.match(b);
      if (m === false) continue;
      ruleOf.set(b.id, rule);
      const g = groups.get(rule.key) ?? { rule, batches: [], sources: new Set<string>() };
      g.batches.push(b);
      if (m) g.sources.add(m.trim().toLowerCase());
      groups.set(rule.key, g);
      break;
    }
  }
  const out: FeedRow[] = [];
  const placed = new Set<string>();
  for (const b of batches) {
    const rule = ruleOf.get(b.id);
    const g = rule ? groups.get(rule.key) : undefined;
    if (!rule || !g || g.batches.length < min) {
      out.push({ type: 'batch', batch: b });
      continue;
    }
    if (placed.has(rule.key)) continue;
    placed.add(rule.key);
    out.push({
      type: 'bulk',
      key: rule.key,
      label: rule.label(g.batches.length, [...g.sources].sort()),
      batches: g.batches,
      undone: g.batches.filter((x) => x.undoneAt != null).length,
    });
  }
  return out;
}

/** Batches of the chosen families (all of them when none is chosen). */
export function filterBatches(batches: readonly ActivityBatch[], families: ReadonlySet<Family>): ActivityBatch[] {
  if (families.size === 0) return [...batches];
  return batches.filter((b) => families.has(familyOf(b.kind)));
}
