/**
 * 016 (owner: LLM builder): LLM client bookkeeping on top of 001's llm_batches / llm_requests / pseudonyms.
 *
 * llm_requests is THE custom_id ledger (written BEFORE any HTTP submit) and the spend ledger (cost_usd per
 * request, budget day in spent_date). `params` keeps the pseudonymized request body so a refused batch item can be
 * re-run synchronously and a max_tokens item re-queued; it is purged with `output` after 30 days (llm-purge).
 * Nothing here is journaled: it is operational bookkeeping (class S), never user-visible data.
 */
export const sql = /* sql */ `
ALTER TABLE llm_requests ADD COLUMN pool TEXT NOT NULL DEFAULT 'steady' CHECK (pool IN ('steady','backfill'));
ALTER TABLE llm_requests ADD COLUMN mode TEXT NOT NULL DEFAULT 'batch' CHECK (mode IN ('sync','batch'));
ALTER TABLE llm_requests ADD COLUMN run_id TEXT;
ALTER TABLE llm_requests ADD COLUMN purpose TEXT;
ALTER TABLE llm_requests ADD COLUMN effort TEXT;
ALTER TABLE llm_requests ADD COLUMN max_tokens INTEGER;
-- pseudonymized request body (system, messages, output schema); purged with output
ALTER TABLE llm_requests ADD COLUMN params TEXT CHECK (params IS NULL OR json_valid(params));
ALTER TABLE llm_requests ADD COLUMN estimate_usd REAL;
ALTER TABLE llm_requests ADD COLUMN refusal_category TEXT;
-- invalid_request | other | canceled | submit_failed | aborted | api_error | egress_blocked
ALTER TABLE llm_requests ADD COLUMN error_type TEXT;
ALTER TABLE llm_requests ADD COLUMN fallback_used INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0,1));
-- the custom_id this one retries (re-queue after max_tokens/errored/expired, sync re-run after a refusal)
ALTER TABLE llm_requests ADD COLUMN retry_of TEXT;
ALTER TABLE llm_requests ADD COLUMN completed_at INTEGER;
-- a re-queued batch item waits until then (expired / late errors go out with the next night's submit)
ALTER TABLE llm_requests ADD COLUMN not_before INTEGER;
-- local YYYY-MM-DD (settings tz) the cost was recorded on: the budget day
ALTER TABLE llm_requests ADD COLUMN spent_date TEXT CHECK (spent_date IS NULL OR spent_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
CREATE INDEX llm_req_spend ON llm_requests(pool, spent_date);
CREATE INDEX llm_req_open ON llm_requests(status, created_at) WHERE status IN ('pending', 'submitted');
CREATE INDEX llm_req_retry ON llm_requests(retry_of) WHERE retry_of IS NOT NULL;
CREATE INDEX llm_req_unpurged ON llm_requests(created_at) WHERE purged_at IS NULL;

ALTER TABLE llm_batches ADD COLUMN pool TEXT NOT NULL DEFAULT 'steady' CHECK (pool IN ('steady','backfill'));
ALTER TABLE llm_batches ADD COLUMN counts TEXT CHECK (counts IS NULL OR json_valid(counts));
ALTER TABLE llm_batches ADD COLUMN last_polled_at INTEGER;
ALTER TABLE llm_batches ADD COLUMN poll_count INTEGER NOT NULL DEFAULT 0;
-- results handed to the purpose's consumer (llm/batches.ts); NULL = still to collect
ALTER TABLE llm_batches ADD COLUMN collected_at INTEGER;
CREATE INDEX llm_batches_open ON llm_batches(submitted_at) WHERE collected_at IS NULL;
`;
