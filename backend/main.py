from __future__ import annotations
import asyncio
import json
import logging
import os
import re
import secrets
import sys
import time
from collections import Counter, defaultdict
from typing import Any
from urllib.parse import urlencode, urlparse

import httpx
from dotenv import load_dotenv
from fastapi import BackgroundTasks, Cookie, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from sse_starlette.sse import EventSourceResponse

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from models import (
    FetchRequest, CompareRequest, MultiCompareRequest, RenameJobRequest, TagsRequest,
    CreateScheduleRequest, UpdateScheduleRequest,
)
from store import (
    create_job_async, get_job, result_to_csv_bytes,
    load_all_jobs_into_runtime, get_job_async, delete_job, load_jobs_list,
    set_job_tags, clear_all_jobs, persist_job, purge_expired, load_repo_history,
    create_session, get_session, delete_session,
    add_oauth_state, consume_oauth_state, add_share_token, get_share_token,
    create_schedule, list_schedules, get_schedule, set_schedule_enabled,
    count_jobs, prune_oldest_jobs,
    delete_schedule, claim_due_schedules, record_schedule_run, close_pool,
)
from worker import run_fetch_job, shutdown_executor

from pathlib import Path as _Path
load_dotenv(_Path(__file__).resolve().parent / ".env", override=True)

# Basic logging so startup prints are visible in Cloud Run logs
logging.basicConfig(level=logging.INFO)

# Maximum users fetchable per job on the hosted service.
# Set FETCH_LIMIT=0 in .env to disable the cap (local installs).
_raw_limit = os.environ.get("FETCH_LIMIT", "500")
FETCH_LIMIT: int = int(_raw_limit) if _raw_limit.isdigit() else 500

# ---------------------------------------------------------------------------
# GitHub OAuth configuration
# Read GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET from environment.
# FRONTEND_URL: where to redirect after successful OAuth (default: Vite dev server).
# BACKEND_URL: the publicly-reachable URL of this backend (used as redirect_uri).
# ---------------------------------------------------------------------------
GITHUB_CLIENT_ID = os.environ.get("GITHUB_CLIENT_ID", "")
GITHUB_CLIENT_SECRET = os.environ.get("GITHUB_CLIENT_SECRET", "")
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:5173")
# BACKEND_URL is the redirect_uri this server advertises to GitHub. It must come
# from configuration, never from the request — see _backend_base_url().
_DEFAULT_BACKEND_URL = "http://localhost:8000"


def _resolve_backend_url(raw: str | None) -> tuple[str, bool]:
    """Normalise the configured BACKEND_URL, returning (url, was_configured).

    A malformed value would be handed to GitHub as a redirect_uri, so it is
    rejected here — at import — rather than at the first login attempt.
    """
    cleaned = (raw or "").strip().rstrip("/")
    if not cleaned:
        return _DEFAULT_BACKEND_URL, False
    parsed = urlparse(cleaned)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise RuntimeError(
            f"BACKEND_URL must be an absolute http(s) URL (got {cleaned!r})."
        )
    return cleaned, True


BACKEND_URL, BACKEND_URL_IS_CONFIGURED = _resolve_backend_url(os.environ.get("BACKEND_URL"))
SESSION_COOKIE = "rp_session"
ANON_COOKIE = "rp_client"
OAUTH_STATE_COOKIE = "rp_oauth_state"

# Cookie flags. Secure is auto-enabled when the backend is served over HTTPS.
# COOKIE_SAMESITE=none is required when the frontend and backend are on
# different origins (e.g. Vercel frontend + Cloud Run backend); it forces Secure.
_cookie_secure = BACKEND_URL.startswith("https")
_cookie_samesite = os.environ.get("COOKIE_SAMESITE", "lax").lower()
if _cookie_samesite == "none":
    _cookie_secure = True


# Hosts that can only be reached from this machine. Used to decide whether the
# unconfigured localhost default is plausibly correct.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})

# Presence of any of these means a proxy sits in front, so the externally
# reachable URL is not something this process can infer.
_FORWARDING_HEADERS = ("x-forwarded-host", "x-forwarded-proto", "forwarded")


def _backend_base_url(request: Request) -> str:
    """Return the externally reachable backend base URL for OAuth callbacks.

    Derived from configuration only. This value becomes the `redirect_uri` sent
    to GitHub, and it previously fell back to `X-Forwarded-Host`/`Host` whenever
    BACKEND_URL was unset *or* left at the localhost default — both of which are
    client-supplied. Anyone able to set `X-Forwarded-Host` on a request to
    /auth/login (directly, or via an edge proxy that forwards client-supplied
    headers) could make the server advertise a callback host of their choosing,
    leaving GitHub's exact-match callback check as the only remaining defence.

    Now: an explicitly configured BACKEND_URL is always used verbatim, and when
    it is unset the localhost default is served only to a genuinely local
    request with no proxy in front. Anything else is a misconfiguration and is
    refused rather than guessed at.
    """
    if BACKEND_URL_IS_CONFIGURED:
        return BACKEND_URL

    client_host = request.client.host if request.client else ""
    proxied = any(request.headers.get(h) for h in _FORWARDING_HEADERS)
    if proxied or client_host not in _LOOPBACK_HOSTS:
        logging.getLogger(__name__).error(
            "Refusing to build an OAuth redirect_uri from request headers "
            "(client=%s, proxied=%s). Set BACKEND_URL to this service's public URL.",
            client_host or "unknown", proxied,
        )
        raise HTTPException(
            500,
            "GitHub OAuth is misconfigured on this server: BACKEND_URL is not set. "
            "The administrator must set it to this service's public URL.",
        )
    return BACKEND_URL

# Per-caller rate limit for expensive endpoints (/fetch, /import).
# ponytail: in-memory per-instance window; move to Redis if you run >1 instance.
_RATE_LIMIT = int(os.environ.get("FETCH_RATE_LIMIT", "20"))   # requests per window
_RATE_WINDOW = 60                                             # seconds
_rate_hits: dict[str, list[float]] = defaultdict(list)

# Production hardening: interactive docs and the OpenAPI schema are only served
# when explicitly enabled, so a public deployment does not advertise its whole
# API surface. Health checks use /healthz instead.
_EXPOSE_DOCS = os.environ.get("EXPOSE_DOCS", "").lower() in ("1", "true", "yes")

app = FastAPI(
    title="repo-people Explorer API",
    version="1.1.0",
    docs_url="/docs" if _EXPOSE_DOCS else None,
    redoc_url="/redoc" if _EXPOSE_DOCS else None,
    openapi_url="/openapi.json" if _EXPOSE_DOCS else None,
)

