/** Human labels for the server's enum-ish strings. Unknown values fall back to a humanized form. */

export const humanize = (s: string) => {
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : s;
};

const SOURCES: Record<string, string> = {
  imessage: 'iMessage',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  instagram_dyi: 'Instagram export',
  ig_dyi: 'Instagram export',
  beeper: 'Beeper',
  partiful: 'Partiful',
  addressbook: 'Contacts',
  calendar: 'Calendar',
  gcal: 'Google Calendar',
  legacy: 'Blackbook',
  collector: 'Mac helper',
  user: 'You',
  phone: 'Phone',
  email: 'Email',
  x: 'X',
  linkedin: 'LinkedIn',
  inference: 'Inferred',
  llm: 'Inferred',
  manual: 'You',
};
export const sourceLabel = (s: string) => SOURCES[s] ?? humanize(s);

/** Two-letter badge text for a source tile. */
const SOURCE_SHORT: Record<string, string> = {
  imessage: 'iM',
  whatsapp: 'WA',
  instagram: 'IG',
  instagram_dyi: 'IG',
  beeper: 'Bp',
  partiful: 'Pf',
  addressbook: 'Ct',
  calendar: 'Ca',
  gcal: 'Ca',
  legacy: 'Bb',
  collector: 'Mc',
  phone: 'Ph',
  email: '@',
  x: 'X',
  linkedin: 'in',
  inference: 'AI',
};
export const sourceShort = (s: string) => SOURCE_SHORT[s] ?? s.slice(0, 2).replace(/^./, (c) => c.toUpperCase());

/** Source names that are one network on screen (Beeper is read for Instagram only). */
const CHANNELS: Record<string, string> = {
  beeper: 'instagram',
  instagram_dyi: 'instagram',
  ig_dyi: 'instagram',
  gcal: 'calendar',
  google_calendar: 'calendar',
};
/** The network a source name belongs to: beeper → instagram, gcal → calendar, others unchanged. */
export const channelOf = (source: string) => CHANNELS[source] ?? source;

