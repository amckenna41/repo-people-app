"""
test_api_jobs.py — Integration tests for job management API endpoints:
  GET  /jobs
  POST /fetch                (job creation only — worker is mocked)
  POST /fetch/{id}/cancel
  DELETE /jobs/{id}
  PATCH /jobs/{id}           (rename)
  PATCH /jobs/{id}/tags      (update tags)
"""
from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio

from conftest import SAMPLE_USERS, _seed_done_job, _seed_pending_job
from store import _runtime, get_job_async


# ===========================================================================
# GET /jobs
# ===========================================================================

class TestListJobs:
    @pytest.mark.asyncio
    async def test_empty_returns_empty_list(self, async_client):
        resp = await async_client.get("/jobs")
        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_returns_one_job(self, async_client, done_job_id):
        resp = await async_client.get("/jobs")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["job_id"] == done_job_id

    @pytest.mark.asyncio
    async def test_job_has_required_fields(self, async_client, done_job_id):
        resp = await async_client.get("/jobs")
        job = resp.json()[0]
        for field in ("job_id", "status", "total_fetched", "tags", "created_at"):
            assert field in job, f"Missing field: {field}"

    @pytest.mark.asyncio
    async def test_tags_field_is_list(self, async_client, done_job_id):
        resp = await async_client.get("/jobs")
        job = resp.json()[0]
        assert isinstance(job["tags"], list)

    @pytest.mark.asyncio
    async def test_status_reflects_done(self, async_client, done_job_id):
        resp = await async_client.get("/jobs")
        assert resp.json()[0]["status"] == "done"

    @pytest.mark.asyncio
    async def test_total_fetched_reflects_result_size(self, async_client, done_job_id):
        resp = await async_client.get("/jobs")
        assert resp.json()[0]["total_fetched"] == len(SAMPLE_USERS)

    @pytest.mark.asyncio
    async def test_returns_multiple_jobs(self, async_client):
        id1 = await _seed_done_job({"alice": SAMPLE_USERS["alice"]})
        id2 = await _seed_done_job({"bob": SAMPLE_USERS["bob"]})
        resp = await async_client.get("/jobs")
        ids = [j["job_id"] for j in resp.json()]
        assert id1 in ids
        assert id2 in ids


# ===========================================================================
# POST /fetch  (mocked — we only test job creation, not the real worker)
# ===========================================================================

class TestPostFetch:
    @pytest.mark.asyncio
    async def test_returns_job_id(self, async_client):
        with patch("main.run_fetch_job", new_callable=AsyncMock) as mock_worker:
            resp = await async_client.post("/fetch", json={
                "owner": "facebook",
                "repo": "react",
            })
        assert resp.status_code == 200
        data = resp.json()
        assert "job_id" in data
        assert isinstance(data["job_id"], str)

    @pytest.mark.asyncio
    async def test_job_id_is_valid_uuid(self, async_client):
        import uuid
        with patch("main.run_fetch_job", new_callable=AsyncMock):
            resp = await async_client.post("/fetch", json={
                "owner": "octocat",
                "repo": "hello-world",
            })
        jid = resp.json()["job_id"]
        uuid.UUID(jid)  # raises if invalid

    @pytest.mark.asyncio
    async def test_job_appears_in_runtime(self, async_client):
        with patch("main.run_fetch_job", new_callable=AsyncMock):
            resp = await async_client.post("/fetch", json={
                "owner": "owner",
                "repo": "repo",
            }, headers={"Authorization": "Bearer ghp_test"})
        jid = resp.json()["job_id"]
        assert jid in _runtime

    @pytest.mark.asyncio
    async def test_missing_owner_returns_422(self, async_client):
        resp = await async_client.post("/fetch", json={"repo": "react"})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_missing_repo_returns_422(self, async_client):
        resp = await async_client.post("/fetch", json={"owner": "facebook"})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_no_token_in_header_still_accepted(self, async_client):
        # Token is optional (unauthenticated requests get 60 req/hr rate limit)
        with patch("main.run_fetch_job", new_callable=AsyncMock):
            resp = await async_client.post("/fetch", json={"owner": "facebook", "repo": "react"})
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_token_in_auth_header_accepted(self, async_client):
        with patch("main.run_fetch_job", new_callable=AsyncMock):
            resp = await async_client.post(
                "/fetch",
                json={"owner": "facebook", "repo": "react"},
                headers={"Authorization": "Bearer ghp_test"},
            )
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_invalid_owner_chars_returns_422(self, async_client):
        resp = await async_client.post("/fetch", json={"owner": "bad owner!", "repo": "react"})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_optional_roles_accepted(self, async_client):
        with patch("main.run_fetch_job", new_callable=AsyncMock):
            resp = await async_client.post("/fetch", json={
                "owner": "facebook",
                "repo": "react",
                "roles": ["stargazers", "contributors"],
                "limit": 10,
                "exclude_bots": True,
            })
        assert resp.status_code == 200


# ===========================================================================
# POST /fetch/{job_id}/cancel
# ===========================================================================

