/**
 * Core-phase plan: a pure mapping from the legacy store to target rows (architecture.md §5 "Mapping", with the
 * PLAN.md/critic fixes). Nothing here touches the target database; core.ts applies the plan idempotently.
 *
 * Decisions encoded here:
 *  - Merged-away contacts become pointer merges. The legacy store may have lost ZMERGEDINTOCONTACT (the real one
 *    has it NULL on every merged-away row), so a missing pointer is recovered from the arrays the old merge
 *    unioned onto the survivor: a unique live owner of the same E.164/email with a compatible name, else a unique
 *    live contact with the exact same name (audited as "name-only"). Anything else stays active + hidden, flagged.
 *  - Shared-identity guard: a phone/email claimed by two live contacts merges them only when every pair of names
 *    is compatible; otherwise the identity is marked shared=1 (never a merge key) and nobody merges.
 *  - No name locks: PLAN.md says locks come only from user edits made in yeackbot, so Address Book names keep
 *    flowing into imported people.
 */
import {
  firstNameScore,
  lastNameScore,
  nameKey,
  normalizeEmail,
  normalizePhone,
  normalizeNamePart,
  RAW_PHONE_PREFIX,
} from '@yb/shared';
import type { Row } from '../journal/batch';
import { cityFromAddress, instagramUsername, legacyBirthday, linkedinUrl, normText, xUsername } from './convert';
import type { LegacyContact, LegacyStore, SourceCounts } from './legacyStore';

export type MergeBasis = 'pointer' | 'key_name' | 'name_only';

export interface PlannedMerge {
  mergedPk: number;
  mergedId: string;
  /** resolved root of the chain (a live contact, or an orphan that stays active) */
  targetPk: number;
  targetId: string;
  basis: MergeBasis;
  depth: number;
}

export type IdentityKind = 'phone' | 'email' | 'instagram_username' | 'x_username' | 'linkedin_url' | 'addressbook_id';

export interface PlannedIdentity {
  kind: IdentityKind;
  key: string;
  raw: string;
  personId: string;
  ownerPk: number;
  confidence: number;
  shared: boolean;
  createdAt: number;
}

export interface IdentityConflict {
  kind: IdentityKind;
  personIds: string[];
  resolution: 'merged' | 'shared';
}

export interface PlannedFact {
  personId: string;
  type: 'address' | 'home_location' | 'interest' | 'location_current';
  value: string;
  valueNorm: string;
  confidence: number;
  status: 'confirmed' | 'tentative';
}

export interface CorePlan {
  source: SourceCounts;
  people: Row[];
  merges: PlannedMerge[];
  /** live contacts (person ids) to auto-merge because they share a phone/email and their names are compatible */
  autoMergeGroups: string[][];
  identities: PlannedIdentity[];
  tags: Row[];
  /** legacy tag id → id actually used (same-name tags collapse onto the first) */
  tagIdMap: Map<string, string>;
  personTags: { personId: string; tagId: string }[];
  circles: Row[];
  circleMembers: { circleId: string; personId: string }[];
  locations: Row[];
  personLocations: { personId: string; locationId: string }[];
  facts: PlannedFact[];
  notes: Row[];
  events: Row[];
  attendees: { eventId: string; personId: string; status: 'attended' | 'going' }[];
  commitments: Row[];
  edgeLabels: { aId: string; bId: string; label: string; directed: boolean; confidence: number }[];
  feedback: Row[];
  diag: PlanDiagnostics;
}

