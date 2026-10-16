/**
 * Deterministic identity resolution (intelligence §1.1–1.4). A raw handle becomes an identity key (E.164 phone,
 * lowercased email, short code, business chat id) via the @yb/shared normalizers; an existing identity with that
 * key decides the person (respecting identity_blocks). Unknown handles get a person whose status follows §1.4:
 *   provisional  I sent it ≥1 message, it sent ≥2, it posted in a group with a known person, or it is in ≥2 groups;
 *   roster_only  seen (group roster, a single inbound text) but below that bar: hidden, promoted later;
 *   service      §1.3 filter (identity/service.ts): stored, never a visible person.
 * Every write is a journaled batch (create_person / attach_identity / person_update) so the activity feed can undo
 * it. An undone create_person leaves the person 'suppressed' with its identities still bound to it, so re-ingest
 * routes back to the suppressed person instead of recreating it.
 */
import { looksLikePhone, maskPhone, normalizeEmail, normalizePhone, uuidv7 } from '@yb/shared';
import type { DB } from '../db/connection';
import { withBatch, type Actor } from '../journal/batch';
import { classifyByHistory, classifyIdentity, isPartifulSender, serviceKind, type IdentityRef, type ServiceReason } from './service';

export type HandleKind = 'phone' | 'email' | 'shortcode' | 'business_chat';

export interface HandleKey extends IdentityRef {
  kind: HandleKind;
  /** 1 for valid keys; 0.5 for unparseable phone numbers kept as raw:<digits>. */
  confidence: number;
}

/** Raw chat.db / address-book handle → identity key; null when it is neither a phone, an email nor a business id. */
export function handleKey(raw: string): HandleKey | null {
  const s = raw.normalize('NFKC').trim();
  if (!s) return null;
  if (/^urn:biz:/i.test(s)) return { kind: 'business_chat', key: s.toLowerCase(), confidence: 1 };
  if (s.includes('@')) {
    const email = normalizeEmail(s);
    return email ? { kind: 'email', key: email, confidence: 1 } : null;
  }
  if (!looksLikePhone(s)) return null;
  const p = normalizePhone(s);
  if (!p) return null;
  if (p.kind === 'e164') return { kind: 'phone', key: p.key, confidence: 1 };
  if (p.kind === 'shortcode') return { kind: 'shortcode', key: p.key, confidence: 1 };
  return { kind: 'phone', key: p.key, confidence: 0.5 };
}

export const refString = (r: IdentityRef): string => `${r.kind}:${r.key}`;

/** Display-name sources, highest precedence first (intelligence §1.4). Only 'handle' exists so far. */
export const NAME_PRECEDENCE = ['addressbook', 'self_id', 'whatsapp', 'beeper', 'partiful', 'ig_dyi', 'handle'] as const;
export type NameSource = (typeof NAME_PRECEDENCE)[number];

/** The best available display name: the first non-empty candidate in NAME_PRECEDENCE order. */
export function pickDisplayName(candidates: Partial<Record<NameSource, string | null>>): string | null {
  for (const s of NAME_PRECEDENCE) {
    const v = candidates[s]?.trim();
    if (v) return v;
  }
  return null;
}

/** Placeholder display name until address-book / WhatsApp / Partiful names exist: the masked handle. */
export function maskedHandle(k: IdentityRef): string {
  if (isPartifulSender(k)) return 'Partiful';
  switch (k.kind) {
    case 'phone':
      return k.key.startsWith('+') ? maskPhone(k.key) : `••${k.key.replace(/\D/g, '').slice(-2)}`;
    case 'email': {
      const [local = '', domain = ''] = k.key.split('@');
      return `${local.slice(0, 1)}•••@${domain}`;
    }
    case 'shortcode':
      return `Short code ${k.key}`;
    case 'business_chat':
      return 'Business chat';
    default:
      return '(unknown)';
  }
}

export interface IdentityRow {
  id: string;
  person_id: string;
  kind: string;
  key: string;
  status: string;
}

