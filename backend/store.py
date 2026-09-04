from __future__ import annotations
import asyncio
import io
import csv
import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

_logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Session token encryption
# ---------------------------------------------------------------------------
# sessions.github_token holds a live GitHub OAuth token for up to 30 days, so a
# database dump used to hand over every user's credentials in plaintext. Tokens
# are now encrypted at rest with Fernet (AES-128-CBC + HMAC).
#
# SESSION_TOKEN_KEY must be a urlsafe-base64 32-byte key — generate one with:
#   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
# and store it in Secret Manager. Without it a per-process ephemeral key is used,
# which is still safe but invalidates every session on restart.
# ---------------------------------------------------------------------------

_TOKEN_KEY = os.environ.get("SESSION_TOKEN_KEY", "").strip()
if _TOKEN_KEY:
    _fernet = Fernet(_TOKEN_KEY.encode())
else:
    _fernet = Fernet(Fernet.generate_key())
    _logger.warning(
        "SESSION_TOKEN_KEY is not set — using an ephemeral encryption key. "
        "Every OAuth session will be invalidated when this process restarts. "
        "Set SESSION_TOKEN_KEY to a persistent Fernet key in any real deployment."
    )


def _encrypt_token(token: str) -> str:
    return _fernet.encrypt(token.encode()).decode()


def _decrypt_token(blob: str) -> str | None:
    """Decrypt a stored token. Returns None when the ciphertext is unreadable —
    a rotated key, an ephemeral key after restart, or a legacy plaintext row.
    Callers treat that as an invalid session, so the user simply logs in again."""
    try:
        return _fernet.decrypt(blob.encode()).decode()
    except (InvalidToken, ValueError):
        return None

# ---------------------------------------------------------------------------
# Job store — SQLite by default, Postgres when DATABASE_URL is set
# ---------------------------------------------------------------------------
# SQLite keeps state in-process, which means a Cloud Run instance that scales to
# zero loses every job. Set DATABASE_URL to a Postgres connection string for
# durable, multi-instance storage; everything else in this module is written to
# be dialect-agnostic (see _sql()).
#
# The in-memory `_runtime` overlay still holds the per-job asyncio.Queue and
# cancellation flag, which cannot be serialised. Those are inherently
# per-instance: an SSE stream is served by the instance running the job.
# ---------------------------------------------------------------------------

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
IS_POSTGRES = DATABASE_URL.startswith(("postgres://", "postgresql://"))

_DB_PATH = os.environ.get(
    "REPO_PEOPLE_DB",
    os.path.join(os.path.dirname(__file__), "repo_people_jobs.db"),
)

# How long SQLite waits for a competing writer before giving up. The driver
# default (5s) is easily exceeded when several jobs finish together.
# ponytail: a longer wait, not a connection pool. aiosqlite opens a connection
# per _db() call, which is cheap for a local file; revisit if profiling says
# otherwise, or move to Postgres (see docs/supabase-evaluation.md).
_SQLITE_BUSY_TIMEOUT_MS = int(os.environ.get("SQLITE_BUSY_TIMEOUT_MS", "15000"))
_SQLITE_TIMEOUT_SECONDS = _SQLITE_BUSY_TIMEOUT_MS / 1000

# Runtime-only overlay: stores asyncio.Queue and cancelled flag keyed by job_id
_runtime: dict[str, dict[str, Any]] = {}

_pg_pool = None  # lazily created AsyncConnectionPool when IS_POSTGRES


def _utcnow_iso() -> str:
    """Naive UTC ISO timestamp. Naive (no offset suffix) so that string
    comparison against other stored timestamps stays lexicographically correct."""
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()


def _iso_in(seconds: float) -> str:
    return (datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(seconds=seconds)).isoformat()


def _sql(query: str) -> str:
    """Translate the `?` placeholder style used throughout this module into the
    dialect the active driver expects. All other SQL here is written to be
    portable: no `datetime('now')` (timestamps come from Python), and no
    `INSERT OR REPLACE` (every key inserted is a fresh UUID or random token)."""
    if not IS_POSTGRES:
        return query
    return query.replace("?", "%s")


