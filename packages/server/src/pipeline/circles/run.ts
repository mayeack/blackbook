/**
 * The weekly circles pass (job 'circles', AGENT_TIMES.circles): aggregate the graph, detect communities
 * (detect.ts) and shared-interest groups (interests.ts), keep circle ids stable, and write the auto circles through
 * the journal (every change undoable). Circles are friend groups and interests: never one party's guest list, and
 * never named after an event (naming.ts).
 *
 * Stability: new communities are matched one-to-one to existing auto circles by Jaccard ≥ 0.5 (greedy, highest
 * first). A match to an active auto circle updates it: new members are added, members the community lost are
 * dropped (only rows the agent itself added or last changed), scores refresh; it is renamed only when the overlap
 * is under 0.7, the owner never renamed it, and it isn't locked. A match to an archived (deleted by the owner) or
 * retracted (agent creation undone) circle is left alone, so the agent never brings it back. Unmatched communities
 * that mostly (Jaccard ≥ 0.6) are one of the owner's own circles (legacy groups included) don't become a
 * duplicate: their extra people show up as that circle's "Suggested additions". Everything else becomes a new auto
 * circle, named by the LLM when available (naming.ts) or from group-chat titles, shared interests or first names; an
 * LLM name another active circle already has falls back to the deterministic one.
 *
 * Interest groups are found by their circle's signature (`interest:<value_norm>`), never renamed, and skipped when a
 * friend group this run covers mostly the same people. One the owner already has a circle for (same name, or
 * Jaccard ≥ 0.6) feeds that circle's "Suggested additions" instead.
 *
 * Event-named circles from before names stopped using event titles (circle_auto_meta basis kind 'event'): one the
 * detection still finds is renamed; one it no longer finds is retired (status 'retracted', an agent batch the owner
 * can undo) unless the owner ever touched it (renamed, locked, edited members, undid something). A circle the agent
 * retired doesn't block a later community from becoming a new circle.
 *
 * Partiful organizer accounts (partifulOrganizers) are never members: a venue or promoter hosting a party series is
 * the center of every one of its guest lists, not part of a friend group.
 *
 * Sticky decisions: a member the owner removed (or whose addition was undone) stays out; the agent re-adds only
 * people it dropped itself. Manual (user) circles, tags and locations are never written here. Apart from those
 * event-named retirements, auto circles are never deleted by the agent.
 */
import { uuidv7 } from '@yb/shared';
import { sourceRun } from '../../adapters/common/context';
import type { DB } from '../../db/connection';
import { tx } from '../../db/tx';
import { selfPeople } from '../../identity/self';
import { withBatch, type JournalTx } from '../../journal/batch';
import { encodeKey } from '../../journal/tables';
import type { Egress, LlmClient } from '../../llm/types';
import { nullLogger, type Logger } from '../../ops/logger';
import { aggregateEdges } from '../graph/aggregate';
import { loadGraphPeople } from '../graph/evidence';
import { runSteps } from '../graph/steps';
import { buildCircleGraph, DETECT_SEED, detectCommunities, greedyMatch, jaccard, type Community } from './detect';
import { INTEREST_SIGNATURE_PREFIX, interestGroups, type InterestGroup } from './interests';
import { deterministicName, llmName, loadNamingContext, titleKey, type CircleName, type NamingContext } from './naming';

export const MATCH_JACCARD = 0.5;
export const RENAME_BELOW_JACCARD = 0.7;
export const USER_CIRCLE_JACCARD = 0.6;
const SCORE_EPSILON = 0.05;
const MAX_LLM_NAMES = 12;

export const CIRCLE_COLORS = ['#4f7cac', '#c0504d', '#7a9e3b', '#8064a2', '#3f9fb5', '#e08a2e', '#2c7873', '#c25b9a', '#9a7b2f', '#5b6bd6'];

export function circleColor(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return CIRCLE_COLORS[(h >>> 0) % CIRCLE_COLORS.length]!;
}

