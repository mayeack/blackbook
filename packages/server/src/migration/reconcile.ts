/**
 * Reconcile phase (architecture.md §5, ZINTERACTION): runs after the iMessage backfill. Each legacy Text
 * interaction is matched to an ingested chat.db message by (the person's phone/email identities, direction,
 * timestamp within ±2 s), preferring an exact text match, then the nearest timestamp; one message matches at most
 * one interaction. Tapback summaries ("Loved “…”") are dropped. Unmatched rows become messages(source='legacy')
 * in a per-person "legacy:<person>" conversation, which is then sessionized so that history chat.db no longer has
 * still yields sessions and derived dm_session interactions. Non-text interactions (calls, meetings) become legacy
 * interactions. Idempotent by the interaction's legacy UUID.
 */
import { uuidv7 } from '@yb/shared';
import { canonicalId, canonicalMembers } from '../db/canon';
import type { DB } from '../db/connection';
import { withBatch } from '../journal/batch';
import { refreshConversations } from '../pipeline/interactions';
import { TAPBACK_SUMMARY } from './convert';
import type { LegacyInteraction, LegacyStore } from './legacyStore';

export class ReconcileRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconcileRefusedError';
  }
}

export interface ReconcileResult {
  total: number;
  tapbacksDropped: number;
  nonText: number;
  noPerson: number;
  noDateOrDirection: number;
  /** text interactions eligible for matching */
  eligible: number;
  matched: number;
  matchedByText: number;
  alreadyImported: number;
  insertedMessages: number;
  insertedConversations: number;
  insertedInteractions: number;
  /** sessions (re)computed over the legacy conversations, and the derived interactions written for them */
  legacySessions: number;
  legacyDerivedInteractions: number;
  matchRate: number;
  /** PLAN.md target: ≥ 98% of eligible rows matched */
  targetMet: boolean;
  ingestedImessageMessages: number;
}

export interface ReconcileOptions {
  runId: string;
  now: number;
  toleranceMs?: number;
  /** Run even when no iMessage history is ingested yet (everything would become a legacy message). */
  force?: boolean;
}

export const MATCH_TARGET = 0.98;

const NON_TEXT_KIND: Record<string, 'call' | 'meeting' | 'manual'> = { call: 'call', meeting: 'meeting' };

interface Candidate {
  id: number;
  sent_at: number;
  text: string | null;
}

