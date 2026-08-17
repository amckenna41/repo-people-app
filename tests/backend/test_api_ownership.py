"""
test_api_ownership.py — jobs are scoped to their creator.

A job created by one caller (identified by the rp_client cookie for anonymous
users) must not be listable or readable by another caller. Jobs with a NULL
owner_key are private too — they used to be readable by everyone, which exposed
every pre-migration job to anonymous visitors.
"""
from __future__ import annotations

import pytest

from conftest import SAMPLE_USERS, _seed_done_job

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
    async def test_ownerless_job_is_not_readable(self, async_client):
        # A job with no owner_key belongs to nobody, so nobody may read it.
        jid = await _seed_done_job(dict(SAMPLE_USERS), owner_key=None)
        assert (await async_client.get(f"/results/{jid}", cookies=A)).status_code == 404
        assert (await async_client.get(f"/results/{jid}", cookies=B)).status_code == 404

    @pytest.mark.asyncio
    async def test_ownerless_job_is_not_listed(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS), owner_key=None)
        listed = [j["job_id"] for j in (await async_client.get("/jobs", cookies=A)).json()]
        assert jid not in listed

    @pytest.mark.asyncio
    async def test_caller_without_cookie_lists_nothing(self, anonymous_client):
        # No identity → no jobs, rather than the pool of ownerless ones.
        await _seed_done_job(dict(SAMPLE_USERS), owner_key=None)
        assert (await anonymous_client.get("/jobs")).json() == []

    @pytest.mark.asyncio
    async def test_import_mints_anonymous_cookie(self, anonymous_client):
        # A caller with no cookie gets an rp_client cookie minted on the response.
        resp = await anonymous_client.post("/import", json=SAMPLE_USERS)
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
