# DARKNOTE CONTROL CENTER

Remote administration for an existing **Darknote WhatsApp bot** running on a **Pterodactyl** panel.

The bot stays where it is. This is a separate web application that talks to your panel through its
official **Client API**, so the files it shows, edits, backs up and deploys are the real production
files.

> Not a static dashboard. Every read, write, hash, backup and restart in this app goes through the
> panel API at request time. Where a capability is missing (no credentials, no permission, no
> console output) the UI says so instead of pretending.

---

## What it does

| Section | Reality |
|---|---|
| **Overview / Live Monitor** | Live container state, CPU/RAM/disk, uptime and restart count from the panel; Start/Stop/Restart over `POST /power`; WhatsApp verdict from the bot process's own status file or its own connection events |
| **Server Discovery** | Recursive walk of the actual filesystem → file index, SHA-256, AST-derived commands |
| **File Manager** | Browse, create, rename, move, copy, delete, upload, ZIP import with path-traversal rejection, ZIP download |
| **Project Explorer** | Deep discovery of plugins, cases, functions, config, dependencies and the real entry point, plus project-wide symbol/code search and safe file management |
| **Code Editor** | Monaco, multi-tab, chunked load/save for multi-megabyte files, server-side drafts, validate → diff → deploy |
| **Case Manager** | Every `switch` case parsed with an AST, edit/duplicate/delete with structural checks |
| **Global Search** | Text, regex (ReDoS-guarded) and AST modes over indexed content, optional live re-verification |
| **Synchronization** | Index reconciliation, hash-based conflict detection, both sides preserved |
| **Deployments** | Backup → validate → atomic write → hash verify → restart → startup observation → rollback |
| **Backups & Versions** | Private content-addressed store + panel backups |
| **Download Center** | Serves freshly-read production bytes with a verified SHA-256 |
| **Terminal & Logs** | One persistent authenticated console websocket per server, relayed over SSE; command sending gated behind confirmation |
| **CRASH AND FIX 👷‍♂️** | Searches the imported projects' real JavaScript for `case 'cmd':` blocks, extracts only that case with an AST walk, edits it in Monaco and writes it back with hash guards, validation, version history and rollback |
| **Projects & Imports** | Every imported project: source (GitHub or file), branch, pending changes, sync state, last commit — browse and edit its files, remove the working copy |
| **GitHub import** | LIVE MONITORING → *Upload a file* → **File Upload** (ZIP or files) or **GitHub Import** (configured repository, or a searchable list of repositories the connected token can see) |
| **Activity Logs** | Every privileged action, read from the append-only `activity_logs` table: server scope, severity, action family, case-insensitive search, paging — all filtered in SQL. The header bell shows the open-problem count from the same tables the Error Center and Deployments pages read |
| **Admin Settings** | Accounts, roles, capability probe, security posture, install status, and the **GitHub connection** (token or OAuth App, specific repository, sync preferences, TEST CONNECTION) |
| **Installable app (PWA)** | Manifest, service worker and install prompts for a standalone window on desktop, Android and iOS, with an offline fallback page |

---

## Honest limits

- **No file-change events.** The Pterodactyl Client API has no webhook, so changes made directly in
  the panel are detected by *scheduled reconciliation*, not instantly. The UI labels the method.
- **A running container is not a connected WhatsApp session.** They are reported separately.
- **Startup health is only claimed when console output was actually observed.** If the panel will
  not give us the websocket, the deployment succeeds but is marked *unverified*, not *healthy*.
- **WhatsApp state has two sources.** If `DARKNOTE_BOT_STATUS_PATH` is configured and the bot writes
  a JSON status file (for example `/data/status.json` with `{"whatsapp":"connected","startedAt":"..."}`),
  that file is authoritative. Otherwise the state comes from this process's own console connection
  events; generic log text cannot change it, and events from a previous process are discarded. If
  neither is available the badge says *unknown* — it is never inferred from the container running.
- **The console buffer lives in process memory.** Run a single instance (`next start`), or the monitor
  and terminal will show different tails per replica.
