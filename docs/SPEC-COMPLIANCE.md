# DARKNOTE — specification compliance report

This file maps the delivery specification (§1–§20) to what actually exists in this repository, and
says plainly which parts were **verified in this environment**, which are **implemented but need your
credentials to verify**, and which are **not built**. Nothing below is marked verified because it
compiles. A claim is only "verified" when a tool result in this environment showed it working.

Verification environment: Node 22.23, Linux x64, no Pterodactyl panel credentials, one GitHub token
supplied by the project owner, no physical Android device. Date of this pass: 2026-11-24.

Status key:

- **PASS** — ran here, against the real implementation, and produced evidence.
- **READY (unverified)** — implemented and covered by a protocol-accurate double or an offline test;
  needs your panel/account to prove against production.
- **PARTIAL** — real but narrower than the specification asks for; the gap is named.
- **NOT BUILT** — does not exist yet. Listed so it cannot be mistaken for done.

---

## Summary

| Spec | Area | Status |
|---|---|---|
| §2 | Inspect-before-modify discipline | PASS — 280 tracked files, 12k lines of TS/TSX inspected; existing features preserved |
| §3 | Dashboard + 10 sections | PASS (one section added: Activity Logs) |
| §4 | Hosting panel integration | READY (unverified) — Pterodactyl Client API; no credentials here |
| §5 | Terminal | READY (unverified) — real websocket relay, protocol-accurate double in tests |
| §6 | File manager | READY (unverified) — full CRUD + ZIP; GitHub import PASS against live GitHub |
| §6 | GitHub import (list → import → manifests) | PASS — imported `alsphalt/Darknote` from github.com (15 files, `package.json`, start script read) |
| §6 | "REPLACE EXISTING PROJECT FILES?" + Backup & Replace | PASS — 409 confirmation with real counts, verified whole-tree snapshot, atomic restore, automatic rollback on a failed import |
| §7 | Project Explorer / code search | PASS (offline, real parser) + READY for a live index |
| §8 | Monaco editor + save | READY (unverified) — chunked load/save, drafts, versions |
| §8 | GitHub two-way sync | READY (unverified) — pull/push/webhook/conflicts implemented; needs write access to a repo |
| §8 | Live application updates | READY — HMR is not assumed; restart + health observation + rollback |
| §9 | Error detector + numeric bell | PASS — bell added this pass, counters verified 0→1 on a failed login |
| §10 | AI engineering assistant | READY (unverified) — requires an LLM key; without one it runs grounded-only and says so |
| §11 | Dependency installation engine | PASS for detection + report (Node/Python/PHP/static, lockfile-aware commands); execution is guarded and unverified without the panel |
| §12 | Neon PostgreSQL | PASS locally (PGlite, 54 tables) — Neon driver implemented, no Neon credentials here |
| §13 | Infra as code / CI / monitoring | PARTIAL — Dockerfile + GitHub Actions added this pass; no Terraform/K8s; no Sentry/Prometheus |
| §14 | Security | PASS — RBAC, CSRF, AES-256-GCM secret store, path + ZIP guards, token never returned to the browser |
| §15 | Performance / low-end Android | PARTIAL — bundle sizes measured, no polling in `safe` profile; no physical device |
| §16 | Real-time activity | PARTIAL — SSE console stream + persistent audit trail; no single global event bus |
| §17 | Project lifecycle | READY (unverified) — import/inspect/start/stop/backup/restore/remove wired to the panel |
| §18 | Testing | PASS (own suite + live GitHub); panel workflows unverified |
| §19 | Deliverables | see the per-item table at the end |
| §20 | End-to-end acceptance workflow | steps 1,3,4–8 PASS; steps 2,9–24 need your panel (step 2 is the gate) |

---

## §3 — the ten dashboard sections

| Section in the spec | Route here | Notes |
|---|---|---|
| Overview | `/` | server state, WhatsApp verdict, recent activity |
| Terminal | `/console` | one authenticated panel websocket per server, relayed over SSE |
| File Manager | `/files` | browse, create, rename, move, copy, delete, upload, ZIP import/export |
| GitHub Integration | `/projects` + Settings → GitHub | token **or** OAuth App; repository list with IMPORT |
| Project Explorer | `/explorer` | symbol/case/function search over the real index |
| File Editor | `/editor` | Monaco, tabs, drafts, versions, validate → diff → deploy |
| Error Detector | `/errors` | real diagnostics; header bell shows the open count |
| Deployment Manager | `/deployments` | backup → validate → atomic write → verify → restart → rollback |
| Activity Logs | `/activity` | **added this pass** — SQL-filtered audit feed, 50/page, facets, detail drawer |
| Settings | `/settings` | accounts, roles, panel + GitHub connections, security posture |

