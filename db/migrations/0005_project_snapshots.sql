-- Project-level snapshots: the recoverable copy taken before an import replaces
-- an existing working copy, and before a restore replaces it again.
--
-- Why a table of its own instead of `file_versions`? A version row is per file
-- and unbounded; an import replaces an entire tree at once, and "Backup &
-- Replace" has to be able to put that entire tree back from one verified
-- artefact. The archive lives in object/backup storage (never in Postgres); the
-- row holds its identity and the manifest hash that proves it is intact.

create table if not exists project_snapshots (
  id              text primary key,
  project_id      text not null references imported_projects(id) on delete cascade,
  kind            text not null default 'manual',   -- pre-import | manual | pre-restore | auto-rollback
  label           text,
  storage_key     text not null,
  files_count     integer not null default 0,
  bytes           bigint not null default 0,
  manifest_sha256 text not null,
  verified        boolean not null default false,
  verified_at     timestamptz,
  restored_at     timestamptz,
  created_by      text,
  created_at      timestamptz not null default now()
);
create index if not exists project_snapshots_project_idx
  on project_snapshots (project_id, created_at desc);
create index if not exists project_snapshots_kind_idx
  on project_snapshots (project_id, kind, created_at desc);
