/**
 * Digest composition (07:30, and again at send time if the ranker's picks changed since): template copy for every
 * item, then the LLM composer over the eligible ones (grounded items replace their template copy), then the
 * iMessage text and the push body. The composer never ranks and never sends.
 *
 * iMessage format (delivery §3):
 *   🅨 Wed Oct 14 · 4 for today            ← U+1F168 is the very first character
 *
 *   1 Sam R. · quiet 41d (usually ~9d)      ← numbered, first name + last initial, ≤70 chars
 *     ↳ "Hey Sam, how's the new place?"     ← first opener draft (LLM copy only), to copy into a text yourself
 *   2 Something personal — open the app     ← sensitive items never show details outside the web
 *
 *   Last night: 2 merges · 4 links · 11 facts
 *   ⚠ WhatsApp quiet 4d · open WhatsApp on your phone      ← at most one health line
 *   yeackbot.com/today                      ← the only link
 *   reply done 1 · snooze 1 2w · skip 1 · ? ask
 * The finished text is checked with checkOutboundText; a failure falls back to template copy, then to a minimal
 * header + link text, so a bad fragment can never block the brief.
 */
import type { DigestItem } from '@yb/shared';
import type { DB } from '../db/connection';
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
import { healthLine, lastNightCounts, lastNightLine, pipelineFailure, topHealthIssue } from './status';
import { SENSITIVE_LINE, templateCopy, type ItemCopy } from './template';
import { BOT_MARKER, firstNameOnly, headerDate, MAX_MAIN_LINE, MAX_SUB_LINE, nameList, plural, TODAY_LINK, truncate } from './text';
import { checkOutboundText } from './types';

const DAY = 86_400_000;

export interface ComposedItem extends SelectedItem {
  copy: 'llm' | 'template';
  headline: string;
  body: string | null;
  openers: string[];
  /** The numbered main line as it appears in the iMessage text. */
  line: string;
}