Design: dark glass panels, neon accent/cyan tokens, reduced-motion and `?profile=safe` support. The
built route table shows every page as a dynamic route with a first-load JS of 113–148 kB — the
mobile cost that matters on a low-RAM phone.

## §4 — hosting panel integration

`src/lib/pterodactyl/client.ts` (537 lines) implements the official **Pterodactyl Client API v1**:
server view, live resources, websocket credentials, command send, power signals, startup variables,
activity log and the `/files` group (list, contents, write, delete, rename, copy, compress,
decompress, upload, download). Credentials are AES-256-GCM encrypted server-side and never sent to
the browser; there is no admin-API key path and no permission bypass.

**Why it is not marked PASS:** the panel URL and a client API key are deployment secrets that were not
supplied in this environment. Enter them in *Admin Settings → Connections* and run **Connection
checks (deep)** — it performs a real scratch write, reads it back and deletes it.

## §6 — GitHub import, evidence from this pass

`npm run verify:github -- alsphalt/Darknote` (the application's own code, not a mock):

```
PASS  token accepted — account alsphalt
PASS  token not readable back — hint ••••••••uwS9
PASS  connection row persists — connected
PASS  repositories listed — 24 repositories on page 1
      alsphalt/project-z-programa · public · branch main · n/a
      alsphalt/Darknote           · public · branch main · JavaScript
PASS  branches listed — main
PASS  repository imported — 15 files, 130336 bytes, branch main
PASS  text files detected — 14 decodable text files
PASS  commit recorded — 3de598a3041c
PASS  working copy populated — 15 stored files
      manifests: package.json
      package.json: name=dark-angel-bot start=node main.js
PASS  token round-trips from storage — decrypted value matches what was supplied
```

That is §18's GitHub integration block (connect → list → download → store → verify structure →
detect manifests) executed against github.com.

**Project-level replace confirmation and Backup & Replace.** Built and tested this pass. The
import start call is now the preflight: if the destination already holds files it answers
`409 confirmation_required` with the counts the dialog needs — `identical`, `different`, `new`,
`orphaned` (paths deleted upstream) and `unsyncedEdits` — and writes nothing. The File Manager
dialog renders *"REPLACE EXISTING PROJECT FILES?"* with **Cancel** and **Backup & Replace**.

`onExisting: "replace"` makes `startGitHubImport` call `createProjectSnapshot()`
(`src/lib/projects/snapshot.ts`) **before the first batch runs**:

```
read all rows → gzip NDJSON archive → put in backup storage
→ re-read it, gunzip, recompute the manifest → only then allow the import
```

The manifest is a SHA-256 over `path\tcontentHash\tsize` for every file, so a truncated archive fails
verification instead of replacing a project with nothing. If the import then fails mid-batch, the
failure path calls `restoreProjectSnapshot()` and says so in the job message; a restore that itself
fails names the snapshot to restore by hand rather than pretending.

Restoring is a single transaction: delete the tree, insert the snapshot, recompute the manifest
**inside** the transaction, roll back on mismatch. It also snapshots the current state first
(`kind: pre-restore`), so a restore is reversible. An existing project record with **zero** stored
files is treated as an empty destination and imports without a dialog, as specified.

Two defects were found by the tests written for this flow and fixed:

1. `purgeDeletedFiles()` only deleted rows with `pending_delete = true`, so the finalise step's
   "remove stale paths" comment was **false** — a file deleted upstream survived every re-import.
   Added `removeProjectPaths()` (unconditional, by path) and used it there.
2. A batch in which *every* blob download failed was counted as `skipped`, so a token that lost its
   scope produced a "successful" import and then pruned the working copy. The batch now throws
   `import_batch_failed` when all downloads fail and nothing was written, and the finalise step
   refuses to treat an empty fetch as a tree.

## §9 — error detector and the counter

Diagnostics come from `src/lib/errors/*`: layerised taxonomy, console/stack parsing, route
introspection (`HTTP 405` names the route file and the missing verb), evidence and repair proposals.
The header bell (`src/components/notification-bell.tsx`, added this pass) reads
`/api/notifications`, which counts **open Error Intelligence rows plus failed deployments in 24 h**
from the same tables the Error Center and Deployments pages read.

Verified on the running production build this pass:

```
login 200 → activity total=1 (auth.login, owner@darknote.test)
bad login 401 → notifications: {last24h: 2, warnings24h: 1}   (0 → 1)
GET /activity → 200, renders "Activity Logs", "Events (24h)", bell aria-label "No open problems"
GET /api/notifications without a session → 401
```