export function reconcileInteractions(db: DB, store: LegacyStore, o: ReconcileOptions): ReconcileResult {
  const tolerance = o.toleranceMs ?? 2000;
  const ingested = Number(db.prepare("SELECT count(*) FROM messages WHERE source = 'imessage'").pluck().get());
  if (!ingested && !o.force) {
    throw new ReconcileRefusedError('no iMessage history has been ingested yet; run the reconcile phase after the backfill');
  }
  const personByPk = new Map(
    (db.prepare('SELECT legacy_pk, id FROM people WHERE legacy_pk IS NOT NULL').all() as { legacy_pk: number; id: string }[]).map((r) => [
      r.legacy_pk,
      r.id,
    ]),
  );
  const res: ReconcileResult = {
    total: 0,
    tapbacksDropped: 0,
    nonText: 0,
    noPerson: 0,
    noDateOrDirection: 0,
    eligible: 0,
    matched: 0,
    matchedByText: 0,
    alreadyImported: 0,
    insertedMessages: 0,
    insertedConversations: 0,
    insertedInteractions: 0,
    legacySessions: 0,
    legacyDerivedInteractions: 0,
    matchRate: 0,
    targetMet: false,
    ingestedImessageMessages: ingested,
  };

  const identityCache = new Map<string, { identities: string; conversations: string }>();
  const scope = (personId: string) => {
    const canonical = canonicalId(db, personId);
    let s = identityCache.get(canonical);
    if (!s) {
      const members = JSON.stringify(canonicalMembers(db, canonical));
      const ids = db
        .prepare(
          `SELECT id FROM identities WHERE person_id IN (SELECT value FROM json_each(?))
           AND kind IN ('phone','email') AND status = 'active'`,
        )
        .pluck()
        .all(members) as string[];
      const convs = ids.length
        ? (db
            .prepare(
              `SELECT DISTINCT cm.conversation_id FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
               WHERE c.source = 'imessage' AND cm.identity_id IN (SELECT value FROM json_each(?))`,
            )
            .pluck()
            .all(JSON.stringify(ids)) as string[])
        : [];
      s = { identities: JSON.stringify(ids), conversations: JSON.stringify(convs) };
      identityCache.set(canonical, s);
    }
    return s;
  };
  const received = db.prepare(
    `SELECT id, sent_at, text FROM messages WHERE source = 'imessage' AND is_from_me = 0
     AND sender_identity_id IN (SELECT value FROM json_each(?)) AND sent_at BETWEEN ? AND ?`,
  );
  const sent = db.prepare(
    `SELECT id, sent_at, text FROM messages WHERE source = 'imessage' AND is_from_me = 1
     AND conversation_id IN (SELECT value FROM json_each(?)) AND sent_at BETWEEN ? AND ?`,
  );
  const legacyMessage = db.prepare("SELECT 1 FROM messages WHERE source = 'legacy' AND source_msg_id = ?");
  const used = new Set<number>();

  const rows = store.interactions().sort((a, b) => (a.date ?? 0) - (b.date ?? 0) || a.pk - b.pk);
  const unmatched: { ix: LegacyInteraction; personId: string }[] = [];
  const nonText: { ix: LegacyInteraction; personId: string }[] = [];
  for (const ix of rows) {
    res.total++;
    const personId = ix.contactPk === null ? undefined : personByPk.get(ix.contactPk);
    if (!personId) {
      res.noPerson++;
      continue;
    }
    const type = (ix.type ?? 'text').toLowerCase();
    if (type !== 'text') {
      res.nonText++;
      nonText.push({ ix, personId });
      continue;
    }
    if (ix.summary && TAPBACK_SUMMARY.test(ix.summary)) {
      res.tapbacksDropped++;
      continue;
    }
    if (ix.date === null || ix.direction === null) {
      res.noDateOrDirection++;
      continue;
    }
    res.eligible++;
    const s = scope(personId);
    const window = [ix.date - tolerance, ix.date + tolerance] as const;
    const candidates = (ix.direction === 'received' ? received.all(s.identities, ...window) : sent.all(s.conversations, ...window)) as Candidate[];
    const free = candidates.filter((c) => !used.has(c.id));
    const summary = ix.summary?.trim() ?? '';
    const byText = summary ? free.filter((c) => (c.text ?? '').trim() === summary) : [];
    const pool = byText.length ? byText : free;
    const best = pool.sort((a, b) => Math.abs(a.sent_at - ix.date!) - Math.abs(b.sent_at - ix.date!) || a.id - b.id)[0];
    if (best) {
      used.add(best.id);
      res.matched++;
      if (byText.length) res.matchedByText++;
      continue;
    }
    if (legacyMessage.get(ix.uuid)) res.alreadyImported++;
    else unmatched.push({ ix, personId });
  }

  if (unmatched.length) {
    // Sessionized in the same run (and transaction) as the import; nothing else ever sessionizes source='legacy'.
    const convIds = importUnmatched(db, unmatched, o, res);
    const r = refreshConversations(db, new Map(convIds.map((id) => [id, null])), { now: o.now });
    res.legacySessions = r.sessionsChanged;
    res.legacyDerivedInteractions = r.interactionsUpserted;
  }
  if (nonText.length) {
    withBatch(
      db,
      { runId: o.runId, kind: 'migration', title: `Imported ${nonText.length} legacy calls and meetings`, actor: 'system' },
      (t) => {
        for (const { ix, personId } of nonText) {
          if (t.get('interactions', { id: ix.uuid }) || ix.date === null) continue;
          const type = (ix.type ?? '').toLowerCase();
          t.insert('interactions', {
            id: ix.uuid,
            person_id: personId,
            kind: NON_TEXT_KIND[type] ?? 'manual',
            channel: type || null,
            started_at: ix.date,
            ended_at: ix.durationS ? ix.date + Math.round(ix.durationS * 1000) : null,
            summary: ix.summary,
            origin: 'legacy',
            created_by_run: o.runId,
          });
          res.insertedInteractions++;
        }
      },
      { now: o.now },
    );
  }
  res.matchRate = res.eligible ? res.matched / res.eligible : 1;
  res.targetMet = res.matchRate >= MATCH_TARGET;
  return res;
}

