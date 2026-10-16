/**
 * `yb migrate-legacy [--dry-run] [--phase core|reconcile]` (architecture.md §5): snapshot the legacy SwiftData
 * store, then import it into yeackbot under one runs(kind='migration') so the whole import can be undone.
 * Real runs are one transaction: any problem (bplist shape, cycles, failed equations, broken integrity) rolls
 * everything back. Dry runs do the same work, run it a second time to prove idempotency, then roll back.
 */
import type { DB } from '../db/connection';
import { rebuildPersonCanon } from '../db/canon';
import { finishRun, startRun } from '../journal/runs';
import { applyCore, verifyCore, type ApplyResult } from './core';
import { LegacySchemaError, LegacyStore } from './legacyStore';
import { buildPlan, type CorePlan } from './plan';
import { reconcileInteractions, ReconcileRefusedError } from './reconcile';
import type { CoreReport, MigrationReport } from './report';
import { openSnapshot, takeSnapshot, type Snapshot } from './snapshot';

export { formatReport, type MigrationReport } from './report';
export { DEFAULT_LEGACY_STORE } from './snapshot';

export type MigrationPhase = 'core' | 'reconcile';

export interface MigrateLegacyOptions {
  /** The yeackbot database (schema migrated). */
  db: DB;
  /** Path of the legacy default.store (only ever copied). */
  sourcePath: string;
  /** Where snapshots go: <importsDir>/legacy-<ts>/ */
  importsDir: string;
  phase?: MigrationPhase;
  dryRun?: boolean;
  now?: number;
  /** Time zone legacy birthdays were entered in (default: this Mac's). */
  timeZone?: string;
  /** reconcile: run even with no ingested iMessage history. */
  force?: boolean;
}

/** Thrown inside the transaction to roll it back while carrying the report out. */
class Rollback extends Error {
  constructor(readonly report: MigrationReport) {
    super('rollback');
  }
}

function coreReport(plan: CorePlan, applied: ApplyResult, verified: ReturnType<typeof verifyCore>): CoreReport {
  const d = plan.diag;
  return {
    inserted: applied.inserted,
    existing: applied.existing,
    respected: applied.respected,
    equations: verified.equations,
    integrity: verified.integrity,
    merges: {
      planned: d.mergesByBasis,
      appliedLegacy: applied.merges.legacy,
      autoMerged: applied.merges.auto,
      skipped: applied.merges.skipped,
      refused: applied.merges.refused,
      maxChainDepth: d.maxChainDepth,
      orphanIds: d.orphanMergedIds,
      danglingPointerIds: d.danglingPointerIds,
      ambiguousIds: d.ambiguousMergeIds,
      cycles: d.cycles,
      nameOnlyAuditIds: d.nameOnlyMergedIds,
    },
    identities: {
      planned: plan.identities.length,
      phonesE164: d.phonesE164,
      phonesRaw: d.phonesRaw,
      unparseablePhonePersonIds: d.unparseablePhonePersonIds,
      emailsInvalid: d.emailsInvalid,
      socialInvalid: d.socialInvalid,
      mergedAwayKeysAlreadyOwned: d.mergedAwayKeysAlreadyOwned,
      conflicts: d.identityConflicts,
      sharedFlagged: plan.identities.filter((i) => i.shared).length,
      targetConflicts: applied.targetIdentityConflicts,
    },
    birthdays: { total: d.birthdays, noYear: d.birthdaysNoYear, invalid: d.birthdaysInvalid },
    links: d.links,
    tagNameCollisions: d.tagNameCollisions,
    orphans: {
      notesWithoutContact: d.notesWithoutContact,
      remindersWithoutContact: d.remindersWithoutContact,
      edgesSkipped: d.edgesSkipped,
      dismissedWithoutContact: d.dismissedWithoutContact,
    },
  };
}

/** Problems found before anything is written: the run refuses to apply a store it can't read faithfully. */
function preflight(store: LegacyStore, plan: CorePlan): string[] {
  const p: string[] = [];
  if (store.decodeFailures.length) p.push(`${store.decodeFailures.length} array/JSON column(s) could not be decoded (see bplist failures)`);
  if (store.uuidFailures.length) p.push(`${store.uuidFailures.length} row(s) without a valid 16-byte ZID`);
  if (plan.diag.duplicateUuids.length) p.push(`duplicate contact ZIDs: ${plan.diag.duplicateUuids.join(', ')}`);
  if (plan.diag.cycles.length) p.push(`${plan.diag.cycles.length} merge cycle(s) among merged-away contacts`);
  return p;
}

