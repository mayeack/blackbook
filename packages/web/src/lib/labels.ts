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
  beeper: 'Beeper',
  partiful: 'Partiful',
  addressbook: 'Contacts',
  calendar: 'Calendar',
  gcal: 'Google Calendar',
  legacy: 'Blackbook',
  collector: 'Mac helper',
  user: 'You',
  phone: 'Phone',
};
export const sourceLabel = (s: string) => SOURCES[s] ?? humanize(s);

/** Two-letter badge text for a source tile. */
const SOURCE_SHORT: Record<string, string> = {
  imessage: 'iM',
  whatsapp: 'WA',
  instagram: 'IG',
  beeper: 'Bp',
  partiful: 'Pf',
  addressbook: 'Ct',
  calendar: 'Ca',
  gcal: 'Ca',
  legacy: 'Bb',
  collector: 'Mc',
  phone: 'Ph',
};
export const sourceShort = (s: string) => SOURCE_SHORT[s] ?? s.slice(0, 2).replace(/^./, (c) => c.toUpperCase());

const IDENTITY_KINDS: Record<string, string> = {
  phone: 'Phone',
  email: 'Email',
  whatsapp_jid: 'WhatsApp',
  whatsapp_lid: 'WhatsApp',
  instagram_id: 'Instagram',
  instagram_username: 'Instagram',
  instagram_name: 'Instagram name',
  partiful_user: 'Partiful',
  addressbook_id: 'Contacts',
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
  contract_broken: { label: 'Needs a fix', tone: 'bad' },
  disabled: { label: 'Off', tone: 'neutral' },
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