/** Unmatched rows → legacy messages in a per-person conversation joined through a legacy_id identity. */
function importUnmatched(db: DB, rows: { ix: LegacyInteraction; personId: string }[], o: ReconcileOptions, res: ReconcileResult): string[] {
  const byPerson = new Map<string, LegacyInteraction[]>();
  for (const r of rows) byPerson.set(r.personId, [...(byPerson.get(r.personId) ?? []), r.ix]);

  // The identity that ties a legacy conversation to its person is journaled (undo detaches it).
  const identityFor = new Map<string, string>();
  const findIdentity = db.prepare("SELECT id FROM identities WHERE kind = 'legacy_id' AND key = ?").pluck();
  withBatch(
    db,
    { runId: o.runId, kind: 'migration', title: 'Linked legacy message history to people', actor: 'system' },
    (t) => {
      for (const personId of byPerson.keys()) {
        let id = findIdentity.get(personId) as string | undefined;
        if (!id) {
          id = uuidv7(o.now);
          t.insert('identities', {
            id,
            person_id: personId,
            kind: 'legacy_id',
            key: personId,
            source: 'legacy',
            match_method: 'legacy',
            created_by_run: o.runId,
          });
        }
        identityFor.set(personId, id);
      }
    },
    { now: o.now },
  );

  const findConv = db.prepare("SELECT id FROM conversations WHERE source = 'legacy' AND source_conv_id = ?").pluck();
  const insConv = db.prepare(
    `INSERT INTO conversations (id, source, source_conv_id, kind, title_source, created_at, updated_at)
     VALUES (?, 'legacy', ?, 'direct', 'legacy', ?, ?)`,
  );
  const insMember = db.prepare(
    `INSERT OR IGNORE INTO conversation_members (conversation_id, identity_id, source, first_seen_at, last_seen_at)
     VALUES (?, ?, 'sender', ?, ?)`,
  );
  const insMsg = db.prepare(
    `INSERT OR IGNORE INTO messages (source, source_msg_id, conversation_id, sender_identity_id, is_from_me, sent_at, kind, text,
       text_source, ingested_at, updated_at)
     VALUES ('legacy', ?, ?, ?, ?, ?, 'text', ?, 'text', ?, ?)`,
  );
  const touchConv = db.prepare(
    `UPDATE conversations SET
       first_message_at = (SELECT min(sent_at) FROM messages WHERE conversation_id = @id),
       last_message_at = (SELECT max(sent_at) FROM messages WHERE conversation_id = @id),
       updated_at = @now
     WHERE id = @id`,
  );
  const convIds: string[] = [];
  for (const [personId, list] of byPerson) {
    const identityId = identityFor.get(personId)!;
    const sourceConvId = `legacy:${personId}`;
    let convId = findConv.get(sourceConvId) as string | undefined;
    if (!convId) {
      convId = uuidv7(o.now);
      insConv.run(convId, sourceConvId, o.now, o.now);
      res.insertedConversations++;
    }
    const times = list.map((ix) => ix.date!);
    insMember.run(convId, identityId, Math.min(...times), Math.max(...times));
    for (const ix of list) {
      const fromMe = ix.direction === 'sent';
      const r = insMsg.run(ix.uuid, convId, fromMe ? null : identityId, fromMe ? 1 : 0, ix.date, ix.summary, o.now, o.now);
      if (r.changes) res.insertedMessages++;
      else res.alreadyImported++;
    }
    touchConv.run({ id: convId, now: o.now });
    convIds.push(convId);
  }
  return convIds;
}
