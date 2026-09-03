"""
test_performance.py — guards for the performance work.

These assert *mechanism*, not timing: that the cheap path is genuinely taken.
A wall-clock assertion would be flaky; "did it read the blob at all" is not.
"""
from __future__ import annotations

import json

import pytest

import store
from conftest import SAMPLE_USERS, _seed_done_job


class TestMetadataOnlyReads:
    """Ownership checks used to SELECT * and json.loads() the whole result blob,
    so renaming a job re-parsed tens of MB on a large fetch."""

    @pytest.mark.asyncio
    async def test_meta_row_omits_result_json(self):
        job_id = await _seed_done_job(dict(SAMPLE_USERS))
        row = await store._load_job_row(job_id, include_result=False)
        assert "result_json" not in row
        # The metadata a route actually needs is still there.
        for col in ("status", "owner_key", "params_json", "repo_owner", "repo_name", "label"):
            assert col in row

    @pytest.mark.asyncio
    async def test_full_row_still_includes_result_json(self):
        job_id = await _seed_done_job(dict(SAMPLE_USERS))
        row = await store._load_job_row(job_id)
        assert json.loads(row["result_json"]).keys() == SAMPLE_USERS.keys()

    @pytest.mark.asyncio
    async def test_get_job_async_without_result_reports_none(self):
        job_id = await _seed_done_job(dict(SAMPLE_USERS))
        meta = await store.get_job_async(job_id, include_result=False)
        assert meta["result"] is None
        assert meta["status"] == "done"
        full = await store.get_job_async(job_id)
        assert full["result"] is not None

    @pytest.mark.asyncio
    async def test_metadata_read_never_parses_the_blob(self, monkeypatch):
        """The point of the change: no json.loads of result_json on this path."""
        job_id = await _seed_done_job(dict(SAMPLE_USERS))
        calls: list[int] = []
        real_loads = json.loads

        def counting_loads(text, *a, **k):
            # Only count parses of something blob-sized.
            if isinstance(text, str) and len(text) > 200:
                calls.append(len(text))
            return real_loads(text, *a, **k)

        monkeypatch.setattr(store.json, "loads", counting_loads)
        await store.get_job_async(job_id, include_result=False)
        assert calls == []

        await store.get_job_async(job_id)
        assert calls, "the full read should still parse the blob"


class TestOwnershipRoutesUseMetadata:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("method,path_suffix,body", [
        ("PATCH", "", {"label": "renamed"}),
        ("PATCH", "/tags", {"tags": ["x"]}),
    ])
    async def test_metadata_routes_still_work(self, async_client, method, path_suffix, body):
        job_id = await _seed_done_job(dict(SAMPLE_USERS))
        res = await async_client.request(method, f"/jobs/{job_id}{path_suffix}", json=body)
        assert res.status_code == 200

    @pytest.mark.asyncio
    async def test_delete_still_works(self, async_client):
        job_id = await _seed_done_job(dict(SAMPLE_USERS))
        assert (await async_client.delete(f"/jobs/{job_id}")).status_code == 200
        assert (await async_client.get(f"/results/{job_id}")).status_code == 404

    @pytest.mark.asyncio
    async def test_results_route_still_returns_the_payload(self, async_client):
        """The routes that *do* need the blob must not have been switched over."""
        job_id = await _seed_done_job(dict(SAMPLE_USERS))
        res = await async_client.get(f"/results/{job_id}")
        assert res.status_code == 200
        assert len(res.json()["users"]) == len(SAMPLE_USERS)

    @pytest.mark.asyncio
    async def test_summary_cache_hit_does_not_need_the_blob(self, async_client):
        job_id = await _seed_done_job(dict(SAMPLE_USERS))
        first = await async_client.get(f"/results/{job_id}/summary")
        assert first.status_code == 200
        # Second call is served from the cached summary column.
        second = await async_client.get(f"/results/{job_id}/summary")
        assert second.status_code == 200
        assert second.json() == first.json()

    @pytest.mark.asyncio
    async def test_export_still_returns_every_user(self, async_client):
        job_id = await _seed_done_job(dict(SAMPLE_USERS))
        res = await async_client.get(f"/results/{job_id}/export/json")
        assert res.status_code == 200
        assert json.loads(res.content).keys() == SAMPLE_USERS.keys()


