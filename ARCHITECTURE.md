# ARCHITECTURE

Maintainer's map of `repo-people-app`. Written from reading the source, not
from the README. Every claim points at a file. Where I couldn't verify
something I wrote "unverified". This code is largely AI-generated, so this
document describes what the code *does* and what a pattern *causes* — never an
imagined intent.

---

## 1. What this app does

A user enters a GitHub `owner/repo`, picks which "roles" of user to collect
(contributors, stargazers, forkers, etc.), and starts a fetch; a live log
streams each user as it is pulled from the GitHub API
(`frontend/src/views/FetchView.tsx`, `backend/worker.py`). When the job
finishes, the Results view shows summary cards, charts, a world map, a sortable
user table, and JSON/CSV/XLSX/PDF export
(`frontend/src/views/ResultsView.tsx`). Two or more completed jobs can be
overlapped in the Compare view to see who appears in which repo
(`frontend/src/views/CompareView.tsx`, `POST /compare` in `backend/main.py`).

---

## 2. Stack and why it's here

### Backend (`backend/`, deps in `backend/requirements.txt`)

| Library | Proven used by | Role |
|---|---|---|
| `fastapi` | `backend/main.py:14` (`app = FastAPI(...)`) | HTTP framework, all routes |
| `uvicorn` | `backend/main.py:931`, `Dockerfile.cloudrun` CMD | ASGI server |
| `sse-starlette` | `backend/main.py:17`, `stream_job` (`main.py:231`) | Server-Sent Events for the progress stream |
| `aiosqlite` | `backend/store.py:11` | Async SQLite driver — the entire persistence layer |
| `httpx` | `backend/main.py:840,858` | GitHub OAuth token exchange + profile fetch |
| `python-dotenv` | `backend/main.py:13,32` | Loads `backend/.env` |
| `repo-people==1.0.2` | `backend/worker.py:15-16` (`from repo_people ...`) | **The data engine.** All role fetchers (`rp_export.export_*`) and profile lookups (`GitHubUserInfo`) live in this external PyPI package, not in this repo |
| `PyGithub` (`github`) | `backend/worker.py:17` (`from github import Github, Auth, GithubException`) | GitHub client for per-user profile calls. **Not declared** in either requirements file — it arrives transitively via `repo-people`. See §9. |
| `pydantic` | `backend/models.py:3` | Request validation. Transitive via FastAPI; not pinned directly |

### Frontend (`frontend/`, deps in `frontend/package.json`)

| Library | Proven used by | Role |
|---|---|---|
| `react` / `react-dom` | `frontend/src/main.tsx` | UI |
| `vite` + `@vitejs/plugin-react` | `frontend/vite.config.ts` | Dev server, proxy, bundler |
| `tailwindcss` / `postcss` / `autoprefixer` | `frontend/tailwind.config.js`, `postcss.config.js` | Styling (plus a lot of inline `style={}`) |
| `lucide-react` | icon imports across views | Icons |
| `recharts` | `ResultsView.tsx:8-11`, `components/UserDrawer.tsx` | Bar/pie/area charts |
| `@tanstack/react-table` | `components/UserTable.tsx` | Sortable/filterable table |
| `@tanstack/react-virtual` | `components/UserTable.tsx` | Row virtualization for large tables |
| `react-simple-maps` | `components/WorldMap.tsx` | Geographic map |
| `xlsx` | `ResultsView.tsx:299` (dynamic `import('xlsx')`) | Excel export, lazy-loaded |
| `jspdf` | `ResultsView.tsx:227` (dynamic import) | PDF export, lazy-loaded |
| `html2canvas` | `ResultsView.tsx:226` (dynamic import) | Rasterizes the report DOM for the PDF |

All frontend runtime deps are actually imported. The heavy three
(`xlsx`, `jspdf`, `html2canvas`) are code-split via dynamic `import()` and
manual chunks (`vite.config.ts:10-18`), so they don't load until an export runs.

### Installed but effectively dead

- **`fetchResults` (fetch-all-pages)** in `frontend/src/utils/api.ts:100` is
  imported by `ResultsView.tsx:2` but never called there; only the tests call
  it (`frontend/src/tests/api.test.ts`). The app uses `fetchResultsPage`
  instead. So the import in `ResultsView.tsx` is unused and the fetch-all path
  is test-only.
