/**
 * Citation ids → AskCitation (label + web deep link) and person chips. Every lookup re-checks visibility, so a
 * citation never surfaces a hidden person or a sensitive fact even if one slipped into the text.
 *
 *   m:<id>  "Sam · iMessage Oct 3"            /p/<person>?m=<message id>   (the timeline opens at that message)
 *   F<seq>  "Sam — lives in Austin (since Mar 2025)"   /p/<person>
 *   E<n>    "Friendsgiving · Nov 22"           /e/<occasion or event id>
 *   P<tok>  "Sam Rivera"                       /p/<person>
 */
import { localParts, type AskCitation, type PersonChip } from '@yb/shared';
import { channelOf, maskText } from '../routes/people';
import { docByNumber } from './fts';
import { decodeRef } from './refs';
import { eventById, factBySeq, firstNameOf, messageById, visiblePerson, type AskScope, type FactRow, type PersonRow } from './retrieval';

const CHANNEL_LABEL: Record<string, string> = { imessage: 'iMessage', whatsapp: 'WhatsApp', instagram: 'Instagram', partiful: 'Partiful' };

/** "Oct 3", or "Oct 3, 2025" when not this year. */
export function shortDate(ms: number, now: number, tz: string): string {
  const year = localParts(ms, tz).date.slice(0, 4);
  const sameYear = year === localParts(now, tz).date.slice(0, 4);
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(new Date(ms));
}

const monthYear = (ms: number, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', year: 'numeric' }).format(new Date(ms));

const FACT_PHRASE: Record<string, (v: string) => string> = {
  location_current: (v) => `lives in ${v}`,
  home_location: (v) => `lives in ${v}`,
  location_next: (v) => `moving to ${v}`,
  hometown: (v) => `from ${v}`,
  employer: (v) => `works at ${v}`,
  job: (v) => `works as ${v}`,
  role: (v) => v,
  school: (v) => `studied at ${v}`,
  education: (v) => `studied ${v}`,
  interest: (v) => `into ${v}`,
  activity_pref: (v) => `likes ${v}`,
  food_drink: (v) => `likes ${v}`,
  travel_plan: (v) => `travel: ${v}`,
  pet: (v) => `pet: ${v}`,
};

export function factLabel(scope: AskScope, f: FactRow, p: PersonRow): string {
  const phrase = (FACT_PHRASE[f.type] ?? ((v: string) => v))(maskText(f.value));
  const since = f.validFrom ? ` (since ${monthYear(f.validFrom, scope.tz)})` : '';
  return `${firstNameOf(p)} — ${phrase}${since}`;
}

export interface CitationContext {
  scope: AskScope;
  /** Person token → person (session registry). */
  personOfToken: (token: string) => PersonRow | null;
  /** Display name for people ("Sam Rivera" on the web, "Sam R." over iMessage). */
  displayName: (p: PersonRow) => string;
}

/** Resolves one citation id, or null when it no longer points at something visible. */
export function resolveCitation(c: CitationContext, ref: string): AskCitation | null {
  const d = decodeRef(ref);
  if (!d) return null;
  const { scope } = c;
  switch (d.kind) {
    case 'message': {
      const m = messageById(scope, d.n);
      if (!m) return null;
      const who = m.fromMe ? 'You' : firstNameOf(m.sender!);
      const target = m.fromMe ? (m.conv.counterpart ? visiblePerson(scope, m.conv.counterpart) : null) : m.sender;
      const network = CHANNEL_LABEL[channelOf(m.source)] ?? channelOf(m.source);
      const where = m.conv.kind === 'group' && m.conv.title ? ` in ${maskText(m.conv.title)}` : '';
      return {
        ref,
        kind: 'message',
        label: `${who} · ${network}${where} ${shortDate(m.sentAt, scope.now, scope.tz)}`,
        href: target ? `/p/${target.id}?m=${m.id}` : null,
        at: m.sentAt,
      };
    }
    case 'fact': {
      const f = factBySeq(scope, d.n);
      const p = f ? visiblePerson(scope, f.personId) : null;
      if (!f || !p) return null;
      return { ref, kind: 'fact', label: factLabel(scope, f, p), href: `/p/${p.id}`, at: f.validFrom ?? f.recordedAt };
    }
    case 'event': {
      const doc = docByNumber(scope.db, d.n);
      if (!doc || doc.kind === 'person') return null;
      const e = eventById(scope, doc.kind, doc.refId);
      if (!e) return null;
      return { ref, kind: 'event', label: `${maskText(e.title ?? 'Event')} · ${shortDate(e.startsAt, scope.now, scope.tz)}`, href: `/e/${e.id}`, at: e.startsAt };
    }
    case 'person': {
      const p = c.personOfToken(d.token);
      if (!p) return null;
      return { ref, kind: 'person', label: maskText(c.displayName(p)), href: `/p/${p.id}`, at: null };
    }
  }
}

export function resolveCitations(c: CitationContext, refs: string[]): AskCitation[] {
  const out: AskCitation[] = [];
  for (const ref of refs) {
    const cit = resolveCitation(c, ref);
    if (cit) out.push(cit);
  }
  return out;
}

/** Tappable person chips (person_visible only), in order, deduped. */
export function personChips(scope: AskScope, people: PersonRow[], max = 12): PersonChip[] {
  const out: PersonChip[] = [];
  const stateOf = scope.db.prepare('SELECT state FROM person_stats WHERE person_id = ?').pluck();
  for (const p of people) {
    const v = visiblePerson(scope, p.id);
    if (!v || out.some((c) => c.id === v.id)) continue;
    out.push({
      id: v.id,
      displayName: maskText(v.display_name),
      firstName: v.first_name ? maskText(v.first_name) : null,
      state: ((stateOf.get(v.id) as string | null | undefined) ?? null) as PersonChip['state'],
    });
    if (out.length >= max) break;
  }
  return out;
}
