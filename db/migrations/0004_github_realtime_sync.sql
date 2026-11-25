-- Real-time GitHub synchronization.
--
-- The working copy in imported_project_files is authoritative for the console.
-- These tables record how it got there: which webhook deliveries were accepted
-- (a retried delivery must not apply twice), which files changed on both sides
-- (nothing is silently overwritten) and what the previous content was (a failed
-- pull can be rolled back).
--
-- Idempotent: safe to run against a database that already has the tables.

create table if not exists github_webhook_deliveries (
  id             text primary key,                  -- X-GitHub-Delivery
  event          text not null,
  action         text,
  repo_full_name text,
  branch         text,
  commit_sha     text,
  project_id     text references imported_projects(id) on delete set null,
  status         text not null default 'received',  -- received | ignored | duplicated | applied | conflict | failed
  message        text,
  received_at    timestamptz not null default now(),
  processed_at   timestamptz
);
create index if not exists github_webhook_deliveries_received_idx
  on github_webhook_deliveries (received_at desc);
create index if not exists github_webhook_deliveries_project_idx
  on github_webhook_deliveries (project_id, received_at desc);

create table if not exists github_sync_conflicts (
  id             text primary key,
  project_id     text not null references imported_projects(id) on delete cascade,
  path           text not null,
  reason         text not null,                     -- both_modified | remote_delete_local_edit | local_delete_remote_edit
  local_content  text,
  remote_content text,
  local_sha      text,
  remote_sha     text,
  base_commit    text,
  head_commit    text,
  status         text not null default 'open',      -- open | resolved
  resolution     text,                              -- local | remote | merged
  resolved_by    text,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);
create unique index if not exists github_sync_conflicts_open_key
  on github_sync_conflicts (project_id, path) where status = 'open';
create index if not exists github_sync_conflicts_project_idx
  on github_sync_conflicts (project_id, status, created_at desc);

create table if not exists github_sync_backups (
  id            text primary key,
  project_id    text not null references imported_projects(id) on delete cascade,
  path          text not null,
  content       text,
  sha256        text,
  commit_before text,
  commit_after  text,
  reason        text not null default 'pull',
  created_at    timestamptz not null default now()
);
create index if not exists github_sync_backups_project_idx
  on github_sync_backups (project_id, created_at desc);
