# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.1.0] — 2026-08-17

Findings from a full-codebase security and correctness audit.

> **Upgrading from 1.0.x.** Two operational notes: OAuth session tokens are now
> encrypted at rest, so every existing session is invalidated and users must sign
> in once after deploying — set `SESSION_TOKEN_KEY` first, or sessions will also
> be dropped on every restart. And `cloudrun-service.yaml` now sets
> `minScale: "1"`, which is required for scheduled re-fetch to run at all but
> bills continuously.

### Security

- **OAuth login CSRF — the `state` was not bound to the browser** (`backend/main.py`, `backend/store.py`). `add_oauth_state()` wrote the state to a global table and `consume_oauth_state()` only checked that it existed, so the state proved *some* flow had started, not that **this** browser started it. An attacker could hit `/auth/login` themselves, capture their own `?code=…&state=…` callback URL without following it, and get a victim to load it — silently signing the victim into the attacker's GitHub account. Since jobs are keyed `gh:{login}`, everything the victim then fetched landed in the attacker's namespace and was readable by them. `/auth/login` now also sets the state in an httponly, short-lived `rp_oauth_state` cookie, and `/auth/callback` requires a `secrets.compare_digest` match **before** the DB lookup — so a replayed callback cannot consume (and thereby burn) a state belonging to someone else's in-flight login. The cookie is cleared on success.
- **GitHub access tokens are encrypted at rest** (`backend/store.py`). `sessions.github_token` held a live OAuth token (`read:user user:email public_repo`) in plaintext for up to 30 days, so a database dump handed over every user's GitHub credentials. Tokens are now Fernet-encrypted (`_encrypt_token`/`_decrypt_token`) under `SESSION_TOKEN_KEY`; unset falls back to a per-process ephemeral key with a startup warning. `get_session` decrypts on read and **deletes** any row it cannot decrypt (legacy plaintext, or a rotated key), so a ciphertext blob can never be sent to GitHub as a Bearer token. **Existing users must sign in once after deploying.**
- **CSRF on preflight-free mutating routes** (`backend/main.py`, `frontend/src/utils/api.ts`). The documented split deployment (Vercel frontend + Cloud Run backend) requires `COOKIE_SAMESITE=none`, so the browser attaches session cookies to cross-site requests; CORS only prevents an attacker *reading* the response, not the request being delivered. `POST /import` with `Content-Type: text/plain` was a "simple" request and let a third-party page create jobs in a victim's account and burn their rate budget; `POST /auth/logout` and `POST /fetch/{id}/cancel` were nuisance-grade. A `require_csrf_header` middleware now rejects `POST`/`PUT`/`PATCH`/`DELETE` without an `X-Requested-With` header (`403`), which forces a preflight that fails CORS for unlisted origins. `GET /auth/callback` is exempt — GitHub drives that redirect and it is protected by the state cookie instead. The middleware is registered *before* `CORSMiddleware` so CORS remains outermost and the `403` is readable rather than surfacing as an opaque CORS failure.
- **Security headers on the frontend** (`vercel.json`). Added `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` and a `Permissions-Policy`. Because the file uses legacy `routes` (which cannot be combined with a top-level `headers` block), they are applied via a `"continue": true` pass-through route. The CSP keeps `script-src 'self'` with no `unsafe-inline`; `connect-src` is `https:` and flagged in-file as the value to tighten to the exact backend origin.

### Fixed

- **Charts, quick-stat badges and client-side exports only ever described the first page** (`frontend/src/views/ResultsView.tsx`, `frontend/src/utils/api.ts`). `users` held only the pages that had been scrolled into view (200 at a time), yet every aggregate derived from it — `healthScore`, location/language/org/email-domain breakdowns, growth, role overlap — silently described that fraction. With the default `FETCH_LIMIT=500` this was the common case, not an edge case. Worse, the "total users" badge rendered `users.length` while the summary card directly above it showed the server's total, so the same screen contradicted itself. `loadJob` now renders page 1 immediately and then pulls the remaining pages in the background via the new `fetchAllResultPages()` helper (capped at `MAX_CLIENT_ROWS = 10000`), guarded by a `loadTokenRef` so a filter change mid-load discards stale pages. The badge reads the server total.
- **Client-side exports silently dropped every unloaded row** (`frontend/src/views/ResultsView.tsx`). Same root cause: "Export JSON/CSV/Excel" and the per-role CSV serialised only the loaded pages, so exporting a 500-row job produced 200 rows with no warning. Export buttons are now disabled until coverage is complete, and a banner states the actual coverage while loading or when a result set exceeds the client cap. Coverage is *derived* from the row count rather than tracked in state, so a page walk that fails part-way is correctly reported as incomplete instead of a flag claiming success.
- **Scheduled re-fetch never fired in production** (`cloudrun-service.yaml`). `_schedule_loop()` is an in-process asyncio loop, but the deployed service set `minScale: "0"` — the instance scaled to zero, the loop died with it, and schedules never ran while the UI still showed them enabled with a sliding `next_run_at`. Set to `minScale: "1"`, documented inline, **including that a warm instance bills continuously**; revert to `0` only if you drop scheduling or move it to Cloud Scheduler.
- **`/schedules` was missing from the Vite dev proxy** (`frontend/vite.config.ts`). Dev requests hit the Vite server and 404'd, and `fetchSchedules()` swallows a failure with `return []` — so scheduling looked empty-but-working locally. Added `/schedules` and `/healthz`.
- **SSE event queues grew without bound** (`backend/store.py`, `backend/worker.py`). Each job got an unbounded `asyncio.Queue`, and the worker emits one event per fetched user whether or not an SSE client is attached. A client that never opened the stream (or disconnected mid-fetch) left every event resident for the life of the process, and `_runtime` entries are only removed on `delete_job`. Queues are now bounded (`_EVENT_QUEUE_MAX = 500`, built by `_new_runtime()`) and `emit_event()` drops the oldest event when full — the terminal `done` event is written last, so it always survives eviction.
- **`GET /jobs/{id}/history` parsed every run's full result blob** (`backend/store.py`). It selected `result_json` for *every* completed run of a repo purely to rebuild each run's set of logins, and `ResultsView` calls it automatically on every job selection — tens of MB of JSON parsing on a hot path for an uncapped local install. Added a `logins_json` column, written whenever `result` is persisted; `load_repo_history` reads it instead and lazily backfills pre-migration rows on first read.

