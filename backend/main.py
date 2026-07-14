from __future__ import annotations
import asyncio
import json
import os
import secrets
import sys
import time
from collections import Counter, defaultdict
from typing import Any
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv
from fastapi import BackgroundTasks, Cookie, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from sse_starlette.sse import EventSourceResponse

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from models import FetchRequest, CompareRequest, MultiCompareRequest, RenameJobRequest, TagsRequest
from store import (
    create_job_async, get_job, result_to_csv_bytes,
    load_all_jobs_into_runtime, get_job_async, delete_job, load_jobs_list,
    set_job_tags, clear_all_jobs, persist_job,
    create_session, get_session, delete_session,
    add_oauth_state, consume_oauth_state, add_share_token, get_share_token,
)
from worker import run_fetch_job

from pathlib import Path as _Path
load_dotenv(_Path(__file__).resolve().parent / ".env", override=True)

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
BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8000")
SESSION_COOKIE = "rp_session"
ANON_COOKIE = "rp_client"

# Cookie flags. Secure is auto-enabled when the backend is served over HTTPS.
# COOKIE_SAMESITE=none is required when the frontend and backend are on
# different origins (e.g. Vercel frontend + Cloud Run backend); it forces Secure.
_cookie_secure = BACKEND_URL.startswith("https")
_cookie_samesite = os.environ.get("COOKIE_SAMESITE", "lax").lower()
if _cookie_samesite == "none":
    _cookie_secure = True


def _backend_base_url(request: Request) -> str:
    """Return the externally reachable backend base URL for OAuth callbacks."""
    configured = (BACKEND_URL or "").strip().rstrip("/")
    if configured and configured != "http://localhost:8000":
        return configured
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}".rstrip("/")

# Per-caller rate limit for expensive endpoints (/fetch, /import).
# ponytail: in-memory per-instance window; move to Redis if you run >1 instance.
_RATE_LIMIT = int(os.environ.get("FETCH_RATE_LIMIT", "20"))   # requests per window
_RATE_WINDOW = 60                                             # seconds
_rate_hits: dict[str, list[float]] = defaultdict(list)

app = FastAPI(title="repo-people Explorer API", version="1.0.0")

@app.on_event("startup")
async def startup():
    await load_all_jobs_into_runtime()


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
    """A job is accessible if it has no owner (legacy) or the caller owns it."""
    owner = job.get("owner_key")
    return owner is None or owner == key


async def _get_owned_job(job_id: str, rp_session: str | None, rp_client: str | None):
    """Return the job only if the caller may access it, else None (missing OR forbidden —
    callers raise 404 without leaking which)."""
    job = await get_job_async(job_id)
    if job is None:
        return None
    key = await _reader_key(rp_session, rp_client)
    if not _can_access(job, key):
        return None
    return job


def _rate_check(key: str) -> None:
    now = time.time()
    hits = [t for t in _rate_hits[key] if t > now - _RATE_WINDOW]
    if len(hits) >= _RATE_LIMIT:
        raise HTTPException(429, f"Rate limit exceeded — max {_RATE_LIMIT} requests per minute.")
    hits.append(now)
    _rate_hits[key] = hits

# S2: CORS origins configurable via env var (comma-separated list).
_raw_origins = os.environ.get("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
_allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
    )


@app.post("/fetch")
async def fetch_users(
    req: FetchRequest,
    background_tasks: BackgroundTasks,
    response: Response,
    authorization: str | None = Header(default=None),
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    # S1: Extract token from Authorization: Bearer header instead of request body.
    token = await _resolve_token(authorization, rp_session)
    # Scope this job to its creator and rate-limit per caller.
    owner_key = await _owner_key(response, rp_session, rp_client)
    _rate_check(owner_key)
    # Cap the per-job fetch limit to keep hosting costs bounded.
    # FETCH_LIMIT=0 disables the cap (local installs only).
    if FETCH_LIMIT > 0:
        if req.limit is None or req.limit > FETCH_LIMIT:
            req.limit = FETCH_LIMIT
    # B4: Await DB insert before starting worker to avoid race condition.
    # Store params (no secrets) so the job can be refreshed later.
    job_id = await create_job_async(owner_key=owner_key, params=req.model_dump())
    _start_fetch(background_tasks, job_id, req, token)
    return {"job_id": job_id}


# ---------------------------------------------------------------------------
# POST /jobs/{job_id}/refresh  — re-run a job with its original parameters
# ---------------------------------------------------------------------------

@app.post("/jobs/{job_id}/refresh")
async def refresh_job(
    job_id: str,
    background_tasks: BackgroundTasks,
    response: Response,
    authorization: str | None = Header(default=None),
    rp_session: str | None = Cookie(default=None),
    rp_client: str | None = Cookie(default=None),
):
    job = await _get_owned_job(job_id, rp_session, rp_client)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    params = job.get("params")
    if not params:
        raise HTTPException(status_code=409, detail="This job has no saved parameters and cannot be refreshed.")
    req = FetchRequest(**params)
    token = await _resolve_token(authorization, rp_session)
    owner_key = await _owner_key(response, rp_session, rp_client)
    _rate_check(owner_key)
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
    if await _get_owned_job(job_id, rp_session, rp_client) is None:
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
    if await _get_owned_job(job_id, rp_session, rp_client) is None:
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
    if await _get_owned_job(job_id, rp_session, rp_client) is None:
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
    if await _get_owned_job(job_id, rp_session, rp_client) is None:
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
    job = await _get_owned_job(job_id, rp_session, rp_client)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    job["label"] = body.label
    return {"job_id": job_id, "label": body.label}


# ---------------------------------------------------------------------------
# GET /results/{job_id}
# ---------------------------------------------------------------------------

@app.get("/results/{job_id}")
async def get_results(
    job_id: str,
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
    all_users = list(result.values())
    total = len(all_users)
    start = (page - 1) * page_size
    end = start + page_size
    page_users = {u["login"]: u for u in all_users[start:end] if isinstance(u, dict) and "login" in u}
    return {
        "users": page_users,
        "total": total,
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
    job = await _get_owned_job(job_id, rp_session, rp_client)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "done":
        raise HTTPException(status_code=409, detail=f"Job status: {job['status']}")

    # H7/B2/P4: Serve cached summary from DB when available — avoids recomputing on every call.
    if job.get("summary"):
        return job["summary"]

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
    job["summary"] = summary
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
    job = await _get_owned_job(job_id, rp_session, rp_client)
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
    _rate_check(owner_key)

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
    # Persist state (10-min TTL) for CSRF validation on callback.
    await add_oauth_state(state, ttl_seconds=600)
    backend_base_url = _backend_base_url(request)
    params = urlencode({
        "client_id": GITHUB_CLIENT_ID,
        "redirect_uri": f"{backend_base_url}/auth/callback",
        "scope": "read:user user:email repo",
        "state": state,
    })
    return RedirectResponse(f"https://github.com/login/oauth/authorize?{params}")


# ---------------------------------------------------------------------------
# GET /auth/callback  — GitHub redirects here after user authorises
# ---------------------------------------------------------------------------

@app.get("/auth/callback")
async def auth_callback(code: str, state: str):
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
    token_data = token_resp.json()
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
    user_data = user_resp.json()

    session_id = secrets.token_urlsafe(32)
    await create_session(
        session_id=session_id,
        token=access_token,
        login=user_data["login"],
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