export interface CirclesRunOptions {
  now?: number;
  signal?: AbortSignal;
  jobRunId?: number | null;
  /** LLM naming (inert when absent, unconfigured or over budget). */
  llm?: LlmClient | null;
  egress?: Egress | null;
  log?: Logger;
  maxLlmNames?: number;
  seed?: number;
}

export interface CirclesRunStats {
  nodes: number;
  edges: number;
  communities: number;
  created: number;
  updated: number;
  renamed: number;
  membersAdded: number;
  membersDropped: number;
  scoresUpdated: number;
  leftAlone: number;
  userMatches: number;
  suggestions: number;
  llmNamed: number;
  /** shared-interest groups considered (after dropping those a friend group covers) */
  interests: number;
  /** event-named circles retired */
  retired: number;
}

export interface CirclesRunResult {
  stats: CirclesRunStats;
  complete: boolean;
  runId: string | null;
}

interface MemberRow {
  circle_id: string;
  person_id: string;
  score: number | null;
  origin: 'auto' | 'user' | 'legacy';
  excluded: number;
}

interface ExistingCircle {
  id: string;
  kind: 'auto' | 'user';
  status: 'active' | 'archived' | 'retracted';
  locked: number;
  name: string;
  signature: string | null;
  /** canonical person → that person's rows (several after a merge; the canonical id's own row first). */
  rows: Map<string, MemberRow[]>;
  /** visible canonical people with a non-excluded row */
  active: Set<string>;
  /** every canonical person with any row */
  all: Set<string>;
}

function loadCircles(db: DB, canon: Map<string, string>, visible: ReadonlySet<string>, onlyId?: string): ExistingCircle[] {
  const circles = db
    .prepare(
      `SELECT id, kind, status, locked, name, signature FROM circles WHERE status IN ('active','archived','retracted') AND (@id IS NULL OR id = @id) ORDER BY id`,
    )
    .all({ id: onlyId ?? null }) as Omit<ExistingCircle, 'rows' | 'active' | 'all'>[];
  const byId = new Map(circles.map((c) => [c.id, { ...c, rows: new Map<string, MemberRow[]>(), active: new Set<string>(), all: new Set<string>() }]));
  for (const m of db
    .prepare('SELECT circle_id, person_id, score, origin, excluded FROM circle_members WHERE (@id IS NULL OR circle_id = @id) ORDER BY circle_id, person_id')
    .all({ id: onlyId ?? null }) as MemberRow[]) {
    const c = byId.get(m.circle_id);
    if (!c) continue;
    const p = canon.get(m.person_id) ?? m.person_id;
    const list = c.rows.get(p) ?? [];
    if (m.person_id === p) list.unshift(m);
    else list.push(m);
    c.rows.set(p, list);
    c.all.add(p);
    if (m.excluded === 0 && visible.has(p)) c.active.add(p);
  }
  return [...byId.values()];
}

/** The batch that last changed a journaled row: was it the agent's own (not an undo)? */
function lastChangeByAgent(db: DB, table: string, key: Record<string, unknown>): boolean {
  const r = db
    .prepare(
      `SELECT cb.actor, cb.kind FROM change_log cl JOIN change_batches cb ON cb.id = cl.batch_id
       WHERE cl.entity = ? AND cl.entity_key = ? ORDER BY cl.seq DESC LIMIT 1`,
    )
    .get(table, encodeKey(table, key)) as { actor: string; kind: string } | undefined;
  return !!r && r.actor === 'agent' && r.kind !== 'undo';
}

