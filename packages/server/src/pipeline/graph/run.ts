/**
 * The nightly graph pass (job 'graph', AGENT_TIMES.graph): derive this module's evidence types from conversations
 * and messages (evidence.ts), then aggregate every writer's edge_evidence plus edge_labels into edge_stats
 * (aggregate.ts). Database-only and LLM-free; every table it writes is derived (D). A generator of small steps
 * (run with runSteps / drainSteps).
 */
import type { DB } from '../../db/connection';
import { aggregateEdges, writeEdgeStats } from './aggregate';
import { deriveCoGroup, deriveMessageEvidence, loadGraphPeople, syncEvidence } from './evidence';
import { drainSteps, runSteps } from './steps';

export interface GraphRunStats {
  coGroup: number;
  groupReply: number;
  mentionedTogether: number;
  messagesScanned: number;
  evidenceInserted: number;
  evidenceUpdated: number;
  evidenceDeleted: number;
  pairs: number;
  edgeStatsStored: number;
  edgeStatsUpserted: number;
  edgeStatsDeleted: number;
}

export function* graphPass(db: DB, o: { now?: number } = {}): Generator<void, GraphRunStats> {
  const now = o.now ?? Date.now();
  const stats: GraphRunStats = {
    coGroup: 0,
    groupReply: 0,
    mentionedTogether: 0,
    messagesScanned: 0,
    evidenceInserted: 0,
    evidenceUpdated: 0,
    evidenceDeleted: 0,
    pairs: 0,
    edgeStatsStored: 0,
    edgeStatsUpserted: 0,
    edgeStatsDeleted: 0,
  };
  const people = loadGraphPeople(db);
  yield;
  const add = (s: { inserted: number; updated: number; deleted: number }) => {
    stats.evidenceInserted += s.inserted;
    stats.evidenceUpdated += s.updated;
    stats.evidenceDeleted += s.deleted;
  };

  const coGroup = yield* deriveCoGroup(db, people, now);
  stats.coGroup = coGroup.size;
  add(yield* syncEvidence(db, 'co_group', coGroup, now));

  const msg = yield* deriveMessageEvidence(db, people, now);
  stats.groupReply = msg.groupReply.size;
  stats.mentionedTogether = msg.mentioned.size;
  stats.messagesScanned = msg.scanned;
  add(yield* syncEvidence(db, 'group_reply', msg.groupReply, now));
  add(yield* syncEvidence(db, 'mentioned_together', msg.mentioned, now));

  const pairs = yield* aggregateEdges(db, now);
  stats.pairs = pairs.size;
  const w = yield* writeEdgeStats(db, pairs, now);
  stats.edgeStatsStored = w.stored;
  stats.edgeStatsUpserted = w.upserted;
  stats.edgeStatsDeleted = w.deleted;
  return stats;
}

export const runGraph = (db: DB, o: { now?: number } = {}): GraphRunStats => drainSteps(graphPass(db, o));

export const runGraphAsync = (db: DB, o: { now?: number; signal?: AbortSignal; sliceMs?: number } = {}) =>
  runSteps(graphPass(db, o), { signal: o.signal, sliceMs: o.sliceMs });

/** Recomputes edge_stats only (after a "wrong" or an undo touched labels), synchronously. */
export function refreshEdgeStats(db: DB, now = Date.now()): { stored: number; upserted: number; deleted: number } {
  return drainSteps(
    (function* () {
      const pairs = yield* aggregateEdges(db, now);
      return yield* writeEdgeStats(db, pairs, now);
    })(),
  );
}