class _Conn:
    """Uniform async cursor API over aiosqlite and psycopg, so callers do not
    branch on the dialect. Returns plain dicts from reads."""

    def __init__(self, raw: Any):
        self._raw = raw

    async def exec(self, query: str, params: tuple | list = ()) -> int:
        if IS_POSTGRES:
            async with self._raw.cursor() as cur:
                await cur.execute(_sql(query), tuple(params))
                return cur.rowcount
        cur = await self._raw.execute(_sql(query), tuple(params))
        try:
            return cur.rowcount
        finally:
            # Leaving cursors open holds a read lock on the table, which makes
            # later DDL fail with "database table is locked".
            await cur.close()

    async def one(self, query: str, params: tuple | list = ()) -> dict | None:
        if IS_POSTGRES:
            from psycopg.rows import dict_row
            async with self._raw.cursor(row_factory=dict_row) as cur:
                await cur.execute(_sql(query), tuple(params))
                return await cur.fetchone()
        async with self._raw.execute(_sql(query), tuple(params)) as cur:
            row = await cur.fetchone()
            return dict(row) if row is not None else None

    async def all(self, query: str, params: tuple | list = ()) -> list[dict]:
        if IS_POSTGRES:
            from psycopg.rows import dict_row
            async with self._raw.cursor(row_factory=dict_row) as cur:
                await cur.execute(_sql(query), tuple(params))
                return list(await cur.fetchall())
        async with self._raw.execute(_sql(query), tuple(params)) as cur:
            return [dict(r) for r in await cur.fetchall()]

    async def commit(self) -> None:
        await self._raw.commit()

    def execute(self, query: str, params: tuple | list = ()):
        """Escape hatch returning the driver's native cursor (SQLite only).
        Prefer exec/one/all — those work on both backends."""
        if IS_POSTGRES:
            raise NotImplementedError("Use exec()/one()/all() — execute() is SQLite-only")
        return self._raw.execute(_sql(query), tuple(params))


_schema_ready = False


async def _init_schema(c: _Conn) -> None:
    """Create tables and apply additive migrations. Runs once per process."""
    global _schema_ready
    if _schema_ready:
        return

    await c.exec("""
        CREATE TABLE IF NOT EXISTS jobs (
            job_id      TEXT PRIMARY KEY,
            status      TEXT NOT NULL DEFAULT 'pending',
            message     TEXT,
            total_fetched INTEGER NOT NULL DEFAULT 0,
            label       TEXT,
            result_json TEXT,
            summary_json TEXT,
            created_at  TEXT
        )
    """)
    await c.exec("""
        CREATE TABLE IF NOT EXISTS sessions (
            session_id   TEXT PRIMARY KEY,
            github_token TEXT NOT NULL,
            github_login TEXT NOT NULL,
            github_name  TEXT,
            github_avatar TEXT,
            created_at   TEXT,
            expires_at   TEXT NOT NULL
        )
    """)
    await c.exec("""
        CREATE TABLE IF NOT EXISTS oauth_states (
            state      TEXT PRIMARY KEY,
            expires_at TEXT NOT NULL
        )
    """)
    await c.exec("""
        CREATE TABLE IF NOT EXISTS share_tokens (
            token      TEXT PRIMARY KEY,
            job_id     TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )
    """)
    # Scheduled re-fetch: re-runs a job's saved params on a fixed interval.
    await c.exec("""
        CREATE TABLE IF NOT EXISTS schedules (
            schedule_id   TEXT PRIMARY KEY,
            owner_key     TEXT NOT NULL,
            source_job_id TEXT NOT NULL,
            params_json   TEXT NOT NULL,
            label         TEXT,
            interval_hours INTEGER NOT NULL,
            next_run_at   TEXT NOT NULL,
            last_run_at   TEXT,
            last_job_id   TEXT,
            enabled       INTEGER NOT NULL DEFAULT 1,
            created_at    TEXT
        )
    """)

    # Additive migrations for pre-existing databases.
    for col, ddl in (
        ("tags",        "ALTER TABLE jobs ADD COLUMN tags TEXT DEFAULT '[]'"),
        ("owner_key",   "ALTER TABLE jobs ADD COLUMN owner_key TEXT"),
        ("params_json", "ALTER TABLE jobs ADD COLUMN params_json TEXT"),
        # Denormalised so history/churn can group runs of the same repo without
        # parsing every params blob.
        ("repo_owner",  "ALTER TABLE jobs ADD COLUMN repo_owner TEXT"),
        ("repo_name",   "ALTER TABLE jobs ADD COLUMN repo_name TEXT"),
        # Just the logins from result_json. Churn/history only ever needs the
        # set of members, and parsing every run's full result blob to rebuild it
        # made /jobs/{id}/history read tens of MB on a hot path.
        ("logins_json", "ALTER TABLE jobs ADD COLUMN logins_json TEXT"),
        # Per-role failures and caps hit during the fetch. These were emitted
        # only on the ephemeral SSE queue, so a user who closed the tab — or who
        # simply looked at the results later — had no way to learn why the set
        # came back smaller than expected.
        ("warnings_json", "ALTER TABLE jobs ADD COLUMN warnings_json TEXT"),
        # How many usernames each role actually contributed. Emitted only to the
        # SSE log before, so a role that returned zero without raising — the
        # signature of a token that lacks the scope for it — left no trace once
        # the fetch tab was closed.
        ("role_counts_json", "ALTER TABLE jobs ADD COLUMN role_counts_json TEXT"),
    ):
        if IS_POSTGRES:
            # Postgres aborts the surrounding transaction on a duplicate-column
            # error, so use IF NOT EXISTS rather than catching.
            await c.exec(ddl.replace("ADD COLUMN", "ADD COLUMN IF NOT EXISTS"))
        else:
            try:
                await c.exec(ddl)
            except Exception:
                pass  # Column already exists

    await c.exec("CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs (owner_key)")
    await c.exec("CREATE INDEX IF NOT EXISTS idx_jobs_repo ON jobs (owner_key, repo_owner, repo_name)")
    await c.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at)")
    await c.exec("CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules (enabled, next_run_at)")
    await c.commit()
    _schema_ready = True


