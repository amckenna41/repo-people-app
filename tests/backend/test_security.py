"""
Security regression tests.

Covers the three server-side hardening measures:
  * CSRF — mutating routes require a custom header, so they cannot be sent as a
    preflight-free cross-site request while cookies are SameSite=None.
  * OAuth — the `state` is bound to the browser that started the flow via a
    cookie, so an attacker cannot hand a victim their own callback URL.
  * Sessions — GitHub tokens are encrypted at rest.
"""
from __future__ import annotations

import pytest

import store
from conftest import TEST_CLIENT_COOKIE, _seed_done_job


# ---------------------------------------------------------------------------
# CSRF header enforcement
# ---------------------------------------------------------------------------

class TestCsrfHeader:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "method,path",
        [
            ("POST", "/import"),
            ("POST", "/fetch"),
            ("POST", "/auth/logout"),
            ("POST", "/compare"),
            ("DELETE", "/jobs/whatever"),
            ("PATCH", "/jobs/whatever"),
        ],
    )
    async def test_mutating_request_without_header_is_rejected(
        self, async_client, method, path
    ):
        # Strip the header the fixture normally sends — this is what a
        # cross-site form/beacon request looks like.
        res = await async_client.request(
            method, path, headers={"X-Requested-With": ""}, json={}
        )
        assert res.status_code == 403
        assert "X-Requested-With" in res.json()["detail"]

    @pytest.mark.asyncio
    async def test_mutating_request_with_header_passes_the_check(self, async_client):
        # Reaches the handler and fails validation there (422), not at the guard.
        res = await async_client.post("/import", content=b"not json")
        assert res.status_code != 403

    @pytest.mark.asyncio
    async def test_get_requests_do_not_need_the_header(self, async_client, done_job_id):
        res = await async_client.get(
            f"/results/{done_job_id}", headers={"X-Requested-With": ""}
        )
        assert res.status_code == 200

    @pytest.mark.asyncio
    async def test_oauth_callback_is_exempt(self, async_client):
        """GitHub redirects the browser here and cannot send our header, so the
        guard must not run — the state check rejects it instead."""
        res = await async_client.get(
            "/auth/callback?code=x&state=y", headers={"X-Requested-With": ""}
        )
        assert res.status_code == 400
        assert "state" in res.json()["detail"].lower()


# ---------------------------------------------------------------------------
# OAuth state binding
# ---------------------------------------------------------------------------

class TestOauthStateBinding:
    # backend/.env is loaded at import, so GITHUB_CLIENT_SECRET is usually set
    # when these run. Blanking it keeps the callback tests hermetic: if a state
    # check ever stops rejecting, the request stops at the 503 "not configured"
    # branch instead of making a live token exchange against github.com.
    #
    # Depends on async_client deliberately: that fixture calls
    # importlib.reload(main), which re-reads .env and would otherwise undo a
    # patch applied before it.
    @pytest.fixture(autouse=True)
    def _no_outbound_oauth(self, async_client, monkeypatch):
        import main
        monkeypatch.setattr(main, "GITHUB_CLIENT_SECRET", "")

    STATE_REJECTED = "Invalid or expired OAuth state."

    @pytest.mark.asyncio
    async def test_login_sets_a_state_cookie_matching_the_redirect(
        self, async_client, monkeypatch
    ):
        import main
        monkeypatch.setattr(main, "GITHUB_CLIENT_ID", "test-client-id")

        res = await async_client.get("/auth/login", follow_redirects=False)
        assert res.status_code == 307
        cookie = res.cookies.get(main.OAUTH_STATE_COOKIE)
        assert cookie
        # The cookie must carry the same value sent to GitHub, or the callback
        # can never match the two.
        assert f"state={cookie}" in res.headers["location"]

    @pytest.mark.asyncio
    async def test_callback_without_the_cookie_is_rejected(self, async_client):
        """The attack: a valid state exists server-side, but this browser never
        started the flow, so it holds no matching cookie."""
        await store.add_oauth_state("attacker-state", ttl_seconds=600)

        res = await async_client.get(
            "/auth/callback?code=abc&state=attacker-state", follow_redirects=False
        )
        assert res.status_code == 400
        # Assert the *reason*, not just the code: a failed GitHub token exchange
        # also returns 400, so a code-only assertion could pass for the wrong
        # reason if the state check ever stopped rejecting.
        assert res.json()["detail"] == self.STATE_REJECTED
        # The state must survive — a rejected replay cannot burn a state that
        # belongs to somebody else's in-flight login.
        assert await store.consume_oauth_state("attacker-state") is True

    @pytest.mark.asyncio
    async def test_callback_with_a_mismatched_cookie_is_rejected(self, async_client):
        import main
        await store.add_oauth_state("real-state", ttl_seconds=600)
        async_client.cookies.set(main.OAUTH_STATE_COOKIE, "some-other-state")

        res = await async_client.get(
            "/auth/callback?code=abc&state=real-state", follow_redirects=False
        )
        assert res.status_code == 400
        assert res.json()["detail"] == self.STATE_REJECTED
        assert await store.consume_oauth_state("real-state") is True
        async_client.cookies.delete(main.OAUTH_STATE_COOKIE)

    @pytest.mark.asyncio
    async def test_callback_with_matching_cookie_gets_past_the_state_check(
        self, async_client
    ):
        import main
        await store.add_oauth_state("good-state", ttl_seconds=600)
        async_client.cookies.set(main.OAUTH_STATE_COOKIE, "good-state")

        res = await async_client.get(
            "/auth/callback?code=abc&state=good-state", follow_redirects=False
        )
        # 503 = passed both state checks, stopped at the missing client secret.
        assert res.status_code == 503
        async_client.cookies.delete(main.OAUTH_STATE_COOKIE)