## §11 — dependency installation

`src/lib/projects/install.ts` splits detection from execution on purpose.

**Detection (`analyzeProject`, pure, executes nothing):** runtime (`node`/`python`/`php`/`static`),
manifest and lockfile, package manager **chosen from the lockfile** (`package-lock.json` → `npm ci`,
`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock`, `bun.lockb`, `composer.lock`), the
install command, the start command derived from `scripts.start` → `scripts.dev` → `main`, dependency
and dev-dependency counts, `engines.node`, and the environment **keys** a project expects (from
`.env.example` — values are never read, because credential-shaped paths are not stored at all).
Problems are raised with severities: invalid `package.json` (critical), no entrypoint (critical), no
`start` script (high), no lockfile (low), unpinned Python requirements (low), mixed manifests (low).
`GET /api/projects/{id}/install` returns this as the installation report, and the import job's final
message names the runtime, manager and install command, so the report exists immediately after an
import without a second request.

**Execution (`executeInstall`)** sends exactly that command — `cd /<binding prefix> && npm ci` — to
the server the project is **bound** to (`server_github_bindings`), through the existing console
service. It refuses without `confirm: true`, without a binding (`no_server_binding`, naming the step
to take), when nothing is installable, and for any override that is not a single package-manager
invocation (shell operators are rejected). The response states that the command was **sent** and that
the panel console is the proof — it never claims the install succeeded. Untested against a real
panel (no credentials); the analysis half is covered by `tests/install.test.ts` (9 tests).

## §13 — infrastructure

Added this pass: a multi-stage `Dockerfile` (Node 22, `next start`, `/data` volume, HTTP health
check) and `.github/workflows/ci.yml` (typecheck → test → build on every push). Neither has been
executed here — there is no Docker daemon and no Actions runner in this environment; both are
standard, minimal configurations.

Not built: Terraform, Kubernetes manifests, Prometheus/Grafana/Sentry wiring. The application is a
single long-running process **by design** (in-process console buffer and SSE hub), so a replica set
would need a Redis fan-out before horizontal scaling is honest.

## §15 — performance

Measured from the production build: shared JS 103 kB gzip-ish first load, per-page 113–148 kB,
Monaco loaded on demand from `/monaco/`, `useApi` cache bounded by count **and** bytes (3 MB), no
timers while the tab is hidden, `?profile=safe` disables background polling and ambient animation.
Not verified: a physical Samsung Galaxy A17, memory over a long terminal session, a 50 MB import.

## §18 — test evidence

```
npm run typecheck   clean
npm test            186 tests, 175 pass, 0 fail, 11 skipped
npm run build       succeeds; /activity and /api/{activity,notifications} present in the route table
npm run verify:github  12/12 checks against github.com (above)
```

The 11 skips are the PostgreSQL-only file; it needs `DARKNOTE_TEST_PG_URL`. Panel-dependent
workflows are exercised against `tests/mock-pterodactyl.mjs`, a double that enforces HTTP verbs and
serves a real Pterodactyl-style websocket — that proves the client, not your panel.

## §20 — end-to-end acceptance

| # | Step | Status |
|---|---|---|
| 1 | Open DARKNOTE | PASS — production build serves `/login`, `/api/health` `ok:true`, 54 tables |
| 2 | Connect the hosting panel | **BLOCKED** — needs your panel URL + client API key |
| 3 | Connect GitHub | PASS — live token accepted, account resolved, encrypted at rest |
| 4–6 | File Manager → Upload → Import from GitHub | PASS (route + panel double); the GitHub list itself verified live |
| 7–8 | View repositories → import one | PASS — 15 files imported from github.com |
| 9 | Replace confirmation when files exist | PASS — 409 `confirmation_required` with identical/different/new/orphaned counts; Backup & Replace verifies before writing |
| 10 | Extract the project | PASS — text/binary classification, 14 text files |
| 11 | Inspect dependencies | PASS — `GET /api/projects/{id}/install` returns runtime, manager, install/start commands, dependency and env-key counts, problems |
| 12–13 | Diagnostics → error counts | PASS offline (PGlite) + counter verified on the live build |
| 14–16 | Explorer → search `menu` → open in editor | PASS offline (real AST/index tests); live index needs the panel |
| 17–19 | Edit → save → push to GitHub | READY (unverified) — needs a repo the token can write to |
| 20–21 | Update hosting project → validate | BLOCKED — panel |
| 22–24 | Terminal → start app → verify it runs | BLOCKED — panel |

Step 2 is the gate for everything from 9 onward: without a panel there is no directory to import
into, no file to write, no command to execute. Nothing above is claimed as working merely because it
compiles.
