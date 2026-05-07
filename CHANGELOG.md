# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