class TestCancelJob:
    @pytest.mark.asyncio
    async def test_cancel_sets_cancelled_flag(self, async_client, pending_job_id):
        resp = await async_client.post(f"/fetch/{pending_job_id}/cancel")
        assert resp.status_code == 200
        assert resp.json()["cancelled"] is True
        assert _runtime[pending_job_id]["cancelled"] is True

    @pytest.mark.asyncio
    async def test_cancel_nonexistent_returns_404(self, async_client):
        resp = await async_client.post("/fetch/no-such-job/cancel")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_cancel_done_job_sets_flag(self, async_client, done_job_id):
        # Cancelling a completed job is technically allowed (idempotent-ish)
        resp = await async_client.post(f"/fetch/{done_job_id}/cancel")
        assert resp.status_code == 200


# ===========================================================================
# DELETE /jobs/{job_id}
# ===========================================================================

class TestDeleteJob:
    @pytest.mark.asyncio
    async def test_delete_existing_returns_200(self, async_client, done_job_id):
        resp = await async_client.delete(f"/jobs/{done_job_id}")
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True

    @pytest.mark.asyncio
    async def test_delete_removes_from_job_list(self, async_client, done_job_id):
        await async_client.delete(f"/jobs/{done_job_id}")
        resp = await async_client.get("/jobs")
        ids = [j["job_id"] for j in resp.json()]
        assert done_job_id not in ids

    @pytest.mark.asyncio
    async def test_delete_nonexistent_returns_404(self, async_client):
        resp = await async_client.delete("/jobs/no-such-job")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_twice_second_is_404(self, async_client, done_job_id):
        await async_client.delete(f"/jobs/{done_job_id}")
        resp = await async_client.delete(f"/jobs/{done_job_id}")
        assert resp.status_code == 404


# ===========================================================================
# PATCH /jobs/{job_id}  — rename
# ===========================================================================

class TestRenameJob:
    @pytest.mark.asyncio
    async def test_rename_updates_label(self, async_client, done_job_id):
        resp = await async_client.patch(f"/jobs/{done_job_id}", json={"label": "owner/repo"})
        assert resp.status_code == 200
        assert resp.json()["label"] == "owner/repo"

    @pytest.mark.asyncio
    async def test_rename_nonexistent_returns_404(self, async_client):
        resp = await async_client.patch("/jobs/no-such-job", json={"label": "name"})
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_rename_truncates_at_120_chars(self, async_client, done_job_id):
        # RenameJobRequest enforces max_length=120 — labels over 120 chars return 422.
        long_label = "x" * 200
        resp = await async_client.patch(f"/jobs/{done_job_id}", json={"label": long_label})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_rename_with_no_label_field_returns_422(self, async_client, done_job_id):
        # label is required in RenameJobRequest — missing field returns 422.
        resp = await async_client.patch(f"/jobs/{done_job_id}", json={"other": "value"})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_rename_empty_string_returns_422(self, async_client, done_job_id):
        # RenameJobRequest enforces min_length=1 — empty label returns 422.
        resp = await async_client.patch(f"/jobs/{done_job_id}", json={"label": ""})
        assert resp.status_code == 422


# ===========================================================================
# PATCH /jobs/{job_id}/tags  — update tags
# ===========================================================================

class TestUpdateJobTags:
    @pytest.mark.asyncio
    async def test_set_tags_returns_200(self, async_client, done_job_id):
        resp = await async_client.patch(
            f"/jobs/{done_job_id}/tags",
            json={"tags": ["production", "research"]},
        )
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_set_tags_returns_normalised_tags(self, async_client, done_job_id):
        resp = await async_client.patch(
            f"/jobs/{done_job_id}/tags",
            json={"tags": ["PRODUCTION", "  Research  "]},
        )
        data = resp.json()
        assert "production" in data["tags"]
        assert "research" in data["tags"]

    @pytest.mark.asyncio
    async def test_set_tags_deduplicates(self, async_client, done_job_id):
        resp = await async_client.patch(
            f"/jobs/{done_job_id}/tags",
            json={"tags": ["alpha", "alpha", "beta"]},
        )
        tags = resp.json()["tags"]
        assert tags.count("alpha") == 1

    @pytest.mark.asyncio
    async def test_set_tags_empty_list_clears(self, async_client, done_job_id):
        await async_client.patch(f"/jobs/{done_job_id}/tags", json={"tags": ["old"]})
        resp = await async_client.patch(f"/jobs/{done_job_id}/tags", json={"tags": []})
        assert resp.json()["tags"] == []

    @pytest.mark.asyncio
    async def test_set_tags_reflected_in_jobs_list(self, async_client, done_job_id):
        await async_client.patch(
            f"/jobs/{done_job_id}/tags",
            json={"tags": ["production"]},
        )
        resp = await async_client.get("/jobs")
        job = next(j for j in resp.json() if j["job_id"] == done_job_id)
        assert "production" in job["tags"]

    @pytest.mark.asyncio
    async def test_set_tags_nonexistent_job_returns_404(self, async_client):
        resp = await async_client.patch("/jobs/no-such-job/tags", json={"tags": ["tag"]})
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_set_tags_non_list_body_returns_422(self, async_client, done_job_id):
        resp = await async_client.patch(
            f"/jobs/{done_job_id}/tags",
            json={"tags": "production"},  # string, not list
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_set_tags_filters_blank_entries(self, async_client, done_job_id):
        resp = await async_client.patch(
            f"/jobs/{done_job_id}/tags",
            json={"tags": ["valid", "", "   "]},
        )
        tags = resp.json()["tags"]
        assert tags == ["valid"]