### Changed

- **`beaconCancelJob` uses `fetch(keepalive)` instead of `navigator.sendBeacon`** (`frontend/src/utils/api.ts`). A beacon cannot set custom headers, so it could not send the CSRF header the backend now requires. `keepalive` gives the same outlive-the-page guarantee and still sends cookies.
- **Vite's modulepreload polyfill is disabled** (`frontend/vite.config.ts`). It is injected as an inline `<script>`, which would have forced `'unsafe-inline'` into the CSP's `script-src`. Every browser this app targets supports modulepreload natively; the built `index.html` now has exactly one external script tag.
- **`req()` adds `X-Requested-With` to non-GET requests only** (`frontend/src/utils/api.ts`), so `GET`s stay "simple" and don't pay for a preflight round trip.

### Removed

- **`fetchResults()` deleted** (`frontend/src/utils/api.ts`) — the page-merging helper was imported by `ResultsView` but never called; only tests exercised it. Its role is now filled for real by `fetchAllResultPages()`. `_persist_field`, `_all_job_ids_async` and `get_job_tags` were left in place: `conftest`/`test_store` use them, so they are test helpers rather than dead code.

### Dependencies

- **`cryptography>=43.0.0`** added to `backend/requirements.txt` and `backend/requirements.cloudrun.txt` for Fernet session-token encryption. It was already present transitively, but session encryption is not something to leave depending on another package's dependency graph.

### Tests

