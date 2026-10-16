/**
 * The migration report: counts and ids only. Never names, phones, emails, handles or message text, so it is
 * safe to print, log and store in runs.summary.
 */
import type { Equation, Integrity } from './core';
import type { DecodeFailure, SourceCounts } from './legacyStore';
import type { IdentityConflict, MergeBasis, PlanDiagnostics } from './plan';
import type { ReconcileResult } from './reconcile';

export interface CoreReport {
  inserted: Record<string, number>;
  existing: Record<string, number>;
  /** skipped because the user undid them after an earlier import (undo is sticky) */
  respected: Record<string, number>;
  equations: Equation[];
  integrity: Integrity;
  merges: {
    planned: Record<MergeBasis, number>;
    appliedLegacy: number;
    autoMerged: number;
    skipped: number;
    refused: Record<string, number>;
    maxChainDepth: number;
    orphanIds: string[];
    danglingPointerIds: string[];
    ambiguousIds: string[];
    cycles: string[][];
    /** legacy merges recovered from a name match alone: listed for the one-time audit on Today */
    nameOnlyAuditIds: string[];
  };
  identities: {
    planned: number;
    phonesE164: number;
    phonesRaw: number;
    unparseablePhonePersonIds: string[];
    emailsInvalid: number;
    socialInvalid: number;
    mergedAwayKeysAlreadyOwned: number;
    conflicts: IdentityConflict[];
    sharedFlagged: number;
    targetConflicts: number;
  };
  birthdays: { total: number; noYear: number; invalid: number };
  links: PlanDiagnostics['links'];
  tagNameCollisions: number;
  orphans: { notesWithoutContact: number; remindersWithoutContact: number; edgesSkipped: number; dismissedWithoutContact: number };
  /** dry run only: a second pass inside the same rolled-back transaction */
  idempotency?: { secondPassInserted: number; byTable: Record<string, number> };
}

export interface MigrationReport {
  phase: 'core' | 'reconcile';
  dryRun: boolean;
  ok: boolean;
  problems: string[];
  runId: string | null;
  snapshot: { dir: string; takenAt: number; copiedWal: boolean; attempts: number } | null;
  source: SourceCounts | null;
  plist: { encodings: Record<string, number>; failures: DecodeFailure[] };
  uuidFailures: { entity: string; pk: number }[];
  core?: CoreReport;
  reconcile?: ReconcileResult;
}

const MAX_IDS = 12;
const ids = (list: string[]) => (list.length <= MAX_IDS ? list.join(', ') : `${list.slice(0, MAX_IDS).join(', ')} … +${list.length - MAX_IDS} more`);

function table(rows: (string | number)[][]): string[] {
  const widths = rows.reduce<number[]>((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, String(c).length)), []);
  return rows.map((r) => `  ${r.map((c, i) => (typeof c === 'number' ? String(c).padStart(widths[i]!) : String(c).padEnd(widths[i]!))).join('  ')}`.trimEnd());
}

