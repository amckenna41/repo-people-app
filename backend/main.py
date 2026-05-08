from __future__ import annotations
import asyncio
import json
import os
import sys
from collections import Counter, defaultdict
from typing import Any

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from sse_starlette.sse import EventSourceResponse

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from models import FetchRequest, CompareRequest, MultiCompareRequest, RenameJobRequest, TagsRequest
from store import create_job, create_job_async, get_job, result_to_csv_bytes, load_all_jobs_into_runtime, get_job_async, delete_job, load_jobs_list, set_job_tags
from worker import run_fetch_job

load_dotenv()

# Maximum users fetchable per job on the hosted service.
# Set FETCH_LIMIT=0 in .env to disable the cap (local installs).
_raw_limit = os.environ.get("FETCH_LIMIT", "500")
FETCH_LIMIT: int = int(_raw_limit) if _raw_limit.isdigit() else 500

app = FastAPI(title="repo-people Explorer API", version="1.0.0")

@app.on_event("startup")
async def startup():
    await load_all_jobs_into_runtime()

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

@app.post("/fetch")
async def fetch_users(
    req: FetchRequest,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
):
    # S1: Extract token from Authorization: Bearer header instead of request body.
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    # Cap the per-job fetch limit to keep hosting costs bounded.
    # FETCH_LIMIT=0 disables the cap (local installs only).
    if FETCH_LIMIT > 0:
        if req.limit is None or req.limit > FETCH_LIMIT:
            req.limit = FETCH_LIMIT
    # B4: Await DB insert before starting worker to avoid race condition.
    job_id = await create_job_async()
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
    return {"job_id": job_id}


# ---------------------------------------------------------------------------
# GET /fetch/{job_id}/stream  — SSE progress stream
# ---------------------------------------------------------------------------

@app.get("/fetch/{job_id}/stream")
async def stream_job(job_id: str):
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
async def cancel_job(job_id: str):
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    job["cancelled"] = True
    return {"cancelled": True}


# ---------------------------------------------------------------------------
# GET /jobs — list all job IDs
# ---------------------------------------------------------------------------

@app.get("/jobs")
async def list_jobs():
    # P1: Single SELECT — no N+1 per-job queries.
    return await load_jobs_list()


# ---------------------------------------------------------------------------
# DELETE /jobs/{job_id}
# ---------------------------------------------------------------------------

@app.delete("/jobs/{job_id}")
async def remove_job(job_id: str):
    existed = await delete_job(job_id)
    if not existed:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# PATCH /jobs/{job_id}/tags — update tags
# ---------------------------------------------------------------------------

@app.patch("/jobs/{job_id}/tags")
async def update_job_tags(job_id: str, body: TagsRequest):
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
async def rename_job(job_id: str, body: RenameJobRequest):
    # BE1: Typed RenameJobRequest model. H4/B1: use get_job_async to avoid stale proxy.
    job = await get_job_async(job_id)
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
):
    # P3: Paginated results endpoint — avoids serialising huge JSON blobs in one shot.
    job = await get_job_async(job_id)
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
async def get_summary(job_id: str):
    job = await get_job_async(job_id)
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
):
    job = await get_job_async(job_id)
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
async def compare(req: CompareRequest):
    job_a = await get_job_async(req.job_id_a)
    job_b = await get_job_async(req.job_id_b)

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
async def compare_multi(req: MultiCompareRequest):
    if len(req.job_ids) < 2:
        raise HTTPException(status_code=422, detail="Need at least 2 job IDs")
    if len(req.job_ids) > 5:
        raise HTTPException(status_code=422, detail="Max 5 job IDs")

    jobs_data: list[dict] = []
    for jid in req.job_ids:
        job = await get_job_async(jid)
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
async def export_json(job_id: str):
    job = await get_job_async(job_id)
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
async def export_csv(job_id: str):
    job = await get_job_async(job_id)
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
# POST /import  — create a completed job from uploaded JSON data
# ---------------------------------------------------------------------------

@app.post("/import")
async def import_results(request: Request):
    """
    Accept a JSON object (mapping login → user record, the same format
    exported by /results/{job_id}/export/json) and register it as a
    completed job so it can be visualised in the Results view.
    """
    # S6: Reject payloads larger than 5 MB before deserialising.
    MAX_IMPORT_BYTES = 5 * 1024 * 1024
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_IMPORT_BYTES:
        raise HTTPException(status_code=413, detail="Payload too large — maximum 5 MB")

    try:
        payload: Any = await request.json()
    except Exception:
        raise HTTPException(status_code=422, detail="Invalid JSON body")

    if not isinstance(payload, dict) or not payload:
        raise HTTPException(status_code=422, detail="Payload must be a non-empty JSON object mapping logins to user records.")

    # Sanitise: keep only dict values (skip any top-level metadata scalars)
    result: dict[str, Any] = {k: v for k, v in payload.items() if isinstance(v, dict)}
    if not result:
        raise HTTPException(status_code=422, detail="No valid user records found in the uploaded file.")

    # B4: Await DB insert before updating job fields.
    job_id = await create_job_async()
    job = get_job(job_id)
    job["status"] = "done"
    job["result"] = result
    job["total_fetched"] = len(result)

    return {"job_id": job_id, "total_imported": len(result)}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
