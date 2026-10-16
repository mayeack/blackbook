/**
 * Candidate generators for reply_debt and commitment_due (intelligence §5 table), registered through
 * pipeline/suggestions/registry.ts. Pure readers over the live loops (the hourly passes keep them fresh):
 *
 *   reply_debt      one per person (their most pressing open debt); base = normalized priority
 *                   urg · (0.3 + 0.7·T/100 + 0.3·priority) · age_w, clamped to [0, 1]; expires 30 days after it
 *                   was asked.
 *   commitment_due  due commitments and open ones due within 24 h; base 0.6 + 0.4·[owner me/both];
 *                   owner = them ("waiting on") only for priority people or T ≥ 60, at × 0.5. Expires when it
 *                   would lapse. A commitment that lapsed in the last 7 days is asked about once ("did this
 *                   happen?", subject `lapsed:<id>`, base 0.4) unless that question was already delivered.
 * Persons are canonical and visible; sensitive commitments are flagged (never shown in iMessage or push).
 */
import type { DB } from '../../db/connection';
import type { Candidate, CandidateGenerator, GeneratorContext, WildcardSource } from '../suggestions/types';
import { commitmentPeople, dueMoment, lapseMoment, madeAt, type CommitmentRow } from './commitments';
import { COMMITMENT, DAY, HOUR, REPLY_DEBT } from './constants';
import { recentlyLapsed, waitingOnSurfaces } from './loops';
import { debtPriority, type DebtRow } from './replyDebt';
import { isVisible } from './signals';

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

interface DebtGen extends DebtRow {
  pid: string;
  source: string | null;
  conv_kind: string | null;
  tie_strength: number | null;
  is_priority: number;
}

export function replyDebtCandidates(db: DB, now: number): Candidate[] {
  const rows = db
    .prepare(
      `SELECT d.*, pc.canonical_id AS pid, c.source, c.kind AS conv_kind, ps.tie_strength, pv.is_priority
       FROM reply_debts d
       JOIN person_canon pc ON pc.person_id = d.person_id
       JOIN person_visible pv ON pv.id = pc.canonical_id
       LEFT JOIN person_stats ps ON ps.person_id = pc.canonical_id
       LEFT JOIN conversations c ON c.id = d.conversation_id
       WHERE d.status = 'open' OR (d.status = 'snoozed' AND coalesce(d.snoozed_until, 0) <= @now)`,
    )
    .all({ now }) as DebtGen[];
  const best = new Map<string, { row: DebtGen; priority: number }>();
  for (const r of rows) {
    if (now - r.asked_at > REPLY_DEBT.expiryMs) continue;
    const priority = debtPriority(r, r.tie_strength, r.is_priority === 1, now);
    const cur = best.get(r.pid);
    if (!cur || priority > cur.priority || (priority === cur.priority && r.asked_at < cur.row.asked_at)) best.set(r.pid, { row: r, priority });
  }
  const out: Candidate[] = [];
  for (const { row: r, priority } of best.values()) {
    const msg = r.debt_msg ?? r.last_inbound_msg;
    out.push({
      kind: 'reply_debt',
      personIds: [r.pid],
      subjectKey: r.id,
      base: clamp01(priority),
      evidenceIds: [`m:${msg}`, `conv:${r.conversation_id}`],
      expiresAt: r.asked_at + REPLY_DEBT.expiryMs,
      links: { replyDebtId: r.id },
      payload: {
        question: `m:${msg}`,
        ageH: Math.round((now - r.asked_at) / HOUR),
        reason: r.reason ?? null,
        urgency: r.urgency ?? 'normal',
        likely: r.classifier === 'heuristic',
        confidence: r.confidence ?? null,
        source: r.source ?? null,
        group: r.conv_kind === 'group',
        priority: Math.round(priority * 1000) / 1000,
        tieStrength: r.tie_strength ?? null,
      },
    });
  }
  return out;
}

interface CommitGen extends CommitmentRow {
  pid: string;
  tie_strength: number | null;
  is_priority: number;
}

function commitmentEvidenceIds(db: DB, k: CommitmentRow): string[] {
  const msgs = db
    .prepare(`SELECT message_id FROM evidence WHERE subject_type = 'commitment' AND subject_id = ? ORDER BY message_id LIMIT 3`)
    .pluck()
    .all(k.id) as number[];
  return [`K${k.id}`, ...msgs.map((m) => `m:${m}`)];
}

