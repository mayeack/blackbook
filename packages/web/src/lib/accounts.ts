/** Person page → Linked accounts: order, wording and the confidence tone of each identity row. */
import type { IdentityView } from '../api/types';
import { identityKindLabel, identityNetwork, matchMethodLabel, sourceLabel } from './labels';

/** "Phone (mobile) · via Contacts · from your contacts", "Instagram · via Beeper · same identifier". */
export function accountSubtitle(i: IdentityView): string {
  const kindLabel = identityKindLabel(i.kind);
  const kind = i.label ? `${kindLabel} (${i.label})` : kindLabel;
  // A masked value that already names its kind ("WhatsApp ID ••2345", "Contacts card") needn't repeat it.
  const parts = i.label || !i.value.startsWith(kindLabel) ? [kind] : [];
  // "via Beeper" under an Instagram badge says how it got here; "WhatsApp via WhatsApp" says nothing.
  if (identityNetwork(i.kind, i.source) !== i.source) parts.push(`via ${sourceLabel(i.source)}`);
  parts.push(matchMethodLabel(i.matchMethod));
  if (i.shared) parts.push('shared');
  if (i.status !== 'active') parts.push(i.status);
  return parts.join(' · ');
}

/** ≥0.9 strong, ≥0.75 fair, below that weak (a likely match that may be wrong). */
export const confidenceTone = (c: number) => (c >= 0.9 ? 'conf-high' : c >= 0.75 ? 'conf-mid' : 'conf-low');

const NETWORK_ORDER = ['phone', 'email', 'addressbook', 'imessage', 'whatsapp', 'instagram', 'partiful'];
const networkRank = (n: string) => {
  const i = NETWORK_ORDER.indexOf(n);
  return i === -1 ? NETWORK_ORDER.length : i;
};

/** Grouped by network (phones and emails first), server order within a network. */
export const orderAccounts = (ids: IdentityView[]) =>
  ids
    .map((i, n) => ({ i, n, r: networkRank(identityNetwork(i.kind, i.source)) }))
    .sort((a, b) => a.r - b.r || a.n - b.n)
    .map((x) => x.i);

