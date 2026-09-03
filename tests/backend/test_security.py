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
import pytest_asyncio

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


# ---------------------------------------------------------------------------
# OAuth redirect_uri derivation
# ---------------------------------------------------------------------------

class TestBackendBaseUrl:
    """The redirect_uri sent to GitHub must come from configuration, never from
    the request.

    It used to fall back to X-Forwarded-Host / Host whenever BACKEND_URL was
    unset *or* still at the localhost default. Both are client-supplied, so
    anyone able to set X-Forwarded-Host on /auth/login — directly, or through an
    edge proxy that passes client headers through — could make the server
    advertise a callback host of their choosing, leaving GitHub's exact-match
    callback check as the only remaining defence.
    """

    @pytest.fixture(autouse=True)
    def _oauth_configured(self, async_client, monkeypatch):
        import main
        monkeypatch.setattr(main, "GITHUB_CLIENT_ID", "test-client-id")

    @pytest.mark.asyncio
    async def test_configured_url_is_used_verbatim(self, async_client, monkeypatch):
        import main
        monkeypatch.setattr(main, "BACKEND_URL_IS_CONFIGURED", True)
        monkeypatch.setattr(main, "BACKEND_URL", "https://api.example.com")

        res = await async_client.get("/auth/login", follow_redirects=False)
        assert res.status_code == 307
        assert "redirect_uri=https%3A%2F%2Fapi.example.com%2Fauth%2Fcallback" in res.headers["location"]

    @pytest.mark.asyncio
    async def test_spoofed_forwarded_host_cannot_influence_redirect_uri(
        self, async_client, monkeypatch
    ):
        import main
        monkeypatch.setattr(main, "BACKEND_URL_IS_CONFIGURED", True)
        monkeypatch.setattr(main, "BACKEND_URL", "https://api.example.com")

        res = await async_client.get(
            "/auth/login",
            headers={"X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https"},
            follow_redirects=False,
        )
        assert res.status_code == 307
        assert "evil.example" not in res.headers["location"]
        assert "api.example.com" in res.headers["location"]

    @pytest.mark.asyncio
    async def test_spoofed_host_header_cannot_influence_redirect_uri(
        self, async_client, monkeypatch
    ):
        import main
        monkeypatch.setattr(main, "BACKEND_URL_IS_CONFIGURED", True)
        monkeypatch.setattr(main, "BACKEND_URL", "https://api.example.com")

        res = await async_client.get(
            "/auth/login", headers={"Host": "evil.example"}, follow_redirects=False
        )
        assert res.status_code == 307
        assert "evil.example" not in res.headers["location"]

    @pytest.mark.asyncio
    async def test_unconfigured_backend_url_refuses_a_proxied_request(
        self, async_client, monkeypatch
    ):
        """The dangerous case: no BACKEND_URL and a proxy in front. Previously
        this built the callback from the forwarded header."""
        import main
        monkeypatch.setattr(main, "BACKEND_URL_IS_CONFIGURED", False)

        res = await async_client.get(
            "/auth/login",
            headers={"X-Forwarded-Host": "evil.example"},
            follow_redirects=False,
        )
        assert res.status_code == 500
        assert "BACKEND_URL" in res.json()["detail"]

    @pytest.mark.asyncio
    async def test_unconfigured_backend_url_still_serves_local_development(
        self, async_client, monkeypatch
    ):
        """A plain local request with no proxy keeps working, so `uvicorn` +
        OAuth on a laptop needs no extra configuration."""
        import main
        monkeypatch.setattr(main, "BACKEND_URL_IS_CONFIGURED", False)
        monkeypatch.setattr(main, "BACKEND_URL", "http://localhost:8000")

        res = await async_client.get("/auth/login", follow_redirects=False)
        assert res.status_code == 307
        assert "localhost%3A8000%2Fauth%2Fcallback" in res.headers["location"]

    @pytest.mark.parametrize("bad", ["not-a-url", "javascript:alert(1)", "ftp://x", "//evil.example"])
    def test_malformed_backend_url_is_rejected(self, bad):
        """A bad value would otherwise be handed to GitHub as the redirect_uri."""
        import main
        with pytest.raises(RuntimeError, match="BACKEND_URL"):
            main._resolve_backend_url(bad)

    @pytest.mark.parametrize("raw,expected", [
        ("https://api.example.com", "https://api.example.com"),
        ("https://api.example.com/", "https://api.example.com"),   # trailing slash trimmed
        ("  https://api.example.com  ", "https://api.example.com"),
        ("http://localhost:8000", "http://localhost:8000"),
    ])
    def test_valid_backend_url_is_normalised_and_marked_configured(self, raw, expected):
        import main
        url, configured = main._resolve_backend_url(raw)
        assert (url, configured) == (expected, True)

    @pytest.mark.parametrize("raw", [None, "", "   "])
    def test_unset_backend_url_falls_back_to_the_local_default(self, raw):
        import main
        url, configured = main._resolve_backend_url(raw)
        assert url == main._DEFAULT_BACKEND_URL
        # Explicitly *not* configured — this is what gates the header fallback.
        assert configured is False

    def test_explicit_localhost_counts_as_configured(self):
        """Previously any value equal to the localhost default was treated as
        unset, which is precisely what dropped requests into the header
        fallback even when an operator had set it deliberately."""
        import main
        _, configured = main._resolve_backend_url("http://localhost:8000")
        assert configured is True


# ---------------------------------------------------------------------------
# OAuth callback robustness
# ---------------------------------------------------------------------------