- **Pterodactyl has no ranged file read.** Opening a large file downloads it once to the control
  center (cached for 90 s) and the browser then receives slices. The file itself is never truncated.
- **`node --check` is a syntax check, not a runtime proof.** A deployment can still fail at runtime;
  that is what rollback and the console are for.

---

## Quick start

```bash
npm install
cp .env.example .env.local        # then fill in the values
npm run db:check                  # connects, applies schema, prints table count
npm run create-admin -- --email you@example.com --name "You" --role owner
npm run dev                       # http://localhost:3000
```

Production:

```bash
npm run build && npm start        # must be a long-running Node process for SSE + scheduler
```

### Required environment

See `.env.example` for the annotated list. The three that matter:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL connection string (`sslmode=require`) |
| `DARKNOTE_SECRET` | 32+ chars. Signs sessions and encrypts stored panel keys. **Changing it makes stored API keys unreadable.** |
| `DARKNOTE_ADMIN_EMAIL` / `DARKNOTE_ADMIN_PASSWORD` | One-time first-run owner bootstrap (or use `create-admin`) |

**Pterodactyl credentials are not environment variables.** Enter the panel URL, server identifier
and Client API key in *Admin Settings*. They are encrypted with `DARKNOTE_SECRET` (AES-256-GCM)
before storage and are never returned to the browser.

### Pterodactyl API key

Create a **Client API key** (Account → API Credentials) for the account that owns the server.
The key needs these subusers permissions on that server:

```
control.console   control.start   control.stop   control.restart
file.read         file.create     file.update    file.delete
file.rename       file.compress   file.decompress
file.upload       file.download
backup.read       backup.create   backup.download
websocket.connect
```

`getServer()` / `getPermissions()` are used by the capability probe; if your panel does not expose
`/permissions`, the probe reports restart permission as *unknown* rather than guessing.

Enter the **short server identifier** from the panel URL
(`https://panel.example.com/server/<identifier>`), not the server name.

---

## Verification status

Run:

```bash
npm run typecheck     # clean
npm test              # 186 tests, 175 pass, 0 fail, 11 skipped (need a real PostgreSQL)
npm run build         # compiles
npm run verify:github # live GitHub: token store, repo list, real import (needs DARKNOTE_GITHUB_TOKEN)
```

`tests/monitor-editor.test.ts` drives the real services against a protocol-accurate panel double
that **enforces HTTP verbs** (a wrong verb gets 405, exactly like Next.js and Pterodactyl) and serves
a real Pterodactyl-style websocket:

1. resources come from the panel, not from defaults (null, never 0, when absent)
2. Start/Stop/Restart go out as `POST /api/client/servers/{id}/power` with `{"signal":"..."}` and
   actually change the container state
3. the console websocket authenticates, streams output, survives a reconnect, and the monitor shows
   the same tail
4. WhatsApp state follows this process's events, flips to disconnected on a drop, and resets when a
   new process starts
5. a 3 MB JavaScript file opens completely, reassembles byte-for-byte from chunks, saves with a
   backup, and the pre-write version restores exactly
6. the per-server editor limit is 16 MB by default and clamped by `DARKNOTE_MAX_EDITOR_BYTES`

`tests/routes.test.ts` parses every route file and every client call site and fails when a component
uses a verb the route does not export — the exact defect behind “Request failed (405)”.

`tests/pipeline.test.ts` drives the real services against a Pterodactyl-shaped panel
(`tests/mock-pterodactyl.mjs`) and asserts:

1. connection + registration against the panel API
2. discovery indexes real files, discovers `menu` / `ping` / `play`, never indexes the session folder
3. reading `.env` / `auth/creds.json` is refused
4. a stale `expectedHash` blocks the write and leaves production byte-identical
5. an approved write is backed up, hash-verified on read-back, and versioned
6. deployment triggers a real restart and does not claim healthy without evidence
7. rollback restores only the files that deployment changed
8. downloads serve SHA-256-verified production bytes
9. an edit made directly in the panel is detected on the next scan
10. the monitor never invents a WhatsApp state

