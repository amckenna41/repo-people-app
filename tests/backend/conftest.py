"""
conftest.py — shared pytest fixtures for backend tests.

All tests use an isolated temporary SQLite DB file (REPO_PEOPLE_DB=<tmpfile>)
so that multiple connections within a single test can share state — unlike
:memory: which gives each connection its own fresh database.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import uuid
from typing import Any, Generator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

# ---------------------------------------------------------------------------
# Path setup — allow imports from backend/ and repo root
# ---------------------------------------------------------------------------
BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../backend"))
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
sys.path.insert(0, BACKEND_DIR)
sys.path.insert(0, REPO_ROOT)

# Use a shared temp file so all connections within a test share the same DB.
# :memory: doesn't work because each aiosqlite.connect(":memory:") is isolated.
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["REPO_PEOPLE_DB"] = _tmp_db.name

# ---------------------------------------------------------------------------
# Import app modules after env var is set
# ---------------------------------------------------------------------------
import store  # noqa: E402
from store import _runtime  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SAMPLE_USERS: dict[str, Any] = {
    "alice": {
        "login": "alice",
        "name": "Alice Example",
        "avatar_url": "https://avatars.githubusercontent.com/u/1",
        "html_url": "https://github.com/alice",
        "email": "alice@example.com",
        "company": "ACME Corp",
        "company_normalized": "ACME Corp",
        "location": "London, UK",
        "location_normalized": "United Kingdom",
        "followers": 200,
        "following": 50,
        "public_repos": 30,
        "account_age_days": 3650,  # ~10 years
        "is_bot": False,
        "roles": ["stargazers", "contributors"],
        "total_public_stars_sampled": 500,
    },
    "bob": {
        "login": "bob",
        "name": "Bob Builder",
        "avatar_url": "https://avatars.githubusercontent.com/u/2",
        "html_url": "https://github.com/bob",
        "email": None,
        "company": None,
        "company_normalized": None,
        "location": "New York, USA",
        "location_normalized": "United States",
        "followers": 50,
        "following": 10,
        "public_repos": 8,
        "account_age_days": 730,   # ~2 years
        "is_bot": False,
        "roles": ["stargazers"],
        "total_public_stars_sampled": 20,
    },
    "dependabot[bot]": {
        "login": "dependabot[bot]",
        "name": "Dependabot",
        "avatar_url": "https://avatars.githubusercontent.com/u/3",
        "html_url": "https://github.com/apps/dependabot",
        "email": None,
        "company": None,
        "company_normalized": None,
        "location": None,
        "location_normalized": None,
        "followers": 0,
        "following": 0,
        "public_repos": 0,
        "account_age_days": 100,
        "is_bot": True,
        "roles": ["contributors"],
        "total_public_stars_sampled": 0,
    },
}


async def _seed_done_job(result: dict[str, Any] | None = None) -> str:
    """Insert a completed job into the DB and return its job_id."""
    job_id = str(uuid.uuid4())
    _runtime[job_id] = {"cancelled": False, "events": asyncio.Queue()}
    await store._insert_job(job_id)

    # Directly patch via _persist_field
    await store._persist_field(job_id, "status", "done")
    await store._persist_field(job_id, "total_fetched", len(result or {}))
    if result is not None:
        await store._persist_field(job_id, "result", result)
    return job_id


async def _seed_pending_job() -> str:
    """Insert a pending job and return its job_id."""
    job_id = str(uuid.uuid4())
    _runtime[job_id] = {"cancelled": False, "events": asyncio.Queue()}
    await store._insert_job(job_id)
    return job_id


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def event_loop():
    """Single event loop for the whole test session (avoids 'loop closed' errors)."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(autouse=True)
async def reset_store():
    """Clear runtime + DB before each test for full isolation."""
    _runtime.clear()
    # Drop and recreate the jobs table so each test starts clean
    async with store._db() as conn:
        await conn.execute("DROP TABLE IF EXISTS jobs")
        await conn.commit()
    # Re-initialise — _db() creates the table on entry
    async with store._db() as conn:
        pass
    yield
    _runtime.clear()


@pytest_asyncio.fixture
async def done_job_id() -> str:
    """A job pre-seeded in the DB with SAMPLE_USERS as result."""
    return await _seed_done_job(dict(SAMPLE_USERS))


@pytest_asyncio.fixture
async def pending_job_id() -> str:
    """A job pre-seeded in the DB with status=pending."""
    return await _seed_pending_job()


@pytest_asyncio.fixture
async def two_done_jobs() -> tuple[str, str]:
    """Two completed jobs for compare tests.

    Job A: alice + bob
    Job B: bob + a new user 'carol'
    """
    carol = {
        "login": "carol",
        "name": "Carol Smith",
        "avatar_url": "https://avatars.githubusercontent.com/u/4",
        "html_url": "https://github.com/carol",
        "followers": 10,
        "is_bot": False,
        "roles": ["watchers"],
    }
    job_a = await _seed_done_job({"alice": SAMPLE_USERS["alice"], "bob": SAMPLE_USERS["bob"]})
    job_b = await _seed_done_job({"bob": SAMPLE_USERS["bob"], "carol": carol})
    return job_a, job_b


@pytest_asyncio.fixture
async def async_client():
    """Async HTTPX client targeting the FastAPI app."""
    # Import here so store env var is already set
    import importlib
    import main as main_module
    importlib.reload(main_module)
    app = main_module.app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client