const CHANNEL_ORDER = ['addressbook', 'imessage', 'whatsapp', 'instagram', 'partiful', 'calendar'];
/** Distinct networks for badges, in a fixed order (Contacts first). */
export function channelsOf(sources: readonly string[]): string[] {
  const rank = (c: string) => {
    const i = CHANNEL_ORDER.indexOf(c);
    return i === -1 ? CHANNEL_ORDER.length : i;
  };
  return [...new Set(sources.map(channelOf))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Sources-screen card titles. */
const CARD_LABELS: Record<string, string> = {
  beeper: 'Instagram (Beeper)',
  instagram_dyi: 'Instagram export',
  gcal: 'Google Calendar',
  addressbook: 'Contacts',
};
export const sourceCardLabel = (s: string) => CARD_LABELS[s] ?? sourceLabel(s);

/** The network an identity belongs to, for its badge on the person page. */
const IDENTITY_NETWORKS: Record<string, string> = {
  phone: 'phone',
  email: 'email',
  whatsapp_jid: 'whatsapp',
  whatsapp_lid: 'whatsapp',
  instagram_id: 'instagram',
  instagram_username: 'instagram',
  instagram_name: 'instagram',
  beeper_user: 'instagram',
  partiful_user: 'partiful',
  addressbook_id: 'addressbook',
  x_username: 'x',
  linkedin_url: 'linkedin',
  legacy_id: 'legacy',
  shortcode: 'imessage',
  business_chat: 'imessage',
};
export const identityNetwork = (kind: string, source: string) => IDENTITY_NETWORKS[kind] ?? channelOf(source);

const IDENTITY_KINDS: Record<string, string> = {
  phone: 'Phone',
  email: 'Email',
  whatsapp_jid: 'WhatsApp',
  whatsapp_lid: 'WhatsApp ID',
  instagram_id: 'Instagram ID',
  instagram_username: 'Instagram',
  instagram_name: 'Instagram name',
  partiful_user: 'Partiful',
  addressbook_id: 'Contacts card',
  beeper_user: 'Beeper',
  x_username: 'X',
  linkedin_url: 'LinkedIn',
  legacy_id: 'Blackbook',
  shortcode: 'Short code',
  business_chat: 'Business',
};
export const identityKindLabel = (k: string) => IDENTITY_KINDS[k] ?? humanize(k);

const MATCH_METHODS: Record<string, string> = {
  exact: 'exact match',
  deterministic: 'same identifier',
  addressbook: 'from your contacts',
  seed: 'seeded',
  probabilistic: 'likely match',
  llm_tiebreak: 'AI tie-break',
  self_id: 'introduced themselves',
  user: 'linked by you',
  legacy: 'from Blackbook',
};
export const matchMethodLabel = (m: string) => MATCH_METHODS[m] ?? m.replace(/_/g, ' ');

const RUN_KINDS: Record<string, string> = {
  nightly: 'Nightly run',
  ingest: 'Ingest',
  command: 'Text command',
  user: 'Your changes',
  migration: 'Migration',
  import: 'Import',
  undo: 'Undo',
  weekly: 'Weekly run',
  system: 'System',
};
export const runKindLabel = (k: string) => RUN_KINDS[k] ?? humanize(k);

const BATCH_KINDS: Record<string, string> = {
  merge: 'Merge',
  attach_identity: 'Linked account',
  create_person: 'New person',
  person_update: 'Updated',
  fact: 'Fact',
  edge_label: 'Relationship',
  commitment: 'Promise',
  reply_debt: 'Reply owed',
  circle: 'Circle',
  tag: 'Tag',
  location: 'Place',
  note: 'Note',
  setting: 'Setting',
  attendee: 'Attendee',
  interaction: 'Interaction',
  user_edit: 'Your edit',
  migration: 'Migration',
  undo: 'Undo',
};
export const batchKindLabel = (k: string) => BATCH_KINDS[k] ?? humanize(k);

const STATES: Record<string, string> = {
  strong: 'Strong',
  steady: 'Steady',
  cooling: 'Cooling',
  fading: 'Fading',
  dormant: 'Dormant',
  new: 'New',
};
export const stateLabel = (s: string) => STATES[s] ?? humanize(s);

const SOURCE_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  ok: { label: 'Healthy', tone: 'ok' },
  stale: { label: 'Stale', tone: 'warn' },
  error: { label: 'Error', tone: 'bad' },
  auth_required: { label: 'Needs you', tone: 'bad' },
  contract_broken: { label: 'Error', tone: 'bad' },
  disabled: { label: 'Disabled', tone: 'neutral' },
  unknown: { label: 'No report yet', tone: 'neutral' },
};
export const sourceStatus = (s: string) => SOURCE_STATUS[s] ?? { label: humanize(s), tone: 'neutral' as const };

const INTERACTION_KINDS: Record<string, string> = {
  event: 'Event',
  occasion: 'Get-together',
  call: 'Call',
  meeting: 'Meeting',
  manual: 'Logged',
  text_log: 'Logged by text',
  legacy_text: 'Message (Blackbook)',
  dm_session: 'Messages',
  group_session: 'Group chat',
};
export const interactionLabel = (k: string) => INTERACTION_KINDS[k] ?? humanize(k);

/** Attendance status words (Partiful RSVPs and inferred attendance). */
const ATTENDEE_STATUS: Record<string, string> = {
  going: 'Going',
  approved: 'Going',
  checked_in: 'Checked in',
  attended: 'Was there',
  host: 'Host',
  maybe: 'Maybe',
  invited: 'Invited',
  waitlist: 'Waitlist',
  declined: 'Can’t go',
  possible: 'Possibly there',
};
export const attendeeStatusLabel = (s: string) => ATTENDEE_STATUS[s] ?? humanize(s);

const ATTENDEE_ROLES: Record<string, string> = {
  companion: 'With you',
  host: 'Host',
  co_host: 'Co-host',
  guest: 'Guest',
  ticket_holder: 'Has a ticket',
  plus_one: 'Plus-one',
  mentioned_only: 'Mentioned',
};
export const attendeeRoleLabel = (r: string) => ATTENDEE_ROLES[r] ?? humanize(r);

/** What each attendee clue means (pipeline/occasions/signals.ts types), in the owner's words. */
const CLUE_TYPES: Record<string, string> = {
  explicit: 'On your calendar invite',
  explicit_name: 'Named on your calendar invite',
  title_name: 'Named in the event title',
  notes_name: 'Named in the event notes',
  pair_name: 'Named in the title',
  ticket_holder: 'Has your ticket (from the notes)',
  partiful_going: 'Going on Partiful',
  partiful_maybe: 'Maybe on Partiful',
  partiful_host: 'Hosting on Partiful',
  group_nickname: 'In the group named in the title',
  mention_dm: 'Texted you about it',
  mention_group: 'Brought it up in a group chat',
  group_discussed: 'In a small group chat that discussed it',
  date_dm: 'Texted you about that day',
  tickets_dm: 'Talked tickets with you',
  logistics_dm: '“On my way / here” texts around the start',
  logistics_group: '“On my way / here” in a group chat around the start',
  after_dm: 'Texted you after it',
  after_group: 'Wrote in a group chat after it',
  photos_dm: 'Sent you photos during or after it',
  llm: 'AI review of these messages',
};
export const clueLabel = (t: string) => CLUE_TYPES[t] ?? humanize(t);

/** Where an attendee came from: the calendar invite, the Partiful guest list, or yeackbot's inference. */
const ATTENDEE_SOURCES: Record<string, string> = {
  calendar: 'Calendar',
  gcal: 'Calendar',
  partiful: 'Partiful',
  inference: 'Inferred',
  inferred: 'Inferred',
  llm: 'Inferred',
  user: 'Added by you',
  legacy: 'Blackbook',
};
export const attendeeSourceLabel = (s: string) => ATTENDEE_SOURCES[s] ?? humanize(s);

const OCCASION_KINDS: Record<string, string> = {
  social: 'Social',
  logistics: 'Logistics',
  appointment: 'Appointment',
  work: 'Work',
  lodging: 'Stay',
  travel: 'Travel',
  meeting: 'Meeting',
  trip: 'Trip',
};
export const occasionKindLabel = (k: string) => OCCASION_KINDS[k] ?? humanize(k);

/** Google Calendar treatments (PLAN "Google Calendar → Calendars"). */
const TREATMENTS: Record<string, { label: string; hint: string }> = {
  attending: { label: 'Attending', hint: 'Events here are ones you go to.' },
  candidate: { label: 'Candidate only', hint: 'Counts only when messages or an RSVP back it up.' },
  classify: { label: 'Include, then classify', hint: 'Included; yeackbot sorts social from logistics.' },
  excluded: { label: 'Excluded', hint: 'Never read for people or digests.' },
};
export const treatmentLabel = (t: string) => TREATMENTS[t]?.label ?? humanize(t);
export const treatmentHint = (t: string) => TREATMENTS[t]?.hint ?? null;
export const DEFAULT_TREATMENTS = Object.keys(TREATMENTS);
