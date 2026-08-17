"""
test_fixes.py — regression cover for the bug/security fixes and new features.

Each test here fails against the pre-fix behaviour.
"""
from __future__ import annotations

import asyncio
import csv
import io
from unittest.mock import MagicMock, patch

import pytest

import store
import worker
from conftest import SAMPLE_USERS, TEST_OWNER_KEY, _seed_done_job

A = {"rp_client": "test-client-cookie"}


# ---------------------------------------------------------------------------
# CSV formula injection
# ---------------------------------------------------------------------------

class TestCsvInjection:
    @pytest.mark.parametrize("payload", ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"])
    def test_dangerous_prefixes_are_neutralised(self, payload):
        assert store.csv_safe(payload).startswith("'")

    def test_ordinary_values_are_untouched(self):
        for value in ["alice", "ACME Corp", "", None, 42, True]:
            assert store.csv_safe(value) == value

    def test_export_escapes_formula_in_user_field(self):
        # An imported record can carry any string; opening the export in Excel
        # must not execute it.
        result = {"evil": {"login": "evil", "name": '=cmd|" /C calc"!A0'}}
        rows = list(csv.DictReader(io.StringIO(store.result_to_csv_bytes(result).decode())))
        assert rows[0]["name"].startswith("'=")

    def test_export_still_round_trips_normal_data(self):
        rows = list(csv.DictReader(io.StringIO(store.result_to_csv_bytes(dict(SAMPLE_USERS)).decode())))
        assert {r["login"] for r in rows} == set(SAMPLE_USERS)


# ---------------------------------------------------------------------------
# Job cancellation
# ---------------------------------------------------------------------------

class TestCancellation:
    @pytest.mark.asyncio
    async def test_cancel_is_visible_to_a_separate_proxy(self):
        """The worker holds its own proxy instance. A cancel issued through a
        different one must be visible to it — previously each proxy cached its
        own `cancelled: False` and the worker never noticed."""
        job_id = await store.create_job_async(owner_key=TEST_OWNER_KEY)
        worker_view = store.get_job(job_id)
        api_view = store.get_job(job_id)
        assert worker_view is not api_view

        assert worker_view.get("cancelled") is False
        api_view["cancelled"] = True
        assert worker_view.get("cancelled") is True
        assert worker_view["cancelled"] is True

    @pytest.mark.asyncio
    async def test_cancel_endpoint_reaches_the_worker_view(self, async_client):
        job_id = await store.create_job_async(owner_key=TEST_OWNER_KEY)
        worker_view = store.get_job(job_id)
        resp = await async_client.post(f"/fetch/{job_id}/cancel", cookies=A)
        assert resp.status_code == 200
        assert worker_view.get("cancelled") is True

    @pytest.mark.asyncio
    async def test_proxies_share_the_event_queue(self):
        job_id = await store.create_job_async(owner_key=TEST_OWNER_KEY)
        assert store.get_job(job_id)["events"] is store.get_job(job_id)["events"]


# ---------------------------------------------------------------------------
# Fetch limits — the cost cap that used to be silently ignored
# ---------------------------------------------------------------------------

def _mock_github_env(users_per_role: int):
    """Patch worker's GitHub surface so run_fetch_job does no network I/O."""
    logins = [f"user{i:03d}" for i in range(users_per_role)]

    export = MagicMock()
    for name in (
        "export_contributors", "export_maintainers", "export_stargazers",
        "export_watchers", "export_issue_authors", "export_pr_authors",
        "export_fork_owners", "export_commit_authors", "export_dependents",
    ):
        getattr(export, name).return_value = list(logins)

    def _user_info(gh, username):
        info = MagicMock()
        info.to_dict.return_value = {"login": username, "is_bot": False}
        return info

    return patch.multiple(
        worker,
        rp_export=export,
        GitHubUserInfo=_user_info,
        Github=MagicMock(),
    )


async def _run(job_id: str, **kwargs):
    defaults = dict(
        owner="acme", repo="widget", token="", roles=["contributors"],
        limit=None, exclude_bots=False, include_social_accounts=False,
        workers=2, save_each_user=False,
    )
    defaults.update(kwargs)
    await worker.run_fetch_job(job_id=job_id, **defaults)


class TestFetchLimits:
    @pytest.mark.asyncio
    async def test_per_role_limit_is_applied(self):
        job_id = await store.create_job_async(owner_key=TEST_OWNER_KEY)
        with _mock_github_env(50):
            await _run(job_id, limit=10)
        job = await store.get_job_async(job_id)
        assert job["total_fetched"] == 10

    @pytest.mark.asyncio
    async def test_max_total_caps_across_roles(self):
        # 3 roles x 30 distinct-per-role usernames would exceed the cap without
        # the server-side max_total ceiling.
        job_id = await store.create_job_async(owner_key=TEST_OWNER_KEY)
        with _mock_github_env(30):
            await _run(job_id, roles=["contributors", "stargazers", "watchers"],
                       limit=None, max_total=12)
        job = await store.get_job_async(job_id)
        assert job["total_fetched"] == 12

    @pytest.mark.asyncio
    async def test_no_limit_fetches_everything(self):
        job_id = await store.create_job_async(owner_key=TEST_OWNER_KEY)
        with _mock_github_env(15):
            await _run(job_id, limit=None, max_total=None)
        job = await store.get_job_async(job_id)
        assert job["total_fetched"] == 15

    @pytest.mark.asyncio
    async def test_capped_run_keeps_roles_consistent(self):
        job_id = await store.create_job_async(owner_key=TEST_OWNER_KEY)
        with _mock_github_env(40):
            await _run(job_id, roles=["contributors", "stargazers"], max_total=5)
        job = await store.get_job_async(job_id)
        # Every retained user still carries its role membership.
        assert all(u["roles"] for u in job["result"].values())


# ---------------------------------------------------------------------------
# Server-side filtering — used to apply only to already-loaded pages
# ---------------------------------------------------------------------------

class TestResultFiltering:
    @pytest.mark.asyncio
    async def test_filter_applies_across_whole_result_set(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS))
        resp = await async_client.get(f"/results/{jid}", params={"q": "alice"}, cookies=A)
        body = resp.json()
        assert body["total"] == 1
        assert body["unfiltered_total"] == 3
        assert list(body["users"]) == ["alice"]

    @pytest.mark.asyncio
    async def test_hide_bots_excludes_bot_accounts(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS))
        body = (await async_client.get(
            f"/results/{jid}", params={"hide_bots": "true"}, cookies=A)).json()
        assert "dependabot[bot]" not in body["users"]
        assert body["total"] == 2

    @pytest.mark.asyncio
    async def test_min_followers_filter(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS))
        body = (await async_client.get(
            f"/results/{jid}", params={"min_followers": 100}, cookies=A)).json()
        assert list(body["users"]) == ["alice"]

    @pytest.mark.asyncio
    async def test_sort_desc_orders_by_field(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS))
        body = (await async_client.get(
            f"/results/{jid}",
            params={"sort_by": "followers", "sort_dir": "desc"}, cookies=A)).json()
        assert list(body["users"])[0] == "alice"

    @pytest.mark.asyncio
    async def test_filtered_pagination_reports_filtered_total(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS))
        body = (await async_client.get(
            f"/results/{jid}",
            params={"hide_bots": "true", "page_size": 1}, cookies=A)).json()
        assert body["pages"] == 2 and body["total"] == 2

    @pytest.mark.asyncio
    async def test_role_filter(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS))
        body = (await async_client.get(
            f"/results/{jid}", params={"role": "contributors"}, cookies=A)).json()
        assert set(body["users"]) == {"alice", "dependabot[bot]"}