_background: list[asyncio.Task] = []


@app.on_event("startup")
async def startup():
    await load_all_jobs_into_runtime()
    _background.append(asyncio.create_task(_maintenance_loop()))
    _background.append(asyncio.create_task(_schedule_loop()))


@app.on_event("shutdown")
async def shutdown():
    for task in _background:
        task.cancel()
    shutdown_executor()
    await close_pool()


@app.get("/healthz", include_in_schema=False)
async def healthz():
    """Liveness/startup probe target. Deliberately reveals nothing."""
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Ownership + rate-limiting helpers
# ---------------------------------------------------------------------------

async def _reader_key(rp_session: str | None, rp_client: str | None) -> str | None:
    """Identify the caller for read access without minting a cookie.
    OAuth users are keyed by GitHub login; anonymous users by their browser cookie."""
    if rp_session:
        s = await get_session(rp_session)
        if s:
            return f"gh:{s['github_login']}"
    if rp_client:
        return f"anon:{rp_client}"
    return None


async def _owner_key(response: Response, rp_session: str | None, rp_client: str | None) -> str:
    """Identify the caller for job creation, minting an anonymous cookie if needed."""
    key = await _reader_key(rp_session, rp_client)
    if key:
        return key
    tok = secrets.token_urlsafe(24)
    response.set_cookie(
        ANON_COOKIE, tok, httponly=True, samesite=_cookie_samesite,
        secure=_cookie_secure, max_age=365 * 24 * 3600, path="/",
    )
    return f"anon:{tok}"


def _can_access(job: dict, key: str | None) -> bool:
    """A job is accessible only to its owner.

    Ownerless jobs used to be readable by everyone, which exposed every
    pre-migration job to anonymous visitors. They are now private: run the
    backfill in docs/ to assign owners, or delete them.
    """
    owner = job.get("owner_key")
    return owner is not None and key is not None and owner == key


async def _get_owned_job(
    job_id: str, rp_session: str | None, rp_client: str | None,
    include_result: bool = True,
):
    """Return the job only if the caller may access it, else None (missing OR forbidden —
    callers raise 404 without leaking which).

    Most job-scoped routes only need ownership and a little metadata. Reading the
    result blob for those meant a rename, a tag edit, a delete or an SSE connect
    pulled tens of MB out of the database and json.loads()'d it to decide whether
    the caller owned the row. Pass `include_result=False` unless the payload is
    actually used — the returned job's `result` is then always None.
    """
    job = await get_job_async(job_id, include_result=include_result)
    if job is None:
        return None
    key = await _reader_key(rp_session, rp_client)
    if not _can_access(job, key):
        return None
    return job


async def _enforce_job_retention(owner_key: str) -> None:
    """Evict an owner's oldest jobs once they exceed the retention cap.

    Runs after the new job is inserted, so the freshly created one is always
    among those kept. Best-effort: a pruning failure must not fail the fetch the
    caller actually asked for.
    """
    if MAX_JOBS_PER_OWNER <= 0:
        return
    try:
        if await count_jobs(owner_key) > MAX_JOBS_PER_OWNER:
            removed = await prune_oldest_jobs(owner_key, keep=MAX_JOBS_PER_OWNER)
            if removed:
                logging.getLogger(__name__).info(
                    "Retention: pruned %d job(s) for %s", len(removed), owner_key
                )
    except Exception:
        logging.getLogger(__name__).exception("Job retention pruning failed")


def _client_ip(request: Request) -> str:
    """Best-effort caller IP. Trusts the left-most X-Forwarded-For entry, which
    is correct behind Cloud Run / Vercel where the platform rewrites the header."""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_check(*keys: str) -> None:
    """Enforce the window against every supplied key.

    Anonymous callers are identified by a cookie they control, so keying on that
    alone let anyone reset their own budget by discarding the cookie. Callers
    pass both the owner key and the client IP; exceeding either one trips.
    """
    now = time.time()
    for key in keys:
        if not key:
            continue
        hits = [t for t in _rate_hits[key] if t > now - _RATE_WINDOW]
        if len(hits) >= _RATE_LIMIT:
            # Seconds until the oldest hit leaves the window — i.e. when a slot
            # actually frees up. Without this the client can only guess, and
            # retries either hammer the endpoint or wait far longer than needed.
            retry_after = max(1, int(hits[0] + _RATE_WINDOW - now) + 1)
            raise HTTPException(
                429,
                f"Rate limit exceeded — max {_RATE_LIMIT} requests per minute. "
                f"Try again in {retry_after}s.",
                headers={"Retry-After": str(retry_after)},
            )
        hits.append(now)
        _rate_hits[key] = hits


def _prune_rate_hits() -> None:
    """Drop windows with no recent hits. Without this the dict grows one entry
    per visitor forever, since entries are only pruned when re-hit."""
    cutoff = time.time() - _RATE_WINDOW
    for key in [k for k, v in _rate_hits.items() if not v or v[-1] < cutoff]:
        _rate_hits.pop(key, None)


# ---------------------------------------------------------------------------
# CSRF protection
# ---------------------------------------------------------------------------
# Auth is cookie-based, and the split deployment (Vercel frontend + Cloud Run
# backend) needs COOKIE_SAMESITE=none, so the browser attaches those cookies to
# cross-site requests. CORS only stops an attacker *reading* the response — a
# request with no custom headers is "simple", skips the preflight, and is
# delivered regardless. Requiring a custom header on every mutating route forces
# a preflight, which CORS then rejects for unlisted origins.
#
# Callers must send `X-Requested-With` (see req() in frontend/src/utils/api.ts).
_CSRF_HEADER = "x-requested-with"
_CSRF_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
# GitHub redirects the browser here; it cannot send our header, and the flow has
# its own CSRF defence in the state cookie.
_CSRF_EXEMPT_PATHS = frozenset({"/auth/callback"})


@app.middleware("http")
async def require_csrf_header(request: Request, call_next):
    # Allow preflight `OPTIONS` through so CORSMiddleware can answer it.
    if request.method == "OPTIONS":
        return await call_next(request)

    if (
        request.method in _CSRF_METHODS
        and request.url.path not in _CSRF_EXEMPT_PATHS
        and not request.headers.get(_CSRF_HEADER)
    ):
        return JSONResponse(
            {"detail": "Missing X-Requested-With header."}, status_code=403
        )
    return await call_next(request)