- **Backend — `tests/backend/test_security.py`** (new, 18 tests) — CSRF: mutating requests are rejected without the header across `POST`/`PATCH`/`DELETE`, requests carrying it reach the handler, `GET`s don't need it, and `/auth/callback` is exempt. OAuth: `/auth/login` sets a state cookie matching the redirect; a callback with no cookie is rejected **and leaves the state unconsumed**; a mismatched cookie is rejected; a matching cookie gets past both checks. Sessions: the stored token is not plaintext, `get_session` returns it decrypted, and an undecryptable row is dropped and reported as no session. Queues: the bound holds under overflow and the terminal `done` event survives eviction.
- **Backend — `tests/backend/test_store.py`** — Added `TestLoginsDenormalisation` (6 tests): persisting a result writes a sorted login list; rewriting a result updates it; history reads runs without touching `result_json`; history is owner-scoped; a legacy `NULL` row is backfilled on read so the slow path is not taken twice; pending runs of the same repo are excluded.
- **Backend — `tests/backend/conftest.py`** — Both test clients now send `X-Requested-With` by default (`CSRF_HEADERS`), matching real clients; tests asserting enforcement strip it deliberately. Seed helpers use `store._new_runtime()` rather than building their own unbounded `asyncio.Queue` — writing the queue-bound test is what surfaced that they were bypassing the cap.
- **Frontend — `tests/frontend/api.test.ts`** — Added a `CSRF header` suite (mutating calls send it, `GET`s don't, `postFetch` keeps its own headers alongside it, `beaconCancelJob` sends it) and a `fetchAllResultPages` suite (walks every page and unions the results, deduplicates the first page against the overlapping page-1 refetch, **does not stop early on a partial last page**, stops at `MAX_CLIENT_ROWS`, abandons the walk when `shouldContinue` goes false, reports progress per page, and forwards active filters). Removed the six `fetchResults` tests along with the function.

### Documentation

- **`README.md`** — Added `SESSION_TOKEN_KEY` to the backend environment table (with the key-generation command) and a CSRF note alongside the existing job-scoping note.
- **`docs/cloud-run-deployment-guide.md`** — Added `SESSION_TOKEN_KEY` to the Cloud Run variables table plus a "Session token encryption key" section covering generation, Secret Manager storage, and the consequences of leaving it unset or rotating it.
- **`ARCHITECTURE.md`** — Updated the `jobs`/`sessions`/`oauth_states` schema descriptions, the runtime-overlay and request-lifecycle sections, and the environment/secrets notes. Two "known issues" are now struck through as resolved (plaintext tokens; no cleanup of expired rows — `_maintenance_loop` already covered the latter), and the dead-`fetchResults` entry reflects its deletion.
- **`cloudrun-service.yaml`** — Documented why `minScale` must be `1`, and added a commented `SESSION_TOKEN_KEY` secret reference next to the existing `DATABASE_URL` one.

### Known and not fixed

- **Two browser tabs streaming the same job split its events between them.** `asyncio.Queue.get()` is destructive and there is one queue per job, so each tab receives roughly half the log lines. Fixing it properly means a per-job ring buffer with per-subscriber cursors — real work for a cosmetic symptom, deliberately deferred.

---

## [Unreleased] — 2026-07-14

### Security

- **Jobs are now scoped to their creator (IDOR fix).** Previously every endpoint was unauthenticated and `GET /jobs` listed *all* jobs to *all* visitors, so anyone could read, export, compare, rename, or delete anyone else's harvested data. A new `owner_key` column (`backend/store.py`) scopes each job to its creator — the GitHub login for OAuth users, or an anonymous httponly `rp_client` cookie otherwise. `GET /jobs` filters to the caller (`load_jobs_list(owner_key)`); `/results`, `/summary`, `/top`, `/export/*`, `/compare`, `/compare/multi`, `/share`, `DELETE`, `PATCH`, `/cancel`, and `/stream` all resolve jobs through `_get_owned_job()` and return `404` for jobs the caller doesn't own (existence is not leaked). Legacy jobs with a `NULL` owner remain public for back-compat.
- **`GET /clear_cache` (destructive) replaced by a guarded `POST`.** The old endpoint was a prefetchable `GET` that ran `DELETE FROM jobs` with no auth — any crawler, link prefetch, or `<img>` could wipe the database. It is now `POST /clear_cache`, disabled unless `ALLOW_DEV_CLEAR=1` (returns `403` otherwise). `main.tsx` updated to `POST`.
- **Stored-XSS guard on import.** `POST /import` accepted arbitrary records that the frontend later rendered in `href`/`src`. `_sanitise_urls()` (`backend/main.py`) now blanks any non-`http(s)` `html_url`/`avatar_url`/`blog` value (e.g. `javascript:`, `data:`) before storage.
- **Import size-limit bypass closed.** The 5 MB cap previously trusted the `Content-Length` header (omit it and the body was read unbounded). `_read_capped_body()` now streams the request and aborts at 5 MB regardless of headers.
- **Session cookie flags are environment-driven.** The OAuth session cookie was hardcoded `secure=False`. `Secure` is now auto-enabled when `BACKEND_URL` is HTTPS, and `SameSite` is configurable via `COOKIE_SAMESITE` (`lax` default; `none` forces `Secure`) for cross-origin frontend/backend deployments. The anonymous `rp_client` cookie uses the same flags.
- **Per-caller rate limiting.** `POST /fetch` and `POST /import` are limited to `FETCH_RATE_LIMIT` (default 20) requests per minute per `owner_key` via an in-memory sliding window (`_rate_check`), returning `429` when exceeded.
- **SQLite job store removed from version control.** `backend/repo_people_jobs.db` (which contained harvested results *and* the `sessions` table of raw GitHub OAuth tokens) plus six committed `.pyc` files are now untracked; `*.db` added to `.gitignore`. **Rotate any GitHub tokens that were stored in the committed DB — git history still contains them.**

### Added

- **`POST /jobs/{job_id}/refresh`** (`backend/main.py`, `frontend/src/utils/api.ts`, `frontend/src/views/ResultsView.tsx`, `frontend/src/App.tsx`) — Re-runs a job with its original fetch parameters as a new owned job. Fetch parameters (no secrets) are stored in a new `params_json` column at creation time. A refresh button in the Results toolbar starts the re-fetch; `App.handleJobRefresh` adds the new running job and attaches an SSE listener to flip it to *done*. *Scheduled/cron refresh deferred — requires a durable scheduler and job execution.*
- **DB-backed OAuth state and share tokens** (`backend/store.py`) — New `oauth_states` and `share_tokens` tables with `add_oauth_state`/`consume_oauth_state` and `add_share_token`/`get_share_token` helpers replace the in-memory `_oauth_states`/`_share_tokens` dicts, so CSRF state and share links survive restarts and multiple instances. Expiry is enforced in Python (ISO timestamps) with an inline sweep on access.
- **`persist_job()` store helper** (`backend/store.py`) — Writes several job fields (`result`, `status`, `total_fetched`, …) in a single awaited `UPDATE`, used for terminal state transitions in the worker and import path.
- **`owner_key` / `params_json` columns** (`backend/store.py`) — Added to the `jobs` table via idempotent `ALTER TABLE` migrations; `create_job_async(owner_key, params)` and `_insert_job` persist them; `_row_to_job` surfaces them.
- **`refreshJob()` API client** (`frontend/src/utils/api.ts`) — Typed `POST /jobs/{id}/refresh` with optional `Authorization: Bearer` token.

### Changed

- **All frontend API calls send credentials.** A `req()` wrapper in `api.ts` sets `credentials: 'include'` on every request so the scoping cookie is transmitted; the refresh-job `EventSource` uses `withCredentials: true`.
- **Worker terminal writes are atomic** (`backend/worker.py`) — The success and partial-salvage completion paths now call `persist_job(...)` once instead of three fire-and-forget `_JobProxy` writes, fixing a race where `status="done"` could persist before `result`.
- **`POST /import` reads a capped stream** (`backend/main.py`) — Signature/body handling changed to stream-read with a hard byte cap and persist the completed job via `persist_job` (owner-scoped).
- **Startup no longer spawns `_cleanup_ephemeral_stores`** (`backend/main.py`) — The in-memory sweep task is removed; expired OAuth state and share tokens are pruned inline by their DB helpers.

### Fixed

- **`export_maintainers` called with keyword arguments** (`backend/worker.py`) — The positional `False, False` (`skip_codeowners`, `skip_collaborators`) are now passed by name, guarding against signature drift.
- **Build-breaking stray file removed** (`frontend/src/error_test.ts`) — This file (`const a: number = 'string';`, committed in v1.1.0) failed `tsc` and therefore `npm run build`. Deleted; it was unreferenced.
- **Share-link expiry date comparison** (`backend/store.py`) — Expiry checks use consistent ISO timestamps rather than mixing `isoformat()` with SQLite `datetime('now')` (whose differing separators broke string comparison).
- **`httpx` missing from `backend/requirements.cloudrun.txt`** — `backend/main.py` imports `httpx` (GitHub OAuth token/profile exchange), but the Cloud Run requirements file omitted it, so OAuth would `ImportError` at runtime on Cloud Run. Added `httpx>=0.27.0`.
- **Misleading dependency comments corrected** — `backend/requirements.txt` no longer claims a `file://` local install; `Dockerfile.cloudrun` no longer claims a non-existent commit pin or that `repo-people` is unpublished (1.0.0 and 1.0.1 are on PyPI).

### Removed

- **Dead store helpers deleted** (`backend/store.py`) — Unused `all_job_ids()` and `clear_summary_caches()` removed.
- **In-memory `_oauth_states` / `_share_tokens` dicts** (`backend/main.py`) — Replaced by the DB-backed tables above.

### Dependencies

- **`repo-people` pinned to `==1.0.1` across all four install paths.** `repo-people` is the data engine (role fetchers and profile lookups in `backend/worker.py`), but it was installed inconsistently: `backend/requirements.txt` used `>=1.0.0` (PyPI), while `Dockerfile.cloudrun` and `.github/workflows/build_test.yml` installed from **unpinned** `git+https://…/repo-people.git` (default branch HEAD) — so Vercel/local and Cloud Run/CI could run different versions, and git builds were not reproducible despite a comment claiming a commit pin. All four now install `repo-people==1.0.1` from PyPI (verified to expose every export function the worker calls). Bump deliberately.
- **`.github/dependabot.yml`** (new) — Weekly update PRs for `pip` (`/backend`), `npm` (`/frontend`), and `github-actions`, so a new `repo-people` (or any dependency) release surfaces as a reviewable PR instead of silently changing at build time.
- **`Dockerfile.cloudrun` simplified** — Removed the separate unpinned `git+https` install of `repo-people` and the now-unneeded `git` apt layer; the image installs everything (including pinned `repo-people`) from `requirements.cloudrun.txt`.
- **`.github/workflows/build_test.yml`** — CI now installs runtime deps from `requirements.cloudrun.txt` (the same file Cloud Run uses) plus test-only `pytest`/`pytest-asyncio`, instead of an ad-hoc list topped by the unpinned git install — so CI tests the exact version that ships.

### Tests

- **Backend — `tests/backend/test_api_ownership.py`** (new) — 8 tests: owners see their own jobs in the list; other callers don't; other callers get `404` on read/delete; legacy `NULL`-owner jobs stay public; `/import` mints an anonymous cookie; refresh returns `409` without saved params and `404` for non-owners.
- **Backend — `tests/backend/test_api_import.py`** — Added `test_unsafe_urls_are_stripped` asserting `javascript:`/`data:` URL fields are blanked while `https` URLs survive.
- **Backend — `tests/backend/test_api_results.py`** — `TestShareEndpoints` expired-token test updated to the DB-backed store (expired tokens now return `404` and are pruned on access); the paginated-share assertion corrected to `len(SAMPLE_USERS)`.

---

## [Unreleased] — 2026-05-13

### Added

- **Paginated "Load more" for Results** (`frontend/src/views/ResultsView.tsx`, `frontend/src/utils/api.ts`) — `loadJob` now fetches only the first page of results (up to 200 users) for fast initial render. A "Load more (N remaining)" button below the table fetches successive pages on demand via `fetchResultsPage()`. The header shows "showing X of Y users" when partial data is loaded.
- **CONTRIBUTORS.md download** (`frontend/src/views/ResultsView.tsx`) — A "CONTRIBUTORS" button in the export row generates and downloads a `CONTRIBUTORS_<repo>.md` file. Users are sorted by role count then followers and rendered as a Markdown table with avatar, name, login (linked), roles, followers, and location.
- **Shareable job URL** (`backend/main.py`, `frontend/src/views/ResultsView.tsx`, `frontend/src/utils/api.ts`, `frontend/src/App.tsx`) — A "Share" button creates a 24-hour read-only token via `POST /results/{job_id}/share` and copies the link to the clipboard. Recipients who open the link (`#share=TOKEN`) are shown the results immediately without authentication. Tokens are stored in-memory in `_share_tokens` and automatically pruned by the background cleanup task. `GET /share/{token}` supports the same `page` / `page_size` query parameters as the main results endpoint.
- **Rate limit display in Fetch progress** (`frontend/src/views/FetchView.tsx`) — The progress row now shows "N API calls left · resets in Xm" alongside ETA. The label turns amber when fewer than 100 calls remain.
- **Warning log lines** (`frontend/src/views/FetchView.tsx`) — A new `warning` SSE event type is handled client-side and rendered in amber in the live log panel.
- **Column visibility localStorage persistence** (`frontend/src/components/UserTable.tsx`) — The user's column show/hide choices are saved to `localStorage` under the key `repo-people-col-visibility` and restored on next visit. Unknown keys in storage are merged with the current defaults.
- **Improved empty state in Results view** (`frontend/src/views/ResultsView.tsx`) — When no completed jobs exist, a centred card with an icon and "Go to Fetch →" button replaces the previous plain text message.
- **OAuth help step in Help modal** (`frontend/src/App.tsx`) — A new "Sign in with GitHub (OAuth)" step explains the popup OAuth flow, session duration, and how to sign out.
- **Extended "Explore Results" bullets** (`frontend/src/App.tsx`) — The existing step now lists overlap analysis, geographic world map, email/social analysis, CONTRIBUTORS.md export, and shareable URL as available capabilities.

### Changed

- **`fetchResults` in `api.ts`** — Remains available for full transparent fetch but is now supplemented by `fetchResultsPage` for incremental loading.
- **`_cleanup_ephemeral_stores` background task** (`backend/main.py`) — The startup event now spawns a background coroutine that sweeps expired `_oauth_states` (>10 min) and `_share_tokens` (past `expires_at`) every 5 minutes. This replaces the previous inline pruning in `/auth/login`.

### Fixed

- **`_oauth_states` memory leak** (`backend/main.py`) — Inline state pruning on every `/auth/login` call is removed; expiry is handled exclusively by the background cleanup task.
- **Per-role fetch error isolation** (`backend/worker.py`) — Role-level exceptions are caught inside `_fetch_role`, classified with `_classify_role_error()`, and emitted as `warning` SSE events. The overall fetch continues with remaining roles rather than aborting. Friendly messages cover 401, 403, 404, 429, and generic errors.
- **Rate limit tracking in worker** (`backend/worker.py`) — `_fetch_with_sem` reads `gh.rate_limiting` and `gh.rate_limiting_resettime` after each user fetch and emits `warning` SSE events when remaining calls cross the 500, 200, 100, and 50 thresholds. The `progress` event now includes `rate_limit_remaining` and `rate_limit_reset`.

### Tests

- **Backend — `tests/backend/test_api_results.py`** (`TestShareEndpoints`) — 8 async integration tests covering `POST /results/{id}/share` (200 with token/url/expires_at, 404 missing job, 409 non-done job) and `GET /share/{token}` (200 with users/total/pages, correct user content, pagination, 404 bad token, 410 expired token with auto-prune verification).

---

## [Unreleased] — 2026-05-12

### Added

- **Fetch limit presets** (`frontend/src/views/FetchView.tsx`) — Quick-select buttons (Top 50 / Top 200 / Top 500 / All) above the custom limit input let users jump to common fetch sizes in one click. The active preset is highlighted; "All" clears the limit field. The hosted-app cap is still respected when the `VITE_FETCH_LIMIT` environment variable is set.
- **Advanced client-side filter panel** (`frontend/src/components/UserTable.tsx`) — A "Filters" button above the table opens a collapsible panel with six filter inputs: location (contains), company (contains), minimum followers, maximum followers, joined-after date, and joined-before date. An active-filter count badge appears on the button when any filter is set. A "Reset all filters" link clears every input at once. The table footer shows "Showing X of Y users" whenever a filter reduces the visible set.
- **Bot / spam heuristic detection** (`frontend/src/components/UserTable.tsx`, `frontend/src/utils/errors.ts`) — `computeBotScore()` assigns a 0–100 risk score based on five signals: zero followers (+25), zero public repos (+20), account age under 180 days (+20), missing name/bio/location (+15), and a generated-username pattern (+20). Accounts already flagged `is_bot` by the backend receive 100 automatically. Accounts scoring ≥ 60 show an amber ⚠ icon next to their login name. A "Hide likely bots" toggle in the filter panel removes flagged accounts from view. A `bot_score` column (hidden by default) can be enabled via the Columns picker.
- **Improved error messages** (`frontend/src/utils/errors.ts`, `frontend/src/views/FetchView.tsx`) — `friendlyFetchError()` in the new `src/utils/errors.ts` module maps HTTP status codes and error keywords to actionable user messages: 401 / bad credentials → PAT expiry guidance; 429 / secondary rate limit → wait + reduce workers; 403 + rate limit → rate limit with PAT upsell; 403 forbidden → access denied with scope hint; 404 / repository not found → spelling check; 422 → invalid characters; 503 → GitHub unavailable; network errors → backend connectivity check. The fetch form error area now shows contextual sub-hints for rate-limit and not-found cases.
- **`GET /clear_cache` dev endpoint** (`backend/main.py`, `backend/store.py`) — Dev-only endpoint (excluded from the OpenAPI schema) that deletes every job from the database and clears the in-memory runtime overlay via `clear_all_jobs()`. The JSON response reports how many jobs were deleted with correct singular/plural wording. Visiting `http://localhost:5173/clear_cache` in the browser also clears `sessionStorage`, `localStorage` (jobs + search history), and redirects to the app root — wired via a Vite dev-proxy rule (`vite.config.ts`) and a pre-mount intercept in `main.tsx`.

### Tests

- **Frontend — `src/tests/components/UserTable.test.ts`** — 11 unit tests for `computeBotScore`. Covers: backend-flagged bots (→100), legitimate popular users (→0), each individual signal contribution (followers, repos, account age, profile completeness, login pattern), score cap at 100, confirmed spam accounts score ≥ 60, and legitimate low-follower developers score < 60.
- **Frontend — `src/tests/utils/errors.test.ts`** — 16 unit tests for `friendlyFetchError`. Covers all mapped error patterns (401, 403, 404, 422, 429, 503, secondary rate limit, network errors) and the passthrough case for unknown messages. Tests include owner/repo interpolation and the absence of `undefined` in error text when owner/repo are omitted.

---

## [Unreleased] — 2026-05-06

### Security

- **Token moved out of request body.** The GitHub personal access token is now sent as an `Authorization: Bearer <token>` HTTP header rather than a JSON body field. This prevents the token from appearing in server access logs, request traces, or browser history. Updated `FetchRequest` model (removed `token` field), `POST /fetch` handler (reads header), `api.ts` `postFetch()` (builds header conditionally), and `FetchView.tsx` (passes token as second argument).
- **CORS origins configurable via environment variable.** Allowed origins are now read from the `CORS_ORIGINS` environment variable (comma-separated). Defaults to `http://localhost:5173,http://127.0.0.1:5173` for local development. This prevents wildcard CORS in production deployments.
- **Worker count capped at 20.** `FetchRequest.workers` is now validated as `ge=1, le=20` via Pydantic `Field`, preventing unbounded thread-pool resource exhaustion.
- **Import payload size limit.** `POST /import` now reads `content-length` before parsing JSON and returns `HTTP 413` if the payload exceeds 5 MB, guarding against large-payload denial-of-service.
- **Worker exceptions no longer leak internals.** Unhandled exceptions in `run_fetch_job` are now logged server-side with full tracebacks via `logging.exception`, while the SSE event and `job["message"]` field receive only the sanitised string `"An internal error occurred during fetch. Check server logs for details."` — preventing stack traces and file paths from reaching the client.

### Added

- **`RenameJobRequest` model** (`backend/models.py`) — Pydantic model with `label: str = Field(..., min_length=1, max_length=120)` used by `PATCH /jobs/{id}`. Replaces ad-hoc dict parsing and enforces label constraints at the framework layer.
- **`TagsRequest` model** (`backend/models.py`) — Pydantic model for `PATCH /jobs/{id}/tags` with a `@field_validator` that enforces a maximum of 10 tags, each at most 50 characters.
- **`create_job_async()` store function** (`backend/store.py`) — Async counterpart to `create_job()` that awaits the SQLite insert before returning, eliminating the race condition where the background worker could start writing results before the job row existed in the database.
- **`load_jobs_list()` store function** (`backend/store.py`) — Single `SELECT` query that fetches `job_id, status, total_fetched, label, created_at, tags` for all jobs in one round-trip, used by `GET /jobs` to eliminate the prior N+1 per-job query pattern.
- **`_log_task_error()` callback** (`backend/store.py`) — Done-callback attached to all fire-and-forget `asyncio.Task` objects to surface silent background exceptions in the server log.
- **`ErrorBoundary` component** (`frontend/src/components/ErrorBoundary.tsx`) — React class component that catches runtime errors in the component tree and renders a styled fallback UI with a "Try again" reset button, preventing a single view crash from taking down the whole application.
- **Hash-based routing** (`frontend/src/App.tsx`) — `view` state is now initialised from `window.location.hash` on load and kept in sync via a `hashchange` listener and a `useEffect` that writes back to the hash on view change. Enables browser back/forward navigation between views and bookmarkable URLs.
- **Pagination support on `GET /results/{job_id}`** (`backend/main.py`) — Endpoint now accepts `page` and `page_size` query parameters (defaults: `page=1`, `page_size=200`, max `page_size=1000`) and returns `{ "users": {...}, "total": N, "page": P, "page_size": PS, "pages": Q }`.
- **Summary caching on `GET /results/{job_id}/summary`** (`backend/main.py`) — Computed summary is stored in `job["summary"]` on first request and returned directly on subsequent calls, avoiding redundant computation over large result sets.
- **`postImport` API function** (`frontend/src/utils/api.ts`) — Client-side function for `POST /import` with typed return value `{ job_id, total_imported }`.
- **SSE reconnect logic** (`frontend/src/views/FetchView.tsx`) — The SSE connection is now wrapped in a `connectSSE()` function with up to 3 automatic reconnect attempts on unexpected close, with exponential backoff (`attempt × 1000 ms`).

### Changed

- **`POST /fetch` — `token` removed from `FetchRequest` body.** Token is now read exclusively from the `Authorization` header. Existing clients sending a `token` field in the JSON body will have it ignored (no breaking 422 — field simply isn't in the model).
- **`GET /jobs` — N+1 query eliminated.** The endpoint now calls `load_jobs_list()` which issues a single `SELECT` covering all job metadata, replacing per-job `get_job()` calls.
- **`PATCH /jobs/{id}` — typed `RenameJobRequest` body.** The endpoint now accepts a `RenameJobRequest` body. Labels must be 1–120 characters; missing or empty labels return `HTTP 422` instead of silently succeeding.
- **`PATCH /jobs/{id}/tags` — typed `TagsRequest` body.** Tag validation (max 10 tags, max 50 chars each) is now enforced at model level before any handler logic runs.
- **`POST /import` — reads raw `Request` for size check.** Endpoint signature changed from `payload: dict` (FastAPI auto-parse) to `request: Request` so that `content-length` can be inspected before the body is decoded.
- **`asyncio.ensure_future` → `asyncio.create_task`** across `store.py` and `worker.py`. `create_task` requires a running event loop (the correct contract for async code) and supports done-callbacks for error surfacing. `ensure_future` silently swallowed exceptions.
- **Hardcoded `/tmp` replaced with `tempfile.gettempdir()`** (`backend/worker.py`). Partial-result checkpoint files now use the OS-appropriate temp directory, fixing compatibility on Windows and systems where `/tmp` is not writable.
- **`fetchResults` handles paginated response** (`frontend/src/utils/api.ts`). Transparently fetches all pages and merges them into a single flat dict keyed by login, preserving the existing call-site contract.
- **`GlobalSearchModal` uses `useDeferredValue`** (`frontend/src/components/GlobalSearchModal.tsx`). The `results` memo now depends on `deferredQuery` rather than the raw `query` state, deferring expensive filter work while the user is typing.
- **xlsx import is lazy-loaded** (`frontend/src/views/ResultsView.tsx`). The `xlsx` library (≈ 800 kB) is no longer in the initial bundle; it is dynamically imported only when the user triggers an XLSX export.
- **Avatar fallback updated** (`frontend/src/components/UserDrawer.tsx`). The placeholder for missing `avatar_url` is now `https://github.com/ghost.png` (the official GitHub ghost avatar) instead of a non-canonical URL.
- **Error boundaries added to all main views** (`frontend/src/App.tsx`). `FetchView`, `ResultsView`, and `CompareView` are each wrapped in `<ErrorBoundary>`, ensuring view-level crashes are caught and presented gracefully.
- **HelpModal token scope guidance corrected** (`frontend/src/App.tsx`). The instruction previously stated no scopes were needed for public repos; the correct guidance now reads: *"Grant the `read:user` and `public_repo` scopes (required for profile data and repository access)"*.

### Removed

- **`NetworkGraph` component deleted** (`frontend/src/components/NetworkGraph.tsx`). The force-directed network graph was an incomplete, unperformant placeholder. It has been removed along with its imports to reduce bundle size.
- **`token` field removed from `FetchRequest`** (`backend/models.py`). See Security — S1.

### Fixed

- **`PATCH /jobs/{id}` used synchronous `get_job()`** which could fail to find a job that was created in the same request cycle. The handler now uses `await get_job_async()`.
- **Summary recomputed on every request.** Fixed by caching the computed summary in the job object on first calculation.
- **`asyncio.ensure_future` deprecated and exception-unsafe.** Replaced with `asyncio.create_task` throughout `worker.py`.
- **Race condition between job creation and worker start.** `POST /fetch` and `POST /import` now both use `create_job_async()`, ensuring the SQLite row is committed before the background task begins writing to it.
- **Hardcoded `/tmp` path in worker.** Replaced with `tempfile.gettempdir()`.
- **Incorrect token scope instructions in HelpModal.** Corrected as noted above.
- **SSE connection dropped without reconnect.** Added reconnect logic with exponential backoff in `FetchView.tsx`.
- **N+1 query on `GET /jobs`.** Fixed via `load_jobs_list()` single-query implementation.
- **Large result sets returned in a single response.** Fixed by adding server-side pagination with client-side transparent page merging.
- **Summary recalculated on every `GET /results/{id}/summary` call.** Fixed by caching on the job object.
- **Search filter ran on every keystroke in `GlobalSearchModal`.** Fixed via `useDeferredValue`.
- **`xlsx` library loaded eagerly in initial JS bundle.** Fixed via dynamic import on demand.
- **No browser history support between views.** Fixed via hash-based routing.
- **Uncaught render errors crashed the entire app.** Fixed via `ErrorBoundary` wrappers.
- **Unused `NetworkGraph` component inflated bundle.** Removed.
- **Invalid avatar fallback URL.** Replaced with `https://github.com/ghost.png`.
- **Summary endpoint recomputed on every call.** Fixed via caching.

### Tests

- **Backend — `tests/backend/test_api_results.py`**: Updated `TestGetResults` for the new paginated response envelope (`data["users"]` instead of bare `data`). Added assertions for `total`, `page`, and `pages` fields. Added `test_pagination_page_param` to cover `page` and `page_size` query parameters.
- **Backend — `tests/backend/test_api_jobs.py`**: Updated `TestPostFetch` — removed `token` from JSON bodies, added `test_no_token_in_header_still_accepted`, `test_token_in_auth_header_accepted`, and `test_invalid_owner_chars_returns_422`. Updated `TestRenameJob` — replaced tests for permissive behaviour (truncation, empty string, missing field) with correct `HTTP 422` assertions that reflect the new `RenameJobRequest` validation.
- **Backend — `tests/backend/test_api_import.py`**: Updated comment to reflect `create_job_async()` usage.
- **Frontend — `src/tests/api.test.ts`**: Updated `postFetch` tests — calls now pass the token as a second argument; added `sends token as Authorization Bearer header` and `omits Authorization header when no token provided` test cases; asserted `body.token` is `undefined`. Updated `fetchResults` tests — mocks now return the paginated envelope format; added `merges multiple pages into a single dict` test. Added `postImport` describe block with 5 test cases covering the happy path, typed return, `HTTP 413`, and `HTTP 500`.

---

## [Unreleased] — 2026-05-19

### Added

- **Search history** (`frontend/src/views/FetchView.tsx`): Recently searched `owner/repo` pairs are persisted in `localStorage` under `repo-people-search-history` (max 10 entries). A "Recent searches" dropdown appears below the repo inputs, allowing one-click re-population of the form. Entries are saved on successful fetch completion and can be cleared via a "Clear all" button.
- **Overlap analysis** (`frontend/src/views/ResultsView.tsx`): New "Overlap Analysis" card showing role pair co-occurrence counts as a bar chart and a "Most engaged" chip list of users appearing in two or more roles (e.g. starred and forked and contributed).
- **Growth over time chart** (`frontend/src/views/ResultsView.tsx`): New "Growth Over Time" area chart plotting cumulative user count by GitHub account creation month, revealing when community interest surged.
- **Virtual scrolling in `UserTable`** (`frontend/src/components/UserTable.tsx`): Replaced the manual `visibleCount`/`PAGE_SIZE` pagination footer with `@tanstack/react-virtual`. Only rows in the visible viewport are rendered in the DOM; the scrollable container has a fixed 520 px max-height with `overscan: 10` for smooth scrolling.
- **Client-side result caching** (`frontend/src/utils/api.ts`): `fetchResults` and `fetchSummary` now cache responses in `sessionStorage` with a 5-minute TTL (keys: `rp:{jobId}:{endpoint}`). Switching between jobs within a session avoids redundant API calls. `invalidateJobCache(jobId)` clears all cached entries for a job and is called automatically when a job is deleted.

### Tests

- **Frontend — `src/tests/api.test.ts`**: Added `sessionStorage.clear()` to `beforeEach` to prevent cache bleed between tests. Added `invalidateJobCache` to the import list. Added cache-hit tests for `fetchResults` and `fetchSummary` (second call must not issue a new network request). Added `invalidateJobCache` describe block with two test cases: verifying cache entries are removed for the specified job and that entries for other jobs are left intact.
