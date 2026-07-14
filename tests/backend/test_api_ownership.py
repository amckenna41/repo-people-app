"""
test_api_ownership.py — jobs are scoped to their creator.

A job created by one caller (identified by the rp_client cookie for anonymous
users) must not be listable or readable by another caller. Legacy jobs with a
NULL owner_key remain public for back-compat.
"""
from __future__ import annotations

import pytest

from conftest import SAMPLE_USERS

A = {"rp_client": "user-a"}
B = {"rp_client": "user-b"}


async def _import_as(client, cookies) -> str:
    resp = await client.post("/import", json=SAMPLE_USERS, cookies=cookies)
    assert resp.status_code == 200
    return resp.json()["job_id"]


class TestOwnership:
    @pytest.mark.asyncio
    async def test_owner_sees_own_job_in_list(self, async_client):
        jid = await _import_as(async_client, A)
        resp = await async_client.get("/jobs", cookies=A)
        assert jid in [j["job_id"] for j in resp.json()]

    @pytest.mark.asyncio
    async def test_other_user_does_not_see_job_in_list(self, async_client):
        jid = await _import_as(async_client, A)
        resp = await async_client.get("/jobs", cookies=B)
        assert jid not in [j["job_id"] for j in resp.json()]

    @pytest.mark.asyncio
    async def test_other_user_cannot_read_results(self, async_client):
        jid = await _import_as(async_client, A)
        assert (await async_client.get(f"/results/{jid}", cookies=A)).status_code == 200
        assert (await async_client.get(f"/results/{jid}", cookies=B)).status_code == 404

    @pytest.mark.asyncio
    async def test_other_user_cannot_delete(self, async_client):
        jid = await _import_as(async_client, A)
        assert (await async_client.delete(f"/jobs/{jid}", cookies=B)).status_code == 404
        # Still there for the owner.
        assert (await async_client.get(f"/results/{jid}", cookies=A)).status_code == 200

    @pytest.mark.asyncio
    async def test_legacy_null_owner_job_is_public(self, async_client, done_job_id):
        # done_job_id is seeded directly with no owner_key → visible to anyone.
        assert (await async_client.get(f"/results/{done_job_id}", cookies=B)).status_code == 200
        assert done_job_id in [j["job_id"] for j in (await async_client.get("/jobs", cookies=B)).json()]

    @pytest.mark.asyncio
    async def test_import_mints_anonymous_cookie(self, async_client):
        # A caller with no cookie gets an rp_client cookie minted on the response.
        resp = await async_client.post("/import", json=SAMPLE_USERS)
        assert resp.status_code == 200
        assert "rp_client" in resp.cookies

    @pytest.mark.asyncio
    async def test_refresh_without_params_returns_409(self, async_client):
        # Imported jobs have no saved fetch params, so they can't be refreshed.
        jid = await _import_as(async_client, A)
        resp = await async_client.post(f"/jobs/{jid}/refresh", cookies=A)
        assert resp.status_code == 409

    @pytest.mark.asyncio
    async def test_refresh_other_user_returns_404(self, async_client):
        jid = await _import_as(async_client, A)
        resp = await async_client.post(f"/jobs/{jid}/refresh", cookies=B)
        assert resp.status_code == 404