**What this does not prove:** your panel's real permissions, quirks, rate limits or startup
behaviour. Use *Admin Settings → Connection checks (deep)* against your server — it performs the
real operations, including a scratch write that is read back and deleted.

---

## Code editor runtime

The editor has to show the production bytes, so three things are deliberate:

| Concern | Implementation |
|---|---|
| Component binding | `@monaco-editor/react` is imported as `mod.Editor`, not as the module namespace. A dynamic import of the namespace object is not a React component and renders no surface at all while the rest of the page works. |
| Monaco hosting | Served from this origin at `/monaco/vs`. `scripts/copy-monaco.mjs` copies `node_modules/monaco-editor/min/vs` into `public/monaco` on `postinstall`, `predev` and `prebuild` (git-ignored, ~14 MB). `src/lib/editor/monaco.ts` probes that path first and only falls back to the jsDelivr CDN if the local copy is missing; if neither answers it switches to the plain-text surface instead of showing an empty box. |
| Editor height | Measured with a `ResizeObserver` and passed to Monaco as an explicit pixel height. Percentage heights inside an auto-height panel collapse to `0 px`, which renders a working editor with no visible area. |
| Content proof | `GET /api/files/content?mode=full` returns the body plus `sha256`/`totalChars`; the page refuses to open a tab whose buffer length differs from `totalChars` or is empty while production reports bytes. The header prints the live character count so the buffer is visible as a number, not just as pixels. |

Safety before any write: an empty (or whitespace-only) buffer cannot be saved or
deployed over a file that has bytes on production, the panel response is checked
for a 200-with-empty-body, non-UTF-8 files are refused rather than decoded lossily,
and a deploy still re-reads production and compares SHA-256 before the restart.

## Project Explorer

`/explorer` answers "where is this in the bot?" without making you know the path.
It is built entirely from the indexed project — the same rows the File Manager and
Global Search use — plus a real parse of the source:

| Category | How it is discovered |
|---|---|
| **Plugins** | Any file inside a `plugins`/`modules`/`extensions`/`commands`-style directory (whole segment match), grouped by its own directory; single-file plugins (`/plugins/menu.js`) are detected too. Each group shows its files, command count, function count, the packages it imports and which files load it. |
| **package.json** | The shallowest manifest in the project. Declared ranges, scripts, which packages the code actually imports, which declared packages are missing from `node_modules`, and which imports are undeclared. Outdated versions are **not** guessed: there is no registry lookup, so the UI says so. |
| **Entry point** | The file in the panel's `current_startup_command`, verified against the index; then `package.json` `main`, then the `scripts.start` command, then conventional names that actually exist, then highest import in-degree. Every candidate is listed with its score and evidence, and a startup file that does not exist is called out. |
| **Cases / commands** | AST walk of every parsed JS/TS file (`command_metadata`), grouped by file with exact lines and aliases. Files that look like handlers but produced no cases are listed as *unparsed* instead of being hidden. |
| **Functions / helpers** | Function declarations, arrow constants, class methods and exports per file with line numbers. |
| **Configuration** | Config/settings filenames, `.env` templates and config folders. Only file names and **key names** are shown — `.env` and other credential files are listed as protected and never read. |
| **Database / models / storage** | `.sql`, `.prisma`, model/connection code, plus `database/`, `data/`, `storage/` contents. Database files and JSON/CSV records are marked protected: downloadable, never editable or deletable from the explorer. |

Global search merges three sources: symbol matches (case/function names), file and
folder names, and line-level code matches, each linking straight into the editor at
the right line.

**Rescan** (`POST /api/explorer/scan`) walks the panel again, re-reads changed
content, re-parses symbols and reports added / changed / deleted paths. A delete
and an add with the same SHA-256 are reported as a rename. A scan never edits a
project file.

File relationships come from a real import graph: relative `require`/`import`
specifiers are resolved through `.js/.cjs/.mjs/.json/index.*` candidates, so a file
shows what it imports, what imports it, and which references are broken.

