"""
test_api_import.py — Integration tests for the import endpoint:
  POST /import   — import a pre-built result dict as a new done job
"""
from __future__ import annotations

import asyncio
import json

import pytest

import store
from conftest import SAMPLE_USERS


# ===========================================================================
# POST /import
# ===========================================================================

class TestImport:
    @pytest.mark.asyncio
    async def test_empty_payload_returns_422(self, async_client):
        # Body must be a dict (even if empty dict is semantically valid)
        resp = await async_client.post("/import", content=b"", headers={"Content-Type": "application/json"})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_non_dict_payload_returns_422(self, async_client):
        # A JSON array is not acceptable as the payload
        resp = await async_client.post("/import", json=["alice", "bob"])
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_valid_payload_returns_200(self, async_client):
        resp = await async_client.post("/import", json=SAMPLE_USERS)
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_returns_job_id(self, async_client):
        resp = await async_client.post("/import", json=SAMPLE_USERS)
        data = resp.json()
        assert "job_id" in data

    @pytest.mark.asyncio
    async def test_returns_total_imported(self, async_client):
        resp = await async_client.post("/import", json=SAMPLE_USERS)
        data = resp.json()
        assert "total_imported" in data

    @pytest.mark.asyncio
    async def test_total_imported_counts_dict_values(self, async_client):
        valid_users = {k: v for k, v in SAMPLE_USERS.items() if isinstance(v, dict)}
        resp = await async_client.post("/import", json=valid_users)
        assert resp.json()["total_imported"] == len(valid_users)

    @pytest.mark.asyncio
    async def test_created_job_appears_in_job_list(self, async_client):
        resp = await async_client.post("/import", json=SAMPLE_USERS)
        jid = resp.json()["job_id"]
        # The import endpoint uses create_job_async() which awaits the DB insert.
        await asyncio.sleep(0.1)
        jobs_resp = await async_client.get("/jobs")
        job_ids = [j["job_id"] for j in jobs_resp.json()]
        assert jid in job_ids

    @pytest.mark.asyncio
    async def test_non_dict_values_are_filtered_out(self, async_client):
        # Verify that only dict-valued entries survive the sanitisation in /import.
        # total_imported is computed from the sanitised dict and returned synchronously.
        payload = {
            "alice": SAMPLE_USERS["alice"],      # valid dict → kept
            "invalid_entry": "not a dict",       # string value → filtered
            "another_invalid": 12345,            # int value → filtered
        }
        resp = await async_client.post("/import", json=payload)
        assert resp.status_code == 200
        assert resp.json()["total_imported"] == 1

    @pytest.mark.asyncio
    async def test_job_id_is_valid_uuid(self, async_client):
        import uuid
        resp = await async_client.post("/import", json=SAMPLE_USERS)
        jid = resp.json()["job_id"]
        uuid.UUID(jid)  # raises ValueError if invalid

    @pytest.mark.asyncio
    async def test_multiple_imports_create_distinct_jobs(self, async_client):
        r1 = await async_client.post("/import", json=SAMPLE_USERS)
        r2 = await async_client.post("/import", json=SAMPLE_USERS)
        assert r1.json()["job_id"] != r2.json()["job_id"]

    @pytest.mark.asyncio
    async def test_empty_dict_payload_returns_422(self, async_client):
        # API requires a non-empty dict
        resp = await async_client.post("/import", json={})
        assert resp.status_code == 422