export const findIdentity = (db: DB, r: IdentityRef): IdentityRow | undefined =>
  db.prepare('SELECT id, person_id, kind, key, status FROM identities WHERE kind = ? AND key = ?').get(r.kind, r.key) as
    | IdentityRow
    | undefined;

export const isBlocked = (db: DB, r: IdentityRef, personId: string): boolean =>
  db.prepare('SELECT 1 FROM identity_blocks WHERE kind = ? AND key = ? AND person_id = ?').get(r.kind, r.key, personId) !== undefined;

/** Who and when: every agent write in one ingest pass shares a run (created lazily, so idle passes leave none). */
export interface ResolveContext {
  db: DB;
  runId(): string;
  now: number;
  /** identities.source / people.origin, e.g. 'imessage'. */
  source: string;
  actor?: Actor;
}

export type NewPersonStatus = 'provisional' | 'roster_only';

export interface CreateHandleOptions {
  /** Pre-allocated identity id (rows referencing it may already exist inside a deferred-FK transaction). */
  identityId?: string;
  status: NewPersonStatus;
  service?: ServiceReason | null;
  raw?: string | null;
  firstSeenAt?: number | null;
  lastSeenAt?: number | null;
}

/** One create_person batch: a person plus the identity that introduced it. */
export function createPersonForHandle(ctx: ResolveContext, k: HandleKey, o: CreateHandleOptions): { personId: string; identityId: string } {
  const personId = uuidv7(ctx.now);
  const identityId = o.identityId ?? uuidv7(ctx.now);
  const name = pickDisplayName({ handle: maskedHandle(k) }) ?? '(unknown)';
  const service = o.service ?? null;
  const title = service
    ? `Filed ${name} as a service sender (${service.replaceAll('_', ' ')})`
    : o.status === 'provisional'
      ? `New person ${name} from ${ctx.source}`
      : `Noted ${name} from ${ctx.source} (not yet a contact)`;
  withBatch(
    ctx.db,
    { runId: ctx.runId(), kind: 'create_person', title, subjectPersonId: personId, actor: ctx.actor ?? 'agent', confidence: k.confidence },
    (t) => {
      t.insert('people', {
        id: personId,
        display_name: name,
        kind: service ? serviceKind(service) : 'person',
        status: service ? 'service' : o.status,
        origin: ctx.source,
        created_by_run: ctx.runId(),
      });
      t.insert('identities', {
        id: identityId,
        person_id: personId,
        kind: k.kind,
        key: k.key,
        raw: o.raw ?? null,
        source: ctx.source,
        match_method: 'deterministic',
        confidence: k.confidence,
        status: service ? 'service' : 'active',
        first_seen_at: o.firstSeenAt ?? null,
        last_seen_at: o.lastSeenAt ?? null,
        created_by_run: ctx.runId(),
      });
    },
    { now: ctx.now },
  );
  return { personId, identityId };
}

export type AttachOutcome = 'attached' | 'moved' | 'unchanged' | 'blocked';

/**
 * Binds an identity key to a person (attach_identity batch), unless identity_blocks forbids that pairing.
 * retireEmptied: an agent-created provisional/roster-only person left with no identities is suppressed in the same
 * batch (e.g. your own number, seen before the self handles were configured).
 */
