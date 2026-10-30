/**
 * Digest composition (07:30, and again at send time if the ranker's picks changed since, or an invite to a show
 * lost someone who joined it): template copy for every
 * item, then the LLM composer over the eligible ones (grounded items replace their template copy), then the
 * iMessage text and the push body. The composer never ranks and never sends.
 *
 * iMessage format: ONE TEXT FOR THE WHOLE BRIEF (owner, 2026-10-25: "always include everything you want me to see
 * each day in the text, not just the app"), written like a person would text (line breaks, no "·" separators):
 *
 *   🅨 Good morning! 3 things for today.     ← U+1F168 is the very first character of the text
 *
 *   1. Priya's birthday is today at 4pm      ← ordinal + headline (first name + last initial; "Sam Rivera" when
 *   Sam R., Priya S. and 3 others are going.  "Sam R." is also the owner or someone else in the brief)
 *   Sam R.: You talked 2 days ago. You said you'd send the trail map.   ← an event's people (template.ts)
 *
 *   2. Check in with Priya S.
 *   It's been 6 weeks. You usually talk about once a week.
 *   Maybe: “Hey! How's the new place?”      ← first opener draft (LLM copy only), to copy into a text yourself
 *
 *   3. Something personal                    ← sensitive items never show details outside the web
 *   The details are in the app.
 *
 *   Heads up: WhatsApp hasn't synced in 4 days. Open WhatsApp on your phone to wake it up.   ← ≤1 health line
 *
 *   That's it! Reply "done 2", "skip 2" or "snooze 2" anytime.
 *   yeackbot.com/today                       ← the only link, once
 * The text is checked with checkOutboundText; an item whose LLM copy fails falls back to its template copy, then
 * to a bare "open the app" line, so a bad fragment can never block the brief. "Last night: …" counts stay on the web.
 */
import type { DigestItem } from '@yb/shared';
import type { DB } from '../db/connection';
import { ownerNames } from '../identity/ownerNames';
import type { LlmUsage } from '../llm/types';
import type { Logger } from '../ops/logger';
import type { AgentServices } from '../services';
import { settingsSnapshot, type SettingsSnapshot } from '../settings/registry';
import { composeWithLlm, type LlmComposeResult } from './llmComposer';
import {
  DIGEST_ACTIONS,
  evidenceRefs,
  readDigestSelection,
  targetOf,
  toChip,
  type DigestSelection,
  type SelectDigestItems,
  type SelectedItem,
} from './selection';
import { failureLine, healthLine, lastNightCounts, lastNightLine, pipelineFailure, topHealthIssue } from './status';
import { itemDetails, SENSITIVE_BODY, SENSITIVE_LINE, templateCopy, type ItemCopy } from './template';
import { BOT_MARKER, briefNames, firstNameOnly, MAX_MAIN_LINE, MAX_SUB_LINE, nameList, plural, TODAY_LINK, truncate } from './text';
import { checkOutboundText } from './types';

const DAY = 86_400_000;

export interface ComposedItem extends SelectedItem {
  copy: 'llm' | 'template';
  headline: string;
  body: string | null;
  openers: string[];
  /** The numbered main line as it appears in the brief's text. */
  line: string;
  /** Lines under the body that aren't copy (an event's people: template.ts eventPeopleLines). */
  details: string[];
}

export interface TextPart {
  suggestionId: string;
  ordinal: number;
}

export interface ComposedDigest {
  localDate: string;
  digestId: string | null;
  items: ComposedItem[];
  /**
   * The iMessage texts in send order (each starts with U+1F168): the whole brief as one text (just the health text
   * on a day with no items). Briefs composed between 2026-10-17 and 2026-10-25 stored one text per item.
   */
  texts: string[];
  /** Per text (same order): the suggestion and ordinal it carries (a one-item brief), or null (the whole brief). */
  parts: (TextPart | null)[];
  /** The texts joined with blank lines (digests.imessage_text; display only). */
  text: string;
  pushBody: string;
  composer: 'llm' | 'template';
  lastNight: string | null;
  health: string | null;
  suggestionIds: string[];
  llm: Pick<LlmComposeResult, 'status' | 'reason' | 'sent' | 'rejected' | 'requestId'> & { costUsd: number | null; fallbackUsed: boolean } | null;
}

