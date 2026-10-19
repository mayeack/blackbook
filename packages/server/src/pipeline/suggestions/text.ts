/**
 * Deterministic copy for suggestions: template headlines (the history list and the composer's fallback), the
 * "Why this?" summary and signal rows, and template conversation-starter drafts. Names follow the digest rule
 * (first name + last initial, or the full last name where that reads as the owner or as another of the item's
 * people: PeopleCache.names). Nothing here is ever sent: openers are DRAFTS ONLY (copy on the web).
 */
import type { SuggestionKind, WhySignal } from '@yb/shared';
import { KIND_LABEL, WILDCARD_LABEL } from './learner';

export interface TextInput {
  kind: SuggestionKind;
  isWildcard: boolean;
  wildcardGenerator: keyof typeof WILDCARD_LABEL | null;
  /** The item's people as copy names them (PeopleCache.names), primary first. */
  names: string[];
  /** First names (openers). */
  firstNames: string[];
  circleName: string | null;
  payload: Record<string, unknown>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Payload keys differ a little between the modules that ship generators (e.g. `historical` / `historicalStrength`,
 * `sinceD` / `silenceD` for circles): the first present alias wins, rounded for display (`digits` decimals).
 */
const ALIASES: Record<string, readonly string[]> = {
  silenceD: ['silenceD', 'silence_d'],
  expectedGapD: ['expectedGapD', 'expected_gap_d'],
  fadingRatio: ['fadingRatio', 'fading_ratio'],
  historical: ['historical', 'historicalStrength', 'historical_strength'],
  tie: ['tie', 'tieStrength', 'tie_strength'],
  circleSinceD: ['sinceD', 'silenceD'],
};
const DIGITS: Record<string, number> = { fadingRatio: 1, momentum: 2 };
function pnum(p: Record<string, unknown>, key: string): number | null {
  for (const k of ALIASES[key] ?? [key]) {
    const v = num(p[k]);
    if (v !== null) {
      const d = DIGITS[key] ?? 0;
      return Math.round(v * 10 ** d) / 10 ** d;
    }
  }
  return null;
}
const list = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? 'someone') : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

