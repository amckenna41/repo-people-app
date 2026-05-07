"""
test_api_compare.py — Integration tests for compare and multi-compare endpoints:
  POST /compare       — pairwise comparison between two jobs
  POST /compare/multi — multi-set comparison across 2–5 jobs
"""
from __future__ import annotations

import pytest

from conftest import SAMPLE_USERS, _seed_done_job, _seed_pending_job


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

# The conftest `two_done_jobs` fixture provides (job_a_id, job_b_id) where:
#   job_a = {alice, bob}
#   job_b = {bob, carol}
# Overlap = {bob}, only_in_a = {alice}, only_in_b = {carol}


# ===========================================================================
# POST /compare
# ===========================================================================

class TestCompare:
    @pytest.mark.asyncio
    async def test_returns_200_for_two_done_jobs(self, async_client, two_done_jobs):
        id_a, id_b = two_done_jobs
        resp = await async_client.post("/compare", json={"job_id_a": id_a, "job_id_b": id_b})
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_response_has_required_keys(self, async_client, two_done_jobs):
        id_a, id_b = two_done_jobs
        resp = await async_client.post("/compare", json={"job_id_a": id_a, "job_id_b": id_b})
        data = resp.json()
        for key in ("only_in_a", "only_in_b", "in_both", "stats"):
            assert key in data, f"Missing key: {key}"

    @pytest.mark.asyncio
    async def test_only_in_a_correct(self, async_client, two_done_jobs):
        id_a, id_b = two_done_jobs
        resp = await async_client.post("/compare", json={"job_id_a": id_a, "job_id_b": id_b})
        data = resp.json()
        # only_in_a is a list of {login, avatar_url, html_url} objects
        logins = [u["login"] for u in data["only_in_a"]]
        assert "alice" in logins

    @pytest.mark.asyncio
    async def test_only_in_b_correct(self, async_client, two_done_jobs):
        id_a, id_b = two_done_jobs
        resp = await async_client.post("/compare", json={"job_id_a": id_a, "job_id_b": id_b})
        data = resp.json()
        logins = [u["login"] for u in data["only_in_b"]]
        assert "carol" in logins

    @pytest.mark.asyncio
    async def test_in_both_correct(self, async_client, two_done_jobs):
        id_a, id_b = two_done_jobs
        resp = await async_client.post("/compare", json={"job_id_a": id_a, "job_id_b": id_b})
        data = resp.json()
        logins = [u["login"] for u in data["in_both"]]
        assert "bob" in logins

    @pytest.mark.asyncio
    async def test_user_objects_have_required_fields(self, async_client, two_done_jobs):
        id_a, id_b = two_done_jobs
        resp = await async_client.post("/compare", json={"job_id_a": id_a, "job_id_b": id_b})
        data = resp.json()
        for section in ("only_in_a", "only_in_b", "in_both"):
            for user_obj in data[section]:
                assert "login" in user_obj
                assert "avatar_url" in user_obj
                assert "html_url" in user_obj

    @pytest.mark.asyncio
    async def test_stats_contain_overlap_pct(self, async_client, two_done_jobs):
        id_a, id_b = two_done_jobs
        resp = await async_client.post("/compare", json={"job_id_a": id_a, "job_id_b": id_b})
        data = resp.json()
        assert "overlap_pct" in data["stats"]

    @pytest.mark.asyncio
    async def test_overlap_pct_is_number(self, async_client, two_done_jobs):
        id_a, id_b = two_done_jobs
        resp = await async_client.post("/compare", json={"job_id_a": id_a, "job_id_b": id_b})
        assert isinstance(resp.json()["stats"]["overlap_pct"], (int, float))

    @pytest.mark.asyncio
    async def test_overlap_pct_in_valid_range(self, async_client, two_done_jobs):
        id_a, id_b = two_done_jobs
        resp = await async_client.post("/compare", json={"job_id_a": id_a, "job_id_b": id_b})
        pct = resp.json()["stats"]["overlap_pct"]
        assert 0.0 <= pct <= 100.0

    @pytest.mark.asyncio
    async def test_compare_same_job_with_itself_full_overlap(self, async_client):
        jid = await _seed_done_job({"alice": SAMPLE_USERS["alice"], "bob": SAMPLE_USERS["bob"]})
        resp = await async_client.post("/compare", json={"job_id_a": jid, "job_id_b": jid})
        assert resp.status_code == 200
        data = resp.json()
        assert data["only_in_a"] == []
        assert data["only_in_b"] == []
        assert data["stats"]["overlap_pct"] == 100.0

    @pytest.mark.asyncio
    async def test_returns_404_if_job_a_not_found(self, async_client, done_job_id):
        resp = await async_client.post("/compare", json={"job_id_a": "no-such-job", "job_id_b": done_job_id})
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_returns_404_if_job_b_not_found(self, async_client, done_job_id):
        resp = await async_client.post("/compare", json={"job_id_a": done_job_id, "job_id_b": "no-such-job"})
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_returns_409_if_job_a_not_done(self, async_client, pending_job_id, done_job_id):
        resp = await async_client.post("/compare", json={"job_id_a": pending_job_id, "job_id_b": done_job_id})
        assert resp.status_code == 409

    @pytest.mark.asyncio
    async def test_returns_409_if_job_b_not_done(self, async_client, done_job_id, pending_job_id):
        resp = await async_client.post("/compare", json={"job_id_a": done_job_id, "job_id_b": pending_job_id})
        assert resp.status_code == 409

    @pytest.mark.asyncio
    async def test_missing_job_id_b_returns_422(self, async_client, done_job_id):
        resp = await async_client.post("/compare", json={"job_id_a": done_job_id})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_missing_job_id_a_returns_422(self, async_client, done_job_id):
        resp = await async_client.post("/compare", json={"job_id_b": done_job_id})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_no_overlap_gives_0_pct(self, async_client):
        id_a = await _seed_done_job({"alice": SAMPLE_USERS["alice"]})
        id_b = await _seed_done_job({"bob": SAMPLE_USERS["bob"]})
        resp = await async_client.post("/compare", json={"job_id_a": id_a, "job_id_b": id_b})
        assert resp.json()["stats"]["overlap_pct"] == 0.0