/** web_body JSON (digests.web_body): what Today / preview need to show the composed copy. */
export interface WebBody {
  v: 1;
  composer: 'llm' | 'template';
  suggestionIds: string[];
  pushBody: string;
  lastNight: string | null;
  health: string | null;
  /** The iMessage texts in send order (absent in compositions written before 2026-10-17: recomposed). */
  texts?: string[];
  /** Per text: the item it carries, or null (the whole brief). Sending freezes these once a text was attempted. */
  parts?: (TextPart | null)[];
  items: {
    suggestionId: string;
    ordinal: number;
    copy: 'llm' | 'template';
    headline: string;
    body: string | null;
    openers: string[];
    line: string;
    /** Lines under the body (absent in compositions written before 2026-10-25). */
    details?: string[];
    /** The people the copy names (absent in compositions written before it was recorded). */
    personIds?: string[];
  }[];
}

export interface ComposeOptions {
  localDate: string;
  now: number;
  /** Try the LLM composer (default true). Preview passes false: it never spends. */
  useLlm?: boolean;
  select?: SelectDigestItems;
  runId?: string | null;
  signal?: AbortSignal;
  log?: Logger;
  settings?: SettingsSnapshot;
}

// ---------------------------------------------------------------------------------------------- text

export function mainLine(ordinal: number, headline: string, sensitive: boolean): string {
  return truncate(`${ordinal}. ${sensitive ? SENSITIVE_LINE : headline}`, MAX_MAIN_LINE);
}

/** "Your brief is ready · 4 things" (first names only when names_in_notifications; never sensitive items). */
export function pushBodyFor(items: Pick<ComposedItem, 'people' | 'sensitive'>[], namesOn: boolean): string {
  const n = items.length;
  if (namesOn) {
    const names = [...new Set(items.filter((i) => !i.sensitive).flatMap((i) => (i.people[0] ? [firstNameOnly(i.people[0])] : [])).filter((x): x is string => !!x))];
    if (names.length) {
      const shown = names.slice(0, 2);
      const rest = n - shown.length;
      return truncate(`Your brief is ready · ${nameList(shown)}${rest > 0 ? ` +${rest}` : ''}`, 180);
    }
  }
  return `Your brief is ready · ${plural(n, 'thing')}`;
}

type ItemText = Pick<ComposedItem, 'line' | 'copy' | 'body' | 'openers' | 'sensitive'> & { details?: string[] };

export interface TextParts {
  items: (ItemText & Pick<ComposedItem, 'ordinal'>)[];
  health: string | null;
  commandsEnabled: boolean;
  /** settings digest.time ("08:00"): picks the greeting. */
  digestTime?: string;
}

/** "Good morning! 3 things for today." (time-of-day aware; "Just one thing today." for one). */
export function greeting(n: number, digestTime = '08:00'): string {
  const h = Number(digestTime.slice(0, 2));
  const hi = h < 12 ? 'Good morning!' : h < 17 ? 'Hi!' : 'Evening!';
  return `${hi} ${n === 1 ? 'Just one thing today.' : `${n} things for today.`}`;
}

/** The closing lines of the brief. */
export function closing(items: Pick<ComposedItem, 'ordinal'>[], commandsEnabled: boolean): string[] {
  if (!commandsEnabled) return [`That's it! It's all at ${TODAY_LINK}`];
  if (items.length === 1) return [`That's it! Reply "done", "skip" or "snooze" anytime.`, TODAY_LINK];
  const n = items[1]?.ordinal ?? 2;
  return [`That's it! Reply "done ${n}", "skip ${n}" or "snooze ${n}" anytime.`, TODAY_LINK];
}

/**
 * One item's lines (no marker, no greeting/closing, no blank line: blank lines separate the items): the numbered
 * headline, its context, its details, an opener draft.
 */
export function itemLines(i: ItemText): string[] {
  if (i.sensitive) return [i.line, SENSITIVE_BODY];
  const lines = [i.line];
  if (i.body) lines.push(truncate(i.body, MAX_SUB_LINE * 2));
  for (const d of i.details ?? []) lines.push(truncate(d, MAX_SUB_LINE * 2));
  const opener = i.copy === 'llm' ? i.openers[0] : undefined;
  if (opener) lines.push(`Maybe: “${truncate(opener.replace(/["“”]/g, ''), MAX_SUB_LINE)}”`);
  return lines;
}

/** The fallback for an item none of whose copy passes the outbound rules. */
const bareLines = (ordinal: number): string[] => [`${ordinal}. One for you in the app.`];

const asText = (lines: string[]): string => `${BOT_MARKER} ${lines.join('\n')}`;

