"""
test_store.py — Unit tests for store.py

Tests cover:
  - Job creation and DB persistence
  - Reading jobs back from DB (get_job_async, _load_job_row)
  - Field persistence via _JobProxy.__setitem__
  - Tag CRUD (get_job_tags, set_job_tags)
  - Job deletion (delete_job)
  - load_all_jobs_into_runtime
  - result_to_csv_bytes
  - _all_job_ids_async ordering
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import pytest
import pytest_asyncio

from conftest import SAMPLE_USERS, _seed_done_job, _seed_pending_job
import store
from store import (
    _all_job_ids_async,
    _insert_job,
    _load_job_row,
    _persist_field,
    _runtime,
    create_job,
    delete_job,
    get_job_async,
    get_job_tags,
    load_all_jobs_into_runtime,
    result_to_csv_bytes,
    set_job_tags,
)


# ===========================================================================
# Job creation
# ===========================================================================

class TestCreateJob:
    def test_create_job_returns_uuid(self):
        jid = create_job()
        assert isinstance(jid, str)
        # Valid UUID
        parsed = uuid.UUID(jid)
        assert str(parsed) == jid

    def test_create_job_adds_to_runtime(self):
        jid = create_job()
        assert jid in _runtime
        assert "cancelled" in _runtime[jid]
        assert "events" in _runtime[jid]
        assert _runtime[jid]["cancelled"] is False

    def test_create_job_has_asyncio_queue(self):
        jid = create_job()
        assert isinstance(_runtime[jid]["events"], asyncio.Queue)

    @pytest.mark.asyncio
    async def test_create_job_persisted_to_db(self):
        jid = create_job()
        # Give the ensure_future a tick to run
        await asyncio.sleep(0.05)
        row = await _load_job_row(jid)
        assert row is not None
        assert row["job_id"] == jid
        assert row["status"] == "pending"

    def test_multiple_jobs_have_unique_ids(self):
        ids = [create_job() for _ in range(50)]
        assert len(set(ids)) == 50


# ===========================================================================
# DB persistence helpers
# ===========================================================================

class TestPersistField:
    @pytest.mark.asyncio
    async def test_persist_status(self):
        jid = await _seed_pending_job()
        await _persist_field(jid, "status", "done")
        row = await _load_job_row(jid)
        assert row["status"] == "done"

    @pytest.mark.asyncio
    async def test_persist_total_fetched(self):
        jid = await _seed_pending_job()
        await _persist_field(jid, "total_fetched", 42)
        row = await _load_job_row(jid)
        assert row["total_fetched"] == 42

    @pytest.mark.asyncio
    async def test_persist_label(self):
        jid = await _seed_pending_job()
        await _persist_field(jid, "label", "owner/repo")
        row = await _load_job_row(jid)
        assert row["label"] == "owner/repo"

    @pytest.mark.asyncio
    async def test_persist_result_dict(self):
        jid = await _seed_pending_job()
        data = {"alice": {"login": "alice", "followers": 100}}
        await _persist_field(jid, "result", data)
        row = await _load_job_row(jid)
        loaded = json.loads(row["result_json"])
        assert loaded["alice"]["followers"] == 100

    @pytest.mark.asyncio
    async def test_persist_unknown_key_is_noop(self):
        jid = await _seed_pending_job()
        # Should not raise; column doesn't exist
        await _persist_field(jid, "nonexistent_field", "value")
        row = await _load_job_row(jid)
        assert row is not None  # row still intact


# ===========================================================================
# get_job_async
# ===========================================================================

class TestGetJobAsync:
    @pytest.mark.asyncio
    async def test_returns_none_for_unknown_id(self):
        result = await get_job_async("nonexistent-job-id")
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_job_for_known_id(self):
        jid = await _seed_done_job({"alice": SAMPLE_USERS["alice"]})
        job = await get_job_async(jid)
        assert job is not None
        assert job["status"] == "done"
        assert job["total_fetched"] == 1

    @pytest.mark.asyncio
    async def test_result_is_deserialized(self):
        jid = await _seed_done_job({"alice": SAMPLE_USERS["alice"]})
        job = await get_job_async(jid)
        assert isinstance(job["result"], dict)
        assert job["result"]["alice"]["followers"] == 200

    @pytest.mark.asyncio
    async def test_result_is_none_for_pending_job(self):
        jid = await _seed_pending_job()
        job = await get_job_async(jid)
        assert job is not None
        assert job["result"] is None
        assert job["status"] == "pending"


# ===========================================================================
# JobProxy write-through
# ===========================================================================

class TestJobProxy:
    @pytest.mark.asyncio
    async def test_setitem_persists_status(self):
        jid = await _seed_pending_job()
        job = await get_job_async(jid)
        job["status"] = "running"
        await asyncio.sleep(0.1)  # let ensure_future complete
        row = await _load_job_row(jid)
        assert row["status"] == "running"

    @pytest.mark.asyncio
    async def test_setitem_persists_label(self):
        jid = await _seed_pending_job()
        job = await get_job_async(jid)
        job["label"] = "facebook/react"
        await asyncio.sleep(0.1)
        row = await _load_job_row(jid)
        assert row["label"] == "facebook/react"

    @pytest.mark.asyncio
    async def test_setitem_cancelled_updates_runtime(self):
        jid = await _seed_pending_job()
        job = await get_job_async(jid)
        job["cancelled"] = True
        assert _runtime[jid]["cancelled"] is True

    @pytest.mark.asyncio
    async def test_setitem_result_serializes_dict(self):
        jid = await _seed_pending_job()
        job = await get_job_async(jid)
        job["result"] = {"alice": {"login": "alice"}}
        await asyncio.sleep(0.1)
        row = await _load_job_row(jid)
        loaded = json.loads(row["result_json"])
        assert "alice" in loaded


# ===========================================================================
# Delete job
# ===========================================================================

class TestDeleteJob:
    @pytest.mark.asyncio
    async def test_delete_existing_job_returns_true(self):
        jid = await _seed_done_job({})
        result = await delete_job(jid)
        assert result is True

    @pytest.mark.asyncio
    async def test_delete_removes_from_runtime(self):
        jid = await _seed_done_job({})
        await delete_job(jid)
        assert jid not in _runtime

    @pytest.mark.asyncio
    async def test_delete_removes_from_db(self):
        jid = await _seed_done_job({})
        await delete_job(jid)
        row = await _load_job_row(jid)
        assert row is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent_job_returns_false(self):
        result = await delete_job("no-such-job")
        assert result is False

    @pytest.mark.asyncio
    async def test_delete_twice_returns_false_second_time(self):
        jid = await _seed_done_job({})
        assert await delete_job(jid) is True
        assert await delete_job(jid) is False


# ===========================================================================
# Tags
# ===========================================================================

class TestTags:
    @pytest.mark.asyncio
    async def test_get_tags_returns_empty_list_by_default(self):
        jid = await _seed_done_job({})
        tags = await get_job_tags(jid)
        assert tags == []

    @pytest.mark.asyncio
    async def test_set_tags_persists(self):
        jid = await _seed_done_job({})
        ok = await set_job_tags(jid, ["production", "research"])
        assert ok is True
        tags = await get_job_tags(jid)
        assert sorted(tags) == ["production", "research"]

    @pytest.mark.asyncio
    async def test_set_tags_normalises_to_lowercase(self):
        jid = await _seed_done_job({})
        await set_job_tags(jid, ["PRODUCTION", "Research"])
        tags = await get_job_tags(jid)
        assert "production" in tags
        assert "research" in tags

    @pytest.mark.asyncio
    async def test_set_tags_deduplicates(self):
        jid = await _seed_done_job({})
        await set_job_tags(jid, ["alpha", "alpha", "beta"])
        tags = await get_job_tags(jid)
        assert tags.count("alpha") == 1

    @pytest.mark.asyncio
    async def test_set_tags_trims_whitespace(self):
        jid = await _seed_done_job({})
        await set_job_tags(jid, ["  production  ", " research"])
        tags = await get_job_tags(jid)
        assert "production" in tags
        assert "research" in tags

    @pytest.mark.asyncio
    async def test_set_tags_empty_list_clears_tags(self):
        jid = await _seed_done_job({})
        await set_job_tags(jid, ["old-tag"])
        await set_job_tags(jid, [])
        tags = await get_job_tags(jid)
        assert tags == []

    @pytest.mark.asyncio
    async def test_set_tags_filters_blank_strings(self):
        jid = await _seed_done_job({})
        await set_job_tags(jid, ["valid", "", "   "])
        tags = await get_job_tags(jid)
        assert tags == ["valid"]

    @pytest.mark.asyncio
    async def test_set_tags_nonexistent_job_returns_false(self):
        ok = await set_job_tags("no-such-job", ["tag"])
        assert ok is False

    @pytest.mark.asyncio
    async def test_get_tags_nonexistent_job_returns_empty(self):
        tags = await get_job_tags("no-such-job")
        assert tags == []


# ===========================================================================
# Load all jobs into runtime
# ===========================================================================

class TestLoadAllJobsIntoRuntime:
    @pytest.mark.asyncio
    async def test_populates_runtime_for_db_jobs(self):
        jid = await _seed_done_job({})
        _runtime.clear()
        await load_all_jobs_into_runtime()
        assert jid in _runtime

    @pytest.mark.asyncio
    async def test_does_not_overwrite_existing_runtime_entries(self):
        jid = await _seed_done_job({})
        sentinel_queue = asyncio.Queue()
        _runtime[jid] = {"cancelled": True, "events": sentinel_queue}
        await load_all_jobs_into_runtime()
        # Existing entry should not be replaced
        assert _runtime[jid]["events"] is sentinel_queue


# ===========================================================================
# _all_job_ids_async ordering
# ===========================================================================

class TestAllJobIdsAsync:
    @pytest.mark.asyncio
    async def test_returns_empty_when_no_jobs(self):
        ids = await _all_job_ids_async()
        assert ids == []

    @pytest.mark.asyncio
    async def test_returns_all_inserted_job_ids(self):
        id1 = await _seed_pending_job()
        id2 = await _seed_pending_job()
        id3 = await _seed_pending_job()
        ids = await _all_job_ids_async()
        assert set(ids) == {id1, id2, id3}


# ===========================================================================
# result_to_csv_bytes
# ===========================================================================

class TestResultToCsvBytes:
    def test_empty_result_returns_empty_bytes(self):
        assert result_to_csv_bytes({}) == b""

    def test_single_user_produces_header_and_row(self):
        result = {"alice": {"login": "alice", "followers": 200}}
        csv_bytes = result_to_csv_bytes(result)
        text = csv_bytes.decode()
        assert "login" in text
        assert "alice" in text
        assert "200" in text

    def test_header_contains_all_keys(self):
        result = {
            "alice": {"login": "alice", "followers": 200, "email": "a@example.com"},
        }
        text = result_to_csv_bytes(result).decode()
        header_line = text.splitlines()[0]
        assert "login" in header_line
        assert "followers" in header_line
        assert "email" in header_line

    def test_multiple_users(self):
        result = {
            "alice": {"login": "alice", "followers": 200},
            "bob": {"login": "bob", "followers": 50},
        }
        text = result_to_csv_bytes(result).decode()
        lines = [l for l in text.splitlines() if l.strip()]
        assert len(lines) == 3  # header + 2 rows

    def test_list_fields_serialized_as_json(self):
        result = {"alice": {"login": "alice", "roles": ["stargazers", "contributors"]}}
        text = result_to_csv_bytes(result).decode()
        # The roles column should contain JSON-encoded list
        assert "stargazers" in text

    def test_none_fields_become_empty_string(self):
        result = {"alice": {"login": "alice", "email": None}}
        text = result_to_csv_bytes(result).decode()
        # Row value for email should be empty, not "None"
        rows = text.splitlines()
        assert "None" not in rows[1]

    def test_missing_key_in_some_users_produces_empty_cell(self):
        result = {
            "alice": {"login": "alice", "followers": 200, "email": "a@b.com"},
            "bob": {"login": "bob", "followers": 50},  # no email key
        }
        text = result_to_csv_bytes(result).decode()
        # Should not raise; bob's email cell just empty
        assert text != ""