# ===========================================================================
# POST /compare/multi
# ===========================================================================

class TestCompareMulti:
    @pytest.mark.asyncio
    async def test_returns_200_for_two_jobs(self, async_client, two_done_jobs):
        id_a, id_b = two_done_jobs
        resp = await async_client.post("/compare/multi", json={"job_ids": [id_a, id_b]})
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_response_has_required_keys(self, async_client, two_done_jobs):
        id_a, id_b = two_done_jobs
        resp = await async_client.post("/compare/multi", json={"job_ids": [id_a, id_b]})
        data = resp.json()
        for key in ("in_all", "shared", "exclusive_per_job", "stats"):
            assert key in data, f"Missing key: {key}"

    @pytest.mark.asyncio
    async def test_in_all_is_intersection(self, async_client, two_done_jobs):
        id_a, id_b = two_done_jobs
        resp = await async_client.post("/compare/multi", json={"job_ids": [id_a, id_b]})
        # in_all is a list of {login, avatar_url, html_url} objects
        data = resp.json()
        logins_in_all = [u["login"] for u in data["in_all"]]
        assert "bob" in logins_in_all
        assert "alice" not in logins_in_all
        assert "carol" not in logins_in_all

    @pytest.mark.asyncio
    async def test_exclusive_per_job_is_list_of_lists(self, async_client, two_done_jobs):
        id_a, id_b = two_done_jobs
        resp = await async_client.post("/compare/multi", json={"job_ids": [id_a, id_b]})
        exclusive = resp.json()["exclusive_per_job"]
        # exclusive_per_job is a list indexed by job position, each element a list of user objects
        assert isinstance(exclusive, list)
        assert len(exclusive) == 2

    @pytest.mark.asyncio
    async def test_exclusive_per_job_correct_users(self, async_client, two_done_jobs):
        id_a, id_b = two_done_jobs
        resp = await async_client.post("/compare/multi", json={"job_ids": [id_a, id_b]})
        exclusive = resp.json()["exclusive_per_job"]
        # exclusive_per_job[0] = job_a exclusive users, exclusive_per_job[1] = job_b exclusive users
        logins_a = [u["login"] for u in exclusive[0]]
        logins_b = [u["login"] for u in exclusive[1]]
        assert "alice" in logins_a
        assert "carol" in logins_b

    @pytest.mark.asyncio
    async def test_five_jobs_accepted(self, async_client):
        jids = [await _seed_done_job({"alice": SAMPLE_USERS["alice"]}) for _ in range(5)]
        resp = await async_client.post("/compare/multi", json={"job_ids": jids})
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_one_job_id_returns_422(self, async_client, done_job_id):
        resp = await async_client.post("/compare/multi", json={"job_ids": [done_job_id]})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_six_job_ids_returns_422(self, async_client):
        jids = [await _seed_done_job({}) for _ in range(6)]
        resp = await async_client.post("/compare/multi", json={"job_ids": jids})
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_returns_404_for_missing_job(self, async_client, done_job_id):
        resp = await async_client.post(
            "/compare/multi",
            json={"job_ids": [done_job_id, "no-such-job"]},
        )
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_returns_409_for_pending_job(self, async_client, done_job_id, pending_job_id):
        resp = await async_client.post(
            "/compare/multi",
            json={"job_ids": [done_job_id, pending_job_id]},
        )
        assert resp.status_code == 409

    @pytest.mark.asyncio
    async def test_stats_present(self, async_client, two_done_jobs):
        id_a, id_b = two_done_jobs
        resp = await async_client.post("/compare/multi", json={"job_ids": [id_a, id_b]})
        assert isinstance(resp.json()["stats"], dict)

    @pytest.mark.asyncio
    async def test_three_jobs_returns_200(self, async_client):
        users_a = {"alice": SAMPLE_USERS["alice"]}
        users_b = {"bob": SAMPLE_USERS["bob"]}
        users_c = {"alice": SAMPLE_USERS["alice"], "bob": SAMPLE_USERS["bob"]}
        id_a = await _seed_done_job(users_a)
        id_b = await _seed_done_job(users_b)
        id_c = await _seed_done_job(users_c)
        resp = await async_client.post("/compare/multi", json={"job_ids": [id_a, id_b, id_c]})
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_same_job_twice_in_all(self, async_client):
        jid = await _seed_done_job({"alice": SAMPLE_USERS["alice"]})
        resp = await async_client.post("/compare/multi", json={"job_ids": [jid, jid]})
        assert resp.status_code == 200
        logins = [u["login"] for u in resp.json()["in_all"]]
        assert "alice" in logins