# S2: CORS origins configurable via env var (comma-separated list).
_raw_origins = os.environ.get("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
_allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]
# allow_credentials + a wildcard origin would let any site drive an authenticated
# request. Starlette silently drops the credential header in that combination;
# fail loudly instead so it cannot be misconfigured unnoticed.
if "*" in _allowed_origins:
    raise RuntimeError(
        "CORS_ORIGINS cannot be '*' — this API sends credentialed cookies. "
        "List the exact frontend origins instead."
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Response headers are hidden from cross-origin JS unless named here, and
    # the frontend and backend are on different origins in the hosted
    # deployment — without this the Retry-After we set on 429 is unreadable.
    expose_headers=["Retry-After"],
)

logging.info(f"CORS allowed origins: {_allowed_origins}")

# OAuth needs an explicit public URL: the redirect_uri can no longer be inferred
# from request headers, so an unset BACKEND_URL means logins fail anywhere except
# a local, unproxied dev server. Surface that at boot rather than at first login.
if GITHUB_CLIENT_ID and not BACKEND_URL_IS_CONFIGURED:
    logging.warning(
        "GitHub OAuth is enabled but BACKEND_URL is not set. Sign-in will only "
        "work for local, unproxied requests. Set BACKEND_URL to this service's "
        "public URL (e.g. https://your-service.run.app)."
    )

# ---------------------------------------------------------------------------
# POST /fetch
# ---------------------------------------------------------------------------

async def _resolve_token(authorization: str | None, rp_session: str | None) -> str:
    """Extract the GitHub token: explicit Bearer PAT, else the OAuth session token."""
    if authorization and authorization.lower().startswith("bearer "):
        tok = authorization[7:].strip()
        if tok:
            return tok
    if rp_session:
        session = await get_session(rp_session)
        if session:
            return session["github_token"]
    return ""


def _start_fetch(background_tasks: BackgroundTasks, job_id: str, req: FetchRequest, token: str) -> None:
    background_tasks.add_task(
        run_fetch_job,
        job_id=job_id,
        owner=req.owner,
        repo=req.repo,
        token=token,
        roles=req.roles,
        limit=req.limit,
        exclude_bots=req.exclude_bots,
        include_social_accounts=req.include_social_accounts,
        workers=req.workers,
        save_each_user=req.save_each_user,
        # Hard server-side cap on profile lookups (0 = unlimited, local installs).
        max_total=FETCH_LIMIT if FETCH_LIMIT > 0 else None,
    )