/** The owner renamed this circle at some point (the agent then never renames it). */
export function userRenamed(db: DB, circleId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM change_log cl JOIN change_batches cb ON cb.id = cl.batch_id
         WHERE cl.entity = 'circles' AND cl.entity_key = ? AND cb.actor = 'user' AND json_extract(cl.after, '$.name') IS NOT NULL LIMIT 1`,
      )
      .get(circleId) !== undefined
  );
}

/** The owner changed this circle or its members at some point (edits, removals, undos): the agent never retires it. */
export function ownerTouched(db: DB, circleId: string): boolean {
  const prefix = `${JSON.stringify([circleId]).slice(0, -1)},`.replace(/[\\%_]/g, (c) => `\\${c}`);
  return (
    db
      .prepare(
        `SELECT 1 FROM change_log cl JOIN change_batches cb ON cb.id = cl.batch_id
         WHERE cb.actor = 'user' AND ((cl.entity = 'circles' AND cl.entity_key = ?) OR (cl.entity = 'circle_members' AND cl.entity_key LIKE ? ESCAPE '\\'))
         LIMIT 1`,
      )
      .get(circleId, `${prefix}%`) !== undefined
  );
}

/**
 * Partiful organizer accounts (venues, promoters, party series): records known only through Partiful (no identity
 * from any other source) that hosted at least two Partiful events and never came to one as a guest.
 */
export function partifulOrganizers(db: DB): Set<string> {
  const isHost = `(a.role IN ('host','co_host') OR a.status = 'host')`;
  return new Set(
    db
      .prepare(
        `SELECT pc.canonical_id FROM event_attendees a
         JOIN events e ON e.id = a.event_id AND e.source = 'partiful'
         JOIN person_canon pc ON pc.person_id = a.person_id
         GROUP BY pc.canonical_id
         HAVING sum(${isHost}) >= 2 AND sum(NOT ${isHost}) = 0
           AND NOT EXISTS (SELECT 1 FROM identities i JOIN person_canon q ON q.person_id = i.person_id
                           WHERE q.canonical_id = pc.canonical_id AND i.source <> 'partiful' AND i.status IN ('active','superseded'))`,
      )
      .pluck()
      .all() as string[],
  );
}

interface MemberPlan {
  adds: { person: string; score: number }[];
  revives: { row: MemberRow; score: number }[];
  scores: { row: MemberRow; score: number }[];
  drops: MemberRow[];
}

function planMembers(db: DB, c: ExistingCircle, comm: Community): MemberPlan {
  const plan: MemberPlan = { adds: [], revives: [], scores: [], drops: [] };
  for (const [p, score] of [...comm.scores].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const rows = c.rows.get(p);
    if (!rows?.length) {
      plan.adds.push({ person: p, score });
      continue;
    }
    const live = rows.find((r) => r.excluded === 0);
    if (live) {
      if (live.origin === 'auto' && (live.score === null || Math.abs(live.score - score) >= SCORE_EPSILON)) plan.scores.push({ row: live, score });
      continue;
    }
    const row = rows[0]!;
    if (row.origin === 'auto' && lastChangeByAgent(db, 'circle_members', { circle_id: row.circle_id, person_id: row.person_id })) plan.revives.push({ row, score });
  }
  for (const [p, rows] of c.rows) {
    if (comm.scores.has(p)) continue;
    for (const r of rows) if (r.excluded === 0 && r.origin === 'auto' && lastChangeByAgent(db, 'circle_members', { circle_id: r.circle_id, person_id: r.person_id })) plan.drops.push(r);
  }
  return plan;
}

const planSize = (p: MemberPlan) => p.adds.length + p.revives.length + p.scores.length + p.drops.length;

function applyMembers(t: JournalTx, circleId: string, plan: MemberPlan, stats: CirclesRunStats): void {
  for (const a of plan.adds) {
    t.insert('circle_members', { circle_id: circleId, person_id: a.person, score: a.score, origin: 'auto', excluded: 0 });
    stats.membersAdded++;
  }
  for (const r of plan.revives) {
    if (t.update('circle_members', { circle_id: r.row.circle_id, person_id: r.row.person_id }, { excluded: 0, score: r.score })) stats.membersAdded++;
  }
  for (const s of plan.scores) {
    if (t.update('circle_members', { circle_id: s.row.circle_id, person_id: s.row.person_id }, { score: s.score })) stats.scoresUpdated++;
  }
  for (const d of plan.drops) {
    if (t.update('circle_members', { circle_id: d.circle_id, person_id: d.person_id }, { excluded: 1 })) stats.membersDropped++;
  }
}

function upsertMeta(db: DB, circleId: string, name: CircleName | null, coreSize: number, modularity: number, now: number): void {
  db.prepare(
    `INSERT INTO circle_auto_meta (circle_id, named_by, name_basis, llm_request, modularity, core_size, last_detected_at, created_at, updated_at)
     VALUES (@id, @named_by, @basis, @llm, @modularity, @core, @now, @now, @now)
     ON CONFLICT (circle_id) DO UPDATE SET
       named_by = CASE WHEN @has_name THEN excluded.named_by ELSE circle_auto_meta.named_by END,
       name_basis = CASE WHEN @has_name THEN excluded.name_basis ELSE circle_auto_meta.name_basis END,
       llm_request = CASE WHEN @has_name THEN excluded.llm_request ELSE circle_auto_meta.llm_request END,
       modularity = excluded.modularity, core_size = excluded.core_size, last_detected_at = excluded.last_detected_at,
       updated_at = excluded.updated_at`,
  ).run({
    id: circleId,
    named_by: name?.namedBy ?? 'rule',
    basis: JSON.stringify(name?.basis ?? {}),
    llm: name?.llmRequest ?? null,
    modularity: Math.round(modularity * 10_000) / 10_000,
    core: coreSize,
    now,
    has_name: name ? 1 : 0,
  });
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function runCircles(db: DB, o: CirclesRunOptions = {}): Promise<CirclesRunResult> {
  const now = o.now ?? Date.now();
  const log = o.log ?? nullLogger;
  const stats: CirclesRunStats = {
    nodes: 0,
    edges: 0,
    communities: 0,
    created: 0,
    updated: 0,
    renamed: 0,
    membersAdded: 0,
    membersDropped: 0,
    scoresUpdated: 0,
    leftAlone: 0,
    userMatches: 0,
    suggestions: 0,
    llmNamed: 0,
    interests: 0,
    retired: 0,
  };
  const agg = await runSteps(aggregateEdges(db, now), { signal: o.signal });
  if (!agg.complete) return { stats, complete: false, runId: null };

  // Records of mine (identity/self.ts) are never circle members: the owner is the center of every circle. Nor are
  // Partiful organizer accounts.
  const self = selfPeople(db);
  const organizers = partifulOrganizers(db);
  const visible = new Set((db.prepare('SELECT id FROM person_visible').pluck().all() as string[]).filter((id) => !self.has(id) && !organizers.has(id)));
  const det = detectCommunities(buildCircleGraph(agg.value.values(), visible), o.seed ?? DETECT_SEED);
  stats.nodes = det.nodes;
  stats.edges = det.edges;
  stats.communities = det.communities.length;
  await yieldToLoop();

  const canon = new Map(db.prepare('SELECT person_id, canonical_id FROM person_canon').raw().all() as [string, string][]);
  const existing = loadCircles(db, canon, visible);
  const autos = existing.filter((c) => c.kind === 'auto');
  const users = existing.filter((c) => c.kind === 'user' && c.status === 'active');
  const fresh = det.communities.map((c) => new Set(c.scores.keys()));
  const isInterest = (c: ExistingCircle) => c.signature?.startsWith(INTEREST_SIGNATURE_PREFIX) === true;
  // A circle the agent itself retired (its last change is the agent's) doesn't keep a community from becoming a circle.
  const matches = greedyMatch(
    fresh,
    autos
      .filter((c) => !isInterest(c) && (c.status === 'active' || !lastChangeByAgent(db, 'circles', { id: c.id })))
      .map((c) => ({ key: c, members: c.status === 'active' ? c.active : c.all })),
    MATCH_JACCARD,
  );
  const bySignature = new Map(autos.filter(isInterest).map((c) => [c.signature!, c]));
  const eventNamed = new Set(
    db
      .prepare(`SELECT circle_id FROM circle_auto_meta WHERE named_by <> 'user' AND json_extract(name_basis, '$.kind') = 'event'`)
      .pluck()
      .all() as string[],
  );

  const run = sourceRun(db, 'circles', { now, jobRunId: o.jobRunId ?? null, kind: 'weekly', actor: 'agent' });
  const naming: NamingContext = loadNamingContext(db, loadGraphPeople(db));
  // Shared interests, unless a friend group found this run is mostly the same people.
  const interests = interestGroups(naming, visible).filter((g) => !fresh.some((f) => jaccard(f, new Set(g.community.core)) >= USER_CIRCLE_JACCARD));
  stats.interests = interests.length;
  const items: { comm: Community; interest: InterestGroup | null }[] = [
    ...det.communities.map((comm) => ({ comm, interest: null })),
    ...interests.map((g) => ({ comm: g.community, interest: g })),
  ];
  /** title key → active circle id, to keep LLM names unique */
  const taken = new Map(existing.filter((c) => c.status === 'active').map((c) => [titleKey(c.name), c.id]));
  let llmBudget = o.maxLlmNames ?? MAX_LLM_NAMES;
  const nameFor = async (comm: Community, subject: string, circleId: string): Promise<CircleName> => {
    if (o.llm && o.egress && llmBudget > 0 && !o.signal?.aborted) {
      llmBudget--;
      try {
        const n = await llmName(db, naming, comm.scores, subject, { llm: o.llm, egress: o.egress, log, signal: o.signal, runId: run.ctx.runId() });
        const holder = n ? taken.get(titleKey(n.name)) : undefined;
        if (n && (holder === undefined || holder === circleId)) {
          stats.llmNamed++;
          return n;
        }
      } catch (e) {
        log.warn('circles.naming_failed', { error_class: (e as Error).name });
      }
    }
    return deterministicName(naming, comm.scores);
  };
  const claimName = (circleId: string, name: string) => {
    for (const [k, id] of taken) if (id === circleId) taken.delete(k);
    taken.set(titleKey(name), circleId);
  };

  const suggestions: { circle: string; person: string; score: number; reason: 'community' | 'near_member' }[] = [];
  const nearFor = (circleId: string, comm: Community, c: ExistingCircle | null) => {
    for (const [p, s] of comm.near) if (!c?.all.has(p)) suggestions.push({ circle: circleId, person: p, score: s, reason: 'near_member' });
  };

  const matched = new Set<string>();
  try {
    for (let i = 0; i < items.length; i++) {
      if (o.signal?.aborted) {
        run.finish('partial', { ...stats });
        return { stats, complete: false, runId: run.runId };
      }
      const { comm, interest } = items[i]!;
      const members = new Set(comm.scores.keys());
      const bySig = interest ? bySignature.get(interest.signature) : undefined;
      const match = interest ? (bySig ? { key: bySig, jaccard: jaccard(members, bySig.active) } : undefined) : matches.get(i);
      if (match) {
        const c = match.key;
        matched.add(c.id);
        if (c.status !== 'active') {
          stats.leftAlone++;
          continue;
        }
        // Interest circles keep the interest's name; an event-named circle always gets a new one.
        const fromEvent = eventNamed.has(c.id);
        const wantsRename = !interest && (match.jaccard < RENAME_BELOW_JACCARD || fromEvent);
        const rename = wantsRename && c.locked === 0 && !userRenamed(db, c.id) ? await nameFor(comm, `circle:${c.id}`, c.id) : null;
        // The naming call may have awaited: re-read the circle so edits the owner made meanwhile win.
        const { plan, renaming } = tx(db, () => {
          const cur = loadCircles(db, canon, visible, c.id)[0];
          if (!cur || cur.status !== 'active') return { plan: null, renaming: false };
          const p = planMembers(db, cur, comm);
          const r = rename !== null && rename.name !== cur.name && !userRenamed(db, c.id);
          if (!planSize(p) && !r) return { plan: p, renaming: r };
          withBatch(
            db,
            {
              runId: run.ctx.runId(),
              kind: 'circle',
              title: r
                ? fromEvent
                  ? 'Renamed an auto circle that was named after an event'
                  : 'Renamed and updated an auto circle'
                : `Updated an auto circle (+${p.adds.length + p.revives.length} / −${p.drops.length})`,
              actor: 'agent',
              confidence: Math.round(match.jaccard * 100) / 100,
            },
            (t) => {
              if (r && rename) {
                if (t.update('circles', { id: c.id }, { name: rename.name, description: rename.description, ...(rename.icon ? { icon: rename.icon } : {}) })) stats.renamed++;
                claimName(c.id, rename.name);
              }
              applyMembers(t, c.id, p, stats);
            },
            { now },
          );
          stats.updated++;
          return { plan: p, renaming: r };
        });
        if (!plan) {
          stats.leftAlone++;
          continue;
        }
        upsertMeta(db, c.id, renaming || (fromEvent && rename) ? rename : null, comm.core.length, det.modularity, now);
        nearFor(c.id, comm, c);
        await yieldToLoop();
        continue;
      }

      // mostly one of the owner's own circles (or, for an interest, one named after it): suggest additions there
      // instead of a duplicate
      let best: { c: ExistingCircle; j: number } | null = null;
      for (const u of users) {
        const j = interest && titleKey(u.name) === titleKey(interest.name) ? 1 : jaccard(members, u.active);
        if (j >= USER_CIRCLE_JACCARD && (!best || j > best.j)) best = { c: u, j };
      }
      if (best) {
        stats.userMatches++;
        for (const [p, s] of comm.scores) if (!best.c.all.has(p)) suggestions.push({ circle: best.c.id, person: p, score: s, reason: 'community' });
        continue;
      }

      const id = uuidv7(now);
      const name: CircleName = interest
        ? { name: interest.name, description: interest.description, icon: null, namedBy: 'rule', basis: { kind: 'interest', ref: interest.signature } }
        : await nameFor(comm, `circle:${id}`, id);
      withBatch(
        db,
        { runId: run.ctx.runId(), kind: 'circle', title: `Created an auto circle (${comm.scores.size} people)`, actor: 'agent' },
        (t) => {
          t.insert('circles', {
            id,
            name: name.name,
            kind: 'auto',
            ...(interest ? { signature: interest.signature } : {}),
            description: name.description,
            color_hex: circleColor(id),
            icon: name.icon,
            locked: 0,
            status: 'active',
          });
          applyMembers(t, id, { adds: [...comm.scores].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([person, score]) => ({ person, score })), revives: [], scores: [], drops: [] }, stats);
        },
        { now },
      );
      stats.created++;
      claimName(id, name.name);
      upsertMeta(db, id, name, comm.core.length, det.modularity, now);
      nearFor(id, comm, null);
      await yieldToLoop();
    }

    // event-named circles the detection no longer finds: retire, unless the owner ever touched them
    for (const c of autos) {
      if (!eventNamed.has(c.id) || matched.has(c.id)) continue;
      tx(db, () => {
        const cur = db.prepare(`SELECT status, locked FROM circles WHERE id = ?`).get(c.id) as { status: string; locked: number } | undefined;
        if (cur?.status !== 'active' || cur.locked === 1 || userRenamed(db, c.id) || ownerTouched(db, c.id)) return;
        withBatch(
          db,
          { runId: run.ctx.runId(), kind: 'circle', title: 'Retired an auto circle that was named after an event', actor: 'agent' },
          (t) => {
            if (t.update('circles', { id: c.id }, { status: 'retracted' })) stats.retired++;
          },
          { now },
        );
      });
    }

    tx(db, () => {
      db.prepare('DELETE FROM circle_suggestions').run();
      const ins = db.prepare(
        `INSERT INTO circle_suggestions (circle_id, person_id, score, reason, computed_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (circle_id, person_id) DO UPDATE SET score = max(score, excluded.score)`,
      );
      for (const s of suggestions) stats.suggestions += ins.run(s.circle, s.person, Math.min(1, Math.max(0, s.score)), s.reason, now).changes;
    });
    run.finish('ok', { ...stats });
  } catch (e) {
    run.finish('error');
    throw e;
  }
  return { stats, complete: true, runId: run.runId };
}