/** Human-readable report (the JSON form is the report object itself). */
export function formatReport(r: MigrationReport): string {
  const out: string[] = [];
  out.push(`legacy migration · phase ${r.phase}${r.dryRun ? ' · DRY RUN (rolled back)' : ''} · ${r.ok ? 'OK' : 'FAILED'}`);
  if (r.runId) out.push(`run: ${r.runId}`);
  if (r.snapshot) out.push(`snapshot: ${r.snapshot.dir} (wal copied: ${r.snapshot.copiedWal ? 'yes' : 'no'}, attempts ${r.snapshot.attempts})`);
  if (r.problems.length) {
    out.push('problems:');
    for (const p of r.problems) out.push(`  - ${p}`);
  }
  if (r.source) {
    out.push('source (snapshot):');
    out.push(...table(Object.entries(r.source).map(([k, v]) => [k, v])));
  }
  const enc = r.plist.encodings;
  out.push(`bplist arrays: ${enc.plain ?? 0} plain, ${enc.keyed_archive ?? 0} NSKeyedArchiver string arrays, ${enc.empty ?? 0} empty; ${r.plist.failures.length} failure(s)`);
  for (const f of r.plist.failures.slice(0, MAX_IDS)) out.push(`  - ${f.entity} pk ${f.pk} ${f.column}: ${f.reason}`);
  if (r.uuidFailures.length) out.push(`ZID failures: ${r.uuidFailures.map((u) => `${u.entity}#${u.pk}`).join(', ')}`);

  const c = r.core;
  if (c) {
    const tables = [...new Set([...Object.keys(c.inserted), ...Object.keys(c.existing)])].sort();
    out.push('target (this run):');
    out.push(...table([['table', 'inserted', 'existing'], ...tables.map((t) => [t, c.inserted[t] ?? 0, c.existing[t] ?? 0])]));
    const respected = Object.entries(c.respected);
    if (respected.length) out.push(`kept undone since an earlier import: ${respected.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    out.push('equations:');
    out.push(...table([['check', 'expected', 'actual', ''], ...c.equations.map((e) => [e.name, e.expected, e.actual, e.ok ? 'ok' : 'MISMATCH'])]));
    const m = c.merges;
    out.push(
      `merges: planned ${m.planned.pointer} by pointer, ${m.planned.key_name} recovered by phone/email + name, ${m.planned.name_only} by name only; ` +
        `applied ${m.appliedLegacy} legacy + ${m.autoMerged} shared-key auto-merges; skipped ${m.skipped}; max chain depth ${m.maxChainDepth}`,
    );
    const refused = Object.entries(m.refused);
    if (refused.length) out.push(`  refused: ${refused.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (m.orphanIds.length) out.push(`  merged-away without a target (kept active + hidden): ${m.orphanIds.length}: ${ids(m.orphanIds)}`);
    if (m.danglingPointerIds.length) out.push(`  dangling ZMERGEDINTOCONTACT: ${ids(m.danglingPointerIds)}`);
    if (m.ambiguousIds.length) out.push(`  ambiguous targets: ${ids(m.ambiguousIds)}`);
    if (m.cycles.length) out.push(`  CYCLES: ${m.cycles.map((cy) => `[${cy.join(' → ')}]`).join(' ')}`);
    if (m.nameOnlyAuditIds.length) out.push(`  name-only legacy merges (audit): ${m.nameOnlyAuditIds.length}: ${ids(m.nameOnlyAuditIds)}`);
    const i = c.identities;
    out.push(
      `identities: ${i.planned} planned · phones ${i.phonesE164} E.164 + ${i.phonesRaw} unparseable (raw:, conf 0.5) · ` +
        `${i.emailsInvalid} invalid emails · ${i.socialInvalid} invalid social handles · ${i.mergedAwayKeysAlreadyOwned} merged-away duplicates skipped`,
    );
    if (i.unparseablePhonePersonIds.length) out.push(`  people with unparseable phones: ${ids(i.unparseablePhonePersonIds)}`);
    out.push(`  shared-key conflicts: ${i.conflicts.length} (${i.sharedFlagged} flagged shared=1, never a merge key); target conflicts ${i.targetConflicts}`);
    for (const k of i.conflicts.slice(0, MAX_IDS)) out.push(`  - ${k.kind}: ${k.personIds.join(', ')} → ${k.resolution}`);
    out.push(`birthdays: ${c.birthdays.total} (${c.birthdays.noYear} without a year → --MM-DD, ${c.birthdays.invalid} invalid)`);
    out.push(
      `links: ${Object.entries(c.links)
        .map(([k, v]) => `${k} ${v.total} (orphan ${v.orphan}, merged dupes ${v.dupes})`)
        .join(' · ')}; same-name tags ${c.tagNameCollisions}`,
    );
    const o = c.orphans;
    out.push(
      `without a contact: notes ${o.notesWithoutContact}, reminders ${o.remindersWithoutContact}, dismissed notifications ${o.dismissedWithoutContact}; edges skipped ${o.edgesSkipped}`,
    );
    const g = c.integrity;
    out.push(
      `integrity: foreign_key_check ${g.foreignKeyViolations} · canon cycles ${g.canonCycles} · merged into a non-active person ${g.mergedIntoInactive.length}`,
    );
    if (c.idempotency) {
      out.push(`idempotency: second pass inserted ${c.idempotency.secondPassInserted} row(s)${c.idempotency.secondPassInserted ? ` ${JSON.stringify(c.idempotency.byTable)}` : ''}`);
    }
  }
  const x = r.reconcile;
  if (x) {
    out.push('reconcile:');
    out.push(
      ...table([
        ['legacy interactions', x.total],
        ['tapbacks dropped', x.tapbacksDropped],
        ['non-text (→ interactions)', x.nonText],
        ['no person in target', x.noPerson],
        ['no date/direction', x.noDateOrDirection],
        ['eligible text rows', x.eligible],
        ['matched to iMessage', x.matched],
        ['  of which by exact text', x.matchedByText],
        ['already imported', x.alreadyImported],
        ['inserted legacy messages', x.insertedMessages],
        ['inserted conversations', x.insertedConversations],
        ['inserted interactions', x.insertedInteractions],
        ['legacy sessions (re)computed', x.legacySessions],
        ['legacy derived interactions', x.legacyDerivedInteractions],
        ['ingested iMessage rows', x.ingestedImessageMessages],
      ]),
    );
    out.push(`  match rate ${(x.matchRate * 100).toFixed(2)}% (target ≥ 98%: ${x.targetMet ? 'met' : 'NOT met'})`);
  }
  return out.join('\n');
}