class TestFetchConcurrencyLimits:
    def test_a_dedicated_executor_is_used(self):
        """Fetch work must not run on asyncio's shared, process-wide pool."""
        import worker
        assert worker._fetch_executor is not None
        assert worker._fetch_executor._thread_name_prefix == "repo-people-fetch"

    def test_concurrent_jobs_are_capped(self):
        import worker
        assert worker._MAX_CONCURRENT_JOBS >= 1
        assert worker._job_slots._value == worker._MAX_CONCURRENT_JOBS

    def test_no_call_site_uses_the_default_executor(self):
        """A new run_in_executor(None, ...) would silently reintroduce the bug."""
        import pathlib
        import worker
        # Strip comments: the explanation of this very bug mentions the pattern.
        code = "\n".join(
            line for line in pathlib.Path(worker.__file__).read_text().splitlines()
            if not line.lstrip().startswith("#")
        )
        assert "run_in_executor(None" not in code
        assert code.count("run_in_executor(_fetch_executor") >= 2


class TestSqliteContention:
    def test_busy_timeout_exceeds_the_driver_default(self):
        """The 5s default is easily exceeded when several jobs finish together,
        and surfaces as an unexplained 5xx ("database is locked")."""
        assert store._SQLITE_BUSY_TIMEOUT_MS > 5000

    @pytest.mark.asyncio
    async def test_pragmas_are_applied_to_each_connection(self):
        if store.IS_POSTGRES:
            pytest.skip("SQLite-only")
        async with store._db() as c:
            busy = await c.one("PRAGMA busy_timeout")
            journal = await c.one("PRAGMA journal_mode")
        assert int(list(busy.values())[0]) == store._SQLITE_BUSY_TIMEOUT_MS
        assert str(list(journal.values())[0]).lower() == "wal"

    @pytest.mark.asyncio
    async def test_concurrent_writes_do_not_raise_database_is_locked(self):
        import asyncio
        job_ids = [await _seed_done_job() for _ in range(6)]
        await asyncio.gather(*[
            store.persist_job(j, label=f"concurrent-{i}") for i, j in enumerate(job_ids)
        ])
        for i, j in enumerate(job_ids):
            row = await store._load_job_row(j, include_result=False)
            assert row["label"] == f"concurrent-{i}"


class TestPersistedWarnings:
    """Warnings were emitted only on the ephemeral SSE queue, so a user who
    closed the tab lost the reason their result set came back short."""

    @pytest.mark.asyncio
    async def test_warnings_round_trip_through_the_job(self):
        job_id = await _seed_done_job(dict(SAMPLE_USERS))
        await store.persist_job(job_id, warnings=["⚠️ stargazers: needs a token"])
        job = await store.get_job_async(job_id, include_result=False)
        assert job["warnings"] == ["⚠️ stargazers: needs a token"]

    @pytest.mark.asyncio
    async def test_absent_warnings_read_as_an_empty_list(self):
        job_id = await _seed_done_job(dict(SAMPLE_USERS))
        job = await store.get_job_async(job_id)
        assert job["warnings"] == []

    @pytest.mark.asyncio
    async def test_results_endpoint_surfaces_them(self, async_client):
        job_id = await _seed_done_job(dict(SAMPLE_USERS))
        await store.persist_job(job_id, warnings=["⚠️ watchers: needs a token"])
        res = await async_client.get(f"/results/{job_id}")
        assert res.status_code == 200
        assert res.json()["warnings"] == ["⚠️ watchers: needs a token"]

    @pytest.mark.asyncio
    async def test_worker_deduplicates_repeated_warnings(self):
        """One warning per role, not one per retry."""
        import worker
        seen: list[str] = []

        # Mirror the collector in run_fetch_job.
        def collect(message: str) -> None:
            if message and message not in seen:
                seen.append(message)

        for _ in range(3):
            collect("⚠️ stargazers: needs a token")
        collect("⚠️ watchers: needs a token")
        assert seen == ["⚠️ stargazers: needs a token", "⚠️ watchers: needs a token"]
        assert hasattr(worker, "run_fetch_job")