@app.post("/fetch")
async def fetch_users(
    req: FetchRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    response: Response,
    authorization: str | None = Header(default=None),
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    # S1: Extract token from Authorization: Bearer header instead of request body.
    token = await _resolve_token(authorization, rp_session)
    # Scope this job to its creator and rate-limit per caller *and* per IP, so a
    # cookie reset does not buy a fresh budget.
    owner_key = await _owner_key(response, rp_session, rp_client)
    _rate_check(owner_key, f"ip:{_client_ip(request)}")
    # The hosted cap is enforced in the worker via max_total (see _start_fetch);
    # req.limit stays as the user set it and is applied per role.
    # B4: Await DB insert before starting worker to avoid race condition.
    # Store params (no secrets) so the job can be refreshed later.
    job_id = await create_job_async(owner_key=owner_key, params=req.model_dump())
    await _enforce_job_retention(owner_key)
    _start_fetch(background_tasks, job_id, req, token)
    return {"job_id": job_id}


# ---------------------------------------------------------------------------
# POST /jobs/{job_id}/refresh  — re-run a job with its original parameters
# ---------------------------------------------------------------------------

@app.post("/jobs/{job_id}/refresh")
async def refresh_job(
    job_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
    response: Response,
    authorization: str | None = Header(default=None),
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    job = await _get_owned_job(job_id, rp_session, rp_client, include_result=False)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    params = job.get("params")
    if not params:
        raise HTTPException(status_code=409, detail="This job has no saved parameters and cannot be refreshed.")
    req = FetchRequest(**params)
    token = await _resolve_token(authorization, rp_session)
    owner_key = await _owner_key(response, rp_session, rp_client)
    _rate_check(owner_key, f"ip:{_client_ip(request)}")
    new_id = await create_job_async(owner_key=owner_key, params=params)
    _start_fetch(background_tasks, new_id, req, token)
    return {"job_id": new_id, "refreshed_from": job_id}


# ---------------------------------------------------------------------------
# GET /fetch/{job_id}/stream  — SSE progress stream
# ---------------------------------------------------------------------------

@app.get("/fetch/{job_id}/stream")
async def stream_job(
    job_id: str,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    if await _get_owned_job(job_id, rp_session, rp_client, include_result=False) is None:
        raise HTTPException(status_code=404, detail="Job not found")
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    queue: asyncio.Queue = job["events"]

    async def event_generator():
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=30)
            except asyncio.TimeoutError:
                yield {"event": "heartbeat", "data": "{}"}
                continue

            data = json.dumps(item["data"])
            yield {"event": item["event"], "data": data}

            if item["event"] == "done":
                break

    return EventSourceResponse(event_generator())


# ---------------------------------------------------------------------------
# POST /fetch/{job_id}/cancel
# ---------------------------------------------------------------------------

@app.post("/fetch/{job_id}/cancel")
async def cancel_job(
    job_id: str,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    if await _get_owned_job(job_id, rp_session, rp_client, include_result=False) is None:
        raise HTTPException(status_code=404, detail="Job not found")
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    job["cancelled"] = True
    return {"cancelled": True}


# ---------------------------------------------------------------------------
# GET /jobs — list all job IDs
# ---------------------------------------------------------------------------

@app.get("/jobs")
async def list_jobs(
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    # P1: Single SELECT — no N+1 per-job queries. Scoped to the caller's jobs.
    key = await _reader_key(rp_session, rp_client)
    return await load_jobs_list(owner_key=key)


# ---------------------------------------------------------------------------
# DELETE /jobs/{job_id}
# ---------------------------------------------------------------------------

@app.delete("/jobs/{job_id}")
async def remove_job(
    job_id: str,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    if await _get_owned_job(job_id, rp_session, rp_client, include_result=False) is None:
        raise HTTPException(status_code=404, detail="Job not found")
    await delete_job(job_id)
    return {"deleted": True}


# ---------------------------------------------------------------------------
# PATCH /jobs/{job_id}/tags — update tags
# ---------------------------------------------------------------------------

@app.patch("/jobs/{job_id}/tags")
async def update_job_tags(
    job_id: str,
    body: TagsRequest,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    if await _get_owned_job(job_id, rp_session, rp_client, include_result=False) is None:
        raise HTTPException(status_code=404, detail="Job not found")
    # BE2: Validated TagsRequest model (max 10 tags, max 50 chars each).
    cleaned = sorted({t.strip().lower() for t in body.tags if t.strip()})
    ok = await set_job_tags(job_id, cleaned)
    if not ok:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job_id": job_id, "tags": cleaned}


# ---------------------------------------------------------------------------
# PATCH /jobs/{job_id} — rename a job
# ---------------------------------------------------------------------------

@app.patch("/jobs/{job_id}")
async def rename_job(
    job_id: str,
    body: RenameJobRequest,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    # BE1: Typed RenameJobRequest model. H4/B1: use get_job_async to avoid stale proxy.
    job = await _get_owned_job(job_id, rp_session, rp_client, include_result=False)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    # Awaited rather than assigned through the job proxy: a proxy write is
    # fire-and-forget, so this used to return 200 before the write was attempted
    # and swallowed any failure into a log line.
    await persist_job(job_id, label=body.label)
    return {"job_id": job_id, "label": body.label}


# ---------------------------------------------------------------------------
# GET /results/{job_id}
# ---------------------------------------------------------------------------

_BOT_LOGIN_RE = re.compile(r"^[a-z][-a-z]*\d{6,}$", re.IGNORECASE)


def _bot_score(u: dict) -> int:
    """Heuristic spam/bot score 0–100, mirroring the client-side version so that
    server-filtered results match what the table would have shown."""
    if u.get("is_bot"):
        return 100
    score = 0
    if not u.get("followers"):
        score += 25
    if not u.get("public_repos"):
        score += 20
    age = u.get("account_age_days")
    if age is not None and age < 180:
        score += 20
    if not u.get("name") and not u.get("bio") and not u.get("location"):
        score += 15
    login = u.get("login") or ""
    if login and _BOT_LOGIN_RE.match(login):
        score += 20
    return min(score, 100)


def _filter_sort_users(users: list[dict], f: "ResultFilters") -> list[dict]:
    """Apply filters and sorting across the *whole* result set.

    Previously the table filtered only the pages it had already loaded, so on any
    job larger than one page the counts and filter results were silently wrong.
    """
    rows = users

    if f.q:
        q = f.q.lower()
        fields = ("login", "name", "company", "location", "bio")
        rows = [u for u in rows if any(q in str(u.get(k) or "").lower() for k in fields)]
    if f.location:
        q = f.location.lower()
        rows = [u for u in rows if q in str(u.get("location") or "").lower()]
    if f.company:
        q = f.company.lower()
        rows = [u for u in rows if q in str(u.get("company") or "").lower()]
    if f.role:
        rows = [u for u in rows if f.role in (u.get("roles") or [])]
    if f.min_followers is not None:
        rows = [u for u in rows if (u.get("followers") or 0) >= f.min_followers]
    if f.max_followers is not None:
        rows = [u for u in rows if (u.get("followers") or 0) <= f.max_followers]
    if f.joined_after:
        rows = [u for u in rows if not u.get("created_at") or str(u["created_at"])[:10] >= f.joined_after]
    if f.joined_before:
        rows = [u for u in rows if not u.get("created_at") or str(u["created_at"])[:10] <= f.joined_before]
    if f.hide_bots:
        rows = [u for u in rows if _bot_score(u) < 60]

    if f.sort_by:
        def _key(u: dict):
            v = u.get(f.sort_by)
            if v is None:
                # Sort missing values last in both directions.
                return (1, 0.0, "")
            if isinstance(v, bool):
                return (0, float(v), "")
            if isinstance(v, (int, float)):
                return (0, float(v), "")
            return (0, 0.0, str(v).lower())
        rows = sorted(rows, key=_key, reverse=(f.sort_dir == "desc"))

    return rows


class ResultFilters:
    """Query-parameter bundle for the filtered results endpoints."""

    def __init__(
        self,
        q: str | None = Query(None, max_length=200),
        location: str | None = Query(None, max_length=200),
        company: str | None = Query(None, max_length=200),
        role: str | None = Query(None, max_length=50),
        min_followers: int | None = Query(None, ge=0),
        max_followers: int | None = Query(None, ge=0),
        joined_after: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
        joined_before: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
        hide_bots: bool = Query(False),
        sort_by: str | None = Query(None, max_length=50),
        sort_dir: str = Query("asc", pattern="^(asc|desc)$"),
    ):
        self.q = q
        self.location = location
        self.company = company
        self.role = role
        self.min_followers = min_followers
        self.max_followers = max_followers
        self.joined_after = joined_after
        self.joined_before = joined_before
        self.hide_bots = hide_bots
        self.sort_by = sort_by
        self.sort_dir = sort_dir


@app.get("/results/{job_id}")
async def get_results(
    job_id: str,
    filters: ResultFilters = Depends(),
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    # P3: Paginated results endpoint — avoids serialising huge JSON blobs in one shot.
    job = await _get_owned_job(job_id, rp_session, rp_client)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "done":
        raise HTTPException(status_code=409, detail=f"Job status: {job['status']}")

    result: dict[str, Any] = job["result"] or {}
    all_users = [u for u in result.values() if isinstance(u, dict) and "login" in u]
    unfiltered_total = len(all_users)
    all_users = _filter_sort_users(all_users, filters)
    total = len(all_users)
    start = (page - 1) * page_size
    page_users = {u["login"]: u for u in all_users[start:start + page_size]}
    return {
        "users": page_users,
        # Why the set may be smaller than expected — e.g. a role that needed a
        # token and collected nothing. Streamed during the fetch, but the SSE
        # queue is gone by the time anyone reads the results.
        "warnings": job.get("warnings") or [],
        # How many usernames each requested role contributed. A role that came
        # back empty without erroring produces no warning, so the counts are the
        # only place that gap is visible after the fetch.
        "role_counts": job.get("role_counts") or {},
        "total": total,
        "unfiltered_total": unfiltered_total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, (total + page_size - 1) // page_size),
    }


# ---------------------------------------------------------------------------
# GET /results/{job_id}/summary
# ---------------------------------------------------------------------------

@app.get("/results/{job_id}/summary")
async def get_summary(
    job_id: str,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    # Metadata first: the summary is cached after the first call, so the common
    # path returns without ever reading the result blob.
    job = await _get_owned_job(job_id, rp_session, rp_client, include_result=False)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "done":
        raise HTTPException(status_code=409, detail=f"Job status: {job['status']}")

    # H7/B2/P4: Serve cached summary from DB when available — avoids recomputing on every call.
    if job.get("summary"):
        return job["summary"]

    # Cache miss: now the payload really is needed. Ownership is already proven.
    job = await get_job_async(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    result: dict[str, Any] = job["result"] or {}
    users = list(result.values())

    total = len(users)
    humans = sum(1 for u in users if not u.get("is_bot"))
    bots = total - humans

    # Top locations
    loc_counter: Counter = Counter()
    for u in users:
        loc = u.get("location_normalized") or u.get("location") or ""
        if loc:
            loc_counter[loc] += 1
    top_locations = loc_counter.most_common(10)

    # Top companies
    co_counter: Counter = Counter()
    for u in users:
        co = u.get("company_normalized") or u.get("company") or ""
        if co:
            co_counter[co] += 1
    top_companies = co_counter.most_common(10)

    # Account age distribution
    bands = {"<1yr": 0, "1-5yr": 0, "5-10yr": 0, ">10yr": 0}
    for u in users:
        age = u.get("account_age_days") or 0
        years = age / 365.25
        if years < 1:
            bands["<1yr"] += 1
        elif years < 5:
            bands["1-5yr"] += 1
        elif years < 10:
            bands["5-10yr"] += 1
        else:
            bands[">10yr"] += 1

    # Role distribution
    role_counter: Counter = Counter()
    for u in users:
        for role in u.get("roles") or []:
            role_counter[role] += 1

    summary = {
        "total": total,
        "humans": humans,
        "bots": bots,
        "top_locations": [{"location": k, "count": v} for k, v in top_locations],
        "top_companies": [{"company": k, "count": v} for k, v in top_companies],
        "account_age_distribution": bands,
        "role_distribution": dict(role_counter),
    }
    # Cache computed summary back to DB so subsequent calls are instant.
    await persist_job(job_id, summary=summary)
    return summary


# ---------------------------------------------------------------------------
# GET /results/{job_id}/top
# ---------------------------------------------------------------------------

@app.get("/results/{job_id}/top")
async def get_top(
    job_id: str,
    by: str = Query("followers", description="Field to rank by"),
    n: int = Query(10, ge=1, le=100),
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    job = await _get_owned_job(job_id, rp_session, rp_client)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "done":
        raise HTTPException(status_code=409, detail=f"Job status: {job['status']}")

    result: dict[str, Any] = job["result"] or {}
    users = list(result.values())

    def _key(u: dict) -> float:
        v = u.get(by, 0)
        if v is None:
            return 0.0
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0

    top = sorted(users, key=_key, reverse=True)[:n]
    return top


# ---------------------------------------------------------------------------
# GET /jobs/{job_id}/history  — churn / retention across runs of the same repo
# ---------------------------------------------------------------------------

@app.get("/jobs/{job_id}/history")
async def get_job_history(
    job_id: str,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    """Diff every completed run of this job's repo, oldest first.

    Each run reports who joined and who left relative to the previous run, plus
    retention (share of the previous run's members still present). One run
    returns a baseline with no deltas.
    """
    job = await _get_owned_job(job_id, rp_session, rp_client, include_result=False)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    repo_owner, repo_name = job.get("repo_owner"), job.get("repo_name")
    if not repo_owner or not repo_name:
        raise HTTPException(
            status_code=409,
            detail="This job has no repository recorded (imported jobs cannot be tracked over time).",
        )

    key = await _reader_key(rp_session, rp_client)
    runs = await load_repo_history(key, repo_owner, repo_name)
    if not runs:
        return {"repo": f"{repo_owner}/{repo_name}", "runs": [], "total_runs": 0}

    points = []
    prev: set[str] | None = None
    for run in runs:
        logins = run["logins"]
        if prev is None:
            joined, left, retention = [], [], None
        else:
            joined = sorted(logins - prev)
            left = sorted(prev - logins)
            retention = round(len(logins & prev) / max(len(prev), 1) * 100, 1)
        points.append({
            "job_id": run["job_id"],
            "label": run["label"],
            "created_at": run["created_at"],
            "total": len(logins),
            "joined": joined,
            "left": left,
            "joined_count": len(joined),
            "left_count": len(left),
            "retention_pct": retention,
        })
        prev = logins

    first, last = runs[0]["logins"], runs[-1]["logins"]
    return {
        "repo": f"{repo_owner}/{repo_name}",
        "runs": points,
        "total_runs": len(points),
        "net_change": len(last) - len(first),
        # Members present in every single run — the stable core of the community.
        "core_members": len(set.intersection(*[r["logins"] for r in runs])) if runs else 0,
    }


# ---------------------------------------------------------------------------
# Scheduled re-fetch
# ---------------------------------------------------------------------------

@app.get("/schedules")
async def get_schedules(
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    key = await _reader_key(rp_session, rp_client)
    if not key:
        return []
    return await list_schedules(key)


@app.post("/schedules")
async def add_schedule(
    body: CreateScheduleRequest,
    response: Response,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    job = await _get_owned_job(body.job_id, rp_session, rp_client, include_result=False)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    params = job.get("params")
    if not params:
        raise HTTPException(
            status_code=409,
            detail="This job has no saved parameters and cannot be scheduled.",
        )
    owner_key = await _owner_key(response, rp_session, rp_client)
    # Each schedule is a recurring cost, so cap how many one caller can create.
    # Enforced inside create_schedule's transaction: a check here followed by an
    # insert is a read-then-write race, and two concurrent POSTs (a double-click
    # is enough) could both see the same under-cap count and both succeed.
    created = await create_schedule(
        owner_key=owner_key,
        source_job_id=body.job_id,
        params=params,
        label=job.get("label"),
        interval_hours=body.interval_hours,
        max_per_owner=MAX_SCHEDULES_PER_OWNER,
    )
    if created is None:
        raise HTTPException(
            status_code=409,
            detail=f"Maximum of {MAX_SCHEDULES_PER_OWNER} schedules per account.",
        )
    return created


@app.patch("/schedules/{schedule_id}")
async def update_schedule(
    schedule_id: str,
    body: UpdateScheduleRequest,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    key = await _reader_key(rp_session, rp_client)
    if not key or not await set_schedule_enabled(schedule_id, key, body.enabled):
        raise HTTPException(status_code=404, detail="Schedule not found")
    return await get_schedule(schedule_id, key)


@app.delete("/schedules/{schedule_id}")
async def remove_schedule(
    schedule_id: str,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    key = await _reader_key(rp_session, rp_client)
    if not key or not await delete_schedule(schedule_id, key):
        raise HTTPException(status_code=404, detail="Schedule not found")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Background loops
# ---------------------------------------------------------------------------

MAX_SCHEDULES_PER_OWNER = 10

# Retention: the newest N jobs per owner are kept and older ones are evicted when
# a new job is created. Only a per-minute rate limit existed before, so a caller
# well inside it could accumulate rows indefinitely, each up to FETCH_LIMIT
# profiles. Set MAX_JOBS_PER_OWNER=0 to disable (local installs).
_raw_job_cap = os.environ.get("MAX_JOBS_PER_OWNER", "50")
MAX_JOBS_PER_OWNER: int = int(_raw_job_cap) if _raw_job_cap.isdigit() else 50
_SCHEDULE_TICK_SECONDS = int(os.environ.get("SCHEDULE_TICK_SECONDS", "300"))
_MAINTENANCE_TICK_SECONDS = 3600


async def _maintenance_loop() -> None:
    """Periodically drop expired sessions/states/tokens and prune rate windows."""
    while True:
        try:
            await asyncio.sleep(_MAINTENANCE_TICK_SECONDS)
            _prune_rate_hits()
            purged = await purge_expired()
            if any(purged.values()):
                logging.getLogger(__name__).info("Purged expired records: %s", purged)
        except asyncio.CancelledError:
            raise
        except Exception:
            logging.getLogger(__name__).exception("Maintenance loop iteration failed")


async def _schedule_loop() -> None:
    """Run due schedules.

    ponytail: an in-process loop, not a real job queue. It only runs while an
    instance is alive, so keep minScale >= 1 (or move to Cloud Scheduler hitting
    an authenticated endpoint) if schedules must fire on an idle service.
    """
    while True:
        try:
            await asyncio.sleep(_SCHEDULE_TICK_SECONDS)
            for sched in await claim_due_schedules():
                try:
                    req = FetchRequest(**sched["params"])
                except Exception:
                    logging.getLogger(__name__).warning(
                        "Schedule %s has unusable params; skipping", sched["schedule_id"]
                    )
                    continue
                # Scheduled runs are unauthenticated against GitHub: the OAuth
                # token belongs to a session that may be long gone, and storing
                # one per schedule would mean holding a credential indefinitely.
                job_id = await create_job_async(owner_key=sched["owner_key"], params=sched["params"])
                await record_schedule_run(sched["schedule_id"], job_id)
                task = asyncio.create_task(run_fetch_job(
                    job_id=job_id,
                    owner=req.owner,
                    repo=req.repo,
                    token="",
                    roles=req.roles,
                    limit=req.limit,
                    exclude_bots=req.exclude_bots,
                    include_social_accounts=req.include_social_accounts,
                    workers=req.workers,
                    save_each_user=req.save_each_user,
                    max_total=FETCH_LIMIT if FETCH_LIMIT > 0 else None,
                ))
                _background.append(task)
                task.add_done_callback(lambda t: _background.remove(t) if t in _background else None)
        except asyncio.CancelledError:
            raise
        except Exception:
            logging.getLogger(__name__).exception("Schedule loop iteration failed")


# ---------------------------------------------------------------------------
# POST /compare
# ---------------------------------------------------------------------------

@app.post("/compare")
async def compare(
    req: CompareRequest,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    job_a = await _get_owned_job(req.job_id_a, rp_session, rp_client)
    job_b = await _get_owned_job(req.job_id_b, rp_session, rp_client)

    if job_a is None:
        raise HTTPException(status_code=404, detail=f"Job A not found: {req.job_id_a}")
    if job_b is None:
        raise HTTPException(status_code=404, detail=f"Job B not found: {req.job_id_b}")
    if job_a["status"] != "done":
        raise HTTPException(status_code=409, detail="Job A not complete")
    if job_b["status"] != "done":
        raise HTTPException(status_code=409, detail="Job B not complete")

    set_a: set[str] = set((job_a["result"] or {}).keys())
    set_b: set[str] = set((job_b["result"] or {}).keys())

    only_a = sorted(set_a - set_b)
    only_b = sorted(set_b - set_a)
    in_both = sorted(set_a & set_b)

    def _pick(login: str, result: dict) -> dict:
        u = result.get(login, {})
        return {"login": login, "avatar_url": u.get("avatar_url", ""), "html_url": u.get("html_url", "")}

    return {
        "only_in_a": [_pick(l, job_a["result"]) for l in only_a],
        "only_in_b": [_pick(l, job_b["result"]) for l in only_b],
        "in_both": [_pick(l, job_a["result"]) for l in in_both],
        "stats": {
            "count_a": len(set_a),
            "count_b": len(set_b),
            "only_in_a": len(only_a),
            "only_in_b": len(only_b),
            "in_both": len(in_both),
            "overlap_pct": round(len(in_both) / max(len(set_a | set_b), 1) * 100, 1),
        },
    }


# ---------------------------------------------------------------------------
# POST /compare/multi  — overlap across 2–5 jobs
# ---------------------------------------------------------------------------

@app.post("/compare/multi")
async def compare_multi(
    req: MultiCompareRequest,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    if len(req.job_ids) < 2:
        raise HTTPException(status_code=422, detail="Need at least 2 job IDs")
    if len(req.job_ids) > 5:
        raise HTTPException(status_code=422, detail="Max 5 job IDs")
    # A repeated id inflates n, which shifts the "in all" threshold and splits
    # one job across two "exclusive" buckets — wrong numbers, returned silently.
    if len(set(req.job_ids)) != len(req.job_ids):
        raise HTTPException(status_code=422, detail="Duplicate job IDs are not allowed.")

    jobs_data: list[dict] = []
    for jid in req.job_ids:
        job = await _get_owned_job(jid, rp_session, rp_client)
        if job is None:
            raise HTTPException(status_code=404, detail=f"Job not found: {jid}")
        if job["status"] != "done":
            raise HTTPException(status_code=409, detail=f"Job {jid} not complete")
        jobs_data.append({"job_id": jid, "logins": set((job["result"] or {}).keys()), "result": job["result"] or {}})

    n = len(jobs_data)

    all_logins: set[str] = set()
    for jd in jobs_data:
        all_logins |= jd["logins"]

    # Map each login to the list of job indices that contain it
    login_to_indices: dict[str, list[int]] = {
        login: [i for i, jd in enumerate(jobs_data) if login in jd["logins"]]
        for login in all_logins
    }

    in_all = sorted(l for l, idxs in login_to_indices.items() if len(idxs) == n)
    # shared = in 2+ but not all (only meaningful when n>2; if n==2 in_all covers this)
    shared = sorted(l for l, idxs in login_to_indices.items() if 1 < len(idxs) < n)
    exclusive_per_job = [
        sorted(l for l, idxs in login_to_indices.items() if idxs == [i])
        for i in range(n)
    ]

    def _pick(login: str) -> dict:
        for jd in jobs_data:
            if login in jd["result"]:
                u = jd["result"][login]
                return {"login": login, "avatar_url": u.get("avatar_url", ""), "html_url": u.get("html_url", "")}
        return {"login": login, "avatar_url": "", "html_url": ""}

    return {
        "in_all": [_pick(l) for l in in_all],
        "shared": [_pick(l) for l in shared],
        "exclusive_per_job": [[_pick(l) for l in excl] for excl in exclusive_per_job],
        "stats": {
            "total_unique": len(all_logins),
            "in_all_count": len(in_all),
            "shared_count": len(shared),
            "exclusive_per_job": [len(e) for e in exclusive_per_job],
            "per_job_totals": [len(jd["logins"]) for jd in jobs_data],
        },
    }


# ---------------------------------------------------------------------------
# GET /results/{job_id}/export/json
# ---------------------------------------------------------------------------

@app.get("/results/{job_id}/export/json")
async def export_json(
    job_id: str,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    job = await _get_owned_job(job_id, rp_session, rp_client)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "done":
        raise HTTPException(status_code=409, detail=f"Job status: {job['status']}")

    content = json.dumps(job["result"], indent=2, default=str).encode()
    return Response(
        content=content,
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename={job_id}.json"},
    )


# ---------------------------------------------------------------------------
# GET /results/{job_id}/export/csv
# ---------------------------------------------------------------------------

@app.get("/results/{job_id}/export/csv")
async def export_csv(
    job_id: str,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    job = await _get_owned_job(job_id, rp_session, rp_client)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "done":
        raise HTTPException(status_code=409, detail=f"Job status: {job['status']}")

    content = result_to_csv_bytes(job["result"])
    return Response(
        content=content,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={job_id}.csv"},
    )


# ---------------------------------------------------------------------------
# POST /results/{job_id}/share  — create a short-lived read token
# ---------------------------------------------------------------------------

@app.post("/results/{job_id}/share")
async def create_share_token(
    job_id: str,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    job = await _get_owned_job(job_id, rp_session, rp_client, include_result=False)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "done":
        raise HTTPException(status_code=409, detail="Job not complete")

    token = secrets.token_urlsafe(32)
    expires_iso = await add_share_token(token, job_id, ttl_seconds=24 * 3600)
    return {
        "token": token,
        "expires_at": expires_iso,
        "url": f"{FRONTEND_URL}/#share={token}",
    }


# ---------------------------------------------------------------------------
# GET /share/{token}  — return paginated results for a shared token
# ---------------------------------------------------------------------------

@app.get("/share/{token}")
async def get_shared_results(
    token: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=1000),
):
    entry = await get_share_token(token)
    if not entry:
        raise HTTPException(status_code=404, detail="Share link not found or has expired.")

    job = await get_job_async(entry["job_id"])
    if job is None or job["status"] != "done":
        raise HTTPException(status_code=404, detail="The shared job is no longer available.")

    result: dict[str, Any] = job["result"] or {}
    all_users = list(result.values())
    total = len(all_users)
    start = (page - 1) * page_size
    page_users = {u["login"]: u for u in all_users[start: start + page_size] if isinstance(u, dict) and "login" in u}
    expires_iso = entry["expires_at"]
    return {
        "users": page_users,
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, (total + page_size - 1) // page_size),
        "job_label": job.get("label", ""),
        "expires_at": expires_iso,
    }


# ---------------------------------------------------------------------------
# POST /import  — create a completed job from uploaded JSON data
# ---------------------------------------------------------------------------

MAX_IMPORT_BYTES = 5 * 1024 * 1024


async def _read_capped_body(request: Request, max_bytes: int) -> bytes:
    """Read the request body, aborting if it exceeds max_bytes — regardless of
    whether a Content-Length header was sent (S6: header can be omitted/lied about)."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > max_bytes:
            raise HTTPException(status_code=413, detail="Payload too large — maximum 5 MB")
        chunks.append(chunk)
    return b"".join(chunks)


def _sanitise_urls(record: dict[str, Any]) -> dict[str, Any]:
    """Drop non-http(s) URL values so imported data can't inject javascript:/data: links
    that the frontend later renders in href/src attributes (stored-XSS guard)."""
    for field in ("html_url", "avatar_url", "blog"):
        v = record.get(field)
        if isinstance(v, str) and v and not v.lower().startswith(("http://", "https://")):
            record[field] = ""
    return record


@app.post("/import")
async def import_results(
    request: Request,
    response: Response,
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    """
    Accept a JSON object (mapping login → user record, the same format
    exported by /results/{job_id}/export/json) and register it as a
    completed job so it can be visualised in the Results view.
    """
    owner_key = await _owner_key(response, rp_session, rp_client)
    _rate_check(owner_key, f"ip:{_client_ip(request)}")

    raw = await _read_capped_body(request, MAX_IMPORT_BYTES)
    try:
        payload: Any = json.loads(raw)
    except Exception:
        raise HTTPException(status_code=422, detail="Invalid JSON body")

    if not isinstance(payload, dict) or not payload:
        raise HTTPException(status_code=422, detail="Payload must be a non-empty JSON object mapping logins to user records.")

    # Keep only dict values (skip top-level scalars) and neutralise unsafe URLs.
    result: dict[str, Any] = {k: _sanitise_urls(v) for k, v in payload.items() if isinstance(v, dict)}
    if not result:
        raise HTTPException(status_code=422, detail="No valid user records found in the uploaded file.")

    # B4: Await DB insert, then persist the done state atomically (avoids the
    # out-of-order fire-and-forget writes the _JobProxy would otherwise make).
    job_id = await create_job_async(owner_key=owner_key)
    await persist_job(job_id, status="done", result=result, total_fetched=len(result))

    return {"job_id": job_id, "total_imported": len(result)}


# ---------------------------------------------------------------------------
# GET /clear_cache  — development / testing only
# ---------------------------------------------------------------------------
# Deletes all jobs from the database and runtime store.
# Hidden from the OpenAPI schema (include_in_schema=False) so it does not
# appear in Swagger UI or generated API clients.
# ---------------------------------------------------------------------------

@app.post("/clear_cache", include_in_schema=False)
async def dev_clear_cache():
    # Guarded: a global wipe is dev-only. Must be a POST (not a prefetchable GET)
    # and explicitly enabled via ALLOW_DEV_CLEAR=1, else it stays disabled in prod.
    if os.environ.get("ALLOW_DEV_CLEAR", "").lower() not in ("1", "true", "yes"):
        raise HTTPException(status_code=403, detail="Cache clearing is disabled on this server.")
    deleted = await clear_all_jobs()
    job_word = "job" if deleted == 1 else "jobs"
    return {
        "message": f"Cache cleared successfully. {deleted} {job_word} deleted.",
        "deleted_jobs": deleted,
    }


# ---------------------------------------------------------------------------
# GET /auth/login  — start GitHub OAuth flow
# ---------------------------------------------------------------------------

@app.get("/auth/login")
async def auth_login(request: Request):
    if not GITHUB_CLIENT_ID:
        raise HTTPException(503, "GitHub OAuth is not configured on this server.")
    state = secrets.token_urlsafe(32)
    # Persist state (10-min TTL) for CSRF validation on callback, and mirror it
    # into a cookie so the callback can prove it is the *same browser* that
    # started the flow. Without the cookie the state was only proof that some
    # flow had started somewhere, which let an attacker hand a victim their own
    # callback URL and silently sign the victim into the attacker's account.
    await add_oauth_state(state, ttl_seconds=600)
    backend_base_url = _backend_base_url(request)
    params = urlencode({
        "client_id": GITHUB_CLIENT_ID,
        "redirect_uri": f"{backend_base_url}/auth/callback",
        # Least privilege. The previous `repo` scope granted read *and write*
        # access to every private repository the user could reach; this app only
        # reads public profile and public-repo metadata. `public_repo` matches
        # what the UI tells users to put on their own PATs.
        "scope": "read:user user:email public_repo",
        "state": state,
    })
    response = RedirectResponse(f"https://github.com/login/oauth/authorize?{params}")
    response.set_cookie(
        OAUTH_STATE_COOKIE, state, httponly=True, samesite=_cookie_samesite,
        secure=_cookie_secure, max_age=600, path="/",
    )
    return response


# ---------------------------------------------------------------------------
# GET /auth/callback  — GitHub redirects here after user authorises
# ---------------------------------------------------------------------------

@app.get("/auth/callback")
async def auth_callback(
    code: str,
    state: str,
    rp_oauth_state: str | None = Cookie(default=None),
):
    # The state must match the cookie set when *this browser* started the flow.
    # Checked before the DB lookup so a replayed callback cannot consume (and
    # thereby burn) a state belonging to someone else's in-flight login.
    if not rp_oauth_state or not secrets.compare_digest(rp_oauth_state, state):
        raise HTTPException(400, "Invalid or expired OAuth state.")
    # Validate state to prevent CSRF (single-use, DB-backed).
    if not await consume_oauth_state(state):
        raise HTTPException(400, "Invalid or expired OAuth state.")

    if not GITHUB_CLIENT_SECRET:
        raise HTTPException(503, "GitHub OAuth is not configured on this server.")

    # Exchange authorisation code for access token
    async with httpx.AsyncClient() as client:
        token_resp = await client.post(
            "https://github.com/login/oauth/access_token",
            json={
                "client_id": GITHUB_CLIENT_ID,
                "client_secret": GITHUB_CLIENT_SECRET,
                "code": code,
            },
            headers={"Accept": "application/json"},
            timeout=15,
        )
    try:
        token_data = token_resp.json()
    except ValueError:
        # Non-JSON body: a GitHub incident, or an intercepting proxy returning
        # an HTML error page. Previously surfaced as an uncaught JSONDecodeError.
        raise HTTPException(502, "GitHub returned an unreadable token response.")
    if not isinstance(token_data, dict):
        raise HTTPException(502, "GitHub returned an unexpected token response.")
    access_token = token_data.get("access_token")
    if not access_token:
        error = token_data.get("error_description", "Unknown error from GitHub")
        raise HTTPException(400, f"Failed to obtain access token: {error}")

    # Fetch the authenticated user's profile
    async with httpx.AsyncClient() as client:
        user_resp = await client.get(
            "https://api.github.com/user",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/vnd.github.v3+json",
            },
            timeout=10,
        )
    if user_resp.status_code != 200:
        raise HTTPException(502, "Failed to fetch GitHub user profile.")
    try:
        user_data = user_resp.json()
    except ValueError:
        raise HTTPException(502, "GitHub returned an unreadable profile response.")
    # `login` is the identity every job is keyed on (`gh:{login}`), so a missing
    # or non-string value must fail loudly rather than key data under "None".
    login = user_data.get("login") if isinstance(user_data, dict) else None
    if not isinstance(login, str) or not login:
        raise HTTPException(502, "GitHub profile response did not include a login.")

    session_id = secrets.token_urlsafe(32)
    await create_session(
        session_id=session_id,
        token=access_token,
        login=login,
        name=user_data.get("name"),
        avatar=user_data.get("avatar_url"),
    )

    # Redirect to frontend with a success indicator in the hash fragment
    response = RedirectResponse(f"{FRONTEND_URL}/#auth=success", status_code=302)
    response.set_cookie(
        SESSION_COOKIE,
        session_id,
        httponly=True,
        samesite=_cookie_samesite,
        secure=_cookie_secure,   # auto-enabled when BACKEND_URL is https / SameSite=None
        max_age=30 * 24 * 3600,
        path="/",
    )
    # The state cookie is single-use — it has done its job.
    response.delete_cookie(OAUTH_STATE_COOKIE, path="/")
    return response


# ---------------------------------------------------------------------------
# GET /auth/me  — return current authenticated user or {authenticated: false}
# ---------------------------------------------------------------------------

@app.get("/auth/me")
async def auth_me(rp_session: str | None = Cookie(default=None)):
    if not rp_session:
        return JSONResponse({"authenticated": False})
    session = await get_session(rp_session)
    if not session:
        return JSONResponse({"authenticated": False})
    return {
        "authenticated": True,
        "login": session["github_login"],
        "name": session["github_name"],
        "avatar_url": session["github_avatar"],
    }


# ---------------------------------------------------------------------------
# POST /auth/logout  — delete session and clear cookie
# ---------------------------------------------------------------------------

@app.post("/auth/logout")
async def auth_logout(rp_session: str | None = Cookie(default=None)):
    if rp_session:
        await delete_session(rp_session)
    response = JSONResponse({"logged_out": True})
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