- **`create_job` (sync)** in `backend/store.py:95` is called only by
  `tests/backend/test_store.py`. Every real endpoint uses `create_job_async`
  (`backend/main.py:194,222,778`). The sync variant and its fire-and-forget
  loop-scheduling exist for the sync unit tests. See §8.

---

## 3. Directory map

| Path | What lives there | Responsible for | Depended on by |
|---|---|---|---|
| `backend/main.py` | All FastAPI routes, auth, rate-limit, CORS | The entire HTTP surface | frontend `api.ts`, `vercel.json`, Dockerfiles |
| `backend/worker.py` | `run_fetch_job` background coroutine | Driving `repo-people`, emitting SSE events, saving results | `main.py` (`_start_fetch`) |
| `backend/store.py` | SQLite access + in-memory runtime overlay | All persistence: jobs, sessions, oauth_states, share_tokens | `main.py`, `worker.py` |
| `backend/models.py` | Pydantic request models | Input validation for `/fetch`, `/compare`, tags, rename | `main.py` |
| `backend/.env` | Local secrets (OAuth id/secret, URLs) | Dev config; git-ignored | `main.py` via dotenv |
| `backend/requirements*.txt` | Python deps (`.txt` local, `.cloudrun.txt` prod/CI) | Reproducible installs | Dockerfiles, CI |
| `frontend/src/App.tsx` | Root component, view routing, job list state | Top-level state + localStorage sync | all views |
| `frontend/src/views/` | `FetchView`, `ResultsView`, `CompareView` | The three screens | `App.tsx` |
| `frontend/src/components/` | `UserTable`, `WorldMap`, `UserDrawer`, `GlobalSearchModal`, `ErrorBoundary`, `RoleBadges` | Reusable UI | views |
| `frontend/src/utils/api.ts` | All `fetch()` wrappers + sessionStorage cache | The client↔server contract | views, `App.tsx` |
| `frontend/src/utils/errors.ts` | `friendlyFetchError` string mapper | Turning raw HTTP errors into prose | `FetchView` |
| `frontend/src/types/index.ts` | TS interfaces + `ALL_ROLES` constant | Shared types; the *implicit* user schema | everything frontend |
| `frontend/src/hooks/useNotification.ts` | Browser Notification wrapper | Desktop notification on fetch done | `FetchView` |
| `tests/backend/` | pytest suites | Backend API + store tests | CI |
| `frontend/src/tests/` | vitest suites | Frontend api/component tests | CI |
| `vercel.json` | Vercel build + routes | One deploy target | Vercel |
| `Dockerfile.cloudrun`, `cloudrun-service.yaml` | Cloud Run image + service | The other (primary) deploy target | GCP |
| `backend/Dockerfile`, `docker-compose.yml` | Local containerized dev | Local-only | developers |
| `frontend/dist/` | **Committed** build output | Should be a build artifact, not in git | nothing at runtime |
| `old/`, `ToDo.md` | Stale deploy yaml, scratch notes | Historical; git-ignored (`.gitignore`) | nothing |

---

## 4. Request lifecycle — one fetch, end to end

The central flow is "start a fetch and watch it stream to completion." Every
hop, in order:

1. **User submits the form.** `FetchView.handleSubmit`
   (`FetchView.tsx:392`) validates repos, decides whether a token or OAuth
   session is present, checks for a recent duplicate job, then calls
   `runAllFetches` → `fetchOneRepo` (`FetchView.tsx:259`).

2. **POST /fetch.** `fetchOneRepo` calls `postFetch`
   (`api.ts:79`), which sends the body (`owner`, `repo`, `roles`, `limit`,
   flags, `workers`) and puts the PAT in an `Authorization: Bearer` header —
   never in the body (comment "S1"). `credentials: 'include'` sends the
   `rp_session` / `rp_client` cookies.

3. **Backend accepts the job.** `fetch_users` (`main.py:173`):
   - `_resolve_token` (`main.py:144`) picks the Bearer PAT or, failing that,
     the GitHub token stored in the OAuth session (`store.get_session`).
   - `_owner_key` (`main.py:89`) resolves the caller identity, minting an
     anonymous `rp_client` cookie if there's neither session nor cookie.
   - `_rate_check` (`main.py:120`) enforces the in-memory per-caller window.
   - `FETCH_LIMIT` clamps `req.limit` (`main.py:189`).
   - `create_job_async` (`store.py:111`) inserts a `pending` row **and awaits
     it** before the worker starts (comment "B4" — avoids a worker-before-insert
     race), and registers a runtime overlay entry holding an `asyncio.Queue`.
   - `_start_fetch` (`main.py:157`) schedules `run_fetch_job` via FastAPI
     `BackgroundTasks`.
   - Returns `{job_id}`.