export interface PlanDiagnostics {
  orphanMergedIds: string[];
  danglingPointerIds: string[];
  ambiguousMergeIds: string[];
  nameOnlyMergedIds: string[];
  cycles: string[][];
  maxChainDepth: number;
  mergesByBasis: Record<MergeBasis, number>;
  duplicateUuids: string[];
  phonesE164: number;
  /** person ids with at least one phone that is not a valid number (stored as raw:<digits>, confidence 0.5) */
  unparseablePhonePersonIds: string[];
  phonesRaw: number;
  phonesEmpty: number;
  emailsInvalid: number;
  socialInvalid: number;
  mergedAwayKeysAlreadyOwned: number;
  identityConflicts: IdentityConflict[];
  birthdays: number;
  birthdaysNoYear: number;
  birthdaysInvalid: number;
  tagNameCollisions: number;
  links: Record<'tags' | 'groups' | 'locations' | 'activities', { total: number; orphan: number; dupes: number }>;
  notesWithoutContact: number;
  remindersWithoutContact: number;
  edgesSkipped: number;
  dismissedWithoutContact: number;
}

export interface PlanOptions {
  runId: string;
  now: number;
  /** Time zone birthdays were entered in (default: this Mac's). */
  timeZone?: string;
}

type NameLike = Pick<LegacyContact, 'firstName' | 'lastName'>;

/** Shared-identity guard's notion of "could be the same person": first names score > 0 and no last-name conflict. */
export function namesCompatible(a: NameLike, b: NameLike): boolean {
  const unnamed = (c: NameLike) => !normalizeNamePart(c.firstName) && !normalizeNamePart(c.lastName);
  if (unnamed(a) && unnamed(b)) return true;
  return firstNameScore(a.firstName ?? '', b.firstName ?? '') > 0 && lastNameScore(a.lastName, b.lastName) > 0;
}

export function displayName(c: NameLike): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || '(unnamed)';
}

interface Claim {
  kind: IdentityKind;
  key: string;
  raw: string;
  confidence: number;
  /** deterministic merge keys (architecture §5: E.164 phone, email) */
  mergeKey: boolean;
}