export function attachIdentity(
  ctx: ResolveContext,
  k: HandleKey,
  personId: string,
  o: { matchMethod?: string; raw?: string | null; title?: string; retireEmptied?: boolean } = {},
): { outcome: AttachOutcome; identityId: string | null } {
  const existing = findIdentity(ctx.db, k);
  if (existing?.person_id === personId) return { outcome: 'unchanged', identityId: existing.id };
  if (isBlocked(ctx.db, k, personId)) return { outcome: 'blocked', identityId: existing?.id ?? null };
  const title = o.title ?? `Linked ${maskedHandle(k)} to a person`;
  let identityId = existing?.id ?? uuidv7(ctx.now);
  withBatch(
    ctx.db,
    { runId: ctx.runId(), kind: 'attach_identity', title, subjectPersonId: personId, actor: ctx.actor ?? 'agent', confidence: k.confidence },
    (t) => {
      if (existing) {
        t.update('identities', { id: existing.id }, { person_id: personId, status: 'active' });
        if (!o.retireEmptied) return;
        const prev = t.get('people', { id: existing.person_id });
        const left = ctx.db.prepare('SELECT count(*) FROM identities WHERE person_id = ?').pluck().get(existing.person_id) as number;
        const autoCreated = prev?.kind === 'person' && (prev.status === 'provisional' || prev.status === 'roster_only');
        if (autoCreated && left === 0) t.tombstone('people', { id: existing.person_id });
        return;
      }
      identityId = String(
        t.insert('identities', {
          id: identityId,
          person_id: personId,
          kind: k.kind,
          key: k.key,
          raw: o.raw ?? null,
          source: ctx.source,
          match_method: o.matchMethod ?? 'deterministic',
          confidence: k.confidence,
          created_by_run: ctx.runId(),
        }).id,
      );
    },
    { now: ctx.now },
  );
  return { outcome: existing ? 'moved' : 'attached', identityId };
}

export interface MeBinding {
  personId: string;
  /** refString(key) → identity id, for the self handles bound to me. */
  identities: Map<string, string>;
}

const findMe = (db: DB) =>
  db.prepare(`SELECT id FROM people WHERE kind = 'me' AND status IN ('active','provisional') ORDER BY created_at LIMIT 1`).pluck().get() as
    | string
    | undefined;

/**
 * Ensures the single 'me' person exists and owns the configured self handles. System bootstrap: journaled but not
 * undoable (undoing "me" would only make the next pass create it again).
 */
export function ensureMe(ctx: ResolveContext, selfKeys: readonly HandleKey[]): MeBinding {
  let personId = findMe(ctx.db);
  if (!personId) {
    const id = uuidv7(ctx.now);
    withBatch(
      ctx.db,
      { runId: ctx.runId(), kind: 'create_person', title: 'Set up your own profile', subjectPersonId: id, actor: 'system', undoable: false },
      (t) => t.insert('people', { id, display_name: 'Me', kind: 'me', status: 'active', origin: 'system', created_by_run: ctx.runId() }),
      { now: ctx.now },
    );
    personId = id;
  }
  const identities = new Map<string, string>();
  const meCtx: ResolveContext = { ...ctx, actor: 'system' };
  for (const k of selfKeys) {
    const r = attachIdentity(meCtx, k, personId, { matchMethod: 'seed', title: `Linked ${maskedHandle(k)} to you`, retireEmptied: true });
    if (r.identityId && r.outcome !== 'blocked') identities.set(refString(k), r.identityId);
  }
  return { personId, identities };
}

export interface Qualification {
  fromMe: number;
  theirs: number;
  groupWithKnown: number;
  groups: number;
}

/** The §1.4 counters for one identity (works for an identity id whose row is still pending in a deferred-FK tx). */
export function qualification(db: DB, identityId: string): Qualification {
  return db
    .prepare(
      `SELECT
         (SELECT count(*) FROM messages m
            JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.identity_id = @id
            JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'direct'
           WHERE m.is_from_me = 1 AND m.is_bot = 0 AND m.kind NOT IN ('system','group_event')) AS fromMe,
         (SELECT count(*) FROM messages m
           WHERE m.sender_identity_id = @id AND m.is_from_me = 0 AND m.kind NOT IN ('system','group_event')) AS theirs,
         (SELECT count(*) FROM messages m
            JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'group'
           WHERE m.sender_identity_id = @id AND m.kind NOT IN ('system','group_event')
             AND EXISTS (SELECT 1 FROM conversation_members cm2
                           JOIN identities i2 ON i2.id = cm2.identity_id
                           JOIN people p2 ON p2.id = i2.person_id
                          WHERE cm2.conversation_id = c.id AND cm2.identity_id <> @id
                            AND p2.kind = 'person' AND p2.status IN ('active','provisional','merged'))) AS groupWithKnown,
         (SELECT count(*) FROM conversation_members cm
            JOIN conversations c ON c.id = cm.conversation_id AND c.kind = 'group'
           WHERE cm.identity_id = @id AND cm.is_active = 1) AS groups`,
    )
    .get({ id: identityId }) as Qualification;
}