@asynccontextmanager
async def _db():
    """Async context manager yielding an initialised _Conn."""
    if IS_POSTGRES:
        global _pg_pool
        if _pg_pool is None:
            from psycopg_pool import AsyncConnectionPool
            _pg_pool = AsyncConnectionPool(DATABASE_URL, min_size=1, max_size=10, open=False)
            await _pg_pool.open()
        async with _pg_pool.connection() as raw:
            c = _Conn(raw)
            await _init_schema(c)
            yield c
    else:
        import aiosqlite
        async with aiosqlite.connect(_DB_PATH, timeout=_SQLITE_TIMEOUT_SECONDS) as raw:
            raw.row_factory = aiosqlite.Row
            # PRAGMA returns a row, so its cursor must be closed — an open
            # cursor holds a read lock and makes later DDL on this connection
            # fail with "database table is locked".
            async with raw.execute("PRAGMA journal_mode=WAL"):
                pass
            # SQLite serialises writers. Several jobs finishing at once, plus the
            # maintenance and schedule loops, can exceed the default 5s wait and
            # surface as an unexplained 5xx ("database is locked"). Wait longer
            # instead — a slow write beats a failed one.
            async with raw.execute(f"PRAGMA busy_timeout={_SQLITE_BUSY_TIMEOUT_MS}"):
                pass
            # NORMAL is durable under WAL for everything except OS-level crash,
            # and removes an fsync from every commit.
            async with raw.execute("PRAGMA synchronous=NORMAL"):
                pass
            c = _Conn(raw)
            await _init_schema(c)
            yield c


def _log_task_error(task: asyncio.Task) -> None:
    """Done-callback that logs exceptions from fire-and-forget tasks."""
    if not task.cancelled() and task.exception() is not None:
        _logger.error("Background store task failed: %s", task.exception())


# ---------------------------------------------------------------------------
# Runtime overlay (per-instance, not persisted)
# ---------------------------------------------------------------------------

# The worker emits one progress event per user whether or not anyone is
# listening, and nothing drains the queue when the client never opens the SSE
# stream (or disconnects mid-fetch). An unbounded queue therefore held every
# event for the life of the process. Cap it and drop the oldest events instead.
_EVENT_QUEUE_MAX = 500


def _new_runtime() -> dict[str, Any]:
    return {"cancelled": False, "events": asyncio.Queue(maxsize=_EVENT_QUEUE_MAX)}


def emit_event(queue: asyncio.Queue, item: dict[str, Any]) -> None:
    """Put an event on a job's queue without ever blocking the worker.

    When the queue is full the oldest event is discarded. Progress events are
    the bulk of the traffic and only the latest one matters for the UI; the
    terminal 'done' event is the last written, so it always survives.
    """
    try:
        queue.put_nowait(item)
        return
    except asyncio.QueueFull:
        pass
    try:
        queue.get_nowait()
    except asyncio.QueueEmpty:  # pragma: no cover — drained concurrently
        pass
    try:
        queue.put_nowait(item)
    except asyncio.QueueFull:  # pragma: no cover — refilled concurrently
        _logger.warning("Dropped SSE event; queue full")


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

def create_job() -> str:
    """Create a job synchronously, deferring the DB insert to the event loop.

    Prefer create_job_async() in async code: this variant can let a worker start
    before the row exists. Retained for synchronous callers and tests.
    """
    job_id = str(uuid.uuid4())
    _runtime[job_id] = _new_runtime()
    try:
        task = asyncio.get_running_loop().create_task(_insert_job(job_id))
        task.add_done_callback(_log_task_error)
    except RuntimeError:
        pass  # No running loop (sync unit tests)
    return job_id


async def create_job_async(owner_key: str | None = None, params: dict | None = None) -> str:
    """Create a new pending job and await the DB insert before returning.
    owner_key scopes the job to its creator; params is the original fetch request."""
    job_id = str(uuid.uuid4())
    _runtime[job_id] = _new_runtime()
    await _insert_job(job_id, owner_key, params)
    return job_id


async def _insert_job(job_id: str, owner_key: str | None = None, params: dict | None = None) -> None:
    params = params or None
    async with _db() as c:
        await c.exec(
            "INSERT INTO jobs (job_id, status, owner_key, params_json, repo_owner, repo_name, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                job_id, "pending", owner_key,
                json.dumps(params) if params else None,
                (params or {}).get("owner"),
                (params or {}).get("repo"),
                _utcnow_iso(),
            ),
        )
        await c.commit()