4. **Client opens the SSE stream.** Back in `fetchOneRepo`, `connectSSE`
   (`FetchView.tsx:293`) opens `new EventSource('/fetch/${job_id}/stream')` and
   listens for `status`, `warning`, `progress`, `error`, `done` events, with up
   to 3 auto-reconnects (`FetchView.tsx:341`).

5. **The worker runs.** `run_fetch_job` (`worker.py:41`):
   - Sets `job["status"] = "running"` — a `_JobProxy` write that
     fire-and-forgets a DB `UPDATE` (`store.py:227`).
   - Builds a `Github` client (`worker.py:75`) and, **in parallel**, calls one
     `repo_people.export.export_<role>` function per selected role via
     `loop.run_in_executor` (`worker.py:98-113`). Per-role failures are
     classified by `_classify_role_error` (`worker.py:22`) and emitted as
     `warning` events rather than aborting.
   - Unions all logins, then fetches each user's profile concurrently under an
     `asyncio.Semaphore(workers)` (`worker.py:145`), each via
     `GitHubUserInfo(gh, login).to_dict()` in the executor (`worker.py:139`).
   - Emits a `progress` event per user with counts, ETA, and rate-limit
     headers read from `gh.rate_limiting` (`worker.py:182`).
   - Attaches each user's roles, applies the bot filter, and (if
     `save_each_user`) checkpoints to a temp file every 25 users
     (`worker.py:199`).
   - On completion, `persist_job(result, status="done", total_fetched)` writes
     the terminal state in **one awaited** UPDATE (`worker.py:229`, comment
     "B3"), then emits `done`.

6. **Events reach the browser.** `stream_job` (`main.py:231`) pulls items off
   `job["events"]` and yields them as SSE, with a 30s heartbeat, closing on
   `done`. `FetchView` updates the log and, on `done`, flips the job card to
   `done` and stores it (`FetchView.tsx:326`).

7. **Results render.** When the user opens Results, `ResultsView.loadJob`
   (`ResultsView.tsx:150`) calls `fetchResultsPage(jobId,1,200)` +
   `fetchSummary(jobId)` in parallel (`api.ts:135`, `:189`).
   - `get_results` (`main.py:355`) paginates `job["result"]`.
   - `get_summary` (`main.py:389`) returns the cached summary if present,
     else computes location/company/age/role aggregates and caches them back
     into `job["summary"]` (which persists via the `_JobProxy` write).
   - `api.ts` caches both in `sessionStorage` for 5 minutes (`api.ts:130,203`).
   - The view renders summary cards, recharts charts, `WorldMap`, and
     `UserTable`. "Load more" pages in the rest via `loadMoreUsers`
     (`ResultsView.tsx:178`).

---

## 5. Data model

Persistence is SQLite, schema declared in `store._db` (`store.py:31-84`).
Four tables:

**`jobs`** (`store.py:37`)
- `job_id` TEXT PK, `status` TEXT (`pending|running|done|error`),
  `message`, `total_fetched` INT, `label`, `result_json`, `summary_json`,
  `created_at`.
- Added by ad-hoc migrations (`store.py:50-54`): `tags` TEXT (JSON array,
  default `'[]'`), `owner_key` TEXT (scopes a job to its creator),
  `params_json` TEXT (original fetch request, for refresh).
- `result_json` holds the whole `{login: userRecord}` map as a JSON string.
  **The per-user record itself has no schema on the backend** — it is whatever
  `repo_people.GitHubUserInfo.to_dict()` produces, stored verbatim. The only
  fielded view of it is the TypeScript `UserRecord` interface
  (`frontend/src/types/index.ts:1-48`), which is descriptive, not enforced.
  Treat that as the *implicit, unvalidated* schema.

**`sessions`** (`store.py:59`) — OAuth: `session_id` PK, `github_token`,
`github_login`, `github_name`, `github_avatar`, `created_at`, `expires_at`.
The GitHub access token is stored in plaintext here.