export function commitmentCandidates(db: DB, now: number): Candidate[] {
  const rows = db
    .prepare(
      `SELECT k.*, pc.canonical_id AS pid, ps.tie_strength, pv.is_priority
       FROM commitments k
       JOIN person_canon pc ON pc.person_id = k.person_id
       JOIN person_visible pv ON pv.id = pc.canonical_id
       LEFT JOIN person_stats ps ON ps.person_id = pc.canonical_id
       WHERE k.status IN ('open','due')`,
    )
    .all() as CommitGen[];
  const out: Candidate[] = [];
  for (const k of rows) {
    const due = dueMoment(k);
    const isDue = k.status === 'due' || now >= due;
    if (!isDue && due - now > COMMITMENT.upcomingMs) continue;
    const them = k.owner === 'them';
    if (them && !waitingOnSurfaces(k.tie_strength, k.is_priority === 1)) continue;
    const people = commitmentPeople(db, k).filter((p) => isVisible(db, p));
    out.push({
      kind: 'commitment_due',
      personIds: people.length ? people : [k.pid],
      subjectKey: k.id,
      base: clamp01((0.6 + 0.4 * (them ? 0 : 1)) * (them ? COMMITMENT.waitingWeight : 1)),
      evidenceIds: commitmentEvidenceIds(db, k),
      expiresAt: lapseMoment(k),
      sensitive: k.sensitive === 1,
      links: { commitmentId: k.id },
      payload: {
        commitment: `K${k.id}`,
        owner: k.owner,
        commitmentKind: k.kind,
        waitingOn: them,
        dueAt: due,
        precision: k.due_precision ?? null,
        overdueD: isDue ? Math.max(0, Math.floor((now - due) / DAY)) : 0,
        upcoming: !isDue,
        madeD: Math.floor((now - madeAt(k)) / DAY),
      },
    });
  }
  // "Did this happen?" — once per lapsed commitment.
  const asked = db.prepare(`SELECT 1 FROM suggestions WHERE dedupe_key = ? AND delivered_at IS NOT NULL LIMIT 1`).pluck();
  for (const k of recentlyLapsed(db, now)) {
    const pid = (db.prepare('SELECT pv.id FROM person_canon pc JOIN person_visible pv ON pv.id = pc.canonical_id WHERE pc.person_id = ?').pluck().get(k.person_id) as
      | string
      | undefined) ?? null;
    if (!pid) continue;
    const them = k.owner === 'them';
    if (them) {
      const s = db.prepare('SELECT p.is_priority, ps.tie_strength FROM people p LEFT JOIN person_stats ps ON ps.person_id = p.id WHERE p.id = ?').get(pid) as {
        is_priority: number;
        tie_strength: number | null;
      };
      if (!waitingOnSurfaces(s.tie_strength, s.is_priority === 1)) continue;
    }
    const subjectKey = `lapsed:${k.id}`;
    if (asked.get(`commitment_due:${subjectKey}`) !== undefined) continue;
    out.push({
      kind: 'commitment_due',
      personIds: [pid],
      subjectKey,
      base: clamp01(0.4 * (them ? COMMITMENT.waitingWeight : 1)),
      evidenceIds: commitmentEvidenceIds(db, k),
      expiresAt: lapseMoment(k) + COMMITMENT.lapseAskWindowMs,
      sensitive: k.sensitive === 1,
      links: { commitmentId: k.id },
      payload: { commitment: `K${k.id}`, owner: k.owner, commitmentKind: k.kind, lapsed: true, question: 'did_this_happen', waitingOn: them },
    });
  }
  return out;
}

export const generators: CandidateGenerator[] = [
  { kind: 'reply_debt', generate: (ctx: GeneratorContext) => replyDebtCandidates(ctx.db, ctx.now) },
  { kind: 'commitment_due', generate: (ctx: GeneratorContext) => commitmentCandidates(ctx.db, ctx.now) },
];

/** No 🎲 wildcard comes from obligations (an owed reply is never a surprise). */
export const wildcardSources: WildcardSource[] = [];