## GitHub import and synchronization

Repositories are imported **through the GitHub API** — nothing is downloaded by hand and nothing is
written to the deployment filesystem, so this works on Vercel/Neon as well as on a long-running
server. The working copy lives in PostgreSQL (`imported_projects`, `imported_project_files`).

- **Connection.** A personal access token (`repo` + `read:user`) is verified against `GET /user`
  *before* it is stored, encrypted with AES-256-GCM under `DARKNOTE_SECRET`. An OAuth App
  authorization-code flow is also supported: paste the client id/secret, press *Authorize with
  GitHub*, and the callback exchanges the code server-side. A GitHub **email address is never used as
  authentication** — only a token GitHub resolves to an account grants access. No route returns the
  token, and only the last four characters are shown as a hint.
- **Import.** `GET /user/repos` is scoped by the token, so the list can only contain repositories that
  account may access. A recursive tree read plus one blob per file stores the text (≤ 2 MB per file)
  and the git blob sha of every file; dependencies, build output, `.env`-style credential paths and
  binaries are recorded as metadata only and never rewritten.
- **Editing.** CRASH AND FIX replaces exactly one AST range, re-parses the whole file and writes with
  a conditional `UPDATE … WHERE sha256 = <what you loaded>`. A concurrent edit loses cleanly.
- **Synchronization.** A save marks the file dirty and schedules one job per project at *now + 5 s*;
  every further save moves that deadline, so a burst of edits becomes one commit. When it fires the
  worker compares the branch head and every touched blob sha with what was imported, creates
  blobs → tree → commit through the Git Data API, updates the ref **without force**, then reads the ref
  back before reporting `GITHUB SYNCHRONIZED SUCCESSFULLY`. A moved branch or a changed file is a
  **conflict**: the remote is never overwritten, the local edit is kept, and you can rebase onto the
  remote head or discard the local change.
- **Branches.** The default branch is detected and remembered at import, another branch can be chosen
  in the import dialog, and pushes always target that same branch. Nothing is pushed to a branch the
  project was not imported from.
- **Queue.** The debounce is a real row (`github_sync_jobs`), drained by an in-process timer on Node
  deployments and by `POST /api/github/sync/tick` (called by the pending-project views) where timers
  are not reliable.

---

## Large files

The old build refused anything above 2 MB. That limit came from a 512 KB database default multiplied
by four in the read layer; it is gone.

| Setting | Meaning |
|---|---|
| `DARKNOTE_MAX_EDITOR_BYTES` | Process-wide ceiling for one text file (default 64 MB) |
| `DARKNOTE_EDITOR_CHUNK_BYTES` | Slice size for chunked reads/writes (default 512 KB, 64 KB–8 MB) |
| `DARKNOTE_MAX_DOWNLOAD_BYTES` | Ceiling for downloads, backups and uploads (default 96 MB) |
| Settings → *Editor file limit (MB)* | Per-server limit, default 16 MB, clamped by the ceiling |
| `DARKNOTE_MAX_SQL_CACHE_BYTES` | Files above this (default 1 MB) are not mirrored into SQL |

How a large edit flows:

1. `GET /api/files/content?mode=meta` — size, SHA-256 and limit, no body.
2. `GET …&mode=chunk&offset=&length=` — ordered slices (UTF-16 units), progress bar in the UI.
3. `POST /api/drafts/chunk` (create) → `PUT` each slice → `POST` (finalize). Finalize reassembles
   once, checks every index is present, compares the byte count and verifies the browser's SHA-256.
4. `POST /api/deployments` with `{ draftId }` — the browser never re-uploads the file. Deploy backs
   up the current production file, writes atomically, re-reads and verifies SHA-256, restarts and
   watches startup output.
5. Older content stays restorable from Backups & Versions.

If a file genuinely exceeds the limit, the API answers **413** with the actual size, the configured
limit and the ceiling — it does not silently truncate.

---