**`oauth_states`** (`store.py:71`) — CSRF: `state` PK, `expires_at`.
Single-use, consumed in `consume_oauth_state` (`store.py:467`).

**`share_tokens`** (`store.py:77`) — `token` PK, `job_id`, `expires_at`.
24h read links (`main.py:661`).

Expiry for sessions/states/tokens is enforced by comparing ISO strings in SQL
(`store.py:436,477,507`) — lexicographic comparison that works only because all
timestamps are `datetime.utcnow().isoformat()` at the same precision. There is
no scheduled cleanup; expired rows are deleted opportunistically when queried.

---

## 6. State and side effects

State lives in four places, and some of it is deliberately duplicated:

- **SQLite (`*.db`)** — source of truth for jobs, results, sessions, tokens
  (`store.py`).
- **In-memory `_runtime` dict (`store.py:28`)** — holds the per-job
  `asyncio.Queue` and `cancelled` flag, which cannot be serialized. This is
  **duplicated state**: `status`, `cancelled`, etc. exist both in the DB row
  and in the runtime overlay, reconciled by `_row_to_job` (`store.py:188`) and
  the `_JobProxy` subclass (`store.py:209`), which mirrors writes into both.
- **Client `localStorage`** — the job list (`App.tsx:192,206`,
  key `repo-people-jobs`) and search history (`FetchView.tsx:35`). This is a
  **second copy of the job list**: the backend also has it, and `App.tsx:270`
  reconciles the two on mount, marking local-only jobs as `stale`.
- **Client `sessionStorage`** — 5-minute TTL cache of results/summary
  (`api.ts:15-44`), invalidated on delete (`api.ts:47`).

Mutations:
- Jobs are created by `/fetch`, `/import`, `/jobs/{id}/refresh`; mutated to
  `done`/`error` by the worker; renamed/tagged/deleted by PATCH/DELETE.
- Sessions created on OAuth callback, deleted on logout.
- The summary is computed lazily and cached back into the job row on first read
  (`main.py:458`).

**Duplication to watch:** the job list exists in localStorage *and* the DB and
is merged heuristically (`App.tsx:270-287`); job status/cancelled exist in both
the DB and `_runtime`; results are cached in sessionStorage on top of the DB.
Any of these can drift — e.g. a job deleted server-side but still in
localStorage becomes `stale` rather than disappearing.

---

## 7. Config and secrets

Backend env vars (read in `backend/main.py` unless noted):

| Var | Read at | Default | Breaks without it |
|---|---|---|---|
| `GITHUB_CLIENT_ID` | `main.py:45` | `""` | `/auth/login` returns 503 (`main.py:812`) — OAuth disabled, PAT still works |
| `GITHUB_CLIENT_SECRET` | `main.py:46` | `""` | `/auth/callback` returns 503 (`main.py:836`) |
| `FRONTEND_URL` | `main.py:47` | `http://localhost:5173` | OAuth redirect + share URL point to the wrong place |
| `BACKEND_URL` | `main.py:48` | `http://localhost:8000` | OAuth `redirect_uri` wrong; also drives cookie `Secure` (`main.py:55`) |
| `COOKIE_SAMESITE` | `main.py:56` | `lax` | Set to `none` for cross-origin frontend+backend; forces `Secure` |
| `CORS_ORIGINS` | `main.py:129` | `localhost:5173,127.0.0.1:5173` | Browser blocks the real frontend origin |
| `FETCH_LIMIT` | `main.py:36` | `500` | `0` disables the per-job cap (local installs) |
| `FETCH_RATE_LIMIT` | `main.py:62` | `20` | Requests/minute per caller |
| `REPO_PEOPLE_DB` | `store.py:22` | file next to `store.py` | DB path; Cloud Run sets it to `/tmp/...` (`Dockerfile.cloudrun`) |
| `ALLOW_DEV_CLEAR` | `main.py:796` | unset | `POST /clear_cache` stays 403 unless `1/true/yes` |

Frontend env vars (read via `import.meta.env`, defined in
`frontend/.env.production`):

| Var | Read at | Breaks without it |
|---|---|---|
| `VITE_API_BASE_URL` | `api.ts:3`, `App.tsx:331` | Empty → all API calls are relative (dev proxy). Must point at the backend in a cross-origin deploy |
| `VITE_FETCH_LIMIT` | `FetchView.tsx:74` | UI-side cap; **must be kept in sync manually** with backend `FETCH_LIMIT` (two independent sources of the same number) |