export const qualifies = (q: Qualification): boolean => q.fromMe >= 1 || q.theirs >= 2 || q.groupWithKnown >= 1 || q.groups >= 2;

/** Service reason for a handle: key rules, then a per-message signal, then message history. */
export function serviceReasonFor(db: DB, identityId: string, k: HandleKey, signal: ServiceReason | null = null): ServiceReason | null {
  return classifyIdentity(k) ?? signal ?? classifyByHistory(db, identityId, k);
}

interface RosterOnlyRow {
  identity_id: string;
  person_id: string;
  kind: HandleKind;
  key: string;
  display_name: string;
}

export interface ReevaluateResult {
  promoted: number;
  service: number;
}

/**
 * Re-checks roster_only people (behind the given identities, or all of them): a §1.3 service sender is filed as
 * service, one that now meets §1.4 becomes provisional. Suppressed, merged and user-touched people are left alone.
 */
export function reevaluateRosterOnly(
  ctx: ResolveContext,
  o: { identityIds?: Iterable<string>; signals?: ReadonlyMap<string, ServiceReason> } = {},
): ReevaluateResult {
  const select = `SELECT i.id AS identity_id, i.person_id, i.kind, i.key, p.display_name FROM identities i
                  JOIN people p ON p.id = i.person_id
                  WHERE p.status = 'roster_only' AND p.kind = 'person' AND i.status = 'active'`;
  let rows: RosterOnlyRow[];
  if (o.identityIds) {
    const one = ctx.db.prepare(`${select} AND i.id = ?`);
    rows = [...new Set(o.identityIds)].flatMap((id) => (one.all(id) as RosterOnlyRow[]));
  } else {
    rows = ctx.db.prepare(select).all() as RosterOnlyRow[];
  }
  const out: ReevaluateResult = { promoted: 0, service: 0 };
  const done = new Set<string>();
  for (const r of rows) {
    if (done.has(r.person_id)) continue;
    const k: HandleKey = { kind: r.kind, key: r.key, confidence: 1 };
    const reason = serviceReasonFor(ctx.db, r.identity_id, k, o.signals?.get(r.identity_id) ?? null);
    if (reason) {
      withBatch(
        ctx.db,
        {
          runId: ctx.runId(),
          kind: 'person_update',
          title: `Filed ${r.display_name} as a service sender (${reason.replaceAll('_', ' ')})`,
          subjectPersonId: r.person_id,
          actor: ctx.actor ?? 'agent',
        },
        (t) => {
          t.update('identities', { id: r.identity_id }, { status: 'service' });
          t.update('people', { id: r.person_id }, { status: 'service', kind: serviceKind(reason) });
        },
        { now: ctx.now },
      );
      out.service++;
      done.add(r.person_id);
      continue;
    }
    if (!qualifies(qualification(ctx.db, r.identity_id))) continue;
    withBatch(
      ctx.db,
      {
        runId: ctx.runId(),
        kind: 'person_update',
        title: `New person ${r.display_name} from ${ctx.source}`,
        subjectPersonId: r.person_id,
        actor: ctx.actor ?? 'agent',
      },
      (t) => t.update('people', { id: r.person_id }, { status: 'provisional' }),
      { now: ctx.now },
    );
    out.promoted++;
    done.add(r.person_id);
  }
  return out;
}

/** Ingestion bumps the volatile seen-at columns outside the journal (undo ignores them). */
export function touchIdentitySeen(db: DB, identityId: string, first: number, last = first): void {
  db.prepare(
    `UPDATE identities SET first_seen_at = min(coalesce(first_seen_at, @first), @first), last_seen_at = max(coalesce(last_seen_at, @last), @last)
     WHERE id = @id AND (first_seen_at IS NULL OR last_seen_at IS NULL OR first_seen_at > @first OR last_seen_at < @last)`,
  ).run({ id: identityId, first, last });
}
