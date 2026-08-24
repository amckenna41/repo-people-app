# Supabase as the database for repo-people-app

An assessment of whether to adopt Supabase, written against the current code
(`backend/store.py`, `backend/main.py`, `cloudrun-service.yaml`) rather than
from the feature list.

---

## Verdict

**There is a real use case, but it is a use case for _managed Postgres_, not for
Supabase specifically.**

The app already speaks Postgres. `store.py` reads `DATABASE_URL` and switches
driver, and every query in the module is written to be dialect-agnostic
(`_sql()` rewrites `?` → `%s`; timestamps come from Python, not `datetime('now')`;
no `INSERT OR REPLACE`). Adopting Supabase is therefore *provisioning plus one
environment variable*, not a migration.

The question worth actually deciding is not "SQLite or Supabase" — it is
"which managed Postgres", and that turns on region and cost rather than
features. Supabase's differentiators (Auth, Row Level Security, Storage,
Realtime) mostly duplicate things this app already implements itself.

**Recommendation:** adopt managed Postgres — this is overdue and fixes a live
data-loss bug. Choose Supabase **only if** you want the Realtime channel or the
dashboard enough to accept cross-cloud latency; otherwise Cloud SQL is the
better operational fit for a Cloud Run backend. See
[Alternatives](#5-alternatives) and [Decision criteria](#7-decision-criteria).

---

## 1. What the storage layer does today

Five tables, all created and migrated in `_init_schema()`:

| Table | Holds | Notes |
|---|---|---|
| `jobs` | fetch jobs + full results | `result_json` is the whole `{login: record}` map as one JSON string |
| `sessions` | GitHub OAuth sessions | `github_token` is Fernet-encrypted at rest |
| `oauth_states` | OAuth CSRF state | single-use, 10-min TTL |
| `share_tokens` | 24h read links | |
| `schedules` | recurring re-fetch config | |

Alongside these sits `_runtime`, an in-process dict holding the per-job
`asyncio.Queue` and `cancelled` flag. This is **deliberately not persistable** —
an SSE stream is served by the instance running the job. No database choice
changes that.

Two backends are supported today:

- **SQLite** (default) — file at `REPO_PEOPLE_DB`.
- **Postgres** — when `DATABASE_URL` is set, via `psycopg` with an
  `AsyncConnectionPool(min_size=1, max_size=10)`.

---

## 2. The problems that actually justify the change

These are real, present defects — not hypotheticals.

### 2.1 Production data is destroyed on every cold start (severity: high)

`Dockerfile.cloudrun` sets `REPO_PEOPLE_DB=/tmp/repo_people_jobs.db`. Cloud Run's
`/tmp` is instance-local and ephemeral. Every scale-to-zero, redeploy, or
instance recycle silently discards **every job, result, session, share link and
schedule**.

The consequences compound:

- A user signs in, and their session vanishes on the next cold start.
- A 24-hour share link stops working long before 24 hours.
- The churn/retention feature (`/jobs/{id}/history`) diffs *runs of the same
  repo over time* — it is structurally unable to work when history does not
  survive the week.
- Scheduled re-fetch writes results nobody will ever read.

Roughly a third of the v1.1.0 feature set assumes durable storage that the
deployed configuration does not provide. This alone justifies the move.

### 2.2 The service cannot scale beyond one instance

`cloudrun-service.yaml` pins `maxScale: "1"`, and the comment states plainly
that this is required *only* because of the SQLite fallback. Shared storage
lifts that constraint and unblocks three things:

- **Horizontal scale.** Currently one container serves all traffic, with
  `containerConcurrency: 80` and fetch jobs that hold connections open for
  minutes.
- **Schedule claiming.** `claim_due_schedules()` carries a `ponytail:` note that
  it uses read-then-write instead of `SELECT … FOR UPDATE SKIP LOCKED`
  *because SQLite has no row locking*. On Postgres the correct primitive becomes
  available, and the documented worst case (duplicate re-fetches under
  multi-instance) goes away.
- **Rate limiting.** `_rate_check` is an in-memory per-instance window, flagged
  in `main.py` as needing Redis above one instance. Note this is **not** solved
  by Postgres — see [§6.3](#63-what-postgres-does-not-fix).

### 2.3 No backups, no point-in-time recovery

There is currently no backup story at all, because there is nothing durable to
back up. Any managed Postgres provides automated backups and PITR.

---

## 3. Mapping Supabase's features onto this app

This is where the case for *Supabase specifically* gets thin. Honest column:

| Supabase feature | Useful here? | Why |
|---|---|---|
| **Managed Postgres** | ✅ **Yes** | The whole justification. Drop-in via `DATABASE_URL`. |
| **Automated backups / PITR** | ✅ Yes | Addresses §2.3. Not unique to Supabase. |
| **Connection pooling (Supavisor)** | ✅ Yes | Genuinely helpful for Cloud Run, where instances come and go and each holds a `psycopg` pool. |
| **Dashboard / SQL editor** | 🟡 Minor | Convenient for inspecting `jobs` without writing a script. Real but small. |
| **Realtime** | 🟡 Interesting | Could replace the per-instance SSE queue and fix a known bug — see §4. Speculative. |
| **Row Level Security** | ❌ No | Ownership is enforced in the application layer (`_can_access`, `owner_key`) and covered by tests. RLS would duplicate it, and the backend connects as one service role anyway — there is no per-user DB identity to key policies on. |
| **Supabase Auth** | ❌ No | The app has its own GitHub OAuth flow: browser-bound state cookie, Fernet-encrypted tokens, 30-day sessions. Migrating would mean discarding hardened, tested code to solve a problem that is already solved. |
| **Storage** | ❌ No | No blobs. Exports are generated on demand and streamed. |
| **Edge Functions** | ❌ No | The backend is FastAPI on Cloud Run. |

**Four of nine capabilities are unused, and two of those (Auth, RLS) would be
actively regressive to adopt.** You would be buying a Postgres host and leaving
most of the platform on the shelf. That is a perfectly reasonable thing to do —
but it should be a conscious choice, not a assumed win.

---

## 4. The one genuinely interesting Supabase-specific angle

There is a known, documented bug in `CHANGELOG.md` under *Known and not fixed*:

> Two browser tabs streaming the same job split its events between them.
> `asyncio.Queue.get()` is destructive and there is one queue per job, so each
> tab receives roughly half the log lines.

The same architecture also means SSE only works because `maxScale: 1` guarantees
the streaming client lands on the instance running the job. **Lifting `maxScale`
to fix §2.2 would break live progress streaming** unless the fan-out problem is
solved first — the two issues are coupled, and it is worth being explicit about
that before raising the cap.

Supabase Realtime (Postgres logical replication → WebSocket) could invert this:
the worker writes progress rows, and every subscribed tab receives every event
regardless of which instance serves it. That fixes the split-events bug *and*
unblocks multi-instance streaming in one move.

**But be honest about the cost:** it means rewriting `stream_job`, the worker's
`emit`, and the client's `EventSource` handling — and writing one row per fetched
user (up to 500 per job) purely to drive a progress bar. A Redis pub/sub channel
or sticky sessions would achieve the same thing more cheaply. Treat this as a
tie-breaker if you already want Supabase, not as a reason to choose it.

---

## 5. Alternatives

| Option | Region vs Cloud Run | Scale-to-zero | Notes |
|---|---|---|---|
| **Cloud SQL (Postgres)** | ✅ Same GCP region | ❌ (min instance billed) | Lowest latency; IAM and private VPC integration; most expensive at idle. |
| **Supabase** | ❌ AWS — cross-cloud | 🟡 (free tier pauses) | Best DX and dashboard; Supavisor pooling; the extras mostly go unused here. |
| **Neon** | ❌ AWS/Azure — cross-cloud | ✅ True scale-to-zero | Closest fit to a bursty, low-traffic workload; branching is useful for preview deploys. |
| **Stay on SQLite** | n/a | n/a | Only viable if you accept §2.1, i.e. treat the deployment as a demo. |

The app is deployed on **Cloud Run (GCP)**, and the frontend on Vercel. Any
non-GCP database puts a public-internet hop on every query.

---

## 6. What to watch if you proceed

### 6.1 Cross-cloud latency meets a `SELECT *` access pattern

This is the most important technical caveat, and it is about *this codebase*
rather than about Supabase.

`_load_job_row()` runs `SELECT * FROM jobs WHERE job_id = ?` — which pulls
`result_json` in full. Measured on the local database, a stored record averages
**~1.3 KB per user** (a 309-user job occupies ~400 KB). At the hosted
`FETCH_LIMIT=500` that is **~650 KB per row**.

Every ownership check goes through that query. `_get_owned_job()` is called by
`/results`, `/summary`, `/top`, `/export/*`, `/compare`, `/share`, `PATCH`,
`DELETE` and `/stream` — so a request that only needs `status` and `owner_key`
transfers the entire result blob.

This is already wasteful on a local socket. Over a cross-cloud link it becomes
the dominant cost. And it now multiplies: `fetchAllResultPages` (added in v1.1.0
so charts and exports cover the whole result set) issues one request per page,
and **each page re-reads and re-parses the full blob**. An uncapped local job of
10,000 users would move on the order of 13 MB per page request.

**Fix this before or alongside any remote database**, independent of vendor:

1. Add a lightweight `SELECT status, owner_key, repo_owner, repo_name … ` path
   for ownership checks, and only fetch `result_json` when results are needed.
2. Consider moving results out of a single JSON column into a `job_users` table,
   so pagination becomes `LIMIT/OFFSET` in SQL instead of "load 650 KB, parse,
   filter in Python, slice". This would also let `_filter_sort_users` become a
   `WHERE` clause and make `logins_json` redundant.

Item 2 is a larger change and not a prerequisite. Item 1 is small and pays for
itself immediately.

### 6.2 Connection pooling and instance churn

Each Cloud Run instance opens its own `AsyncConnectionPool(max_size=10)`. With
`maxScale` raised, concurrent instances multiply that. Supabase's direct
connections are limited on smaller tiers — **use the Supavisor pooler
connection string**, not the direct one. `close_pool()` is already wired to
shutdown, which helps.

### 6.3 What Postgres does not fix

Being explicit, so the change is not oversold:

- **Rate limiting** (`_rate_check`) stays per-instance and in-memory. Above one
  instance a caller gets N× their budget. Needs Redis or a DB-backed counter.
- **The scheduler** (`_schedule_loop`) remains an in-process asyncio loop
  requiring `minScale: 1`. Postgres enables safe claiming via
  `FOR UPDATE SKIP LOCKED`, but does not make the loop itself durable.
- **SSE fan-out** — see §4.

---

## 7. Decision criteria

Choose **Supabase** if: you want the dashboard and DX, may use Realtime for the
SSE rework, and are comfortable with an AWS-hosted database serving a GCP
backend.

Choose **Cloud SQL** if: query latency and staying inside one cloud/IAM boundary
matter more than DX. This is the default recommendation for a Cloud Run backend.

Choose **Neon** if: the traffic is bursty and idle cost dominates — true
scale-to-zero suits a service that currently pins `minScale: 1` mainly for the
scheduler.

Do nothing only if: the deployment is a demo and §2.1 is acceptable.

---

## 8. If you proceed — concrete steps

The code change is genuinely near-zero; the work is provisioning and verification.

1. Provision the database. For Supabase, take the **pooler** (Supavisor)
   connection string.
2. Store it in Secret Manager and reference it from `cloudrun-service.yaml` —
   the commented `DATABASE_URL` block is already in place next to
   `SESSION_TOKEN_KEY`.
3. Set `SESSION_TOKEN_KEY` at the same time if it is not already set. It is
   currently optional and falls back to a per-process ephemeral key, which
   silently invalidates every session on restart — a durable database makes that
   fallback the remaining cause of session loss.
4. Deploy. `_init_schema()` creates tables and applies the additive migrations
   on first connection; the Postgres branch already uses
   `ADD COLUMN IF NOT EXISTS` because Postgres aborts the transaction on a
   duplicate-column error.
5. **Verify the dialect shim under load.** Nine `IS_POSTGRES` branches exist and
   the backend test suite runs against SQLite only — the Postgres path is
   effectively untested. Run the suite against a real Postgres instance before
   trusting it (`DATABASE_URL=… pytest tests/backend`), and expect to fix a
   thing or two.
6. Only then raise `maxScale` — and read §4 first, because SSE streaming
   currently depends on `maxScale: 1`.

### Note on migrating existing data

There is nothing to migrate in production: the Cloud Run SQLite file has already
been discarded many times over. Local development databases can simply be left
behind, or re-imported through `POST /import`.

---

## Summary

| Question | Answer |
|---|---|
| Is there a use case? | **Yes** — the current deployment loses all data on every cold start, and three features silently depend on durability it does not have. |
| Is it a use case for *Supabase*? | Partly. The value is managed Postgres, which any provider supplies. Four of nine Supabase capabilities are unused here, and two would be regressive. |
| How much code changes? | Near zero. `store.py` is already dialect-agnostic; this is one environment variable. |
| Biggest risk? | Cross-cloud latency amplifying the existing `SELECT *`-loads-the-whole-blob access pattern (§6.1). Worth fixing regardless of vendor. |
| Biggest hidden dependency? | SSE streaming currently relies on `maxScale: 1`; fixing durability tempts you to raise it, which breaks streaming until fan-out is solved (§4). |
