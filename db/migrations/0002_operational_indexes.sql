-- ============================================================================
-- 0002_operational_indexes — indexes for the queries the console actually runs
--
-- The baseline schema already indexes the obvious foreign keys. These are the
-- lookups that grew slowly and then started showing up in request latency:
--
--   * login lockout          where lower(email) = $1 and created_at > $2
--   * per-user audit trail   where user_id = $1 order by created_at desc
--   * AI usage accounting    where user_id = $1 and created_at > $2
--   * error listing/retention where created_at > $1
--   * import progress        where project_id = $1 and status = $2
--
-- Every statement is `if not exists`; applying this migration twice is a no-op.
-- Indexes are created without CONCURRENTLY on purpose: they run inside the
-- migration advisory lock, and CONCURRENTLY cannot run in a transaction block.
-- At DARKNOTE's data volumes each one builds in milliseconds.
-- ============================================================================

create index if not exists login_attempts_email_created_idx
  on login_attempts (lower(email), created_at desc);

create index if not exists login_attempts_ip_created_idx
  on login_attempts (ip, created_at desc);

create index if not exists activity_logs_user_created_idx
  on activity_logs (user_id, created_at desc);

create index if not exists bigbrother_usage_user_created_idx
  on bigbrother_usage (user_id, created_at desc);

create index if not exists error_intel_events_seen_idx
  on error_intel_events (last_seen_at desc);

create index if not exists project_import_jobs_project_status_idx
  on project_import_jobs (project_id, status);

-- Conversation pages are read newest-first; the baseline index is ascending,
-- which PostgreSQL can walk backwards, but a matching descending index keeps the
-- plan stable once a thread has thousands of turns.
create index if not exists bigbrother_messages_conversation_desc_idx
  on bigbrother_messages (conversation_id, created_at desc);