def get_job(job_id: str) -> dict[str, Any] | None:
    """Return a live job dict backed by the runtime overlay.

    Synchronous, for use by the worker. Reads of `cancelled`/`events` go
    straight to the shared overlay so a cancel issued through a *different*
    proxy instance is visible here.
    """
    rt = _runtime.get(job_id)
    if rt is None:
        return None
    return _JobProxy(job_id, rt)


async def get_job_async(job_id: str, include_result: bool = True) -> dict[str, Any] | None:
    """Async version — always reads latest state from the DB.

    Pass `include_result=False` when only metadata is needed; the returned job's
    `result` will be None regardless of what is stored.
    """
    row = await _load_job_row(job_id, include_result=include_result)
    if row is None:
        return None
    rt = _runtime.setdefault(job_id, _new_runtime())
    return _row_to_job(row, rt)


# Every column except result_json — the one that holds the whole profile map and
# costs tens of MB to fetch and parse on a large job.
_JOB_META_COLUMNS = (
    "job_id, status, message, total_fetched, label, summary_json, created_at, "
    "tags, owner_key, params_json, repo_owner, repo_name, logins_json, warnings_json, "
    "role_counts_json"
)


async def _load_job_row(job_id: str, include_result: bool = True) -> dict | None:
    """Load a job row.

    `include_result=False` skips `result_json`, which most job-scoped routes
    never touch — an ownership check, a rename, a tag edit or an SSE connect
    used to drag the entire result blob out of the database and json.loads() it
    for nothing.
    """
    columns = "*" if include_result else _JOB_META_COLUMNS
    async with _db() as c:
        return await c.one(f"SELECT {columns} FROM jobs WHERE job_id = ?", (job_id,))


def _row_to_job(row: dict, rt: dict[str, Any]) -> dict[str, Any]:
    # A metadata-only row has no result_json key at all; `result` is then None,
    # which is indistinguishable from a job that has not finished. Callers that
    # need the payload must not ask for a metadata row.
    result = json.loads(row["result_json"]) if row.get("result_json") else None
    summary = json.loads(row["summary_json"]) if row.get("summary_json") else None
    params = json.loads(row["params_json"]) if row.get("params_json") else None
    job: dict[str, Any] = {
        "status": row["status"],
        "message": row.get("message"),
        "total_fetched": row.get("total_fetched") or 0,
        "label": row.get("label"),
        "result": result,
        "summary": summary,
        "warnings": json.loads(row["warnings_json"]) if row.get("warnings_json") else [],
        "role_counts": json.loads(row["role_counts_json"]) if row.get("role_counts_json") else {},
        "owner_key": row.get("owner_key"),
        "params": params,
        "repo_owner": row.get("repo_owner"),
        "repo_name": row.get("repo_name"),
        "created_at": row.get("created_at"),
        "cancelled": rt.get("cancelled", False),
        "events": rt["events"],
        "_job_id": row["job_id"],
    }
    return _JobProxy(row["job_id"], rt, _cached=job)


# Fields that live in the per-instance runtime overlay rather than the DB.
_RUNTIME_FIELDS = ("cancelled", "events")


class _JobProxy(dict):
    """A dict subclass that routes runtime fields to the shared overlay and
    persists DB fields to the store."""

    def __init__(self, job_id: str, rt: dict[str, Any], _cached: dict[str, Any] | None = None):
        super().__init__(_cached or {
            "status": "pending",
            "message": None,
            "total_fetched": 0,
            "label": None,
            "result": None,
            "summary": None,
            "cancelled": rt.get("cancelled", False),
            "events": rt["events"],
            "_job_id": job_id,
        })
        object.__setattr__(self, "_job_id", job_id)
        object.__setattr__(self, "_rt", rt)

    # Runtime fields must always be read live from the overlay. Reading them
    # from this instance's own dict returns whatever was true when the proxy was
    # built, which is why cancellation used to be invisible to a running worker.
    def __getitem__(self, key: str) -> Any:
        if key in _RUNTIME_FIELDS:
            return object.__getattribute__(self, "_rt")[key]
        return super().__getitem__(key)

    def get(self, key: str, default: Any = None) -> Any:  # type: ignore[override]
        if key in _RUNTIME_FIELDS:
            return object.__getattribute__(self, "_rt").get(key, default)
        return super().get(key, default)

    def __setitem__(self, key: str, value: Any) -> None:
        super().__setitem__(key, value)
        if key in _RUNTIME_FIELDS:
            object.__getattribute__(self, "_rt")[key] = value
            return
        if key in _DB_FIELDS:
            job_id = object.__getattribute__(self, "_job_id")
            task = asyncio.create_task(persist_job(job_id, **{key: value}))
            task.add_done_callback(_log_task_error)


_DB_FIELDS = {"status", "message", "total_fetched", "label", "result", "summary", "warnings",
              "role_counts"}

_COL_MAP = {
    "status": "status", "message": "message", "total_fetched": "total_fetched",
    "label": "label", "result": "result_json", "summary": "summary_json",
    "warnings": "warnings_json", "role_counts": "role_counts_json",
}