## Install as an app (PWA)

The console is installable. There is no build plugin and no extra dependency: the manifest, the
worker and the icon set are plain files, and the install UI is one client component.

| Piece | File | Notes |
|---|---|---|
| Manifest | `public/manifest.webmanifest` | `standalone`, scope `/`, theme `#05060a`, three shortcuts (Monitor, Console, Files) |
| Service worker | `public/sw.js` | Served from the root, so its scope covers the whole app |
| Icons | `public/icons/*`, `src/app/icon.png`, `src/app/apple-icon.png` | Generated by `npm run icons` (SDF renderer, no image libraries) |
| Install UI | `src/components/pwa.tsx` | `beforeinstallprompt`, iOS instructions sheet, update toast, offline strip |
| Offline fallback | `src/app/offline/page.tsx` | Static, outside the authenticated group, precached at install |

**What the worker is allowed to cache.** The console is an authenticated admin surface, so the policy
is deliberately narrow:

- `/_next/static/*`, `/icons/*` and the manifest: stale-while-revalidate, so the shell boots on a poor
  connection.
- HTML navigations: **network-first and never written to a cache.** A signed-in page can't be replayed
  from disk to the next person using the device.
- `/api/*`: never intercepted at all — requests keep their cookies, credentials and cache headers.
- When a navigation fails, `/offline` is served instead (its hashed chunks are precached too).

**Updating a deployment.** `sw.js` is served with `must-revalidate` and the new worker does not skip
waiting on its own. When a deploy lands, the open tab shows a "new version is ready" toast; approving it
sends `SKIP_WAITING` and reloads once. Bump `CACHE_VERSION` in `public/sw.js` whenever the cached surface
changes.

**Honest limits.** Install prompts are browser-initiated: Chrome and Edge fire `beforeinstallprompt`
(HTTPS or localhost only), Safari on iOS never does and gets the manual *Share → Add to Home Screen*
instructions instead, and Firefox desktop has no install entry at all. Nothing here caches remote server
content — offline you get the shell and the offline page, not a stale dashboard.

---

## Database (Neon PostgreSQL)

Neon is the only persistent store. Every account, session, imported project, file record, conversation,
deployment, error and audit row lives there; nothing important is kept in process memory or in the
browser. (The embedded PGlite database still exists, but only for local evaluation and the test suite —
`/api/health` reports which driver is live.)

### Connection

```bash
# Neon dashboard → Connection details → "Pooled connection" (PgBouncer, transaction mode)
DATABASE_URL=postgresql://user:password@ep-xxxx-pooler.eu-central-1.aws.neon.tech/darknote?sslmode=require
DATABASE_SSL=require          # require | no-verify | disable
DARKNOTE_DB_DRIVER=auto       # auto | postgres | neon | pglite
DARKNOTE_DB_POOL=1            # optional; 1 on serverless, 8 for a long-running `next start`
```

- `postgres` (default) is node-postgres over TCP/TLS — it works against the pooled endpoint, a
  self-hosted server and CI.
- `neon` uses `@neondatabase/serverless` over a WebSocket (no TCP socket). `auto` selects it only for a
  `*.neon.tech` host on a serverless platform.
- On Vercel the pool is capped at **one** connection per instance with `allowExitOnIdle`, because the
  pooled endpoint multiplexes many clients onto few server connections — a large local pool only burns
  the project's connection limit.
- A dropped idle connection is logged, never fatal, and a single transient failure
  (`ECONNRESET`, `57P01`, `Connection terminated`, …) is retried once with backoff.
- Credentials are read from `DATABASE_URL` on the server only. No route returns them, `dbHealth()`
  reports `host/database` and never the password, and the health endpoint never echoes the URL.

### Migrations

| Command | What it does |
|---|---|
| `npm run db:status` | Prints applied / pending / drifted migrations. Changes nothing. |
| `npm run db:migrate` | Takes a logical backup (when the database has rows), then applies everything pending. |
| `npm run db:migrate -- --dry-run` | Lists what would be applied. |
| `npm run db:maintenance` | Health report → retention prune → row counts. |
| `npm run db:backup` | Full logical backup to `.data/backups/database/<stamp>-<label>/`. |
| `npm run db:restore -- <dir> [--replace]` | Restores a backup. Refuses a populated database unless `--replace`. |