# ---------------------------------------------------------------------------
# Session token encryption
# ---------------------------------------------------------------------------

class TestSessionTokenEncryption:
    @pytest.mark.asyncio
    async def test_token_is_not_stored_in_plaintext(self):
        await store.create_session("sess-1", "ghp_supersecret", "octocat", None, None)

        async with store._db() as c:
            row = await c.one(
                "SELECT github_token FROM sessions WHERE session_id = ?", ("sess-1",)
            )
        assert "ghp_supersecret" not in row["github_token"]

    @pytest.mark.asyncio
    async def test_get_session_returns_the_decrypted_token(self):
        await store.create_session("sess-2", "ghp_supersecret", "octocat", None, None)

        session = await store.get_session("sess-2")
        assert session["github_token"] == "ghp_supersecret"
        assert session["github_login"] == "octocat"

    @pytest.mark.asyncio
    async def test_undecryptable_row_is_treated_as_no_session_and_dropped(self):
        """A legacy plaintext row, or one written under a rotated key. Handing
        the caller that value would send a non-token to GitHub as a Bearer."""
        await store.create_session("sess-3", "ghp_supersecret", "octocat", None, None)
        async with store._db() as c:
            await c.exec(
                "UPDATE sessions SET github_token = ? WHERE session_id = ?",
                ("plaintext-legacy-token", "sess-3"),
            )
            await c.commit()

        assert await store.get_session("sess-3") is None
        async with store._db() as c:
            assert await c.one(
                "SELECT session_id FROM sessions WHERE session_id = ?", ("sess-3",)
            ) is None


# ---------------------------------------------------------------------------
# Bounded SSE queues
# ---------------------------------------------------------------------------

class TestEventQueueBound:
    @pytest.mark.asyncio
    async def test_queue_never_grows_past_the_cap(self):
        """An unattended stream used to retain one event per fetched user."""
        job_id = await _seed_done_job()
        queue = store._runtime[job_id]["events"]

        for i in range(store._EVENT_QUEUE_MAX + 250):
            store.emit_event(queue, {"event": "progress", "data": {"n": i}})

        assert queue.qsize() == store._EVENT_QUEUE_MAX

    @pytest.mark.asyncio
    async def test_oldest_events_are_dropped_so_the_terminal_event_survives(self):
        job_id = await _seed_done_job()
        queue = store._runtime[job_id]["events"]

        for i in range(store._EVENT_QUEUE_MAX):
            store.emit_event(queue, {"event": "progress", "data": {"n": i}})
        store.emit_event(queue, {"event": "done", "data": {"total": 1}})

        events = [queue.get_nowait() for _ in range(queue.qsize())]
        assert events[-1]["event"] == "done"
        # The first event pushed is the one that got evicted.
        assert events[0]["data"]["n"] == 1