async def persist_job(job_id: str, **fields: Any) -> None:
    """Atomically persist several job fields in one awaited write."""
    sets, vals = [], []
    for key, value in fields.items():
        col = _COL_MAP.get(key)
        if col is None:
            continue
        sets.append(f"{col} = ?")
        vals.append(json.dumps(value) if isinstance(value, (dict, list)) else value)
    # Keep the denormalised login list in step with the result it derives from,
    # so history never has to parse a full result blob.
    if isinstance(fields.get("result"), dict):
        sets.append("logins_json = ?")
        vals.append(json.dumps(sorted(fields["result"].keys())))
    if not sets:
        return
    vals.append(job_id)
    async with _db() as c:
        await c.exec(f"UPDATE jobs SET {', '.join(sets)} WHERE job_id = ?", vals)
        await c.commit()


async def _persist_field(job_id: str, key: str, value: Any) -> None:
    """Persist a single job field. Thin wrapper over persist_job()."""
    await persist_job(job_id, **{key: value})


async def _all_job_ids_async() -> list[str]:
    async with _db() as c:
        rows = await c.all("SELECT job_id FROM jobs ORDER BY created_at")
    return [r["job_id"] for r in rows]


async def load_jobs_list(owner_key: str | None = None) -> list[dict]:
    """Return the caller's jobs as lightweight dicts using a single SELECT.

    Jobs are strictly owner-scoped. An anonymous caller with no cookie sees
    nothing rather than the pool of legacy unowned jobs.
    """
    if not owner_key:
        return []
    async with _db() as c:
        rows = await c.all(
            "SELECT job_id, status, total_fetched, label, created_at, tags, repo_owner, repo_name "
            "FROM jobs WHERE owner_key = ? ORDER BY created_at",
            (owner_key,),
        )
    result = []
    for row in rows:
        try:
            tags = json.loads(row.get("tags") or "[]")
        except Exception:
            tags = []
        result.append({
            "job_id": row["job_id"],
            "status": row["status"],
            "total_fetched": row.get("total_fetched") or 0,
            "label": row.get("label"),
            "created_at": row.get("created_at"),
            "tags": tags,
            "repo_owner": row.get("repo_owner"),
            "repo_name": row.get("repo_name"),
        })
    return result


async def load_all_jobs_into_runtime() -> None:
    """Called at startup to restore job IDs from the DB into _runtime."""
    async with _db() as c:
        rows = await c.all("SELECT job_id FROM jobs ORDER BY created_at")
    for row in rows:
        jid = row["job_id"]
        if jid not in _runtime:
            _runtime[jid] = _new_runtime()


async def delete_job(job_id: str) -> bool:
    """Remove a job, its share tokens and its schedules. True if it existed."""
    existed = job_id in _runtime or await _load_job_row(job_id, include_result=False) is not None
    _runtime.pop(job_id, None)
    async with _db() as c:
        await c.exec("DELETE FROM jobs WHERE job_id = ?", (job_id,))
        # Dangling share links to a deleted job are dead weight — drop them so a
        # leaked token cannot outlive the data it pointed at.
        await c.exec("DELETE FROM share_tokens WHERE job_id = ?", (job_id,))
        await c.exec("DELETE FROM schedules WHERE source_job_id = ?", (job_id,))
        await c.commit()
    return existed


async def get_job_tags(job_id: str) -> list[str]:
    row = await _load_job_row(job_id, include_result=False)
    if row is None:
        return []
    try:
        return json.loads(row.get("tags") or "[]")
    except Exception:
        return []


async def set_job_tags(job_id: str, tags: list[str]) -> bool:
    """Persist a new tags list for a job. Returns False if job not found."""
    row = await _load_job_row(job_id, include_result=False)
    if row is None:
        return False
    cleaned = sorted({t.strip().lower() for t in tags if t.strip()})
    async with _db() as c:
        await c.exec("UPDATE jobs SET tags = ? WHERE job_id = ?", (json.dumps(cleaned), job_id))
        await c.commit()
    return True


async def clear_all_jobs() -> int:
    """Delete every job from the DB and clear the runtime overlay.
    Intended for development / testing use only."""
    _runtime.clear()
    async with _db() as c:
        deleted = await c.exec("DELETE FROM jobs")
        await c.exec("DELETE FROM share_tokens")
        await c.exec("DELETE FROM schedules")
        await c.commit()
    return max(deleted, 0)


async def count_jobs(owner_key: str) -> int:
    async with _db() as c:
        row = await c.one("SELECT COUNT(*) AS n FROM jobs WHERE owner_key = ?", (owner_key,))
    return (row["n"] or 0) if row else 0