export function ageText(hours: number | null): string {
  if (hours === null) return 'a while';
  if (hours < 24) return `${Math.max(1, Math.round(hours))}h`;
  return `${Math.round(hours / 24)}d`;
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** ≤90 characters. */
export function templateHeadline(t: TextInput): string {
  const p = t.payload;
  const who = list(t.names);
  const circle = t.circleName ?? 'A circle';
  let h: string;
  switch (t.kind) {
    case 'fading': {
      const s = pnum(p, 'silenceD');
      const e = pnum(p, 'expectedGapD');
      h = s !== null ? `${who} · quiet ${s}d${e !== null ? ` (usually ~${e}d)` : ''}` : `${who} · fading`;
      break;
    }
    case 'cooling':
      h = `${who} · cooling off lately`;
      break;
    case 'dormant': {
      const s = pnum(p, 'silenceD');
      h = s !== null ? `${who} · quiet ${Math.max(1, Math.round(s / 30))} months` : `${who} · it's been a while`;
      break;
    }
    case 'reply_debt':
      h = `Reply to ${who} · ${ageText(pnum(p, 'ageH'))}`;
      break;
    case 'commitment_due':
      h = p.owner === 'them' ? `${who} · waiting on them` : `${who} · your promise is due`;
      break;
    case 'circle_neglect': {
      const d = pnum(p, 'circleSinceD');
      h = p.checkin === true ? `${circle} · check in?` : d !== null ? `${circle} · nothing together in ${d}d` : `${circle} · been a while`;
      break;
    }
    case 'memory':
      h = `A year ago today · ${who}`;
      break;
    case 'intro':
      h = `Intro ${t.names[0] ?? 'someone'} ↔ ${t.names[1] ?? 'someone'}?`;
      break;
    case 'pre_event_brief':
      h = `Before your event · ${who}`;
      break;
    case 'event_followup':
      h = `Follow up · ${who}`;
      break;
    case 'party_invite':
      h = `Who to invite · ${who}`;
      break;
    case 'travel_overlap':
      h = `Trip coming up · ${who} nearby`;
      break;
    default:
      h = who;
  }
  return clip(t.isWildcard ? `🎲 ${h}` : h, 90);
}

/** One sentence for "Why this?". */
export function whySummary(t: TextInput): string {
  const p = t.payload;
  const who = list(t.names);
  const circle = t.circleName ?? 'this circle';
  let s: string;
  switch (t.kind) {
    case 'fading': {
      const S = pnum(p, 'silenceD');
      const E = pnum(p, 'expectedGapD');
      const F = pnum(p, 'fadingRatio');
      s = S !== null && E !== null ? `${who} has been quiet ${S} days${F !== null ? `, about ${F}× ` : ', longer than '}your usual ~${E}-day gap.` : `${who} is fading.`;
      break;
    }
    case 'cooling':
      s = `You've been in touch with ${who} less over the last three months than over the past year.`;
      break;
    case 'dormant': {
      const S = pnum(p, 'silenceD');
      const H = pnum(p, 'historical');
      s = `${who} used to be a big part of your life${H !== null ? ` (history ${H}/100)` : ''}${S !== null ? `, but it's been ${S} days` : ''}.`;
      break;
    }
    case 'reply_debt':
      s = `${who} ${p.likely === true ? 'probably ' : ''}is waiting on a reply (${ageText(pnum(p, 'ageH'))}).`;
      break;
    case 'commitment_due': {
      const od = pnum(p, 'overdueD');
      const due = od !== null && od > 0 ? `, ${od} days past due` : '';
      s = p.owner === 'them' ? `${who} said they'd get back to you${due}.` : `You told ${who} you'd follow through${due}.`;
      break;
    }
    case 'circle_neglect': {
      const d = pnum(p, 'circleSinceD');
      s = p.checkin === true ? `A random check-in with ${circle}.` : `It's been ${d ?? 'many'} days since you were together with ${circle}.`;
      break;
    }
    case 'memory':
      s = `A year ago today: ${p.source === 'conversation' ? 'a long conversation' : 'an event'} with ${who}.`;
      break;
    case 'intro':
      s = `${t.names[0] ?? 'They'} and ${t.names[1] ?? 'someone you know'} might get along.`;
      break;
    case 'pre_event_brief':
      s = `You have an event coming up with ${who}.`;
      break;
    case 'event_followup':
      s = `Follow up with ${who} after your event together.`;
      break;
    case 'party_invite': {
      const d = pnum(p, 'daysOut');
      const pi = pnum(p, 'partyInvites') ?? 0;
      const many = t.names.length > 1;
      const listed = pi <= 0 ? '' : !many ? " They're on your Party invites list." : pi >= t.names.length ? ' All of them are on your Party invites list.' : pi === 1 ? ' One of them is on your Party invites list.' : ` ${pi} of them are on your Party invites list.`;
      s = `You're hosting ${d !== null ? `in ${d} day${d === 1 ? '' : 's'}` : 'soon'} and ${who} ${many ? "aren't" : "isn't"} on the guest list yet.${listed}`;
      break;
    }
    case 'travel_overlap':
      s = `You're traveling soon and ${who} ${t.names.length > 1 ? 'are' : 'is'} nearby.`;
      break;
    default:
      s = `A suggestion about ${who}.`;
  }
  return t.isWildcard ? `🎲 Wildcard (${t.wildcardGenerator ? WILDCARD_LABEL[t.wildcardGenerator] : 'something different'}): ${s}` : s;
}

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Signal rows from a candidate payload (numbers and flags only). */
export function whySignals(payload: Record<string, unknown>): WhySignal[] {
  const out: WhySignal[] = [];
  const add = (label: string, value: string | null) => {
    if (value !== null) out.push({ label, value });
  };
  const n = (k: string) => pnum(payload, k);
  add('Quiet for', n('silenceD') !== null ? `${n('silenceD')} days` : null);
  add('Usually every', n('expectedGapD') !== null ? `~${n('expectedGapD')} days` : null);
  add('Silence vs usual', n('fadingRatio') !== null ? `${n('fadingRatio')}×` : null);
  add('History', n('historical') !== null ? `${n('historical')}/100` : null);
  add('Tie strength', n('tie') !== null ? `${n('tie')}/100` : null);
  add('Momentum (90d vs 1y)', n('momentum') !== null ? `${n('momentum')! > 0 ? '+' : ''}${n('momentum')}` : null);
  add('Waiting', n('ageH') !== null ? ageText(n('ageH')) : null);
  add('Urgency', typeof payload.urgency === 'string' ? payload.urgency : null);
  add('Detected by', payload.likely === true ? 'heuristics (likely)' : null);
  add('Who owes it', payload.owner === 'them' ? 'them' : payload.owner === 'me' || payload.owner === 'both' ? 'you' : null);
  add('Due', n('dueAt') !== null ? fmtDate(n('dueAt')!) : null);
  add('Overdue', n('overdueD') !== null && n('overdueD')! > 0 ? `${n('overdueD')} days` : null);
  add('Last together', n('sinceD') !== null ? `${n('sinceD')} days ago` : null);
  add('Members', n('memberCount') !== null ? String(n('memberCount')) : null);
  add('People there', n('attendeeCount') !== null ? String(n('attendeeCount')) : null);
  add('Starts in', n('daysOut') !== null ? `${n('daysOut')} day${n('daysOut') === 1 ? '' : 's'}` : null);
  add('Going so far', n('guestCount') !== null ? String(n('guestCount')) : null);
  add('From Party invites', n('partyInvites') ? String(n('partyInvites')) : null);
  add('Messages that day', n('messages') !== null ? String(n('messages')) : null);
  add('When', n('yearsAgo') !== null ? `${n('yearsAgo')} year${n('yearsAgo') === 1 ? '' : 's'} ago today` : null);
  add('Priority person', payload.priority === true ? 'yes' : null);
  return out;
}

/** Two template openers (≤160 chars each). DRAFTS ONLY. */
export function templateOpeners(t: TextInput): string[] {
  const f = t.firstNames[0] ?? 'there';
  const g = t.firstNames[1] ?? 'a friend of mine';
  let o: string[];
  switch (t.kind) {
    case 'reply_debt':
      o = [`Sorry for the slow reply, ${f}!`, `Hey ${f} — catching up on messages now. Still on?`];
      break;
    case 'commitment_due':
      o = t.payload.owner === 'them' ? [`Hey ${f}, any update on this?`, `No rush ${f} — just checking in on this.`] : [`Hey ${f}, I haven't forgotten — following up now!`, `${f}! Sorry this took a while — still want to do it?`];
      break;
    case 'circle_neglect':
      o = [`Hey all — it's been a while! Anyone free to get together soon?`, `Missing this crew. Dinner in the next couple of weeks?`];
      break;
    case 'memory':
      o = [`Hey ${f}! I was just thinking about this time last year — how have you been?`, `${f}, a year ago today! We should do that again.`];
      break;
    case 'intro':
      o = [`Hey ${f}, I think you'd really get along with ${g} — open to an intro?`, `${f}, would you be up for meeting ${g}? I think you two would click.`];
      break;
    case 'event_followup':
      o = [`Great seeing you, ${f}!`, `So fun catching up, ${f} — let's not wait so long next time.`];
      break;
    case 'pre_event_brief':
      o = [`Looking forward to seeing you, ${f}!`, `See you soon, ${f}!`];
      break;
    case 'party_invite':
      o = [`Hey ${f}! I'm hosting something soon and would love for you to come. Are you around?`, `${f}! Throwing a little something soon and you should come. Want the details?`];
      break;
    case 'travel_overlap':
      o = [`Hey ${f}, I'll be in town soon — free to meet up?`, `${f}! Heading your way soon, want to grab a coffee?`];
      break;
    case 'cooling':
      o = [`Hey ${f}! How's everything going?`, `${f}, it's been a minute — want to catch up this week?`];
      break;
    default:
      o = [`Hey ${f}! It's been too long — how are you doing?`, `Thinking of you, ${f} — want to catch up soon?`];
  }
  return o.map((s) => clip(s, 160));
}

export { KIND_LABEL };