**Secrets.** `backend/.env` on this machine contains a real-looking
`GITHUB_CLIENT_SECRET`. It is **git-ignored** (`.gitignore` `.env` entry) and
`git ls-files` confirms it is not tracked, so it is not committed — but it is
sitting in plaintext in the working tree, and OAuth `github_token`s are stored
plaintext in the `sessions` table (`store.py:425`). The `.db` files are
git-ignored too (`.gitignore` `*.db`).

---

## 8. Design decisions

**SQLite + an in-memory `_JobProxy` overlay** (`store.py:209`).
The code keeps a `dict` subclass whose `__setitem__` fire-and-forgets an async
DB write, plus a `_runtime` dict for unserializable fields. Plausible reason: let
call sites treat a job like a plain mutable dict while persistence "just
happens." For this app's scale (one instance, few jobs) it works, but it buys
real complexity: two write paths (`_JobProxy` fire-and-forget vs the awaited
`persist_job`), a sync/async split in `get_job`/`get_job_async`, and comments
("B3", "B4") documenting races the pattern itself created. **[unclear]** — the
overlay earns its keep only for the `asyncio.Queue`; the write-proxying is where
the sharp edges are.

**Two persistence functions, `_JobProxy` writes and `persist_job`.**
Terminal transitions go through the awaited `persist_job` (`worker.py:229`) "so
result/status/total can't land out of order," while incidental writes (e.g.
`status="running"`, summary caching) still go through the fire-and-forget proxy.
Consequence: ordering guarantees depend on which path a given write took, and a
reader must know that. **[unclear]**

**Ownership via `owner_key` + anonymous cookie** (`main.py:89-117`).
Jobs are scoped to an OAuth login or an anonymous `rp_client` cookie; unowned
(NULL) legacy jobs are visible to everyone (`_can_access`, `main.py:102`).
Missing-vs-forbidden both return 404 to avoid leaking existence. For a public,
no-login-required tool this is a reasonable lightweight scheme. **[justified]**

**In-memory per-instance rate limiter** (`main.py:62-126`).
A `dict[str, list[float]]` sliding window. The code's own comment says "move to
Redis if you run >1 instance." Cloud Run is pinned to `maxScale: 1`
(`cloudrun-service.yaml`), so the assumption holds *there*. **[justified]** for
Cloud Run, **breaks** on Vercel/any multi-instance target.

**Single-instance SQLite as the deploy contract.**
`cloudrun-service.yaml` sets `maxScale: "1"` and the Dockerfile writes the DB to
`/tmp` (ephemeral). The whole state design (in-memory queues, per-instance rate
limit, local SQLite) only works with exactly one instance and accepts data loss
on restart. **[justified]** as an explicit, documented trade-off for a demo/tool
— *provided* it runs on Cloud Run. See §9 for what happens on Vercel.

**SSE for progress instead of polling** (`sse-starlette`, `worker.py` emit /
`main.py:231`). A fetch is long and streaming; SSE with a heartbeat and
client-side reconnect fits. **[justified]**

**`repo-people` pinned to an exact version** (`requirements*.txt`,
`.github/dependabot.yml`). The data engine is external; pinning + Dependabot
gives reproducible builds and controlled upgrades. **[justified]**

**Token in `Authorization` header, not body** (`api.ts:79`, `models.py:12`).
Keeps the PAT out of request logs/bodies. **[justified]**

**Lazy-loaded export libraries** (`ResultsView.tsx:226-299`, `vite.config.ts`).
`xlsx`/`jspdf`/`html2canvas` are large and rarely used; dynamic `import()` keeps
them out of the initial bundle. **[justified]**

**`sys.path.insert(... "../..")`** in `main.py:19` and `worker.py:14`.
Adds the grandparent dir to the import path — a leftover from when
`repo_people` was a sibling source tree. It is now installed from PyPI
(`repo-people==1.0.2`), so this line is inert in every real deploy.
**[cargo-culted]**

---

## 9. Known weak points

Things that will bite the next maintainer:

1. **Vercel deploy is partially wired and stateful-broken.**
   `vercel.json` routes only `/fetch`, `/results`, `/compare`, `/jobs`,
   `/import` to `backend/main.py`. `/auth/*`, `/share/*`, and `/clear_cache`
   have **no route**, so OAuth and share links can't reach the backend on
   Vercel. Worse, `@vercel/python` is serverless: each invocation gets a fresh
   process, so the in-memory `_runtime` queues and SQLite-in-`/tmp` don't
   survive between the `/fetch` call and the SSE `/fetch/{id}/stream` call. The
   real target is Cloud Run (`cloudrun-service.yaml`, `maxScale:1`); the Vercel
   config looks aspirational. **Verify before relying on it.**

2. **`PyGithub` is an undeclared direct dependency.** `worker.py:17` imports
   `github` but it's in neither `requirements.txt` nor
   `requirements.cloudrun.txt`; it only resolves because `repo-people` pulls it
   in. If `repo-people` ever drops it, the worker breaks with no signal from
   this repo's manifests.

3. **`FETCH_LIMIT` is defined twice.** Backend `FETCH_LIMIT` (`main.py:36`) and
   frontend `VITE_FETCH_LIMIT` (`FetchView.tsx:74`, `.env.production`) are
   independent. They can silently disagree; the backend clamp (`main.py:189`) is
   the only real enforcement.

4. **The client↔backend URL base is applied inconsistently.**
   - `FetchView.tsx:294` opens the SSE stream as `/fetch/${id}/stream` (no
     `BASE`, no `withCredentials`), while `App.tsx:331` opens the *refresh*
     stream with `${base}` and `withCredentials: true`.
   - `openAuthPopup` (`api.ts:290`) navigates to `/auth/login` with no `BASE`.
   - `navigator.sendBeacon(`/fetch/.../cancel`)` (`FetchView.tsx:115`) is
     origin-relative too.
   All of these assume same-origin (i.e. the dev proxy in `vite.config.ts` or a
   reverse proxy). In a cross-origin `VITE_API_BASE_URL` deploy they point at
   the frontend origin and fail. This is the kind of split that "works on my
   machine" and dies in production.

5. **Duplicated / drifting state** (see §6): job list in localStorage vs DB,
   job status/cancelled in `_runtime` vs DB, results in sessionStorage vs DB.
   The reconciliation in `App.tsx:270` and `_row_to_job` is the only thing
   keeping them aligned.

6. **Two persistence paths with different ordering guarantees** (§8). A future
   edit that writes `job["result"] = ...` via the proxy instead of
   `persist_job` reintroduces the out-of-order write the "B3" comment fixed.

7. **`ResultsView.tsx:2` imports `fetchResults` but never uses it** (§2); and
   **`store.create_job` (sync)** is production-dead, test-only (§2). Dead
   imports/functions that read as if they're load-bearing.

8. **`frontend/dist/` is committed** (built assets in the tree). It's stale the
   moment source changes and shouldn't be in version control.

9. **No cleanup of expired rows.** `sessions`, `oauth_states`, and
   `share_tokens` are only pruned opportunistically when queried
   (`store.py:477,507`). A row nobody queries lives forever. Fine at this scale,
   surprising later.

10. **Plaintext GitHub tokens in the DB** (`store.py:425`) and a plaintext OAuth
    secret in `backend/.env`. Not committed (§7), but anyone with the DB file or
    the host has the users' GitHub tokens.

### Things I found confusing (the useful part)

- **`get_job` (sync, `store.py:133`) is a minefield.** It branches on whether an
  event loop is running, sometimes returns `None`, sometimes a partial
  `_JobProxy`, sometimes calls `loop.run_until_complete`. The worker relies on
  it returning a *mutable* proxy so `job["status"] = ...` persists. Whether it
  returns fresh DB data or stale runtime data depends on call context. I could
  not convince myself it behaves correctly in every path — treat it as fragile.
- **Why both `create_job` and `create_job_async` exist** only became clear after
  grepping: the sync one is purely for sync unit tests. Nothing in the comments
  says "test-only," so it looks like a live alternative entry point. It isn't.
- **The Vercel vs Cloud Run split.** Two deploy configs encode contradictory
  assumptions (serverless multi-invocation vs one pinned instance). Nothing in
  the repo says which is canonical; I inferred Cloud Run from `maxScale:1`,
  `REPO_PEOPLE_DB=/tmp`, and the fact that OAuth/share routes are missing from
  `vercel.json`. Unverified which target is actually in use — confirm before
  changing either.
