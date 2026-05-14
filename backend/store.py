from __future__ import annotations
import asyncio
import io
import csv
import json
import os
import uuid
from contextlib import asynccontextmanager
from typing import Any

import aiosqlite

# ---------------------------------------------------------------------------
# SQLite-backed job store
# ---------------------------------------------------------------------------
# The DB file lives next to this module (or in the path set by REPO_PEOPLE_DB).
# Each job's heavy result blob is stored as compressed JSON in the DB.
# The in-memory dict is kept for fast access to runtime-only fields
# (asyncio.Queue, cancelled flag) that cannot be serialised.
# ---------------------------------------------------------------------------

_DB_PATH = os.environ.get(
    "REPO_PEOPLE_DB",
    os.path.join(os.path.dirname(__file__), "repo_people_jobs.db"),
)

# Runtime-only overlay: stores asyncio.Queue and cancelled flag keyed by job_id
_runtime: dict[str, dict[str, Any]] = {}


@asynccontextmanager
async def _db():
    """Async context manager that opens, initialises, and closes the SQLite DB."""
    async with aiosqlite.connect(_DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                job_id      TEXT PRIMARY KEY,
                status      TEXT NOT NULL DEFAULT 'pending',
                message     TEXT,
                total_fetched INTEGER NOT NULL DEFAULT 0,
                label       TEXT,
                result_json TEXT,
                summary_json TEXT,
                created_at  TEXT DEFAULT (datetime('now'))
            )
        """)
        # Add tags column if it doesn't exist yet (migration for existing DBs)
        try:
            await conn.execute("ALTER TABLE jobs ADD COLUMN tags TEXT DEFAULT '[]'")
        except Exception:
            pass  # Column already exists
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                session_id   TEXT PRIMARY KEY,
                github_token TEXT NOT NULL,
                github_login TEXT NOT NULL,
                github_name  TEXT,
                github_avatar TEXT,
                created_at   TEXT DEFAULT (datetime('now')),
                expires_at   TEXT NOT NULL
            )
        """)
        await conn.commit()
        yield conn


def _log_task_error(task: asyncio.Task) -> None:
    """Done-callback that logs exceptions from fire-and-forget tasks."""
    import logging
    if not task.cancelled() and task.exception() is not None:
        logging.getLogger(__name__).error("Background store task failed: %s", task.exception())


def create_job() -> str:
    """Create a new pending job synchronously (DB write is deferred to the event loop)."""
    job_id = str(uuid.uuid4())
    _runtime[job_id] = {
        "cancelled": False,
        "events": asyncio.Queue(),
    }
    # Schedule the DB insert without blocking — only if an event loop is running.
    try:
        task = asyncio.get_event_loop().create_task(_insert_job(job_id))
        task.add_done_callback(_log_task_error)
    except RuntimeError:
        pass  # No running loop (e.g., sync unit tests) — use create_job_async in async contexts.
    return job_id


async def create_job_async() -> str:
    """Create a new pending job and await the DB insert before returning.
    Use this in async endpoints to avoid the worker-starts-before-insert race."""
    job_id = str(uuid.uuid4())
    _runtime[job_id] = {
        "cancelled": False,
        "events": asyncio.Queue(),
    }
    await _insert_job(job_id)
    return job_id


async def _insert_job(job_id: str) -> None:
    async with _db() as conn:
        await conn.execute(
            "INSERT OR IGNORE INTO jobs (job_id, status) VALUES (?, ?)",
            (job_id, "pending"),
        )
        await conn.commit()


def get_job(job_id: str) -> dict[str, Any] | None:
    """Return a live job dict (merges DB state with runtime overlay).
    This is a *synchronous* call that reads from the DB via a helper run in the
    current event loop if available, otherwise falls back to a blocking read."""
    rt = _runtime.get(job_id)
    # If we have no runtime entry the job either never existed or was loaded from DB
    if rt is None:
        # Try to load from DB synchronously (startup reconciliation path)
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # Can't block — return None; callers should use async path
                return None
            row = loop.run_until_complete(_load_job_row(job_id))
        except RuntimeError:
            return None
        if row is None:
            return None
        rt = {"cancelled": False, "events": asyncio.Queue()}
        _runtime[job_id] = rt
        return _row_to_job(row, rt)

    # Fast path: read cached data from DB via get_job_async (sync wrapper)
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # Caller is in async context — they should use get_job_async.
            # Return a partial dict from runtime so the worker can update it.
            return _make_partial(job_id, rt)
    except RuntimeError:
        pass
    return _make_partial(job_id, rt)