# ---------------------------------------------------------------------------
# Churn / retention history
# ---------------------------------------------------------------------------

class TestHistory:
    @pytest.mark.asyncio
    async def test_single_run_has_no_deltas(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS), params={"owner": "acme", "repo": "widget"})
        body = (await async_client.get(f"/jobs/{jid}/history", cookies=A)).json()
        assert body["total_runs"] == 1
        assert body["runs"][0]["retention_pct"] is None

    @pytest.mark.asyncio
    async def test_joiners_and_leavers_between_runs(self, async_client):
        params = {"owner": "acme", "repo": "widget"}
        await _seed_done_job({"alice": SAMPLE_USERS["alice"], "bob": SAMPLE_USERS["bob"]}, params=params)
        await asyncio.sleep(0.01)  # distinct created_at ordering
        jid2 = await _seed_done_job(
            {"bob": SAMPLE_USERS["bob"], "carol": {"login": "carol"}}, params=params)

        body = (await async_client.get(f"/jobs/{jid2}/history", cookies=A)).json()
        assert body["total_runs"] == 2
        latest = body["runs"][-1]
        assert latest["joined"] == ["carol"]
        assert latest["left"] == ["alice"]
        assert latest["retention_pct"] == 50.0
        assert body["core_members"] == 1  # bob is in every run

    @pytest.mark.asyncio
    async def test_imported_job_cannot_be_tracked(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS))  # no params → no repo
        assert (await async_client.get(f"/jobs/{jid}/history", cookies=A)).status_code == 409

    @pytest.mark.asyncio
    async def test_history_is_owner_scoped(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS), params={"owner": "acme", "repo": "widget"})
        resp = await async_client.get(f"/jobs/{jid}/history", cookies={"rp_client": "someone-else"})
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Scheduled re-fetch
# ---------------------------------------------------------------------------

FETCH_PARAMS = {
    "owner": "acme", "repo": "widget", "roles": ["contributors"], "limit": 10,
    "exclude_bots": False, "include_social_accounts": False, "workers": 2,
    "save_each_user": False,
}