async def prune_oldest_jobs(owner_key: str, keep: int) -> list[str]:
    """Delete an owner's oldest jobs beyond *keep*, returning the ids removed.

    Only a per-minute rate limit existed, so a caller staying comfortably inside
    it could accumulate job rows without bound — each holding up to FETCH_LIMIT
    profiles. Oldest-first, because the newest run is the one being looked at.
    """
    async with _db() as c:
        rows = await c.all(
            "SELECT job_id FROM jobs WHERE owner_key = ? ORDER BY created_at DESC, job_id DESC",
            (owner_key,),
        )
        doomed = [r["job_id"] for r in rows[keep:]]
        for job_id in doomed:
            # Same cascade as delete_job: a dangling share link or schedule must
            # not outlive the data it points at.
            await c.exec("DELETE FROM jobs WHERE job_id = ?", (job_id,))
            await c.exec("DELETE FROM share_tokens WHERE job_id = ?", (job_id,))
            await c.exec("DELETE FROM schedules WHERE source_job_id = ?", (job_id,))
        if doomed:
            await c.commit()
    for job_id in doomed:
        _runtime.pop(job_id, None)
    return doomed


async def load_repo_history(owner_key: str, repo_owner: str, repo_name: str) -> list[dict]:
    """Return every completed run for one repo, oldest first, with full results.

    Powers churn/retention: consecutive runs are diffed to find joiners and
    leavers. Only the caller's own runs are considered.
    """
    async with _db() as c:
        # logins_json first: rows written since it was introduced carry just the
        # member list, so the full result blob never has to be read or parsed.
        rows = await c.all(
            "SELECT job_id, label, created_at, total_fetched, logins_json FROM jobs "
            "WHERE owner_key = ? AND repo_owner = ? AND repo_name = ? AND status = 'done' "
            "ORDER BY created_at",
            (owner_key, repo_owner, repo_name),
        )
        legacy = [r["job_id"] for r in rows if not r.get("logins_json")]
        backfilled: dict[str, list[str]] = {}
        for job_id in legacy:
            # Pre-migration row: parse its result once, then persist the derived
            # list so this path is not taken again for that job.
            blob = await c.one("SELECT result_json FROM jobs WHERE job_id = ?", (job_id,))
            try:
                result = json.loads(blob["result_json"]) if blob and blob.get("result_json") else {}
            except Exception:
                result = {}
            logins = sorted(result.keys()) if isinstance(result, dict) else []
            backfilled[job_id] = logins
            await c.exec(
                "UPDATE jobs SET logins_json = ? WHERE job_id = ?", (json.dumps(logins), job_id)
            )
        if legacy:
            await c.commit()

    out = []
    for row in rows:
        job_id = row["job_id"]
        if job_id in backfilled:
            logins = backfilled[job_id]
        else:
            try:
                logins = json.loads(row["logins_json"])
            except Exception:
                logins = []
        out.append({
            "job_id": job_id,
            "label": row.get("label"),
            "created_at": row.get("created_at"),
            "total_fetched": row.get("total_fetched") or 0,
            "logins": set(logins),
        })
    return out


# ---------------------------------------------------------------------------
# CSV export
# ---------------------------------------------------------------------------

# Leading characters that make a spreadsheet treat a cell as a formula.
_CSV_INJECTION_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def csv_safe(value: Any) -> Any:
    """Neutralise spreadsheet formula injection.

    Exported data is attacker-controllable (via /import, and via GitHub profile
    fields like name/bio/company), and a cell beginning `=`, `+`, `-`, `@`, tab
    or CR is executed as a formula when the CSV is opened in Excel or Sheets.
    Prefixing with a single quote makes it render as literal text.
    """
    if not isinstance(value, str) or not value:
        return value
    if value.startswith(_CSV_INJECTION_PREFIXES):
        return "'" + value
    return value


def result_to_csv_bytes(result: dict[str, Any]) -> bytes:
    if not result:
        return b""
    users = list(result.values())
    all_keys: list[str] = []
    for u in users:
        for k in u:
            if k not in all_keys:
                all_keys.append(k)
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=all_keys, extrasaction="ignore")
    writer.writeheader()
    for u in users:
        row = {}
        for k in all_keys:
            v = u.get(k, "")
            v = json.dumps(v) if isinstance(v, (list, dict)) else (v if v is not None else "")
            row[k] = csv_safe(v)
        writer.writerow(row)
    return buf.getvalue().encode()


# ---------------------------------------------------------------------------
# Session store (OAuth)
# ---------------------------------------------------------------------------

