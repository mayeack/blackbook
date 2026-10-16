/**
 * 014 delivery (owner: delivery builder): digest delivery bookkeeping and push device details.
 *
 * digests gains per-channel delivery state so Today can say "Sent 8:00 via iMessage ✓ · push ✓" or why nothing
 * went out, which composer wrote the copy, and the heartbeat / pipeline-failure notice sent on an empty day:
 *   skip_reason        why the iMessage did not go out ('disabled', 'paused', 'empty', 'quiet_hours',
 *                      'catch_up_passed', 'no_self_handle', 'collector_unavailable', 'circuit_open', …)
 *   composer           'llm' (Claude copy that passed grounding, at least one item) | 'template'
 *   imessage_status    per-channel state (TodayDigest.imessage)
 *   push_status        per-channel state (TodayDigest.push)
 *   notice_outbound_id the heartbeat or "last night's run failed" one-liner sent instead of an empty digest
 *   delivery_checked_at last delivery-tick decision (ms)
 * push_subscriptions gains the browser's expirationTime and the last failure (status code + time).
 * push_log (S) records one-off pushes that must not repeat (the pre-event ping per occasion): key + time only.
 */
export const sql = /* sql */ `
ALTER TABLE digests ADD COLUMN skip_reason TEXT CHECK (skip_reason IS NULL OR length(skip_reason) BETWEEN 1 AND 40);
ALTER TABLE digests ADD COLUMN composer TEXT CHECK (composer IS NULL OR composer IN ('llm','template'));
ALTER TABLE digests ADD COLUMN imessage_status TEXT
  CHECK (imessage_status IS NULL OR imessage_status IN ('sent','pending','skipped','failed','disabled','not_configured'));
ALTER TABLE digests ADD COLUMN push_status TEXT
  CHECK (push_status IS NULL OR push_status IN ('sent','pending','skipped','failed','disabled','not_configured'));
ALTER TABLE digests ADD COLUMN notice_outbound_id TEXT;
ALTER TABLE digests ADD COLUMN delivery_checked_at INTEGER;

ALTER TABLE push_subscriptions ADD COLUMN expiration_time INTEGER;
ALTER TABLE push_subscriptions ADD COLUMN last_failure_at INTEGER;
ALTER TABLE push_subscriptions ADD COLUMN last_status INTEGER;

CREATE INDEX outbound_digest ON outbound_messages(digest_id) WHERE digest_id IS NOT NULL;

CREATE TABLE push_log (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('digest','health','pre_event','test','weekly')),
  sent INTEGER NOT NULL DEFAULT 0 CHECK (sent >= 0),
  created_at INTEGER NOT NULL
) STRICT;
`;