function claimsOf(c: LegacyContact, diag: PlanDiagnostics): Claim[] {
  const out: Claim[] = [];
  let rawPhone = false;
  for (const p of c.phones) {
    const k = normalizePhone(p);
    if (!k) {
      diag.phonesEmpty++;
      continue;
    }
    if (k.kind === 'e164') {
      diag.phonesE164++;
      out.push({ kind: 'phone', key: k.key, raw: p, confidence: 1, mergeKey: true });
    } else {
      diag.phonesRaw++;
      rawPhone = true;
      const key = k.kind === 'raw' ? k.key : `${RAW_PHONE_PREFIX}${k.key}`;
      out.push({ kind: 'phone', key, raw: p, confidence: 0.5, mergeKey: false });
    }
  }
  if (rawPhone) diag.unparseablePhonePersonIds.push(c.uuid);
  for (const e of c.emails) {
    const key = normalizeEmail(e);
    if (key) out.push({ kind: 'email', key, raw: e, confidence: 1, mergeKey: true });
    else diag.emailsInvalid++;
  }
  const social: [IdentityKind, string | null, string | null][] = [
    ['instagram_username', c.instagramHandle, instagramUsername(c.instagramHandle)],
    ['x_username', c.twitterHandle, xUsername(c.twitterHandle)],
    ['linkedin_url', c.linkedInURL, linkedinUrl(c.linkedInURL)],
    ['addressbook_id', c.cnContactIdentifier, c.cnContactIdentifier],
  ];
  for (const [kind, raw, key] of social) {
    if (!raw) continue;
    if (key) out.push({ kind, key, raw, confidence: 1, mergeKey: false });
    else diag.socialInvalid++;
  }
  const seen = new Set<string>();
  return out.filter((cl) => {
    const k = `${cl.kind}\u0000${cl.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const sortedPair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export function buildPlan(store: LegacyStore, opts: PlanOptions): CorePlan {
  const source = store.counts();
  const diag: PlanDiagnostics = {
    orphanMergedIds: [],
    danglingPointerIds: [],
    ambiguousMergeIds: [],
    nameOnlyMergedIds: [],
    cycles: [],
    maxChainDepth: 0,
    mergesByBasis: { pointer: 0, key_name: 0, name_only: 0 },
    duplicateUuids: [],
    phonesE164: 0,
    unparseablePhonePersonIds: [],
    phonesRaw: 0,
    phonesEmpty: 0,
    emailsInvalid: 0,
    socialInvalid: 0,
    mergedAwayKeysAlreadyOwned: 0,
    identityConflicts: [],
    birthdays: 0,
    birthdaysNoYear: 0,
    birthdaysInvalid: 0,
    tagNameCollisions: 0,
    links: {
      tags: { total: 0, orphan: 0, dupes: 0 },
      groups: { total: 0, orphan: 0, dupes: 0 },
      locations: { total: 0, orphan: 0, dupes: 0 },
      activities: { total: 0, orphan: 0, dupes: 0 },
    },
    notesWithoutContact: 0,
    remindersWithoutContact: 0,
    edgesSkipped: 0,
    dismissedWithoutContact: 0,
  };

  const contacts = store.contacts();
  const byPk = new Map(contacts.map((c) => [c.pk, c]));
  const seenUuid = new Set<string>();
  for (const c of contacts) {
    if (c.uuid && seenUuid.has(c.uuid)) diag.duplicateUuids.push(c.uuid);
    seenUuid.add(c.uuid);
  }
  const live = contacts.filter((c) => !c.isMergedAway);
  const claims = new Map(contacts.map((c) => [c.pk, claimsOf(c, diag)]));

  // ---- merge targets ---------------------------------------------------------------------------------------
  const liveByKey = new Map<string, number[]>();
  for (const c of live) {
    for (const cl of claims.get(c.pk)!) {
      if (!cl.mergeKey) continue;
      const k = `${cl.kind}\u0000${cl.key}`;
      liveByKey.set(k, [...(liveByKey.get(k) ?? []), c.pk]);
    }
  }
  const liveByName = new Map<string, number[]>();
  for (const c of live) {
    const k = nameKey(c.firstName, c.lastName);
    if (k) liveByName.set(k, [...(liveByName.get(k) ?? []), c.pk]);
  }

  const direct = new Map<number, { targetPk: number; basis: MergeBasis }>();
  for (const c of contacts) {
    if (!c.isMergedAway) continue;
    if (c.mergedIntoPk !== null) {
      if (byPk.has(c.mergedIntoPk) && c.mergedIntoPk !== c.pk) {
        direct.set(c.pk, { targetPk: c.mergedIntoPk, basis: 'pointer' });
        continue;
      }
      diag.danglingPointerIds.push(c.uuid);
    }
    const keyHits = new Set<number>();
    for (const cl of claims.get(c.pk)!) {
      if (cl.mergeKey) for (const pk of liveByKey.get(`${cl.kind}\u0000${cl.key}`) ?? []) keyHits.add(pk);
    }
    if (keyHits.size) {
      const compatible = [...keyHits].filter((pk) => namesCompatible(c, byPk.get(pk)!));
      if (compatible.length === 1) direct.set(c.pk, { targetPk: compatible[0]!, basis: 'key_name' });
      else if (compatible.length > 1) diag.ambiguousMergeIds.push(c.uuid);
      continue;
    }
    const k = nameKey(c.firstName, c.lastName);
    const nameHits = k ? (liveByName.get(k) ?? []) : [];
    const target = nameHits.length === 1 ? byPk.get(nameHits[0]!)! : null;
    // Two different Address Book cards are never joined on a name alone (guard G4).
    if (target && !(c.cnContactIdentifier && target.cnContactIdentifier && c.cnContactIdentifier !== target.cnContactIdentifier)) {
      direct.set(c.pk, { targetPk: target.pk, basis: 'name_only' });
    } else if (nameHits.length > 1) {
      diag.ambiguousMergeIds.push(c.uuid);
    }
  }

  // Resolve chains to their root; a cycle is reported (the run then refuses to apply).
  const root = new Map<number, { pk: number; depth: number }>();
  const inCycle = new Set<number>();
  for (const c of contacts) {
    if (!direct.has(c.pk) || root.has(c.pk)) continue;
    const path: number[] = [];
    const onPath = new Set<number>();
    let cur = c.pk;
    while (direct.has(cur) && !onPath.has(cur) && !root.has(cur)) {
      path.push(cur);
      onPath.add(cur);
      cur = direct.get(cur)!.targetPk;
    }
    if (onPath.has(cur)) {
      const cycle = path.slice(path.indexOf(cur));
      cycle.forEach((pk) => inCycle.add(pk));
      diag.cycles.push(cycle.map((pk) => byPk.get(pk)!.uuid));
      continue;
    }
    const known = root.get(cur);
    const end = known ? known.pk : cur;
    const base = known ? known.depth : 0;
    path.forEach((pk, i) => root.set(pk, { pk: end, depth: base + path.length - i }));
  }
  const merges: PlannedMerge[] = [];
  const orphan = new Set<number>();
  for (const c of contacts) {
    if (!c.isMergedAway) continue;
    const r = root.get(c.pk);
    if (!r || inCycle.has(c.pk)) {
      orphan.add(c.pk);
      if (!inCycle.has(c.pk)) diag.orphanMergedIds.push(c.uuid);
      continue;
    }
    const basis = direct.get(c.pk)!.basis;
    diag.mergesByBasis[basis]++;
    diag.maxChainDepth = Math.max(diag.maxChainDepth, r.depth);
    if (basis === 'name_only') diag.nameOnlyMergedIds.push(c.uuid);
    merges.push({ mergedPk: c.pk, mergedId: c.uuid, targetPk: r.pk, targetId: byPk.get(r.pk)!.uuid, basis, depth: r.depth });
  }
  const canonPk = (pk: number) => root.get(pk)?.pk ?? pk;
  const idOf = (pk: number) => byPk.get(pk)!.uuid;

  // ---- people ----------------------------------------------------------------------------------------------
  const people: Row[] = contacts.map((c) => {
    const b = c.birthday === null ? null : legacyBirthday(c.birthday, opts.timeZone);
    if (c.birthday !== null) {
      diag.birthdays++;
      if (!b) diag.birthdaysInvalid++;
      else if (b.noYear) diag.birthdaysNoYear++;
    }
    const createdAt = c.createdAt ?? opts.now;
    return {
      id: c.uuid,
      display_name: displayName(c),
      first_name: c.firstName,
      last_name: c.lastName,
      company: c.company,
      job_title: c.jobTitle,
      birthday: b?.value ?? null,
      family_details: c.familyDetails,
      custom: c.custom ? JSON.stringify(c.custom) : null,
      kind: 'person',
      status: 'active',
      is_hidden: c.isHidden || orphan.has(c.pk) ? 1 : 0,
      is_priority: c.isPriority ? 1 : 0,
      locked_fields: '[]',
      origin: 'legacy',
      legacy_pk: c.pk,
      created_by_run: opts.runId,
      created_at: createdAt,
      updated_at: c.updatedAt ?? createdAt,
    };
  });

  // ---- identities: live first (shared guard, auto-merge groups), then merged-away where the key is unused ----
  const liveOwners = new Map<string, { claim: Claim; pks: number[] }>();
  for (const c of live) {
    for (const cl of claims.get(c.pk)!) {
      const k = `${cl.kind}\u0000${cl.key}`;
      const entry = liveOwners.get(k) ?? { claim: cl, pks: [] };
      entry.pks.push(c.pk);
      liveOwners.set(k, entry);
    }
  }
  // Union-find over live contacts; a union happens only if every cross pair of names is compatible.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const members = (r: number) => live.filter((c) => find(c.pk) === r);
  const identities: PlannedIdentity[] = [];
  const assigned = new Set<string>();
  const keys = [...liveOwners.keys()].sort();
  for (const k of keys) {
    const { claim, pks } = liveOwners.get(k)!;
    const owner = byPk.get(pks[0]!)!;
    let shared = false;
    if (pks.length > 1) {
      const groups = [...new Set(pks.map(find))];
      const all = groups.flatMap(members);
      const compatible = claim.mergeKey && all.every((a, i) => all.slice(i + 1).every((b) => namesCompatible(a, b)));
      if (compatible) {
        for (const g of groups.slice(1)) parent.set(g, groups[0]!);
        if (!parent.has(groups[0]!)) parent.set(groups[0]!, groups[0]!);
      } else {
        shared = true;
      }
      diag.identityConflicts.push({ kind: claim.kind, personIds: pks.map(idOf), resolution: compatible ? 'merged' : 'shared' });
    }
    assigned.add(k);
    identities.push({
      kind: claim.kind,
      key: claim.key,
      raw: claim.raw,
      personId: owner.uuid,
      ownerPk: owner.pk,
      confidence: claim.confidence,
      shared,
      createdAt: owner.createdAt ?? opts.now,
    });
  }
  for (const c of contacts) {
    if (!c.isMergedAway) continue;
    for (const cl of claims.get(c.pk)!) {
      const k = `${cl.kind}\u0000${cl.key}`;
      if (assigned.has(k)) {
        diag.mergedAwayKeysAlreadyOwned++;
        continue;
      }
      assigned.add(k);
      identities.push({
        kind: cl.kind,
        key: cl.key,
        raw: cl.raw,
        personId: c.uuid,
        ownerPk: c.pk,
        confidence: cl.confidence,
        shared: false,
        createdAt: c.createdAt ?? opts.now,
      });
    }
  }
  const groupMap = new Map<number, string[]>();
  for (const c of live) {
    if (!parent.has(c.pk)) continue;
    const r = find(c.pk);
    groupMap.set(r, [...(groupMap.get(r) ?? []), c.uuid]);
  }
  const autoMergeGroups = [...groupMap.values()].filter((g) => g.length > 1);

  // ---- collections and memberships (re-pointed to the canonical survivor, de-duplicated) -------------------
  const tagsSrc = store.tags();
  const tags: Row[] = [];
  const tagIdMap = new Map<string, string>();
  const tagByName = new Map<string, string>();
  for (const t of tagsSrc) {
    const k = t.name.toLowerCase();
    const existing = tagByName.get(k);
    if (existing) {
      tagIdMap.set(t.uuid, existing);
      diag.tagNameCollisions++;
      continue;
    }
    tagByName.set(k, t.uuid);
    tagIdMap.set(t.uuid, t.uuid);
    tags.push({ id: t.uuid, name: t.name, color_hex: t.colorHex, status: 'active', legacy_pk: t.pk, created_at: opts.now, updated_at: opts.now });
  }
  const tagPkToId = new Map(tagsSrc.map((t) => [t.pk, tagIdMap.get(t.uuid)!]));

  /** Contact↔entity links → (canonical person, target) pairs; unknown ends are orphans, repeats are dupes. */
  const memberships = <T>(
    entity: string,
    stat: { total: number; orphan: number; dupes: number },
    targetOf: (pk: number) => string | undefined,
    make: (personId: string, targetId: string) => T,
  ): T[] => {
    const out: T[] = [];
    const seen = new Set<string>();
    for (const [contactPk, otherPk] of store.links('Contact', entity).rows) {
      stat.total++;
      const targetId = targetOf(otherPk);
      if (!byPk.has(contactPk) || !targetId || inCycle.has(contactPk)) {
        stat.orphan++;
        continue;
      }
      const personId = idOf(canonPk(contactPk));
      const k = `${personId}\u0000${targetId}`;
      if (seen.has(k)) {
        stat.dupes++;
        continue;
      }
      seen.add(k);
      out.push(make(personId, targetId));
    }
    return out;
  };

  const personTags = memberships('Tag', diag.links.tags, (pk) => tagPkToId.get(pk), (personId, tagId) => ({ personId, tagId }));

  const groupsSrc = store.groups();
  const circles: Row[] = groupsSrc.map((g) => ({
    id: g.uuid,
    name: g.name,
    kind: 'user',
    color_hex: g.colorHex,
    icon: g.icon,
    locked: 1,
    status: 'active',
    legacy_pk: g.pk,
    created_at: opts.now,
    updated_at: opts.now,
  }));
  const groupPkToId = new Map(groupsSrc.map((g) => [g.pk, g.uuid]));
  const circleMembers = memberships('Group', diag.links.groups, (pk) => groupPkToId.get(pk), (personId, circleId) => ({
    circleId,
    personId,
  }));

  const locationsSrc = store.locations();
  const locations: Row[] = locationsSrc.map((l) => ({
    id: l.uuid,
    name: l.name,
    color_hex: l.colorHex,
    icon: l.icon,
    status: 'active',
    legacy_pk: l.pk,
    created_at: opts.now,
    updated_at: opts.now,
  }));
  const locationPkToId = new Map(locationsSrc.map((l) => [l.pk, l.uuid]));
  const locationName = new Map(locationsSrc.map((l) => [l.uuid, l.name]));
  const personLocations = memberships('Location', diag.links.locations, (pk) => locationPkToId.get(pk), (personId, locationId) => ({
    personId,
    locationId,
  }));

  // ---- facts: addresses (+ home_location), interests, legacy locations as location_current ----------------
  const facts: PlannedFact[] = [];
  const factSeen = new Set<string>();
  const addFact = (owner: LegacyContact, f: Omit<PlannedFact, 'personId' | 'valueNorm'>) => {
    const valueNorm = normText(f.value);
    if (!valueNorm) return;
    const k = `${canonPk(owner.pk)}\u0000${f.type}\u0000${valueNorm}`;
    if (factSeen.has(k)) return;
    factSeen.add(k);
    facts.push({ ...f, personId: owner.uuid, valueNorm });
  };
  // live contacts first: merged-away arrays were already unioned onto the survivor by the old merge
  for (const c of [...live, ...contacts.filter((x) => x.isMergedAway)]) {
    if (inCycle.has(c.pk)) continue;
    for (const a of c.addresses) {
      addFact(c, { type: 'address', value: a, confidence: 1, status: 'confirmed' });
      const city = cityFromAddress(a);
      if (city) addFact(c, { type: 'home_location', value: city, confidence: 0.9, status: 'tentative' });
    }
    for (const i of c.interests) addFact(c, { type: 'interest', value: i, confidence: 1, status: 'confirmed' });
  }
  const byUuid = new Map(contacts.map((c) => [c.uuid, c]));
  for (const pl of personLocations) {
    addFact(byUuid.get(pl.personId)!, { type: 'location_current', value: locationName.get(pl.locationId)!, confidence: 0.9, status: 'tentative' });
  }

  // ---- notes, activities, reminders, relationships, notifications -----------------------------------------
  const knownContact = (pk: number | null) => (pk !== null && byPk.has(pk) && !inCycle.has(pk) ? byPk.get(pk)! : null);
  const notes: Row[] = store.notes().map((n) => {
    const c = knownContact(n.contactPk);
    if (!c) diag.notesWithoutContact++;
    const createdAt = n.createdAt ?? opts.now;
    return {
      id: n.uuid,
      person_id: c?.uuid ?? null,
      content: n.content,
      category: n.category,
      origin: 'legacy',
      status: 'active',
      created_at: createdAt,
      updated_at: n.updatedAt ?? createdAt,
    };
  });

  const activities = store.activities();
  const groupLinks = store.links('Activity', 'Group').rows;
  const events: Row[] = activities.map((a) => ({
    id: a.uuid,
    source: 'legacy_activity',
    source_event_id: a.uuid,
    kind: 'social',
    title: a.name,
    description: a.description,
    starts_at: a.date,
    ends_at: a.endDate,
    color_hex: a.colorHex,
    icon: a.icon,
    raw: JSON.stringify({
      legacy_pk: a.pk,
      google_event_id: a.googleEventId,
      circle_ids: groupLinks.filter(([ap]) => ap === a.pk).map(([, gp]) => groupPkToId.get(gp)).filter(Boolean),
      migration_run: opts.runId,
    }),
    created_at: a.createdAt ?? opts.now,
    updated_at: opts.now,
  }));
  const activityById = new Map(activities.map((a) => [a.pk, a]));
  const attendees = memberships('Activity', diag.links.activities, (pk) => activityById.get(pk)?.uuid, (personId, eventId) => {
    const at = activities.find((a) => a.uuid === eventId)?.date ?? null;
    return { eventId, personId, status: at !== null && at > opts.now ? ('going' as const) : ('attended' as const) };
  });

  const commitments: Row[] = [];
  for (const r of store.reminders()) {
    const c = knownContact(r.contactPk);
    if (!c) {
      diag.remindersWithoutContact++;
      continue;
    }
    commitments.push({
      id: r.uuid,
      person_id: c.uuid,
      owner: 'me',
      kind: 'other',
      what: r.title,
      due_at: r.dueDate,
      due_precision: r.dueDate === null ? 'none' : 'date',
      confidence: 1,
      status: r.isCompleted ? 'done' : 'open',
      closed_at: r.isCompleted ? opts.now : null,
      closed_reason: r.isCompleted ? 'completed in legacy app' : null,
      created_at: r.createdAt ?? opts.now,
      updated_at: opts.now,
    });
  }

  const edgeLabels: CorePlan['edgeLabels'] = [];
  const edgeSeen = new Set<string>();
  const addEdge = (fromPk: number | null, toPk: number | null, label: string, directed: boolean, confidence: number) => {
    const a = knownContact(fromPk);
    const b = knownContact(toPk);
    if (!a || !b) {
      diag.edgesSkipped++;
      return;
    }
    const x = idOf(canonPk(a.pk));
    const y = idOf(canonPk(b.pk));
    if (x === y) {
      diag.edgesSkipped++;
      return;
    }
    const [aId, bId] = directed ? [x, y] : sortedPair(x, y);
    const k = `${aId}\u0000${bId}\u0000${label}`;
    if (edgeSeen.has(k)) return;
    edgeSeen.add(k);
    edgeLabels.push({ aId, bId, label, directed, confidence });
  };
  for (const c of contacts) if (c.metViaPk !== null) addEdge(c.pk, c.metViaPk, 'met_via', true, 1);
  for (const r of store.relationships()) {
    const label = (r.label ?? 'related').toLowerCase().replace(/\s+/g, '_').slice(0, 40) || 'related';
    const conf = r.strength !== null && r.strength >= 0 && r.strength <= 1 ? r.strength : 1;
    addEdge(r.fromPk, r.toPk, label, false, conf);
  }

  const feedback: Row[] = [];
  for (const n of store.notifications()) {
    if (!n.isDismissed) continue;
    const c = n.contactUuid ? byUuid.get(n.contactUuid) : undefined;
    if (!c || inCycle.has(c.pk)) {
      diag.dismissedWithoutContact++;
      continue;
    }
    const at = n.updatedAt ?? n.createdAt ?? opts.now;
    feedback.push({
      id: n.uuid,
      subject_type: 'person',
      subject_id: idOf(canonPk(c.pk)),
      action: 'dismiss',
      payload: JSON.stringify({ kind: n.kind === 'fadingRelationship' ? 'fading' : n.kind, cooldown_until: at + 30 * 86_400_000, legacy: true }),
      channel: 'system',
      created_at: at,
    });
  }

  return {
    source,
    people,
    merges,
    autoMergeGroups,
    identities,
    tags,
    tagIdMap,
    personTags,
    circles,
    circleMembers,
    locations,
    personLocations,
    facts,
    notes,
    events,
    attendees,
    commitments,
    edgeLabels,
    feedback,
    diag,
  };
}
