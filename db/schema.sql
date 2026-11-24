-- ============================================================================
-- DARKNOTE CONTROL CENTER — Neon PostgreSQL schema
-- Production files stay on Pterodactyl. This database stores administration,
-- metadata, history, indexes and synchronization state only.
-- Compatible with Neon PostgreSQL and the embedded PGlite dev database.
-- ============================================================================

create table if not exists schema_migrations (
  version      integer primary key,
  applied_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 19. Administration
-- ---------------------------------------------------------------------------
create table if not exists admin_users (
  id              text primary key,
  email           text not null,
  name            text not null,
  password_hash   text not null,
  role            text not null default 'admin',          -- owner | admin | operator | viewer
  permissions     jsonb not null default '[]'::jsonb,     -- extra grants on top of the role
  is_active       boolean not null default true,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists admin_users_email_key on admin_users (lower(email));

create table if not exists sessions (
  id          text primary key,
  user_id     text not null references admin_users(id) on delete cascade,
  token_hash  text not null,
  csrf_token  text not null,
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);
create unique index if not exists sessions_token_hash_key on sessions (token_hash);
create index if not exists sessions_user_idx on sessions (user_id);

create table if not exists login_attempts (
  id         bigserial primary key,
  email      text,
  ip         text,
  success    boolean not null,
  reason     text,
  created_at timestamptz not null default now()
);
create index if not exists login_attempts_created_idx on login_attempts (created_at);

-- ---------------------------------------------------------------------------
-- 2. Connected Pterodactyl servers (credentials encrypted at rest)
-- ---------------------------------------------------------------------------
create table if not exists connected_servers (
  id                    text primary key,
  name                  text not null,
  panel_url             text not null,
  server_identifier     text not null,
  api_key_encrypted     text not null,
  api_key_hint          text not null,
  project_root          text not null default '/',
  allowed_extensions    jsonb not null default '[]'::jsonb,
  excluded_paths        jsonb not null default '[]'::jsonb,
  auto_restart          boolean not null default true,
  atomic_writes         boolean not null default true,
  startup_timeout_s     integer not null default 90,
  max_file_bytes        integer not null default 16777216,
  sync_mode             text not null default 'polling',  -- polling | events
  sync_interval_s       integer not null default 300,
  is_active             boolean not null default true,
  created_by            text references admin_users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  last_connected_at     timestamptz,
  last_scan_at          timestamptz,
  last_sync_at          timestamptz,
  connection_state      text not null default 'unconfigured',
  last_error            text
);
create index if not exists connected_servers_active_idx on connected_servers (is_active);

create table if not exists server_permissions (
  id          text primary key,
  server_id   text not null references connected_servers(id) on delete cascade,
  user_id     text not null references admin_users(id) on delete cascade,
  permissions jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);
create unique index if not exists server_permissions_key on server_permissions (server_id, user_id);

-- ---------------------------------------------------------------------------
-- 3. File index / content cache / versions / backups
-- ---------------------------------------------------------------------------
create table if not exists file_indexes (
  id             text primary key,
  server_id      text not null references connected_servers(id) on delete cascade,
  path           text not null,
  name           text not null,
  parent_path    text not null default '/',
  extension      text,
  is_directory   boolean not null default false,
  is_symlink     boolean not null default false,
  size_bytes     bigint not null default 0,
  remote_modified_at timestamptz,
  sha256         text,
  content_cached boolean not null default false,
  is_secret      boolean not null default false,
  access_error   text,
  first_seen_at  timestamptz not null default now(),
  indexed_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create unique index if not exists file_indexes_path_key on file_indexes (server_id, path);
create index if not exists file_indexes_parent_idx on file_indexes (server_id, parent_path);
create index if not exists file_indexes_ext_idx on file_indexes (server_id, extension);

create table if not exists file_contents (
  server_id  text not null references connected_servers(id) on delete cascade,
  path       text not null,
  sha256     text not null,
  content    text not null,
  bytes      integer not null default 0,
  fetched_at timestamptz not null default now(),
  primary key (server_id, path)
);

create table if not exists file_versions (
  id             text primary key,
  server_id      text not null references connected_servers(id) on delete cascade,
  path           text not null,
  version        integer not null,
  sha256         text not null,
  size_bytes     bigint not null default 0,
  content_ref    text,                       -- backup storage key holding this exact content
  backup_id      text,
  deployment_id  text,
  change_note    text,
  created_by     text,
  remote_modified_at timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists file_versions_path_idx on file_versions (server_id, path, version desc);

create table if not exists file_backups (
  id            text primary key,
  server_id     text not null references connected_servers(id) on delete cascade,
  path          text not null,
  sha256        text not null,
  size_bytes    bigint not null default 0,
  storage_kind  text not null default 'local',
  storage_key   text not null,
  reason        text not null default 'manual',
  deployment_id text,
  created_by    text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz
);
create index if not exists file_backups_path_idx on file_backups (server_id, path, created_at desc);

-- ---------------------------------------------------------------------------
-- 14/15. Deployments
-- ---------------------------------------------------------------------------
create table if not exists deployments (
  id                text primary key,
  server_id         text not null references connected_servers(id) on delete cascade,
  status            text not null default 'pending',   -- pending|running|succeeded|failed|rolled_back|rolled_forward
  trigger           text not null default 'manual',
  file_count        integer not null default 0,
  files             jsonb not null default '[]'::jsonb,
  pre_hashes        jsonb not null default '{}'::jsonb,
  post_hashes       jsonb not null default '{}'::jsonb,
  validation        jsonb not null default '{}'::jsonb,
  restart_requested boolean not null default false,
  restart_performed boolean not null default false,
  health            jsonb not null default '{}'::jsonb,
  error             text,
  notes             text,
  created_by        text,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz
);
create index if not exists deployments_server_idx on deployments (server_id, started_at desc);

create table if not exists deployment_logs (
  id            bigserial primary key,
  deployment_id text not null references deployments(id) on delete cascade,
  level         text not null default 'info',
  step          text,
  message       text not null,
  detail        jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists deployment_logs_dep_idx on deployment_logs (deployment_id, id);

create table if not exists deployment_locks (
  server_id     text primary key references connected_servers(id) on delete cascade,
  deployment_id text not null,
  owner         text not null,
  acquired_at   timestamptz not null default now(),
  expires_at    timestamptz not null
);

-- ---------------------------------------------------------------------------
-- 6/9. Command + case metadata (AST derived)
-- ---------------------------------------------------------------------------
create table if not exists command_metadata (
  id          text primary key,
  server_id   text not null references connected_servers(id) on delete cascade,
  path        text not null,
  kind        text not null,                 -- case | function | variable | import | handler
  name        text not null,
  aliases     jsonb not null default '[]'::jsonb,
  line_start  integer not null default 0,
  line_end    integer not null default 0,
  char_start  integer not null default 0,
  char_end    integer not null default 0,
  signature   text,
  sha256      text,
  updated_at  timestamptz not null default now()
);
create unique index if not exists command_metadata_key on command_metadata (server_id, path, kind, name, char_start);
create index if not exists command_metadata_name_idx on command_metadata (server_id, name);

-- ---------------------------------------------------------------------------
-- 15/16. Bot status, update events, configuration history
-- ---------------------------------------------------------------------------
create table if not exists bot_status (
  id             text primary key,
  server_id      text not null references connected_servers(id) on delete cascade,
  container_state text not null default 'unknown',     -- running|starting|stopping|offline|crashed|unknown
  whatsapp_state text not null default 'unknown',      -- connected|disconnected|qr_pending|logged_out|unknown
  whatsapp_signal text,
  cpu_percent    numeric,
  memory_bytes   bigint,
  memory_limit_bytes bigint,
  disk_bytes     bigint,
  uptime_ms      bigint,
  restart_count  integer not null default 0,
  last_start_at  timestamptz,
  last_error     text,
  checked_at     timestamptz not null default now()
);
create unique index if not exists bot_status_server_key on bot_status (server_id);

create table if not exists update_events (
  id          text primary key,
  server_id   text not null references connected_servers(id) on delete cascade,
  path        text,
  kind        text not null,                 -- added|changed|deleted|remote_changed|conflict
  source      text not null default 'scan',
  detail      jsonb,
  acknowledged boolean not null default false,
  detected_at timestamptz not null default now()
);
create index if not exists update_events_server_idx on update_events (server_id, detected_at desc);

create table if not exists configuration_versions (
  id          text primary key,
  server_id   text not null references connected_servers(id) on delete cascade,
  path        text not null,
  sha256      text not null,
  snapshot    jsonb,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists configuration_versions_server_idx on configuration_versions (server_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4/5. Drafts, sync history, conflicts
-- ---------------------------------------------------------------------------
create table if not exists editor_drafts (
  id          text primary key,
  server_id   text not null references connected_servers(id) on delete cascade,
  path        text not null,
  user_id     text,
  content     text not null,
  base_sha256 text,
  status      text not null default 'draft',   -- uploading | draft | deployed | discarded | conflict
  expected_bytes   bigint,
  expected_sha256  text,
  chunk_count      integer,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists editor_drafts_key on editor_drafts (server_id, path, user_id);

-- Large drafts are uploaded in ordered chunks and joined once when finalised, so
-- a 20 MB file never has to be sent from (or held by) the browser in one request.
create table if not exists editor_draft_chunks (
  draft_id   text not null references editor_drafts(id) on delete cascade,
  idx        integer not null,
  content    text not null,
  bytes      integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (draft_id, idx)
);
create index if not exists editor_draft_chunks_draft_idx on editor_draft_chunks (draft_id, idx);

create table if not exists sync_history (
  id            text primary key,
  server_id     text not null references connected_servers(id) on delete cascade,
  mode          text not null default 'scan',  -- scan | poll | manual | write
  status        text not null default 'running',
  files_scanned integer not null default 0,
  files_indexed integer not null default 0,
  files_added   integer not null default 0,
  files_changed integer not null default 0,
  files_deleted integer not null default 0,
  files_failed  integer not null default 0,
  message       text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists sync_history_server_idx on sync_history (server_id, started_at desc);

create table if not exists sync_conflicts (
  id            text primary key,
  server_id     text not null references connected_servers(id) on delete cascade,
  path          text not null,
  draft_id      text,
  base_sha256   text,
  remote_sha256 text,
  local_content text,
  remote_content text,
  detected_at   timestamptz not null default now(),
  resolution    text,                        -- keep_remote | keep_local | merged | dismissed
  resolved_by   text,
  resolved_at   timestamptz
);
create index if not exists sync_conflicts_server_idx on sync_conflicts (server_id, detected_at desc);

-- ---------------------------------------------------------------------------
-- 19/23. Activity + download history
-- ---------------------------------------------------------------------------
create table if not exists activity_logs (
  id         bigserial primary key,
  user_id    text,
  user_email text,
  server_id  text,
  action     text not null,
  target     text,
  severity   text not null default 'info',   -- info | warning | critical
  ip         text,
  user_agent text,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activity_logs_created_idx on activity_logs (created_at desc);
create index if not exists activity_logs_server_idx on activity_logs (server_id, created_at desc);

create table if not exists download_history (
  id             text primary key,
  server_id      text references connected_servers(id) on delete set null,
  user_id        text,
  kind           text not null,              -- file | files | folder | project | version | backup
  target         text,
  sha256         text,
  size_bytes     bigint not null default 0,
  included_secrets boolean not null default false,
  ip             text,
  created_at     timestamptz not null default now()
);
create index if not exists download_history_created_idx on download_history (created_at desc);

-- ---------------------------------------------------------------------------
-- Settings / remote event cursor (per server key-value)
-- ---------------------------------------------------------------------------
create table if not exists server_settings (
  server_id  text not null references connected_servers(id) on delete cascade,
  key        text not null,
  value      jsonb,
  updated_at timestamptz not null default now(),
  primary key (server_id, key)
);

-- ---------------------------------------------------------------------------
-- 20. Error intelligence
-- ---------------------------------------------------------------------------
create table if not exists error_events (
  id               text primary key,
  server_id        text references connected_servers(id) on delete set null,
  user_id          text,
  fingerprint      text not null,
  source           text not null,            -- api | client | scan | deploy | monitor | assistant | websocket
  component        text not null,            -- route, file or subsystem
  severity         text not null default 'moderate',  -- critical | moderate | minor
  title            text not null,
  code             text not null,
  message          text not null,
  status_code      integer,
  endpoint         text,
  method           text,
  file_path        text,
  line_number      integer,
  function_name    text,
  root_cause       text,
  explanation      text,
  remedy           text,
  context          jsonb not null default '{}'::jsonb,
  occurrence_count integer not null default 1,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      text,
  resolution_note  text
);
create unique index if not exists error_events_active_fingerprint on error_events (fingerprint) where resolved_at is null;
create index if not exists error_events_seen_idx on error_events (last_seen_at desc);
create index if not exists error_events_server_idx on error_events (server_id, last_seen_at desc);

-- ---------------------------------------------------------------------------
-- 21. BIGBROTHER conversations, memory and tutorials
-- ---------------------------------------------------------------------------
create table if not exists ai_conversations (
  id            text primary key,
  user_id       text not null references admin_users(id) on delete cascade,
  title         text not null default 'New conversation',
  context       jsonb not null default '{}'::jsonb,
  message_count integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists ai_conversations_user_idx on ai_conversations (user_id, updated_at desc);

create table if not exists ai_messages (
  id              text primary key,
  conversation_id text not null references ai_conversations(id) on delete cascade,
  role            text not null,            -- user | assistant
  content         text not null,
  blocks          jsonb,
  provider        text,
  created_at      timestamptz not null default now()
);
create index if not exists ai_messages_conversation_idx on ai_messages (conversation_id, created_at asc);

create table if not exists ai_tutorials (
  id          text primary key,
  slug        text not null unique,
  title       text not null,
  summary     text,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists ai_tutorial_steps (
  id              text primary key,
  tutorial_id     text not null references ai_tutorials(id) on delete cascade,
  position        integer not null,
  title           text not null,
  body            text not null,
  image_path      text,
  image_alt       text,
  image_width     integer,
  image_height    integer,
  created_at      timestamptz not null default now()
);
create index if not exists ai_tutorial_steps_order on ai_tutorial_steps (tutorial_id, position asc);

-- 24. ERROR INTELLIGENCE
-- Every captured failure, its diagnosis and its repair state. One row per
-- distinct problem (fingerprint), with an occurrence counter for repeats.
-- server_id is nullable: API/frontend/auth failures can happen before a server
-- is selected and are still worth explaining.
-- ---------------------------------------------------------------------------
create table if not exists error_intel_events (
  id              text primary key,
  server_id       text references connected_servers(id) on delete cascade,
  user_id         text,
  fingerprint     text not null,
  title           text not null,
  code            text not null,
  message         text not null,
  source          text not null,              -- whatsapp|panel|console|api|frontend|auth|websocket|files|editor|explorer|deployment|packages|power|storage|database
  severity        text not null default 'moderate',  -- critical|moderate|minor
  status          text not null default 'active',    -- active|resolved|ignored
  occurrences     integer not null default 1,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  file_path       text,
  line_number     integer,
  column_number   integer,
  function_name   text,
  endpoint        text,
  http_method     text,
  http_status     integer,
  root_cause      text,
  why             text,
  recommendation  text,
  evidence        jsonb not null default '[]'::jsonb,
  context         jsonb not null default '{}'::jsonb,
  repair          jsonb not null default '{}'::jsonb,
  resolved_at     timestamptz,
  resolved_by     text,
  resolution_note text,
  updated_at      timestamptz not null default now()
);
create unique index if not exists error_intel_events_fingerprint_key on error_intel_events (fingerprint);
create index if not exists error_intel_events_status_idx on error_intel_events (status, last_seen_at desc);
create index if not exists error_intel_events_server_idx on error_intel_events (server_id, last_seen_at desc);
create index if not exists error_intel_events_source_idx on error_intel_events (source, last_seen_at desc);
create index if not exists error_intel_events_severity_idx on error_intel_events (severity, last_seen_at desc);

-- ---------------------------------------------------------------------------
-- 25. BIGBROTHER AI — conversations, memory, tutorials and assets
-- Conversations and memory belong to one account. Every read and write is
-- scoped by user_id; there is no cross-account query path in the services.
-- ---------------------------------------------------------------------------
create table if not exists bigbrother_conversations (
  id            text primary key,
  user_id       text not null references admin_users(id) on delete cascade,
  server_id     text references connected_servers(id) on delete set null,
  title         text not null default 'New conversation',
  message_count integer not null default 0,
  last_intent   text,
  archived      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists bigbrother_conversations_user_idx
  on bigbrother_conversations (user_id, updated_at desc);

create table if not exists bigbrother_messages (
  id              text primary key,
  conversation_id text not null references bigbrother_conversations(id) on delete cascade,
  user_id         text not null,
  role            text not null,               -- user|assistant|system
  content         text not null,
  blocks          jsonb not null default '[]'::jsonb,
  citations       jsonb not null default '[]'::jsonb,
  actions         jsonb not null default '[]'::jsonb,
  intent          text,
  engine          text,
  created_at      timestamptz not null default now()
);
create index if not exists bigbrother_messages_conversation_idx
  on bigbrother_messages (conversation_id, created_at asc);

create table if not exists bigbrother_memory (
  user_id    text not null references admin_users(id) on delete cascade,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table if not exists bigbrother_assets (
  id          text primary key,
  user_id     text not null references admin_users(id) on delete cascade,
  kind        text not null default 'image',
  filename    text not null,
  mime        text not null,
  size_bytes  integer not null default 0,
  storage_key text not null,
  width       integer,
  height      integer,
  created_at  timestamptz not null default now()
);
create index if not exists bigbrother_assets_user_idx on bigbrother_assets (user_id, created_at desc);

create table if not exists bigbrother_tutorials (
  id          text primary key,
  user_id     text not null references admin_users(id) on delete cascade,
  title       text not null,
  summary     text,
  keywords    jsonb not null default '[]'::jsonb,
  is_published boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists bigbrother_tutorials_user_idx on bigbrother_tutorials (user_id, updated_at desc);

create table if not exists bigbrother_tutorial_steps (
  id           text primary key,
  tutorial_id  text not null references bigbrother_tutorials(id) on delete cascade,
  idx          integer not null,
  title        text not null,
  body         text not null,
  asset_id     text references bigbrother_assets(id) on delete set null,
  link_href    text,
  created_at   timestamptz not null default now()
);
create unique index if not exists bigbrother_tutorial_steps_key
  on bigbrother_tutorial_steps (tutorial_id, idx);

create table if not exists bigbrother_usage (
  id          bigserial primary key,
  user_id     text,
  kind        text not null,                   -- chat|tool|llm|upload
  engine      text,
  ok          boolean not null default true,
  duration_ms integer not null default 0,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists bigbrother_usage_created_idx on bigbrother_usage (created_at desc);

-- ---------------------------------------------------------------------------
-- 26. GitHub connection, imported projects, import jobs, CRASH AND FIX history
-- and the debounced GitHub synchronization queue.
--
-- Imported project contents live here, not on a serverless filesystem: a Vercel
-- lambda cannot write to the deployment source, so the panel keeps the working
-- copy in PostgreSQL and pushes changes through the GitHub API.
-- ---------------------------------------------------------------------------
create table if not exists github_connection (
  id                        text primary key,
  auth_mode                 text,                        -- token | oauth
  token_encrypted           text,
  token_hint                text,
  token_scopes              jsonb not null default '[]'::jsonb,
  account_login             text,
  account_name              text,
  account_id                text,
  account_avatar            text,
  repo_owner                text,
  repo_name                 text,
  repo_branch               text,
  oauth_client_id           text,
  oauth_client_secret_encrypted text,
  oauth_state               text,
  oauth_state_expires_at    timestamptz,
  auto_sync                 boolean not null default true,
  sync_delay_seconds        integer not null default 5,
  connected_at              timestamptz,
  last_verified_at          timestamptz,
  last_test_at              timestamptz,
  last_test_ok              boolean,
  last_error                text,
  updated_at                timestamptz not null default now(),
  updated_by                text
);

create table if not exists imported_projects (
  id                  text primary key,
  name                text not null,
  description         text,
  source              text not null,                 -- github | upload
  source_label        text,                          -- archive name or owner/repo
  github_owner        text,
  github_repo         text,
  github_branch       text,
  github_default_branch text,
  github_private      boolean not null default false,
  base_commit_sha     text,                          -- remote head the local copy is based on
  last_pushed_sha     text,
  last_commit_sha     text,
  last_commit_url     text,
  last_commit_message text,
  sync_enabled        boolean not null default true,
  sync_status         text not null default 'idle',   -- idle | pending | syncing | synced | failed | conflict | disabled
  sync_error          text,
  last_sync_at        timestamptz,
  status              text not null default 'ready',  -- importing | ready | import_failed | removed
  status_message      text,
  file_count          integer not null default 0,
  text_file_count     integer not null default 0,
  total_bytes         bigint not null default 0,
  created_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists imported_projects_source_idx on imported_projects (source, created_at desc);
create index if not exists imported_projects_repo_idx on imported_projects (github_owner, github_repo);
create unique index if not exists imported_projects_active_repo_key
  on imported_projects (lower(github_owner), lower(github_repo), lower(coalesce(github_branch, '')))
  where github_repo is not null and status <> 'removed';

create table if not exists imported_project_files (
  id            text primary key,
  project_id    text not null references imported_projects(id) on delete cascade,
  path          text not null,
  name          text not null,
  extension     text,
  size_bytes    bigint not null default 0,
  sha256        text,
  content       text,
  is_text       boolean not null default true,
  content_omitted boolean not null default false,
  remote_sha    text,                                -- git blob sha at import/last push
  dirty         boolean not null default false,
  pending_delete boolean not null default false,      -- removed locally, delete on GitHub
  changed_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists imported_project_files_path_key on imported_project_files (project_id, path);
create index if not exists imported_project_files_dirty_idx on imported_project_files (project_id, dirty);
create index if not exists imported_project_files_ext_idx on imported_project_files (project_id, extension);

create table if not exists project_import_jobs (
  id            text primary key,
  project_id    text,
  source        text not null,                       -- github | upload
  status        text not null default 'running',     -- running | succeeded | failed
  phase         text,
  total_files   integer not null default 0,
  fetched_files integer not null default 0,
  total_bytes   bigint not null default 0,
  skipped_files integer not null default 0,
  message       text,
  error         text,
  detail        jsonb not null default '{}'::jsonb,
  created_by    text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists project_import_jobs_started_idx on project_import_jobs (started_at desc);

create table if not exists crash_fix_history (
  id               text primary key,
  project_id       text not null references imported_projects(id) on delete cascade,
  file_id          text,
  file_path        text not null,
  case_name        text not null,
  before_code      text not null,
  after_code       text not null,
  file_sha_before  text,
  file_sha_after   text,
  action           text not null default 'edit',      -- edit | rollback
  status           text not null default 'saved',     -- saved | failed | rolled_back
  error            text,
  user_id          text,
  created_at       timestamptz not null default now()
);
create index if not exists crash_fix_history_project_idx on crash_fix_history (project_id, created_at desc);

create table if not exists github_sync_jobs (
  id            text primary key,
  project_id    text not null references imported_projects(id) on delete cascade,
  status        text not null default 'pending',      -- pending | running | succeeded | failed | conflict
  not_before    timestamptz not null default now(),   -- debounce deadline
  attempts      integer not null default 0,
  files         jsonb not null default '[]'::jsonb,
  trigger       text not null default 'auto',         -- auto | manual | retry
  message       text,                                 -- operator-supplied commit message
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create unique index if not exists github_sync_jobs_one_pending_per_project
  on github_sync_jobs (project_id) where status = 'pending';
create index if not exists github_sync_jobs_due_idx on github_sync_jobs (status, not_before);

create table if not exists github_sync_events (
  id          bigserial primary key,
  project_id  text not null references imported_projects(id) on delete cascade,
  level       text not null default 'info',           -- info | success | error | warn
  phase       text,
  message     text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists github_sync_events_project_idx on github_sync_events (project_id, id desc);

-- ---------------------------------------------------------------------------
-- 27. Platform settings (single key/value store for administrator switches)
--
-- Appearance (Christmas effects / animated introduction), security (passkeys,
-- biometric login) and registration policy live here instead of in new tables,
-- because they are read on nearly every request and are pure configuration.
-- Reads go through src/lib/settings/platform.ts, which caches them in process.
-- ---------------------------------------------------------------------------
create table if not exists platform_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 28. WebAuthn / passkeys (biometric authentication)
--
-- Only public-key material is stored. No fingerprint, face image, or biometric
-- template ever reaches this database: the operating system verifies the user
-- and hands the browser a signature over a server-issued challenge.
-- ---------------------------------------------------------------------------
create table if not exists webauthn_credentials (
  id              text primary key,
  user_id         text not null references admin_users(id) on delete cascade,
  credential_id   text not null,                        -- base64url of the raw id
  public_key      text not null,                        -- base64url COSE_Key bytes
  algorithm       integer not null default -7,          -- -7 ES256 | -257 RS256
  counter         bigint not null default 0,
  transports      jsonb not null default '[]'::jsonb,
  device_label    text,
  attachment      text,                                 -- platform | cross-platform
  aaguid          text,
  backup_eligible boolean not null default false,
  backup_state    boolean not null default false,
  user_verified   boolean not null default true,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  last_ip         text,
  revoked_at      timestamptz,
  revoked_by      text
);
create unique index if not exists webauthn_credentials_credential_key on webauthn_credentials (credential_id);
create index if not exists webauthn_credentials_user_idx on webauthn_credentials (user_id, created_at desc);

-- One row per ceremony. The challenge is single-use, expires in minutes, and is
-- deleted when it is consumed, so a replay cannot succeed twice.
create table if not exists webauthn_challenges (
  id          text primary key,
  challenge   text not null,
  purpose     text not null,                            -- register | authenticate
  user_id     text,
  rp_id       text,
  origin      text,
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index if not exists webauthn_challenges_expiry_idx on webauthn_challenges (expires_at);

-- ---------------------------------------------------------------------------
-- 29. Server ↔ repository bindings
--
-- FILE MANAGER and the CODE EDITOR work on a live Pterodactyl filesystem, not on
-- an imported project. A binding points one server at one imported project, so
-- those two surfaces push and pull through the same connection, the same working
-- copy and the same synchronization engine as CRASH AND FIX — no second GitHub
-- client, no second token, no second copy of the repository.
--
-- `path_prefix` maps the panel root onto a repository folder: files under
-- /plugins are pushed as <path_prefix>/plugins/... .
-- ---------------------------------------------------------------------------
create table if not exists server_github_bindings (
  id          text primary key,
  server_id   text not null references connected_servers(id) on delete cascade,
  project_id  text not null references imported_projects(id) on delete cascade,
  path_prefix text not null default '',
  auto_sync   boolean not null default true,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists server_github_bindings_server_key on server_github_bindings (server_id);
create index if not exists server_github_bindings_project_idx on server_github_bindings (project_id);

-- Deletions travel through the queue as well: a removed file keeps its row with
-- `pending_delete = true` until the commit that removes it from GitHub lands.
create index if not exists imported_project_files_pending_delete_idx
  on imported_project_files (project_id) where pending_delete = true;

-- ---------------------------------------------------------------------------
-- 30. Indexes for the hot read paths
--
-- Session validation runs on every request, the activity log is read newest
-- first, and the backup list is always scoped to one file. Without these the
-- console does sequential scans on tables that only grow.
-- ---------------------------------------------------------------------------
create index if not exists sessions_expiry_idx on sessions (expires_at);
create index if not exists sessions_active_user_idx on sessions (user_id) where revoked_at is null;
create index if not exists activity_logs_user_idx on activity_logs (user_id, created_at desc);
create index if not exists file_backups_server_path_idx on file_backups (server_id, path, created_at desc);
create index if not exists imported_project_files_project_idx on imported_project_files (project_id, path);