/** Whether lines pass the outbound rules (no phone numbers, emails or non-yeackbot links) as the brief would send them. */
export const passesOutbound = (lines: string[]): boolean => checkOutboundText(asText(lines)).length === 0;

/** An item's lines as the brief shows them: its own when they pass the outbound rules, else the bare "in the app" line. */
export const safeItemLines = (i: ItemText & Pick<ComposedItem, 'ordinal'>): string[] => (passesOutbound(itemLines(i)) ? itemLines(i) : bareLines(i.ordinal));

/**
 * The brief as one text: the greeting, every item (a blank line between them), the health line, the closing. A day
 * with no items is just the health text, if any.
 */
export function digestTexts(p: TextParts, linesOf: (i: TextParts['items'][number], k: number) => string[] = (i) => itemLines(i)): string[] {
  if (!p.items.length) return p.health ? [asText([p.health])] : [];
  const blocks = p.items.flatMap((i, k) => ['', ...linesOf(i, k)]);
  return [asText([greeting(p.items.length, p.digestTime), ...blocks, ...(p.health ? ['', p.health] : []), '', ...closing(p.items, p.commandsEnabled)])];
}

/**
 * What each of digestTexts' texts carries: a one-item brief's text is that item's (an inline "done" acts on it);
 * otherwise the text is the whole brief (null).
 */
export function textParts(items: Pick<ComposedItem, 'suggestionId' | 'ordinal'>[], texts: string[]): (TextPart | null)[] {
  const only = items.length === 1 ? items[0]! : null;
  return texts.map(() => (only ? { suggestionId: only.suggestionId, ordinal: only.ordinal } : null));
}

/** The last resort: one text with the count and the link (always passes the outbound rules). */
export function minimalText(n: number): string {
  return `${BOT_MARKER} ${n === 1 ? 'One thing' : `${n} things`} for today. They're all at ${TODAY_LINK}`;
}

/** Preview of an empty day (nothing is sent). */
export function allClearText(): string {
  return `${BOT_MARKER} All clear! Nothing needs you today.`;
}

/** The stored display form of a brief (digests.imessage_text). */
export const joinTexts = (texts: string[]): string => texts.join('\n\n');

// ---------------------------------------------------------------------------------------------- compose

function statusLines(db: DB, now: number): { lastNight: string | null; health: string | null } {
  const failure = pipelineFailure(db, now);
  const health = failure ? failureLine(failure.stage) : healthLine(topHealthIssue(db, now));
  return { lastNight: lastNightLine(lastNightCounts(db, now - DAY, now)), health };
}

/** Composes from an already-read selection (no writes). */
export async function composeSelection(
  db: DB,
  services: Pick<AgentServices, 'llm' | 'egress'>,
  selection: DigestSelection,
  o: ComposeOptions,
): Promise<ComposedDigest> {
  const settings = o.settings ?? settingsSnapshot(db);
  const tz = settings.tz;
  const items = selection.items;
  // One set of names for the whole brief: a name that would read as the owner's, or as someone else's in the brief,
  // gets the full last name everywhere (template and LLM copy alike).
  const names = briefNames(items.flatMap((i) => i.people), ownerNames(db));
  const templates = new Map<string, ItemCopy>(items.map((i) => [i.suggestionId, templateCopy(i, { db, now: o.now, timeZone: tz, names })]));
  const details = new Map(items.map((i) => [i.suggestionId, i.sensitive ? [] : itemDetails(i, { db, now: o.now, timeZone: tz, names })]));
  let llm: LlmComposeResult | null = null;
  if (o.useLlm !== false && items.length) {
    llm = await composeWithLlm({
      db,
      llm: services.llm,
      egress: services.egress,
      localDate: o.localDate,
      now: o.now,
      timeZone: tz,
      settings,
      items,
      templates,
      names,
      runId: o.runId ?? selection.digest.run_id,
      signal: o.signal,
      log: o.log,
    });
  }
  const build = (i: SelectedItem, useLlmCopy: boolean): ComposedItem => {
    const llmCopy = useLlmCopy ? llm?.copies.get(i.suggestionId) : undefined;
    const c = llmCopy ?? templates.get(i.suggestionId)!;
    return {
      ...i,
      copy: llmCopy ? 'llm' : 'template',
      headline: c.headline,
      body: c.body,
      openers: c.openers,
      line: mainLine(i.ordinal, c.headline, i.sensitive),
      details: details.get(i.suggestionId) ?? [],
    };
  };
  const { lastNight, health } = statusLines(db, o.now);
  // Per item: LLM copy if its text passes the outbound rules, else template copy, else a bare "open the app" line;
  // a detail line that breaks a rule is dropped on its own (it never costs the item its copy).
  const ok = passesOutbound;
  const fit = (i: ComposedItem): ComposedItem => ({ ...i, details: i.details.filter((d) => ok([d])) });
  let rejected = 0;
  const composed = items.map((i) => {
    const withLlm = build(i, true);
    if (ok(itemLines({ ...withLlm, details: [] }))) return fit(withLlm);
    rejected++;
    return fit(build(i, false));
  });
  const input: TextParts = { items: composed, health, commandsEnabled: settings['commands.enabled'], digestTime: settings['digest.time'] };
  let texts = digestTexts(input, safeItemLines);
  let parts = textParts(composed, texts);
  if (texts.some((t) => checkOutboundText(t).length)) {
    texts = [minimalText(composed.length)];
    parts = [null];
  }
  if (rejected) o.log?.warn('digest.text_rejected', { counts: { items: rejected } });
  const usage: LlmUsage | null = llm?.usage ?? null;
  return {
    localDate: o.localDate,
    digestId: selection.digest.id,
    items: composed,
    texts,
    parts,
    text: joinTexts(texts),
    pushBody: pushBodyFor(composed, settings['push.names_in_notifications']),
    composer: composed.some((i) => i.copy === 'llm') ? 'llm' : 'template',
    lastNight,
    health,
    suggestionIds: items.map((i) => i.suggestionId),
    llm: llm
      ? { status: llm.status, reason: llm.reason, sent: llm.sent, rejected: llm.rejected, requestId: llm.requestId, costUsd: usage?.costUsd ?? null, fallbackUsed: usage?.fallbackUsed ?? false }
      : null,
  };
}