- `db/schema.sql` is the baseline (`0001_baseline`); every later change is a file in `db/migrations/`
  applied in filename order and recorded in `db_migrations` with a SHA-256 checksum.
- Migrations run under a **transaction-scoped** PostgreSQL advisory lock
  (`pg_try_advisory_xact_lock`) taken on the same connection and inside the same transaction that
  applies the DDL, so ten instances cold-starting at once cannot race *and* the gate cannot be
  leaked: the server releases it at commit, at rollback, or when the backend dies.
- The pending set is recomputed **inside** the gate, so an instance that waited finds the registry
  already current and applies nothing.
- **A request never migrates.** `DARKNOTE_DB_MIGRATE=auto` (default) applies pending files on boot
  only where one long-running process owns the schema (local, a container, `next start`) and is
  verify-only on a serverless platform in production. `verify` never applies; `never` refuses to
  start while something is pending; `always` applies on boot for exactly one long-running instance.
- Booting is cheap: the check is two read-only statements, and when nothing is pending no lock is
  taken at all. A failed initialisation is remembered for `DARKNOTE_DB_RETRY_MS` (3 s) so a burst of
  requests does not turn one bad boot into a stampede.
- A database created by an older build (rows in `schema_migrations`, no `db_migrations`) is *adopted*:
  the baseline is recorded without re-running it, and later migrations are applied on top.
- Editing a released numbered migration is refused (checksum drift). The baseline is the exception —
  it is `create … if not exists` end to end, so a cosmetic edit is re-applied once instead of blocking
  a deploy.

#### Where `db/schema.sql` is found

The baseline is read with `fs` at the first database call, so `src/lib/db/migrate.ts` resolves the
project root instead of trusting the working directory:

1. `DARKNOTE_DB_DIR` — the project root, or `db/` itself. The documented escape hatch for an unusual
   host layout.
2. `process.cwd()` and its ancestors (up to 8) — `npm run dev`, `npm start`.
3. The entry script and the bundled module directory, and their ancestors — a process started by
   systemd, pm2 or Pterodactyl, and a `.next` bundle whose cwd is elsewhere.

A candidate is accepted only when `<root>/db/schema.sql` exists **and** contains a `create table`
statement, so an unrelated `db/` higher in the tree cannot be picked up. When nothing matches, the
error lists every path that was tried and names `DARKNOTE_DB_DIR`; it never reports a bare
"not found" for a file that is committed.

`db/` is not imported by any module, so the bundler cannot see it on its own.
`outputFileTracingIncludes` in `next.config.ts` traces `db/schema.sql` and `db/migrations/*.sql` into
every route, which is what carries the folder into a Vercel function or a standalone build. The
`{"functions": {"api/*.js": {"includeFiles": "db/**"}}}` form of `vercel.json` only applies to the
Pages Router `api/` directory; this app has no such files, so that setting would do nothing here.

### Vercel

1. `DATABASE_URL` (pooled) + `DARKNOTE_SECRET` in *Project → Settings → Environment Variables*
   (Production **and** Preview).
2. Run `npm run db:migrate` once — as a step in the build command, or from your machine against the
   production URL. Leave `DARKNOTE_DB_MIGRATE` unset (`auto`): on Vercel it verifies the registry and
   never migrates from a request, so several instances cold-starting at once cannot start a schema
   change. Use `verify` if you want that behaviour stated explicitly.
3. Verify with `GET /api/health`: it returns `200` only when the database answers, the backup store is
   writable and no migration is pending; otherwise `503` with the reason (`databaseError`).
4. Uploads and backups live on the local filesystem, which is **ephemeral on Vercel**. Point
   `DARKNOTE_DATA_DIR` at a persistent volume, or treat the backup store as a cache — the database is
   the durable record.
