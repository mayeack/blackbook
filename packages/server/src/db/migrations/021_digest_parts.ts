/**
 * 021 digest parts (owner: delivery/): the morning brief goes out as one text per suggestion (plus at most one
 * health text), so an outbound row can belong to a single item of a digest.
 *
 *   outbound_messages.digest_ordinal  the digest item a part carries (null for the health text, replies, alerts).
 *                                     An inline reply to that text ("done", "skip", "why") acts on that item.
 */
export const sql = /* sql */ `
ALTER TABLE outbound_messages ADD COLUMN digest_ordinal INTEGER;
`;