export function webBodyOf(c: ComposedDigest): WebBody {
  return {
    v: 1,
    composer: c.composer,
    suggestionIds: c.suggestionIds,
    pushBody: c.pushBody,
    lastNight: c.lastNight,
    health: c.health,
    texts: c.texts,
    parts: c.parts,
    items: c.items.map((i) => ({
      suggestionId: i.suggestionId,
      ordinal: i.ordinal,
      copy: i.copy,
      headline: i.headline,
      body: i.body,
      openers: i.openers,
      line: i.line,
      details: i.details,
      personIds: i.people.map((p) => p.id),
    })),
  };
}

export function parseWebBody(raw: string | null): WebBody | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as WebBody;
    return v && v.v === 1 && Array.isArray(v.items) && Array.isArray(v.suggestionIds) ? v : null;
  } catch {
    return null;
  }
}

/**
 * An "Invite to a show" item whose stored copy names someone it no longer shows (they joined the show since it was
 * composed): that copy would tell the owner to invite someone already going.
 */
function peopleChanged(i: SelectedItem, b: WebBody['items'][number] | undefined): boolean {
  if (i.kind !== 'event_invite' || !b?.personIds) return false;
  const shown = i.people.map((p) => p.id);
  return b.personIds.length !== shown.length || b.personIds.some((id, k) => id !== shown[k]);
}

/** Whether the stored composition still matches the ranker's current picks (and the people each invite shows). */
export function compositionCurrent(selection: DigestSelection): boolean {
  const d = selection.digest;
  if (!d.composed_at || !d.imessage_text) return false;
  const body = parseWebBody(d.web_body);
  // One text per suggestion (composed before 2026-10-25) is recomposed into one text while nothing has gone out.
  if (!body?.texts?.length || body.texts.length > 1) return false;
  const now = selection.items.map((i) => i.suggestionId);
  if (body.suggestionIds.length !== now.length || body.suggestionIds.some((id, k) => id !== now[k])) return false;
  const byId = new Map(body.items.map((i) => [i.suggestionId, i]));
  return !selection.items.some((i) => peopleChanged(i, byId.get(i.suggestionId)));
}

/**
 * Whether any of the brief's texts was handed to the sender. From then on its texts and their per-position
 * client_refs are frozen: nothing recomposes it (a text may have reached the owner before the collector answered).
 */
export const partsAttempted = (db: DB, digestId: string): boolean =>
  db.prepare(`SELECT 1 FROM outbound_messages WHERE digest_id = ? AND purpose = 'digest' LIMIT 1`).get(digestId) !== undefined;