class TestSchedules:
    @pytest.mark.asyncio
    async def test_create_and_list(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS), params=FETCH_PARAMS)
        created = (await async_client.post(
            "/schedules", json={"job_id": jid, "interval_hours": 24}, cookies=A)).json()
        assert created["interval_hours"] == 24 and created["enabled"] is True

        listed = (await async_client.get("/schedules", cookies=A)).json()
        assert [s["schedule_id"] for s in listed] == [created["schedule_id"]]

    @pytest.mark.asyncio
    async def test_cannot_schedule_a_job_without_params(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS))
        resp = await async_client.post("/schedules", json={"job_id": jid}, cookies=A)
        assert resp.status_code == 409

    @pytest.mark.asyncio
    async def test_cannot_schedule_someone_elses_job(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS), params=FETCH_PARAMS)
        resp = await async_client.post(
            "/schedules", json={"job_id": jid}, cookies={"rp_client": "someone-else"})
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_disable_and_delete(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS), params=FETCH_PARAMS)
        sid = (await async_client.post("/schedules", json={"job_id": jid}, cookies=A)).json()["schedule_id"]

        patched = (await async_client.patch(
            f"/schedules/{sid}", json={"enabled": False}, cookies=A)).json()
        assert patched["enabled"] is False

        assert (await async_client.delete(f"/schedules/{sid}", cookies=A)).status_code == 200
        assert (await async_client.get("/schedules", cookies=A)).json() == []

    @pytest.mark.asyncio
    async def test_interval_bounds_enforced(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS), params=FETCH_PARAMS)
        for bad in (0, 721):
            resp = await async_client.post(
                "/schedules", json={"job_id": jid, "interval_hours": bad}, cookies=A)
            assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_due_schedule_is_claimed_once(self):
        sched = await store.create_schedule(
            TEST_OWNER_KEY, "job-1", FETCH_PARAMS, "acme/widget", interval_hours=1)
        # Force it due.
        async with store._db() as c:
            await c.exec("UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?",
                         ("2000-01-01T00:00:00", sched["schedule_id"]))
            await c.commit()

        first = await store.claim_due_schedules()
        second = await store.claim_due_schedules()
        assert [s["schedule_id"] for s in first] == [sched["schedule_id"]]
        assert second == []  # next_run_at advanced, so no double-run

    @pytest.mark.asyncio
    async def test_disabled_schedules_are_not_claimed(self):
        sched = await store.create_schedule(
            TEST_OWNER_KEY, "job-1", FETCH_PARAMS, None, interval_hours=1)
        await store.set_schedule_enabled(sched["schedule_id"], TEST_OWNER_KEY, False)
        async with store._db() as c:
            await c.exec("UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?",
                         ("2000-01-01T00:00:00", sched["schedule_id"]))
            await c.commit()
        assert await store.claim_due_schedules() == []

    @pytest.mark.asyncio
    async def test_deleting_a_job_removes_its_schedules(self, async_client):
        jid = await _seed_done_job(dict(SAMPLE_USERS), params=FETCH_PARAMS)
        await async_client.post("/schedules", json={"job_id": jid}, cookies=A)
        await async_client.delete(f"/jobs/{jid}", cookies=A)
        assert (await async_client.get("/schedules", cookies=A)).json() == []


# ---------------------------------------------------------------------------
# Expiry sweeping
# ---------------------------------------------------------------------------

class TestPurge:
    @pytest.mark.asyncio
    async def test_expired_sessions_are_deleted(self):
        await store.create_session("live", "tok", "alice", None, None, ttl_days=30)
        await store.create_session("dead", "tok", "bob", None, None, ttl_days=30)
        async with store._db() as c:
            await c.exec("UPDATE sessions SET expires_at = ? WHERE session_id = ?",
                         ("2000-01-01T00:00:00", "dead"))
            await c.commit()

        purged = await store.purge_expired()
        assert purged["sessions"] == 1
        assert await store.get_session("live") is not None
        assert await store.get_session("dead") is None

    @pytest.mark.asyncio
    async def test_deleting_a_job_revokes_its_share_tokens(self):
        jid = await _seed_done_job(dict(SAMPLE_USERS))
        await store.add_share_token("tok123", jid)
        assert await store.get_share_token("tok123") is not None
        await store.delete_job(jid)
        assert await store.get_share_token("tok123") is None


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------

class TestRateLimit:
    def test_exceeding_the_window_raises(self):
        import main
        from fastapi import HTTPException

        main._rate_hits.clear()
        key = "test-key"
        for _ in range(main._RATE_LIMIT):
            main._rate_check(key)
        with pytest.raises(HTTPException) as exc:
            main._rate_check(key)
        assert exc.value.status_code == 429

    def test_a_fresh_cookie_does_not_reset_the_ip_budget(self):
        """Anonymous callers control their own cookie, so the IP key is what
        actually holds the line."""
        import main
        from fastapi import HTTPException

        main._rate_hits.clear()
        ip = "ip:198.51.100.7"
        for i in range(main._RATE_LIMIT):
            main._rate_check(f"anon:cookie-{i}", ip)  # new cookie every time
        with pytest.raises(HTTPException):
            main._rate_check("anon:cookie-brand-new", ip)

    def test_prune_drops_stale_windows(self):
        import main

        main._rate_hits.clear()
        main._rate_hits["stale"] = [0.0]           # long expired
        main._rate_check("fresh")
        main._prune_rate_hits()
        assert "stale" not in main._rate_hits
        assert "fresh" in main._rate_hits
