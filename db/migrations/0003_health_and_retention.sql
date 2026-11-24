-- ============================================================================
-- 0003_health_and_retention — persisted system health reports
--
-- `/api/health` answers from the live connection. This table keeps the history:
-- database kind, latency, migration state and the reason a probe failed, so an
-- outage that has already recovered can still be explained. Rows are written by
-- `npm run db:maintenance` (and therefore by any external cron calling the same
-- script) and pruned by the same run — the console never writes to it on a page
-- load, which would turn health checking into write amplification.
-- ============================================================================

create table if not exists system_health_reports (
  id            text primary key,
  created_at    timestamptz not null default now(),
  source        text not null default 'cli',      -- cli | api | deploy
  status        text not null,                    -- ok | degraded | failed
  database_kind text,                             -- neon | postgres | pglite
  latency_ms    integer,
  tables        integer,
  migrations    jsonb not null default '{}'::jsonb,
  detail        jsonb not null default '{}'::jsonb,
  error         text
);

create index if not exists system_health_reports_created_idx
  on system_health_reports (created_at desc);

create index if not exists system_health_reports_status_idx
  on system_health_reports (status, created_at desc);

-- Deployment history is already persisted (deployments / deployment_logs). This
-- only records which migration version the running build expected, so a
-- redeploy can be matched to the schema it was built against.
create table if not exists schema_releases (
  id            text primary key,
  created_at    timestamptz not null default now(),
  git_sha       text,
  migrations    jsonb not null default '[]'::jsonb,
  note          text
);

create index if not exists schema_releases_created_idx
  on schema_releases (created_at desc);
