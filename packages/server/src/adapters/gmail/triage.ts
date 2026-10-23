/**
 * Ticket-mail triage on metadata alone (From, Subject, labels; design §1 "Triage"). Deterministic: no LLM, no body.
 *   candidate   a vendor sender (VENDORS) with a transactional subject; a sender the owner listed in
 *               gmail.extra_senders (his club, a promoter) with any subject that isn't marketing; any sender with a
 *               registration confirmation or RSVP reminder subject ("CES: Registration Confirmation", "RSVP Reminder:
 *               …"); any sender with a registration / ticket subject AND an .ics / .pkpass part (known from the
 *               attachment listing); or a forwarded ticket subject ("Fwd: Your tickets for …").
 *   marketing   a vendor sender with a marketing subject (presale, on sale, just announced, wait list:, buy now:,
 *               you're invited to, how was it, rate, tomorrow!, want to see, …), or with a subject that is neither.
 *   ignored     everything else, and the owner's own sent mail (SENT / DRAFT labels, or a From address of his).
 * A transactional subject wins over marketing words ("Your tickets for tomorrow!" is a reminder), so the
 * transactional patterns are specific: order and receipt words, "your tickets", transfers, refunds, cancellations,
 * changes, registration confirmations, reminders about "your" event.
 * Also builds the messages.list queries (vendor domains OR ticket words OR a pass attachment), so Gmail does the
 * coarse filtering and only plausible mail costs a metadata fetch.
 */
import { VENDORS, vendorOf, type Vendor } from './vendors';

export type TriageVerdict = 'candidate' | 'marketing' | 'ignored';

export interface TriageInput {
  from: string | null;
  subject: string | null;
  labelIds: readonly string[];
  /** The sender's domain (vendors.ts senderDomain). */
  fromDomain: string | null;
  /** The message has a .pkpass or .ics part (it was in the attachment listing). */
  hasPass: boolean;
  /** The From address is one of the owner's (identity/self.ts). */
  fromOwner: boolean;
}

export interface TriageResult {
  verdict: TriageVerdict;
  vendor: Vendor | null;
  forwarded: boolean;
  /** Why (counts only: a fixed token, never the subject). */
  rule:
    | 'own_mail'
    | 'vendor_transactional'
    | 'vendor_marketing'
    | 'vendor_other'
    | 'extra_sender'
    | 'registration'
    | 'pass_registration'
    | 'forwarded_ticket'
    | 'other';
}