export interface ComposedDigest {
  localDate: string;
  digestId: string | null;
  items: ComposedItem[];
  /** iMessage text (first char U+1F168). */
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
  items: { suggestionId: string; ordinal: number; copy: 'llm' | 'template'; headline: string; body: string | null; openers: string[]; line: string }[];
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
  return truncate(`${ordinal} ${sensitive ? SENSITIVE_LINE : headline}`, MAX_MAIN_LINE);
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

export interface TextParts {
  localDate: string;
  items: Pick<ComposedItem, 'ordinal' | 'line' | 'copy' | 'body' | 'openers' | 'sensitive'>[];
  lastNight: string | null;
  health: string | null;
  commandsEnabled: boolean;
}

export function digestText(p: TextParts): string {
  const lines: string[] = [`${BOT_MARKER} ${headerDate(p.localDate)} · ${p.items.length} for today`, ''];
  for (const i of p.items) {
    lines.push(i.line);
    if (i.sensitive || i.copy !== 'llm') continue;
    if (i.body) lines.push(`  ${truncate(i.body, MAX_SUB_LINE)}`);
    const opener = i.openers[0];
    if (opener) lines.push(`  ↳ "${truncate(opener.replace(/["“”]/g, ''), MAX_SUB_LINE - 6)}"`);
  }
  lines.push('');
  if (p.lastNight) lines.push(p.lastNight);
  if (p.health) lines.push(p.health);
  lines.push(TODAY_LINK);
  const first = p.items[0]?.ordinal ?? 1;
  if (p.commandsEnabled) lines.push(`reply done ${first} · snooze ${first} 2w · skip ${first} · ? ask`);
  return lines.join('\n');
}

/** The last resort: header, count and the link (always passes the outbound rules). */
export function minimalText(localDate: string, n: number): string {
  return `${BOT_MARKER} ${headerDate(localDate)} · ${n} for today\n${TODAY_LINK}`;
}

/** "🅨 Wed Oct 14 · all clear" (preview of an empty day; nothing is sent). */
export function allClearText(localDate: string): string {
  return `${BOT_MARKER} ${headerDate(localDate)} · all clear, nothing needs you today\n${TODAY_LINK}`;
}

// ---------------------------------------------------------------------------------------------- compose

function statusLines(db: DB, now: number): { lastNight: string | null; health: string | null } {
  const failure = pipelineFailure(db, now);
  const health = failure ? `⚠ Last night's run failed at ${failure.stage} · see Sources` : healthLine(topHealthIssue(db, now));
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
  const templates = new Map<string, ItemCopy>(items.map((i) => [i.suggestionId, templateCopy(i, { db, now: o.now, timeZone: tz })]));
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
      runId: o.runId ?? selection.digest.run_id,
      signal: o.signal,
      log: o.log,
    });
  }
  const build = (useLlmCopy: boolean): ComposedItem[] =>
    items.map((i) => {
      const llmCopy = useLlmCopy ? llm?.copies.get(i.suggestionId) : undefined;
      const c = llmCopy ?? templates.get(i.suggestionId)!;
      return { ...i, copy: llmCopy ? 'llm' : 'template', headline: c.headline, body: c.body, openers: c.openers, line: mainLine(i.ordinal, c.headline, i.sensitive) };
    });
  const { lastNight, health } = statusLines(db, o.now);
  let composed = build(true);
  let text = digestText({ localDate: o.localDate, items: composed, lastNight, health, commandsEnabled: settings['commands.enabled'] });
  if (checkOutboundText(text).length) {
    o.log?.warn('digest.text_rejected', { counts: { problems: checkOutboundText(text).length } });
    composed = build(false);
    text = digestText({ localDate: o.localDate, items: composed, lastNight, health, commandsEnabled: settings['commands.enabled'] });
    if (checkOutboundText(text).length) text = minimalText(o.localDate, composed.length);
  }
  const usage: LlmUsage | null = llm?.usage ?? null;
  return {
    localDate: o.localDate,
    digestId: selection.digest.id,
    items: composed,
    text,
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
    items: c.items.map((i) => ({ suggestionId: i.suggestionId, ordinal: i.ordinal, copy: i.copy, headline: i.headline, body: i.body, openers: i.openers, line: i.line })),
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

/** Whether the stored composition still matches the ranker's current picks. */
export function compositionCurrent(selection: DigestSelection): boolean {
  const d = selection.digest;
  if (!d.composed_at || !d.imessage_text) return false;
  const body = parseWebBody(d.web_body);
  if (!body) return false;
  const now = selection.items.map((i) => i.suggestionId);
  return body.suggestionIds.length === now.length && body.suggestionIds.every((id, k) => id === now[k]);
}

/** Writes the composition onto the digest row (never once it was sent) and the copy onto its suggestions. */
export function persistComposition(db: DB, c: ComposedDigest, now: number): boolean {
  if (!c.digestId) return false;
  return db.transaction(() => {
    const res = db
      .prepare(
        `UPDATE digests SET imessage_text = ?, web_body = ?, composed_at = ?, composer = ?, llm_usage = ?,
           status = CASE status WHEN 'composing' THEN 'ready' ELSE status END
         WHERE id = ? AND status IN ('composing','ready') AND sent_at IS NULL`,
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
  if (selection.digest.sent_at || !['composing', 'ready'].includes(selection.digest.status)) return storedComposition(selection);
  const composed = await composeSelection(db, services, selection, o);
  persistComposition(db, composed, o.now);
  return composed;
}

/** The stored composition of a digest (stored copy over the current selection), or a fresh template one. */
export function storedComposition(selection: DigestSelection): ComposedDigest | null {
  const d = selection.digest;
  const body = parseWebBody(d.web_body);
  if (!body || !d.imessage_text) return null;
  const byId = new Map(body.items.map((i) => [i.suggestionId, i]));
  const items: ComposedItem[] = selection.items.flatMap((i) => {
    const b = byId.get(i.suggestionId);
    return b ? [{ ...i, copy: b.copy, headline: b.headline, body: b.body, openers: b.openers, line: b.line }] : [];
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