def _make_partial(job_id: str, rt: dict[str, Any]) -> dict[str, Any]:
    """Build a minimal mutable job dict backed by runtime data.
    Writes to this dict are immediately visible and are persisted async."""
    return _JobProxy(job_id, rt)


async def get_job_async(job_id: str) -> dict[str, Any] | None:
    """Async version — always reads latest state from DB."""
    row = await _load_job_row(job_id)
    if row is None:
        return None
    rt = _runtime.setdefault(job_id, {"cancelled": False, "events": asyncio.Queue()})
    return _row_to_job(row, rt)


async def _load_job_row(job_id: str):
    async with _db() as conn:
        async with conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)) as cur:
            return await cur.fetchone()


def _row_to_job(row, rt: dict[str, Any]) -> dict[str, Any]:
    result = json.loads(row["result_json"]) if row["result_json"] else None
    summary = json.loads(row["summary_json"]) if row["summary_json"] else None
    job: dict[str, Any] = {
        "status": row["status"],
        "message": row["message"],
        "total_fetched": row["total_fetched"],
        "label": row["label"],
        "result": result,
        "summary": summary,
        "cancelled": rt.get("cancelled", False),
        "events": rt["events"],
        "_job_id": row["job_id"],
    }
    return _JobProxy(row["job_id"], rt, _cached=job)


class _JobProxy(dict):
    """A dict subclass that intercepts writes and persists them to SQLite."""

    def __init__(self, job_id: str, rt: dict[str, Any], _cached: dict[str, Any] | None = None):
        super().__init__(_cached or {
            "status": "pending",
            "message": None,
            "total_fetched": 0,
            "label": None,
            "result": None,
            "summary": None,
            "cancelled": False,
            "events": rt["events"],
            "_job_id": job_id,
        })
        object.__setattr__(self, "_job_id", job_id)
        object.__setattr__(self, "_rt", rt)

    def __setitem__(self, key: str, value: Any) -> None:
        super().__setitem__(key, value)
        # Sync runtime overlay for fast-path fields
        if key in ("cancelled", "events"):
            object.__getattribute__(self, "_rt")[key] = value
        # Persist DB fields asynchronously
        _DB_FIELDS = {"status", "message", "total_fetched", "label", "result", "summary"}
        if key in _DB_FIELDS:
            job_id = object.__getattribute__(self, "_job_id")
            task = asyncio.create_task(_persist_field(job_id, key, value))
            task.add_done_callback(_log_task_error)

    def get(self, key: str, default: Any = None) -> Any:  # type: ignore[override]
        return super().get(key, default)


async def _persist_field(job_id: str, key: str, value: Any) -> None:
    col_map = {
        "status": "status",
        "message": "message",
        "total_fetched": "total_fetched",
        "label": "label",
        "result": "result_json",
        "summary": "summary_json",
    }
    col = col_map.get(key)
    if col is None:
        return
    serialised = json.dumps(value) if isinstance(value, (dict, list)) else value
    async with _db() as conn:
        await conn.execute(f"UPDATE jobs SET {col} = ? WHERE job_id = ?", (serialised, job_id))
        await conn.commit()