/** Subjects only an order, delivery, transfer, resale, refund, cancellation, change or registration has. */
const STRONG =
  /\border\b\s*(?:#|no\.?|number|confirm\w*|receipt|(?:has been |is )?(?:placed|complete[d]?|processed|received))|\breceipt\b|\bconfirmation\s*(?:#|no\.?|number|code)|\bpurchase (?:confirm\w*|receipt)|\btickets? (?:are |is )?(?:ready|here|confirmed|attached|inside)\b|\be-?tickets?\b|\bticket transfer\b|\btransfer(?:red)? (?:\d+ )?tickets?\b|\btickets? (?:were |was |have been |has been )?transfer(?:red)?\b|\bsent you\b|\baccepted your\b|\bclaimed your\b|\bis on its way\b|\brefund(?:ed)?\b|\bcancel+(?:ed|ation)\b|\bpostponed\b|\brescheduled\b|\b(?:event|show|venue|time|date) (?:change|update|has changed|has moved)|\bimportant (?:info\w*|update|message) about your\b|\bknow before you go\b|\breminder: your\b|\byou(?:'|’)re (?:all set|going|registered|in)\b|\byou(?:'|’)ve registered\b|\bregistration (?:is )?(?:confirmed|complete)|\bthanks for registering\b|\brsvp (?:confirmed|received)\b|\b(?:tickets? )?(?:has|have) sold\b|\bsold!|\blisting (?:is live|has sold|sold)\b|\bpayout\b|\bbooking confirm\w*|\badd to (?:apple )?wallet\b|\bmobile entry\b|\bticket instructions\b|\bevent reminder\b|\bdays? away\b|\bget ready for\b|^\s*\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\s+today:|\bvenue info for\b|\benjoy the event\b|\bdoors open\b|^\s*rsvp reminder\b/i;

/** "Your tickets", "your event": transactional unless the subject also reads as marketing ("Get your tickets now"). */
const WEAK = /\byour (?:mobile |digital |e-?)?tickets?\b|\bmobile tickets?\b|\byour (?:event|show|concert|order|booking|reservation|registration|pass|listing|sale)\b/i;

/** Promotional subjects from a vendor domain. */
const MARKETING =
  /\bpre-?sale\b|\bon ?sale\b|\bjust announced\b|^\s*wait ?list:|^\s*buy now:|\byou(?:'|’)re invited to\b|\bhow was (?:it|the|your)\b|\brate (?:your|the|us|it)\b|tomorrow!|\bwant to see\b|\bdon(?:'|’)?t miss\b|\blast chance\b|\bselling fast\b|\blow tickets\b|\brecommend\w*|\bfor you\b|\bnew (?:shows?|dates?) (?:added|announced)\b|\bannounc\w*|\btickets? (?:still )?available\b|\bthis (?:week|weekend)\b|\bnewsletter\b|%\s*off\b|\bdiscount\b|\bpromo code\b|\bdeals?\b|\bnear you\b|\bfan ?(?:club|access)\b|\b(?:get|buy|grab|score) (?:your )?tickets\b/i;

const TRANSACTIONAL = { test: (s: string) => STRONG.test(s) || (WEAK.test(s) && !MARKETING.test(s)) };

/** Registration / ticket words a non-vendor subject needs (together with a pass or a forward). */
const TICKET_WORDS = /\btickets?\b|\bregist(?:ration|ered)\b|\brsvp\b|\badmission\b|\be-?tickets?\b|\bboarding pass\b|\bpass(?:es)?\b|\byou(?:'|’)re going\b|\border confirm\w*/i;

const FORWARDED = /^\s*(?:fwd?|fw)\s*:/i;

/** A registration someone confirmed or is reminded of: event-specific enough for any sender (the model drops webinars). */
const REGISTERED = /\bregistration (?:confirmation|confirmed|complete)\b|\byou(?:'|’)re registered\b|\b(?:thank you|thanks) for registering\b|^\s*rsvp reminder\b/i;

export const isForwardedSubject = (subject: string | null): boolean => FORWARDED.test(subject ?? '');
export const isTransactionalSubject = (subject: string | null): boolean => TRANSACTIONAL.test(subject ?? '');
export const isMarketingSubject = (subject: string | null): boolean => MARKETING.test(subject ?? '');

export function triage(t: TriageInput, extraSenders: readonly string[] = []): TriageResult {
  const subject = t.subject ?? '';
  const forwarded = FORWARDED.test(subject);
  const vendor = vendorOf(t.fromDomain, extraSenders);
  if (t.fromOwner || t.labelIds.includes('SENT') || t.labelIds.includes('DRAFT')) return { verdict: 'ignored', vendor, forwarded, rule: 'own_mail' };
  if (vendor) {
    if (TRANSACTIONAL.test(subject)) return { verdict: 'candidate', vendor, forwarded, rule: 'vendor_transactional' };
    // A sender the owner listed himself mails event titles as subjects ("Endless Summer Social"): all but marketing.
    if (!VENDORS.includes(vendor) && !MARKETING.test(subject)) return { verdict: 'candidate', vendor, forwarded, rule: 'extra_sender' };
    return { verdict: 'marketing', vendor, forwarded, rule: MARKETING.test(subject) ? 'vendor_marketing' : 'vendor_other' };
  }
  if (forwarded && (TRANSACTIONAL.test(subject) || TICKET_WORDS.test(subject)) && !MARKETING.test(subject)) {
    return { verdict: 'candidate', vendor, forwarded, rule: 'forwarded_ticket' };
  }
  if (REGISTERED.test(subject) && !MARKETING.test(subject)) return { verdict: 'candidate', vendor, forwarded, rule: 'registration' };
  if (t.hasPass && (TICKET_WORDS.test(subject) || TRANSACTIONAL.test(subject))) return { verdict: 'candidate', vendor, forwarded, rule: 'pass_registration' };
  return { verdict: 'ignored', vendor, forwarded, rule: 'other' };
}

// ---------------------------------------------------------------------------------------------- list queries

/** Subject words the main listing ORs in (Gmail matches whole words, so singular and plural both appear). */
const SUBJECT_TERMS = ['ticket', 'tickets', 'eticket', 'registration', 'registered', 'registering', 'rsvp', '"order confirmation"', '"your order"', '"you\'re going"', 'admission'];

const after = (ms: number) => `after:${Math.floor(ms / 1000)}`;
const before = (ms: number) => `before:${Math.floor(ms / 1000)}`;
/** Never the owner's own outgoing mail or chats. */
const NOT_MINE = '-in:sent -in:drafts -in:chats';

/** Every vendor domain (allowlist + extra senders) as `from:` terms. */
function fromTerms(extraSenders: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const v of VENDORS) for (const d of v.domains) domains.add(d);
  for (const x of extraSenders) if (x.trim()) domains.add(x.trim().toLowerCase());
  return [...domains].map((d) => `from:${d}`);
}

/** The main listing: vendor senders, ticket words in the subject, or a wallet pass, within [from, to). */
export function listQuery(range: { from: number; to: number | null }, extraSenders: readonly string[] = []): string {
  const terms = [...fromTerms(extraSenders), ...SUBJECT_TERMS.map((s) => `subject:${s}`), 'filename:pkpass'];
  return [after(range.from), range.to !== null ? before(range.to) : null, NOT_MINE, `{${terms.join(' ')}}`].filter(Boolean).join(' ');
}

/** The attachment listing: an .ics or .pkpass part AND a registration / ticket subject (any sender). */
export function passQuery(range: { from: number; to: number | null }): string {
  const subjects = ['ticket', 'tickets', 'registration', 'registered', 'rsvp', 'confirmed', 'confirmation', 'admission', 'pass'].map((s) => `subject:${s}`);
  return [after(range.from), range.to !== null ? before(range.to) : null, NOT_MINE, '{filename:pkpass filename:ics}', `{${subjects.join(' ')}}`]
    .filter(Boolean)
    .join(' ');
}
