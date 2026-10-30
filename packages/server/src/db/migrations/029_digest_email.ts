/**
 * 029 digest email (owner request 2026-10-30: "Also send my daily digest via email"): the morning brief also goes to
 * the owner's own Gmail (delivery/email.ts, the gmail_send grant), tracked per digest beside the text and the push:
 *   email_status   'sending' (written before the Gmail call, so a crash mid-call never sends twice), then the
 *                  channel's state (TodayDigest.email)
 *   email_sent_at  when Gmail accepted it (ms)
 *   email_id       Gmail's message id
 */
export const sql = /* sql */ `
ALTER TABLE digests ADD COLUMN email_status TEXT
  CHECK (email_status IS NULL OR email_status IN ('sending','sent','pending','skipped','failed','disabled','not_configured'));
ALTER TABLE digests ADD COLUMN email_sent_at INTEGER;
ALTER TABLE digests ADD COLUMN email_id TEXT CHECK (email_id IS NULL OR length(email_id) BETWEEN 1 AND 64);
`;