class TestAuthCallbackResponseShape:
    """GitHub's response shape was trusted unguarded: `.json()` on both calls
    and `user_data["login"]`. A non-JSON body or unexpected payload raised
    JSONDecodeError/KeyError and surfaced as a bare 500."""

    @pytest_asyncio.fixture
    async def primed(self, async_client, monkeypatch):
        """A callback that has passed both state checks and reached the exchange."""
        import main
        monkeypatch.setattr(main, "GITHUB_CLIENT_SECRET", "test-secret")
        await store.add_oauth_state("shape-state", ttl_seconds=600)
        async_client.cookies.set(main.OAUTH_STATE_COOKIE, "shape-state")
        yield async_client
        async_client.cookies.delete(main.OAUTH_STATE_COOKIE)

    @staticmethod
    def _mock_post(monkeypatch, token_body, user_body=None, user_status=200):
        """Stub httpx so the token/profile calls return controlled payloads."""
        import main

        class _Resp:
            def __init__(self, body, status=200):
                self._body, self.status_code = body, status

            def json(self):
                if isinstance(self._body, Exception):
                    raise self._body
                return self._body

        class _Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def post(self, *a, **k):
                return _Resp(token_body)

            async def get(self, *a, **k):
                return _Resp(user_body, user_status)

        monkeypatch.setattr(main.httpx, "AsyncClient", lambda *a, **k: _Client())

    @pytest.mark.asyncio
    async def test_non_json_token_response_returns_502(self, primed, monkeypatch):
        self._mock_post(monkeypatch, ValueError("not json"))
        res = await primed.get("/auth/callback?code=abc&state=shape-state", follow_redirects=False)
        assert res.status_code == 502
        assert "unreadable" in res.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_non_dict_token_response_returns_502(self, primed, monkeypatch):
        self._mock_post(monkeypatch, ["unexpected", "list"])
        res = await primed.get("/auth/callback?code=abc&state=shape-state", follow_redirects=False)
        assert res.status_code == 502

    @pytest.mark.asyncio
    async def test_non_json_profile_response_returns_502(self, primed, monkeypatch):
        self._mock_post(monkeypatch, {"access_token": "t"}, ValueError("not json"))
        res = await primed.get("/auth/callback?code=abc&state=shape-state", follow_redirects=False)
        assert res.status_code == 502

    @pytest.mark.asyncio
    async def test_profile_without_a_login_returns_502(self, primed, monkeypatch):
        # `login` keys every job (`gh:{login}`), so a missing value must not be
        # allowed to create a session keyed on None.
        self._mock_post(monkeypatch, {"access_token": "t"}, {"name": "No Login"})
        res = await primed.get("/auth/callback?code=abc&state=shape-state", follow_redirects=False)
        assert res.status_code == 502
        assert "login" in res.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_non_string_login_returns_502(self, primed, monkeypatch):
        self._mock_post(monkeypatch, {"access_token": "t"}, {"login": 12345})
        res = await primed.get("/auth/callback?code=abc&state=shape-state", follow_redirects=False)
        assert res.status_code == 502

    @pytest.mark.asyncio
    async def test_valid_response_creates_a_session(self, primed, monkeypatch):
        self._mock_post(monkeypatch, {"access_token": "tok"}, {"login": "octocat", "name": "Octo"})
        res = await primed.get("/auth/callback?code=abc&state=shape-state", follow_redirects=False)
        assert res.status_code == 302
        assert "auth=success" in res.headers["location"]


# ---------------------------------------------------------------------------
# Schedule cap
# ---------------------------------------------------------------------------

class TestScheduleCap:
    @pytest.mark.asyncio
    async def test_cap_is_enforced_inside_the_write(self):
        """The cap used to be a read-then-write in the endpoint, so concurrent
        callers could both see an under-cap count and both insert."""
        import main
        owner = "anon:cap-test"
        for _ in range(main.MAX_SCHEDULES_PER_OWNER):
            assert await store.create_schedule(
                owner_key=owner, source_job_id="j", params={}, label=None,
                interval_hours=24, max_per_owner=main.MAX_SCHEDULES_PER_OWNER,
            ) is not None

        # One over the cap is refused by the store itself, not by the caller.
        assert await store.create_schedule(
            owner_key=owner, source_job_id="j", params={}, label=None,
            interval_hours=24, max_per_owner=main.MAX_SCHEDULES_PER_OWNER,
        ) is None
        assert len(await store.list_schedules(owner)) == main.MAX_SCHEDULES_PER_OWNER

    @pytest.mark.asyncio
    async def test_concurrent_creates_cannot_exceed_the_cap(self):
        """Fire the requests together; the total must still land on the cap."""
        import asyncio
        import main
        owner = "anon:cap-race"
        results = await asyncio.gather(*[
            store.create_schedule(
                owner_key=owner, source_job_id="j", params={}, label=None,
                interval_hours=24, max_per_owner=main.MAX_SCHEDULES_PER_OWNER,
            )
            for _ in range(main.MAX_SCHEDULES_PER_OWNER + 6)
        ])
        assert sum(r is not None for r in results) <= main.MAX_SCHEDULES_PER_OWNER
        assert len(await store.list_schedules(owner)) <= main.MAX_SCHEDULES_PER_OWNER

    @pytest.mark.asyncio
    async def test_cap_is_per_owner(self):
        import main
        a = await store.create_schedule(owner_key="anon:a", source_job_id="j", params={},
                                        label=None, interval_hours=24, max_per_owner=1)
        b = await store.create_schedule(owner_key="anon:b", source_job_id="j", params={},
                                        label=None, interval_hours=24, max_per_owner=1)
        assert a is not None and b is not None

    @pytest.mark.asyncio
    async def test_no_cap_argument_keeps_the_old_unlimited_behaviour(self):
        for _ in range(3):
            assert await store.create_schedule(
                owner_key="anon:nocap", source_job_id="j", params={},
                label=None, interval_hours=24,
            ) is not None