function postflight(core: CoreReport, applied: ApplyResult): string[] {
  const p = [...applied.problems];
  for (const e of core.equations) if (!e.ok) p.push(`equation failed: ${e.name} (expected ${e.expected}, got ${e.actual})`);
  const g = core.integrity;
  if (g.foreignKeyViolations) p.push(`${g.foreignKeyViolations} foreign key violation(s)`);
  if (g.canonCycles) p.push('merge pointers form a cycle');
  if (g.mergedIntoInactive.length) p.push(`${g.mergedIntoInactive.length} merged people resolve to a non-active person`);
  return p;
}

export function migrateLegacy(o: MigrateLegacyOptions): MigrationReport {
  const phase = o.phase ?? 'core';
  const dryRun = o.dryRun ?? false;
  const now = o.now ?? Date.now();
  const report: MigrationReport = {
    phase,
    dryRun,
    ok: false,
    problems: [],
    runId: null,
    snapshot: null,
    source: null,
    plist: { encodings: {}, failures: [] },
    uuidFailures: [],
  };

  let snap: Snapshot;
  try {
    snap = takeSnapshot({ sourcePath: o.sourcePath, importsDir: o.importsDir, now });
  } catch (e) {
    report.problems.push((e as Error).message);
    return report;
  }
  report.snapshot = { dir: snap.dir, takenAt: snap.takenAt, copiedWal: snap.copiedWal, attempts: snap.attempts };
  const src = openSnapshot(snap.storePath);
  try {
    let store: LegacyStore;
    try {
      store = new LegacyStore(src);
    } catch (e) {
      if (!(e instanceof LegacySchemaError)) throw e;
      report.problems.push(...e.problems);
      return report;
    }
    report.source = store.counts();

    const work = (): MigrationReport => {
      const runId = startRun(o.db, 'migration', { now });
      if (phase === 'reconcile') {
        try {
          report.reconcile = reconcileInteractions(o.db, store, { runId, now, force: o.force });
        } catch (e) {
          if (!(e instanceof ReconcileRefusedError)) throw e;
          report.problems.push(e.message);
          throw new Rollback(report);
        }
        report.uuidFailures = [...store.uuidFailures];
        // legacy messages are keyed by the interaction's ZID: without one the import can't be idempotent
        if (report.uuidFailures.length) report.problems.push(`${report.uuidFailures.length} interaction(s) without a valid 16-byte ZID`);
      } else {
        const plan = buildPlan(store, { runId, now, timeZone: o.timeZone });
        report.plist = { encodings: { ...store.plistEncodings }, failures: [...store.decodeFailures] };
        report.uuidFailures = [...store.uuidFailures];
        const pre = preflight(store, plan);
        if (pre.length) {
          report.problems.push(...pre);
          throw new Rollback(report);
        }
        const applied = applyCore(o.db, plan, { runId, now });
        const core = coreReport(plan, applied, verifyCore(o.db, plan, applied.respected));
        report.core = core;
        report.problems.push(...postflight(core, applied));
        if (dryRun) {
          const again = applyCore(o.db, plan, { runId: startRun(o.db, 'migration', { now }), now });
          const byTable = Object.fromEntries(Object.entries(again.inserted).filter(([, n]) => n > 0));
          const secondPassInserted = Object.values(byTable).reduce((a, b) => a + b, 0);
          core.idempotency = { secondPassInserted, byTable };
          if (secondPassInserted) report.problems.push(`second pass inserted ${secondPassInserted} row(s): not idempotent`);
        }
      }
      report.ok = report.problems.length === 0;
      if (!report.ok) throw new Rollback(report);
      if (dryRun) throw new Rollback(report);
      rebuildPersonCanon(o.db);
      finishRun(o.db, runId, 'ok', { now, summary: summaryOf(report) });
      report.runId = runId;
      return report;
    };

    // better-sqlite3 nests through a SAVEPOINT, so a Rollback undoes exactly this run even inside a caller's tx.
    const t = o.db.transaction(work);
    try {
      if (o.db.inTransaction) t();
      else t.immediate();
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    return report;
  } finally {
    src.close();
  }
}

/** What runs.summary keeps: the report minus the bulky per-row lists' duplicates. */
function summaryOf(r: MigrationReport): Record<string, unknown> {
  return {
    phase: r.phase,
    snapshot: r.snapshot,
    source: r.source,
    plist: r.plist.encodings,
    core: r.core && {
      inserted: r.core.inserted,
      existing: r.core.existing,
      respected: r.core.respected,
      equations: r.core.equations,
      merges: r.core.merges,
      identities: { ...r.core.identities },
      birthdays: r.core.birthdays,
      links: r.core.links,
    },
    reconcile: r.reconcile,
  };
}