def all_job_ids() -> list[str]:
    """Return all known job IDs (union of runtime and DB)."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            return list(_runtime.keys())
        return loop.run_until_complete(_all_job_ids_async())
    except RuntimeError:
        return list(_runtime.keys())


async def _all_job_ids_async() -> list[str]:
    async with _db() as conn:
        async with conn.execute("SELECT job_id FROM jobs ORDER BY created_at") as cur:
            rows = await cur.fetchall()
    return [r["job_id"] for r in rows]


async def load_jobs_list() -> list[dict]:
    """Return all jobs as a list of lightweight dicts using a single SELECT (avoids N+1)."""
    async with _db() as conn:
        async with conn.execute(
            "SELECT job_id, status, total_fetched, label, created_at, tags FROM jobs ORDER BY created_at"
        ) as cur:
            rows = await cur.fetchall()
    result = []
    for row in rows:
        raw_tags = row["tags"] if "tags" in row.keys() else "[]"
        try:
            tags = json.loads(raw_tags or "[]")
        except Exception:
            tags = []
        result.append({
            "job_id": row["job_id"],
            "status": row["status"],
            "total_fetched": row["total_fetched"],
            "label": row["label"],
            "created_at": row["created_at"],
            "tags": tags,
        })
    return result


async def load_all_jobs_into_runtime() -> None:
    """Called at startup to restore jobs from the DB into _runtime."""
    async with _db() as conn:
        async with conn.execute("SELECT job_id FROM jobs ORDER BY created_at") as cur:
            rows = await cur.fetchall()
    for row in rows:
        jid = row["job_id"]
        if jid not in _runtime:
            _runtime[jid] = {"cancelled": False, "events": asyncio.Queue()}


async def delete_job(job_id: str) -> bool:
    """Remove a job from the DB and runtime. Returns True if it existed."""
    existed = job_id in _runtime or await _load_job_row(job_id) is not None
    _runtime.pop(job_id, None)
    async with _db() as conn:
        await conn.execute("DELETE FROM jobs WHERE job_id = ?", (job_id,))
        await conn.commit()
    return existed


async def get_job_tags(job_id: str) -> list[str]:
    """Return the tags list for a job."""
    row = await _load_job_row(job_id)
    if row is None:
        return []
    raw = row["tags"] if "tags" in row.keys() else "[]"
    try:
        return json.loads(raw or "[]")
    except Exception:
        return []


async def set_job_tags(job_id: str, tags: list[str]) -> bool:
    """Persist a new tags list for a job. Returns False if job not found."""
    row = await _load_job_row(job_id)
    if row is None:
        return False
    cleaned = sorted({t.strip().lower() for t in tags if t.strip()})
    async with _db() as conn:
        await conn.execute(
            "UPDATE jobs SET tags = ? WHERE job_id = ?",
            (json.dumps(cleaned), job_id),
        )
        await conn.commit()
    return True


async def clear_summary_caches(job_id: str | None = None) -> int:
    """Wipe cached summary_json from the DB for one or all jobs.

    Returns the number of rows updated.
    Intended for development / testing use only.
    """
    async with _db() as conn:
        if job_id is not None:
            cur = await conn.execute(
                "UPDATE jobs SET summary_json = NULL WHERE job_id = ? AND summary_json IS NOT NULL",
                (job_id,),
            )
        else:
            cur = await conn.execute(
                "UPDATE jobs SET summary_json = NULL WHERE summary_json IS NOT NULL"
            )
        cleared = cur.rowcount
        await conn.commit()
    return cleared


async def clear_all_jobs() -> int:
    """Delete every job from the DB and clear the runtime overlay.

    Returns the number of rows deleted.
    Intended for development / testing use only.
    """
    _runtime.clear()
    async with _db() as conn:
        cur = await conn.execute("DELETE FROM jobs")
        deleted = cur.rowcount
        await conn.commit()
    return deleted


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
            row[k] = json.dumps(v) if isinstance(v, (list, dict)) else (v if v is not None else "")
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
    """Persist a new OAuth session. Expires after *ttl_days* days."""
    from datetime import datetime, timedelta
    expires_at = (datetime.utcnow() + timedelta(days=ttl_days)).isoformat()
    async with _db() as conn:
        await conn.execute(
            """INSERT OR REPLACE INTO sessions
               (session_id, github_token, github_login, github_name, github_avatar, expires_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (session_id, token, login, name, avatar, expires_at),
        )
        await conn.commit()


async def get_session(session_id: str) -> dict[str, Any] | None:
    """Return a valid, non-expired session dict, or None."""
    async with _db() as conn:
        async with conn.execute(
            "SELECT * FROM sessions WHERE session_id = ? AND expires_at > datetime('now')",
            (session_id,),
        ) as cur:
            row = await cur.fetchone()
    if row is None:
        return None
    return dict(row)


async def delete_session(session_id: str) -> None:
    """Delete a session (logout)."""
    async with _db() as conn:
        await conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
        await conn.commit()