5. Set `CRON_SECRET` and keep `vercel.json`. A serverless function is frozen between requests, so the
   in-process timers that drain the GitHub push queue and poll synchronized branches never fire
   there. `/api/cron/tick` does that work on a schedule (every 5 minutes in `vercel.json`); it
   requires `Authorization: Bearer $CRON_SECRET`, which Vercel Cron sends automatically, and answers
   `503` when the variable is missing rather than running unprotected. Note that **Vercel Hobby
   restricts crons to once a day** — on Hobby, either accept a daily sweep or drive the endpoint from
   an external scheduler that sends the same header.
6. Long-running work (imports, inspections) is written as resumable batches rather than a single
   request, so a serverless timeout parks the job instead of losing it: `POST /api/projects/import/batch`
   continues a job where the previous batch stopped, and `/api/projects/import/status` reports the
   cursor.

### Backup, retention and recovery

- Backups are NDJSON, one gzip file per table plus `manifest.json` (row count + SHA-256 per table),
  streamed in pages of 500 rows so a large table is never materialised in memory at once.
- Retention is explicit and opt-in: failed logins 30 days, resolved error events 120 days, download
  history 90 days, GitHub sync events 60 days, health reports 30 days; audit logs are kept forever
  unless `DARKNOTE_RETAIN_AUDIT_DAYS` is set. Every run prints the rows it actually deleted.
- Recovery: `npm run db:restore -- .data/backups/database/<dir> --replace`, then `npm run db:status`.

### What the database stores (and what it does not)

Structured records only: accounts, roles, sessions, passkeys metadata, preferences, servers and their
encrypted panel keys, indexes and hashes, drafts and versions, imported projects and their **file
metadata + text content**, deployments, errors, audit logs, conversations and AI settings, GitHub
connection metadata and repository configuration, health reports. Large binaries and the bot's real
production files stay on Pterodactyl; project files are stored per owner with a `(project_id, path)`
key, and a route always filters by the authenticated user (see `assertServerAccess` and the project
repository) — one account can never read another account's project, conversation or credential.

---

## Android stability ("Aw, Snap")

`Aw, Snap!` is Chromium killing the renderer, almost always for memory or GPU pressure. There is no
exception to log, so the fix has two halves: stop the app spending memory it does not need, and make the
next death measurable.

It is **not** what a server-side error looks like. A 500 from `/` (a missing `db/schema.sql`, a failed
migration) renders the Next.js error page — "Application error: a server-side exception has occurred" —
inside a working browser tab. Chrome only shows `Aw, Snap!` when its renderer process died, so the two
symptoms have different causes and the database path fix above does not, by itself, explain a renderer
crash. If the panel still shows `Aw, Snap!`, the Error Center now holds the heap and page from the
session that died.

### What the client does now

| Area | Change |
|---|---|
| Response cache | Bounded by **retained bytes** (3 MB) as well as entries, oldest dropped first. A `/api/monitor` payload carries the console tail, so counting entries alone pinned megabytes for the tab's lifetime. |
| Polling | Every `useApi(refreshMs)` timer stops on `visibilitychange → hidden`, on `offline`, and restarts with one fresh read when the tab returns. |
| Console | Lines are buffered and flushed 4×/s instead of a React state update per line; the tail is capped at 600 rows; the SSE stream is closed while the tab is hidden. |
| Monitor payload | 120 console lines by default (`?lines=` up to 400), measured server-side; the terminal asks for the long tail, every other page does not. |
| Long lists | `content-visibility: auto` on console lines, file rows, error cards and monitor output: off-screen rows are not laid out or painted. |
| Backdrop blur | Disabled below 1024 px, under `prefers-reduced-transparency`, and in the app's own reduced mode. A fixed sidebar with `backdrop-filter: blur()` re-blurs the page on every scroll frame — the most expensive thing on a phone screen. |
| BIGBROTHER ambient | The two 18 px-blurred word layers and the `mix-blend-mode` grain are dropped below 768 px; the remaining cycle slows to 34 s. |
| Animations | Paused with `animation-play-state` while the document is hidden (the sentinel sets `data-doc-hidden`), and removed entirely for `prefers-reduced-motion` and the in-app reduced mode. Snow already stops when hidden, respects reduced motion, and caps particles by viewport area. |
| Error containment | Route-level `error.tsx` + a per-page `ErrorBoundary` inside the shell + `global-error.tsx`: a failing panel keeps the navigation, shows the real message, and offers a retry that remounts only that subtree. |