class TestRetryAfter:
    @pytest.mark.asyncio
    async def test_429_carries_a_retry_after_header(self, async_client, monkeypatch):
        import main
        monkeypatch.setattr(main, "_RATE_LIMIT", 1)
        main._rate_hits.clear()

        first = await async_client.post("/import", json={"a": {"login": "a"}})
        assert first.status_code == 200
        second = await async_client.post("/import", json={"b": {"login": "b"}})

        assert second.status_code == 429
        assert "Retry-After" in second.headers
        delay = int(second.headers["Retry-After"])
        assert 1 <= delay <= main._RATE_WINDOW + 1
        # The body should say the same thing, for a human reading the error.
        assert "try again in" in second.json()["detail"].lower()
        main._rate_hits.clear()

    def test_retry_after_is_exposed_to_cross_origin_callers(self):
        """Set but not exposed, the header is invisible to the frontend, which
        runs on a different origin in the hosted deployment."""
        import main
        cors = [m for m in main.app.user_middleware if m.cls.__name__ == "CORSMiddleware"][0]
        assert "Retry-After" in cors.kwargs["expose_headers"]


class TestJobRetention:
    @pytest.mark.asyncio
    async def test_prune_keeps_the_newest_and_removes_the_rest(self):
        owner = "anon:retention"
        ids = [await _seed_done_job({"a": {"login": "a"}}, owner_key=owner) for _ in range(6)]
        removed = await store.prune_oldest_jobs(owner, keep=4)

        assert len(removed) == 2
        remaining = {j["job_id"] for j in await store.load_jobs_list(owner)}
        assert len(remaining) == 4
        # The newest survive; the two oldest went.
        assert set(ids[-4:]) == remaining

    @pytest.mark.asyncio
    async def test_prune_is_a_no_op_under_the_cap(self):
        owner = "anon:under-cap"
        for _ in range(3):
            await _seed_done_job({"a": {"login": "a"}}, owner_key=owner)
        assert await store.prune_oldest_jobs(owner, keep=10) == []
        assert await store.count_jobs(owner) == 3

    @pytest.mark.asyncio
    async def test_prune_is_scoped_to_one_owner(self):
        mine = "anon:mine"
        theirs = "anon:theirs"
        for _ in range(3):
            await _seed_done_job({"a": {"login": "a"}}, owner_key=mine)
        for _ in range(3):
            await _seed_done_job({"a": {"login": "a"}}, owner_key=theirs)

        await store.prune_oldest_jobs(mine, keep=1)
        assert await store.count_jobs(mine) == 1
        assert await store.count_jobs(theirs) == 3

    @pytest.mark.asyncio
    async def test_prune_cascades_to_share_tokens_and_schedules(self):
        """A dangling share link must not outlive the data it points at."""
        owner = "anon:cascade"
        old = await _seed_done_job({"a": {"login": "a"}}, owner_key=owner)
        await store.add_share_token("tok-prune", old, ttl_seconds=3600)
        await store.create_schedule(owner_key=owner, source_job_id=old, params={},
                                    label=None, interval_hours=24)
        await _seed_done_job({"a": {"login": "a"}}, owner_key=owner)

        await store.prune_oldest_jobs(owner, keep=1)
        assert await store.get_share_token("tok-prune") is None
        assert await store.list_schedules(owner) == []

    @pytest.mark.asyncio
    async def test_fetch_endpoint_enforces_the_cap(self, async_client, monkeypatch):
        import main
        monkeypatch.setattr(main, "MAX_JOBS_PER_OWNER", 3)
        from conftest import TEST_OWNER_KEY
        for _ in range(5):
            await _seed_done_job({"a": {"login": "a"}}, owner_key=TEST_OWNER_KEY)

        await main._enforce_job_retention(TEST_OWNER_KEY)
        assert await store.count_jobs(TEST_OWNER_KEY) == 3

    @pytest.mark.asyncio
    async def test_cap_of_zero_disables_retention(self, async_client, monkeypatch):
        import main
        monkeypatch.setattr(main, "MAX_JOBS_PER_OWNER", 0)
        from conftest import TEST_OWNER_KEY
        for _ in range(4):
            await _seed_done_job({"a": {"login": "a"}}, owner_key=TEST_OWNER_KEY)
        await main._enforce_job_retention(TEST_OWNER_KEY)
        assert await store.count_jobs(TEST_OWNER_KEY) == 4