async def create_session(
    session_id: str,
    token: str,
    login: str,
    name: str | None,
    avatar: str | None,
    ttl_days: int = 30,
) -> None:
    """Persist a new OAuth session. Expires after *ttl_days* days.

    The GitHub token is encrypted before it touches the database."""
    async with _db() as c:
        await c.exec(
            """INSERT INTO sessions
               (session_id, github_token, github_login, github_name, github_avatar, created_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (session_id, _encrypt_token(token), login, name, avatar,
             _utcnow_iso(), _iso_in(ttl_days * 24 * 3600)),
        )
        # Expired sessions hold live GitHub access tokens, so sweep them on every
        # write rather than letting them accumulate indefinitely.
        await c.exec("DELETE FROM sessions WHERE expires_at < ?", (_utcnow_iso(),))
        await c.commit()


async def get_session(session_id: str) -> dict[str, Any] | None:
    """Return a valid, non-expired session with its token decrypted, or None.

    A row whose token cannot be decrypted is dropped and treated as no session:
    it is unusable either way, and leaving it in place would keep handing the
    caller a ciphertext blob to send to GitHub as a Bearer token."""
    async with _db() as c:
        row = await c.one(
            "SELECT * FROM sessions WHERE session_id = ? AND expires_at > ?",
            (session_id, _utcnow_iso()),
        )
    if row is None:
        return None
    token = _decrypt_token(row["github_token"] or "")
    if token is None:
        await delete_session(session_id)
        return None
    row["github_token"] = token
    return row


async def delete_session(session_id: str) -> None:
    async with _db() as c:
        await c.exec("DELETE FROM sessions WHERE session_id = ?", (session_id,))
        await c.commit()


async def purge_expired() -> dict[str, int]:
    """Delete expired sessions, OAuth states and share tokens. Returns counts."""
    now = _utcnow_iso()
    async with _db() as c:
        sessions = await c.exec("DELETE FROM sessions WHERE expires_at < ?", (now,))
        states = await c.exec("DELETE FROM oauth_states WHERE expires_at < ?", (now,))
        shares = await c.exec("DELETE FROM share_tokens WHERE expires_at < ?", (now,))
        await c.commit()
    return {"sessions": max(sessions, 0), "oauth_states": max(states, 0), "share_tokens": max(shares, 0)}


# ---------------------------------------------------------------------------
# OAuth CSRF state
# ---------------------------------------------------------------------------

async def add_oauth_state(state: str, ttl_seconds: int = 600) -> None:
    async with _db() as c:
        await c.exec(
            "INSERT INTO oauth_states (state, expires_at) VALUES (?, ?)",
            (state, _iso_in(ttl_seconds)),
        )
        await c.commit()


async def consume_oauth_state(state: str) -> bool:
    """Return True if the state exists and is unexpired, deleting it (single-use)."""
    now_iso = _utcnow_iso()
    async with _db() as c:
        row = await c.one("SELECT expires_at FROM oauth_states WHERE state = ?", (state,))
        await c.exec("DELETE FROM oauth_states WHERE state = ?", (state,))
        await c.exec("DELETE FROM oauth_states WHERE expires_at < ?", (now_iso,))
        await c.commit()
    return bool(row) and row["expires_at"] > now_iso


# ---------------------------------------------------------------------------
# Shareable read tokens
# ---------------------------------------------------------------------------

async def add_share_token(token: str, job_id: str, ttl_seconds: int = 24 * 3600) -> str:
    expires_at = _iso_in(ttl_seconds)
    async with _db() as c:
        await c.exec(
            "INSERT INTO share_tokens (token, job_id, expires_at) VALUES (?, ?, ?)",
            (token, job_id, expires_at),
        )
        await c.commit()
    return expires_at


async def get_share_token(token: str) -> dict[str, Any] | None:
    """Return {job_id, expires_at} for a valid unexpired token, else None."""
    now_iso = _utcnow_iso()
    async with _db() as c:
        row = await c.one("SELECT job_id, expires_at FROM share_tokens WHERE token = ?", (token,))
        await c.exec("DELETE FROM share_tokens WHERE expires_at < ?", (now_iso,))
        await c.commit()
    if row is None or row["expires_at"] <= now_iso:
        return None
    return {"job_id": row["job_id"], "expires_at": row["expires_at"]}


# ---------------------------------------------------------------------------
# Scheduled re-fetch
# ---------------------------------------------------------------------------

# Serialises schedule creation within this process so the per-owner cap cannot
# be raced. The INSERT ... WHERE (SELECT COUNT(*) ...) below is a single
# statement, but each _db() call opens its own connection, so two coroutines can
# otherwise interleave their reads.
# ponytail: per-process only. Under multi-instance Postgres the cap becomes
# approximate; add an advisory lock or SERIALIZABLE if it must be exact.
_create_schedule_lock = asyncio.Lock()


async def create_schedule(
    owner_key: str, source_job_id: str, params: dict, label: str | None, interval_hours: int,
    max_per_owner: int | None = None,
) -> dict | None:
    """Create a schedule, returning None if it would exceed *max_per_owner*.

    The count and the insert share one connection and one commit, so two
    concurrent callers cannot both observe an under-cap count and both insert.

    ponytail: relies on the surrounding transaction rather than a DB constraint,
    because the limit is per-owner rather than per-row. Under multi-instance
    Postgres, wrap in SERIALIZABLE or add a partial unique index if the cap ever
    has to be exact rather than merely enforced.
    """
    schedule_id = str(uuid.uuid4())
    next_run = _iso_in(interval_hours * 3600)
    values = (schedule_id, owner_key, source_job_id, json.dumps(params), label,
              interval_hours, next_run, _utcnow_iso())

    # Written out in full rather than concatenated from a shared prefix: every
    # value is parameterised either way, but a literal keeps static analysis
    # quiet instead of flagging string-built SQL on a security-relevant path.
    _INSERT = (
        "INSERT INTO schedules (schedule_id, owner_key, source_job_id, params_json, "
        "label, interval_hours, next_run_at, enabled, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)"
    )
    # One statement, so the count cannot go stale between reading it and
    # inserting. `_create_schedule_lock` additionally serialises callers within
    # this process, because each _db() call opens its own connection.
    _INSERT_CAPPED = (
        "INSERT INTO schedules (schedule_id, owner_key, source_job_id, params_json, "
        "label, interval_hours, next_run_at, enabled, created_at) "
        "SELECT ?, ?, ?, ?, ?, ?, ?, 1, ? WHERE "
        "(SELECT COUNT(*) FROM schedules WHERE owner_key = ?) < ?"
    )

    async with _create_schedule_lock:
        async with _db() as c:
            if max_per_owner is None:
                await c.exec(_INSERT, values)
            else:
                inserted = await c.exec(_INSERT_CAPPED, (*values, owner_key, max_per_owner))
                if inserted < 1:
                    return None
            await c.commit()
    return {
        "schedule_id": schedule_id, "source_job_id": source_job_id, "label": label,
        "interval_hours": interval_hours, "next_run_at": next_run, "enabled": True,
        "last_run_at": None, "last_job_id": None,
    }


def _schedule_row_to_dict(row: dict) -> dict:
    return {
        "schedule_id": row["schedule_id"],
        "source_job_id": row["source_job_id"],
        "label": row.get("label"),
        "interval_hours": row["interval_hours"],
        "next_run_at": row["next_run_at"],
        "last_run_at": row.get("last_run_at"),
        "last_job_id": row.get("last_job_id"),
        "enabled": bool(row["enabled"]),
    }


async def list_schedules(owner_key: str) -> list[dict]:
    async with _db() as c:
        rows = await c.all(
            "SELECT * FROM schedules WHERE owner_key = ? ORDER BY created_at", (owner_key,)
        )
    return [_schedule_row_to_dict(r) for r in rows]


async def get_schedule(schedule_id: str, owner_key: str) -> dict | None:
    async with _db() as c:
        row = await c.one(
            "SELECT * FROM schedules WHERE schedule_id = ? AND owner_key = ?",
            (schedule_id, owner_key),
        )
    return _schedule_row_to_dict(row) if row else None


async def set_schedule_enabled(schedule_id: str, owner_key: str, enabled: bool) -> bool:
    async with _db() as c:
        n = await c.exec(
            "UPDATE schedules SET enabled = ? WHERE schedule_id = ? AND owner_key = ?",
            (1 if enabled else 0, schedule_id, owner_key),
        )
        await c.commit()
    return n > 0


async def delete_schedule(schedule_id: str, owner_key: str) -> bool:
    async with _db() as c:
        n = await c.exec(
            "DELETE FROM schedules WHERE schedule_id = ? AND owner_key = ?",
            (schedule_id, owner_key),
        )
        await c.commit()
    return n > 0


async def claim_due_schedules(limit: int = 5) -> list[dict]:
    """Return due schedules, immediately advancing next_run_at so a concurrent
    instance cannot pick up the same one.

    ponytail: read-then-write rather than SELECT ... FOR UPDATE, because SQLite
    has no row locking. Worst case under multi-instance Postgres is a duplicate
    re-fetch, which is wasteful but harmless. Switch to FOR UPDATE SKIP LOCKED
    if that becomes expensive.
    """
    now = _utcnow_iso()
    async with _db() as c:
        rows = await c.all(
            "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? "
            "ORDER BY next_run_at LIMIT ?",
            (now, limit),
        )
        claimed = []
        for row in rows:
            advanced = _iso_in(row["interval_hours"] * 3600)
            n = await c.exec(
                "UPDATE schedules SET next_run_at = ?, last_run_at = ? "
                "WHERE schedule_id = ? AND next_run_at = ?",
                (advanced, now, row["schedule_id"], row["next_run_at"]),
            )
            if n > 0:
                claimed.append({
                    "schedule_id": row["schedule_id"],
                    "owner_key": row["owner_key"],
                    "source_job_id": row["source_job_id"],
                    "label": row.get("label"),
                    "params": json.loads(row["params_json"]),
                })
        await c.commit()
    return claimed


async def record_schedule_run(schedule_id: str, job_id: str) -> None:
    async with _db() as c:
        await c.exec(
            "UPDATE schedules SET last_job_id = ? WHERE schedule_id = ?", (job_id, schedule_id)
        )
        await c.commit()


async def close_pool() -> None:
    """Release the Postgres pool on shutdown."""
    global _pg_pool
    if _pg_pool is not None:
        await _pg_pool.close()
        _pg_pool = None