### Crash diagnostics

`src/lib/perf/sentinel.ts` writes a small heartbeat to `localStorage` (one write per 20 s, only while
visible) with the page, JavaScript heap, renderer limit, long-task count and session age. If the next
launch finds a heartbeat that was never closed, the renderer was killed without unloading — and that
record is reported to **Error Center** as `browser_terminated_session` with the last measured numbers.
Two pressure signals are reported the same way while the app is still alive:

- `memory_pressure` — heap crossed 70 % of the renderer limit (the response cache is dropped at once);
- `long_task_pressure` — 50+ main-thread blocks over 50 ms in one session.

So the next report is not "it crashed again" but, for example, "died on `/console` after 11 minutes with
a 412 MB heap and 63 long tasks". The sentinel never blocks rendering, never runs while hidden, and
swallows its own failures.

It is mounted exactly once, in the root layout, and a heartbeat younger than 60 s is treated as a page
that is still alive (a second tab, a fast reload) rather than a crash. Both rules matter: a second
mount used to overwrite the first one's record, so every navigation could file a false
`browser_terminated_session` and poison the evidence it was built to collect.

**Not verified here:** a physical Android device, an installed PWA on Android, and Android WebView. The
changes above are reasoned from the code and measured on the server side (payload sizes, row counts,
bundle sizes); the device-side claims rest on the diagnostics the sentinel now records in Error Center.

---

## Architecture

```
src/app/(app)/*            13 server-rendered pages
src/app/api/*              28 route handlers (all mutating routes: permission + CSRF + origin check)
src/lib/pterodactyl/       Client API client (retries, typed errors, signed upload/download)
src/lib/files/             remote file operations, guarded writes, backups, validation
src/lib/services/          discovery, deploy, console, cases, replace, downloads
src/lib/sync.ts            reconciliation state, conflicts, resolution
src/lib/security/paths.ts  path confinement, secret blocking, exclusion rules
src/lib/projects/          imported-project storage, safe ZIP/GitHub import, import jobs
src/lib/crashfix/          case search + guarded case save, history and rollback
src/lib/github/            REST client, encrypted credentials, OAuth, repo discovery, sync queue
db/schema.sql              31 tables (Neon + embedded PGlite for local evaluation)
```

- **Pterodactyl is the source of truth.** Neon stores administration, indexes, hashes, versions,
  deployments, drafts, conflicts and audit history — never a shadow copy of production.
- **Every remote path** is resolved through `confineToRoot` and checked against the exclusion list and
  the secret patterns before any API call.
- **Drafts never touch production** until a deployment writes and verifies them.
- **Backups** live in a private store outside `public/`, written `0600`, and are read back only
  through authenticated routes.

---

## Security notes

- bcrypt (cost 12) password hashing; server-side sessions with revocation; CSRF double-submit on
  every mutating request; per-IP/per-email login throttling.
- Roles: `owner` → `admin` → `operator` → `viewer`, with per-server grants.
- WhatsApp session folders, `.env` files, private keys and `creds.json` are blocked from reading,
  editing, versioning and export — including from the Download Center. The same rules apply to
  imported projects: credential-shaped paths are never stored, listed or pushed.
- GitHub credentials follow the same envelope as panel keys: verified before storage, AES-256-GCM at
  rest, never logged, never returned, replaceable and disconnectable from Admin Settings.
- Credentials shared in chat should be rotated after use: **the GitHub token and the Neon password
  in this project's history should both be considered exposed.**