/** Writes the composition onto the digest row (never once a text went out) and the copy onto its suggestions. */
export function persistComposition(db: DB, c: ComposedDigest, now: number): boolean {
  if (!c.digestId) return false;
  return db.transaction(() => {
    const res = db
      .prepare(
        `UPDATE digests SET imessage_text = ?, web_body = ?, composed_at = ?, composer = ?, llm_usage = ?,
           status = CASE status WHEN 'composing' THEN 'ready' ELSE status END
         WHERE id = ? AND status IN ('composing','ready') AND sent_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM outbound_messages om WHERE om.digest_id = digests.id AND om.purpose = 'digest')`,
      )
      .run(c.text, JSON.stringify(webBodyOf(c)), now, c.composer, c.llm ? JSON.stringify(c.llm) : null, c.digestId);
    if (!res.changes) return false;
    const upd = db.prepare('UPDATE suggestions SET title = ?, body = ?, openers = ?, updated_at = ? WHERE id = ?');
    for (const i of c.items) upd.run(i.headline, i.body, JSON.stringify(i.openers), now, i.suggestionId);
    return true;
  })();
}

/**
 * Composes and stores the day's digest. Null when the ranker wrote no digest row for that date (nothing to compose
 * yet). An already-sent digest is returned as stored, never recomposed.
 */
export async function composeDigest(db: DB, services: Pick<AgentServices, 'llm' | 'egress'>, o: ComposeOptions): Promise<ComposedDigest | null> {
  const selection = (o.select ?? readDigestSelection)(db, { localDate: o.localDate, now: o.now });
  if (!selection) return null;
  if (selection.digest.sent_at || !['composing', 'ready'].includes(selection.digest.status) || partsAttempted(db, selection.digest.id)) {
    return storedComposition(selection);
  }
  const composed = await composeSelection(db, services, selection, o);
  persistComposition(db, composed, o.now);
  return composed;
}

/**
 * The stored composition of a digest (stored copy over the current selection), or a fresh template one. An invite
 * naming someone who has joined the show since gets template copy for the people it shows now (selection.ts
 * currentCopy); the texts stay as stored (as they went out).
 */
export function storedComposition(selection: DigestSelection): ComposedDigest | null {
  const d = selection.digest;
  const body = parseWebBody(d.web_body);
  if (!body || !d.imessage_text) return null;
  const byId = new Map(body.items.map((i) => [i.suggestionId, i]));
  const items: ComposedItem[] = selection.items.flatMap((i) => {
    const b = byId.get(i.suggestionId);
    if (!b) return [];
    const fresh = peopleChanged(i, b) ? i.currentCopy : undefined;
    const c = fresh ? { ...fresh, copy: 'template' as const, line: mainLine(i.ordinal, fresh.headline, i.sensitive) } : b;
    return [{ ...i, copy: c.copy, headline: c.headline, body: c.body, openers: c.openers, line: c.line, details: b.details ?? [] }];
  });
  let llm: ComposedDigest['llm'] = null;
  try {
    llm = d.llm_usage ? (JSON.parse(d.llm_usage) as ComposedDigest['llm']) : null;
  } catch {
    llm = null;
  }
  return {
    localDate: d.local_date,
    digestId: d.id,
    items,
    texts: body.texts?.length ? body.texts : [d.imessage_text],
    parts: body.texts?.length && body.parts?.length === body.texts.length ? body.parts : (body.texts ?? [d.imessage_text]).map(() => null),
    text: d.imessage_text,
    pushBody: body.pushBody,
    composer: body.composer,
    lastNight: body.lastNight,
    health: body.health,
    suggestionIds: body.suggestionIds,
    llm,
  };
}

// ---------------------------------------------------------------------------------------------- DTO

/** Composed items as the web's digest cards (people as chips, live suggestion status). */
export function toDigestItems(db: DB, items: ComposedItem[]): DigestItem[] {
  return items.map((i) => ({
    suggestionId: i.suggestionId,
    ordinal: i.ordinal,
    kind: i.kind,
    isWildcard: i.isWildcard,
    wildcardGenerator: i.wildcardGenerator,
    people: i.people.map(toChip),
    headline: i.headline,
    body: i.body,
    openers: i.openers,
    sensitive: i.sensitive,
    status: i.status,
    snoozedUntil: i.snoozedUntil,
    deliveredAt: i.deliveredAt,
    expiresAt: i.expiresAt,
    timeCritical: i.timeCritical,
    copy: i.copy,
    target: targetOf(i),
    evidence: i.sensitive ? [] : evidenceRefs(db, i.evidenceIds, i.people[0]?.id ?? null),
    actions: DIGEST_ACTIONS,
  }));
}
