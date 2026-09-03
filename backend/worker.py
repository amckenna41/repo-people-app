from __future__ import annotations
import asyncio
import json
import logging
import os
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

_logger = logging.getLogger(__name__)

# Allow running from repo root where repo_people package lives
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))
from repo_people.users import GitHubUserInfo
from repo_people import export as rp_export
from github import Github, Auth, GithubException

from store import emit_event, get_job, persist_job


# Roles whose GitHub endpoints reject unauthenticated requests outright.
# Listing stargazers and watchers now returns 401 even for a public repo, and
# collaborators (used to derive maintainers) always required a token. Without
# one these roles contribute nothing, which silently halves the result set for
# a repo whose community is mostly stargazers.
_AUTH_REQUIRED_ROLES = frozenset({"stargazers", "watchers", "maintainers"})


def _classify_role_error(exc: Exception, role: str, has_token: bool = True) -> str:
    """Return a user-friendly warning message for a per-role fetch failure."""
    if isinstance(exc, GithubException):
        data_str = str(getattr(exc, 'data', '') or '').lower()
        if exc.status == 401:
            if not has_token:
                # Saying "invalid or expired" when none was supplied sends people
                # off to regenerate a token they never had.
                return (f"⚠️ {role}: GitHub requires a token for this role — "
                        f"0 users collected. Add a PAT or sign in, then re-run.")
            return f"⚠️ {role}: Authentication failed — token is invalid or expired."
        if exc.status == 403:
            if 'rate limit' in data_str or 'x-ratelimit' in data_str:
                return f"⚠️ {role}: Rate limit exceeded — add a PAT or wait for reset."
            if not has_token and role in _AUTH_REQUIRED_ROLES:
                return (f"⚠️ {role}: GitHub requires a token for this role — "
                        f"0 users collected. Add a PAT or sign in, then re-run.")
            return f"⚠️ {role}: Access denied — repository may be private or token lacks scope."
        if exc.status == 404:
            return f"⚠️ {role}: Repository not found — check owner/repo name."
        if exc.status == 429:
            return f"⚠️ {role}: Secondary rate limit hit — reduce workers or wait a moment."
        return f"⚠️ {role}: GitHub API error {exc.status}."
    return f"⚠️ {role}: Unexpected error — {type(exc).__name__}: {exc}"

# ---------------------------------------------------------------------------
# Executor and concurrency limits
# ---------------------------------------------------------------------------
# Every blocking GitHub call used run_in_executor(None, ...) — asyncio's shared,
# process-wide ThreadPoolExecutor (min(32, cpu_count+4) threads). The per-job
# `workers` semaphore bounds concurrency *within* one job, but nothing bounded
# how many jobs ran at once, so a handful of simultaneous fetches could saturate
# the default pool and starve every other coroutine that needs a thread.
#
# A dedicated executor keeps fetch work off the shared pool, and a global
# semaphore caps how many jobs may run concurrently on this instance.
_MAX_CONCURRENT_JOBS = int(os.environ.get("MAX_CONCURRENT_JOBS", "3"))
_FETCH_THREADS = int(os.environ.get("FETCH_THREAD_POOL_SIZE", "24"))

_fetch_executor = ThreadPoolExecutor(
    max_workers=_FETCH_THREADS, thread_name_prefix="repo-people-fetch"
)
_job_slots = asyncio.Semaphore(_MAX_CONCURRENT_JOBS)


def shutdown_executor() -> None:
    """Release the fetch thread pool. Called from the app's shutdown hook."""
    _fetch_executor.shutdown(wait=False, cancel_futures=True)


_SAVE_BLOCK = 25  # write partial checkpoint every N users when save_each_user=True

async def run_fetch_job(
    job_id: str,
    owner: str,
    repo: str,
    token: str,
    roles: list[str] | None,
    limit: int | None,
    exclude_bots: bool,
    include_social_accounts: bool,
    workers: int,
    save_each_user: bool = False,
    max_total: int | None = None,
) -> None:
    """Background coroutine that drives RepoPeople and emits SSE events.

    limit     — user-facing cap on usernames taken *from each role*.
    max_total — server-side hard cap on unique profiles fetched, regardless of
                `limit`. This is the cost control for the hosted service; the
                profile lookups are what actually burn API quota and CPU.
    """
    job = get_job(job_id)
    if job is None:
        return

    queue: asyncio.Queue = job["events"]
    partial_path = os.path.join(tempfile.gettempdir(), f"repo-people-{job_id}-partial.json")

    # Warnings are persisted with the job as well as streamed, so the reason a
    # result set came back short survives the SSE connection (and the tab).
    warnings: list[str] = []

    async def emit(event_type: str, data: dict) -> None:
        if event_type == "warning":
            message = data.get("message")
            if message and message not in warnings:
                warnings.append(message)
        # Never blocks: the queue is bounded and drops its oldest events when
        # nobody is draining it (no SSE client attached, or one that went away).
        emit_event(queue, {"event": event_type, "data": data})

    # Wait for a slot rather than piling onto the thread pool. The job stays
    # "pending" while queued, and the client's SSE stream is already open, so
    # tell them what is happening instead of leaving the log silent.
    if _job_slots.locked():
        await emit("status", {"message": "Queued — waiting for a free fetch slot…"})
    async with _job_slots:
        await _run_fetch_job_inner(
            job=job, job_id=job_id, owner=owner, repo=repo, token=token, roles=roles,
            limit=limit, exclude_bots=exclude_bots,
            include_social_accounts=include_social_accounts, workers=workers,
            save_each_user=save_each_user, max_total=max_total,
            queue=queue, emit=emit, partial_path=partial_path, warnings=warnings,
        )


async def _run_fetch_job_inner(
    *, job, job_id: str, owner: str, repo: str, token: str, roles, limit,
    exclude_bots: bool, include_social_accounts: bool, workers: int,
    save_each_user: bool, max_total, queue, emit, partial_path: str,
    warnings: list[str],
) -> None:
    """The fetch itself. Split out so run_fetch_job can hold a concurrency slot
    for exactly the duration of the work."""
    job["status"] = "running"
    loop = asyncio.get_event_loop()
    # Declare results before try so the except clause can access partial data
    results: dict[str, Any] = {}

    try:
        # Build the authenticated Github client directly — avoids the 2 extra
        # blocking API calls (get_rate_limit + get_repo) that RepoPeople.__init__
        # makes but that we don't need here.
        await emit("status", {"message": "Initialising GitHub client…"})
        t0 = time.monotonic()
        gh = Github(auth=Auth.Token(token)) if token else Github()
        await emit("status", {"message": f"Client ready ({time.monotonic() - t0:.2f}s). Fetching usernames for {len(roles or [])} role(s) in parallel…"})

        # Normalise token: empty string must become None so export functions
        # don't send an empty Bearer header which triggers GitHub 401s.
        _token: str | None = token or None

        # Map each role to its export function
        _tmp = tempfile.gettempdir()  # B5/BE3: use system temp dir, not hardcoded /tmp
        role_funcs: dict[str, Any] = {
            "contributors":   lambda: rp_export.export_contributors(owner, repo, _token, _tmp, return_data=True),
            "maintainers":    lambda: rp_export.export_maintainers(owner, repo, _token, _tmp, skip_codeowners=False, skip_collaborators=False, return_data=True),
            "stargazers":     lambda: rp_export.export_stargazers(owner, repo, _token, _tmp, return_data=True),
            "watchers":       lambda: rp_export.export_watchers(owner, repo, _token, _tmp, return_data=True),
            "issue_authors":  lambda: rp_export.export_issue_authors(owner, repo, _token, _tmp, return_data=True),
            "pr_authors":     lambda: rp_export.export_pr_authors(owner, repo, _token, _tmp, return_data=True),
            "fork_owners":    lambda: rp_export.export_fork_owners(owner, repo, _token, _tmp, return_data=True),
            "commit_authors": lambda: rp_export.export_commit_authors(owner, repo, _token, _tmp, return_data=True),
            "dependents":     lambda: rp_export.export_dependents(owner, repo, _tmp, return_data=True),
        }
        active_roles = [r for r in (roles or list(role_funcs)) if r in role_funcs]

        # Fetch all roles in parallel, emitting a status message as each one finishes
        async def _fetch_role(role: str):
            t_role = time.monotonic()
            await emit("status", {"message": f"  → fetching {role}…"})
            try:
                data = await loop.run_in_executor(_fetch_executor, role_funcs[role])
                elapsed_role = time.monotonic() - t_role
                await emit("status", {"message": f"  ✓ {role}: {len(data)} users ({elapsed_role:.1f}s)"})
                return role, data
            except Exception as role_exc:
                elapsed_role = time.monotonic() - t_role
                _logger.warning("Role fetch failed for %s/%s [%s] after %.1fs: %s", owner, repo, role, elapsed_role, role_exc)
                friendly = _classify_role_error(role_exc, role, has_token=bool(token))
                await emit("warning", {"message": friendly})
                return role, []  # Continue with remaining roles

        role_results = await asyncio.gather(*[_fetch_role(r) for r in active_roles], return_exceptions=True)

        username_map: dict[str, list[str]] = {}
        for item in role_results:
            if isinstance(item, BaseException):
                # gather return_exceptions=True; individual role errors already handled above
                await emit("warning", {"message": f"⚠️ Unexpected error during role fetch — {item}"})
            else:
                role, data = item
                # Apply the per-role cap. Without this the `limit` field was
                # accepted and silently ignored, so neither the user's choice
                # nor the hosted FETCH_LIMIT had any effect.
                username_map[role] = data[:limit] if limit and limit > 0 else data

        unique_logins_set: set[str] = set()
        for logins in username_map.values():
            unique_logins_set.update(logins)

        # Hard server-side cap on profile lookups. Sorted so a truncated run is
        # reproducible rather than dependent on set iteration order.
        unique_logins: list[str] = sorted(unique_logins_set)
        if max_total and max_total > 0 and len(unique_logins) > max_total:
            await emit("warning", {
                "message": f"⚠️ Capped at {max_total} users (found {len(unique_logins)}) — "
                           f"run the app locally to remove this limit."
            })
            unique_logins = unique_logins[:max_total]
            # Keep role membership consistent with what was actually fetched.
            kept = set(unique_logins)
            username_map = {r: [u for u in logins if u in kept] for r, logins in username_map.items()}

        total = len(unique_logins)
        roles_elapsed = time.monotonic() - t0
        await emit("status", {"message": f"Found {total} unique users across all roles ({roles_elapsed:.1f}s total). Fetching profile details…"})
        await emit("progress", {"fetched": 0, "total": total, "login": None, "rate_limit_remaining": None})

        fetched = 0
        block_counter = 0
        start_time = time.monotonic()
        # Track which rate-limit thresholds have already triggered a warning
        _rl_warned_thresholds: set[int] = set()

        def _fetch_one(login: str) -> tuple[str, dict]:
            info = GitHubUserInfo(gh, username=login)
            data = info.to_dict(include_social_accounts=include_social_accounts)
            return login, data

        # Fetch details concurrently using asyncio gather over executor
        semaphore = asyncio.Semaphore(workers)

        async def _fetch_with_sem(login: str):
            nonlocal fetched, block_counter
            if job.get("cancelled"):
                return
            async with semaphore:
                if job.get("cancelled"):
                    return
                try:
                    _login, user_dict = await loop.run_in_executor(_fetch_executor, _fetch_one, login)
                except Exception as fetch_exc:
                    await emit("status", {"message": f"Warning: failed to fetch {login} — {fetch_exc}"})
                    return
                fetched += 1
                elapsed = time.monotonic() - start_time
                rate = fetched / elapsed if elapsed > 0 else 0
                remaining_est = int((total - fetched) / rate) if rate > 0 else None

                # Read rate limit from the last response headers (cached by PyGitHub)
                rl_remaining: int | None = None
                rl_reset: int | None = None
                try:
                    rl_remaining, _ = gh.rate_limiting
                    rl_reset = gh.rate_limiting_resettime
                    # Emit a one-time warning when approaching rate limit exhaustion
                    for threshold in (500, 200, 100, 50):
                        if rl_remaining <= threshold and threshold not in _rl_warned_thresholds:
                            _rl_warned_thresholds.add(threshold)
                            mins_left = max(0, int((rl_reset - time.time()) / 60)) if rl_reset else 0
                            await emit("warning", {
                                "message": f"⚠️ GitHub rate limit: {rl_remaining} API calls remaining — resets in {mins_left}m"
                            })
                            break
                except Exception:
                    pass

                await emit(
                    "progress",
                    {
                        "fetched": fetched,
                        "total": total,
                        "login": _login,
                        "eta_seconds": remaining_est,
                        "rate_limit_remaining": rl_remaining,
                        "rate_limit_reset": rl_reset,
                    },
                )
                # Attach roles and apply bot filter
                user_roles = [role for role, logins in username_map.items() if _login in logins]
                user_dict["roles"] = user_roles
                if not (exclude_bots and user_dict.get("is_bot")):
                    results[_login] = user_dict

                # Incrementally save to a temp checkpoint file every _SAVE_BLOCK users
                if save_each_user:
                    block_counter += 1
                    if block_counter >= _SAVE_BLOCK:
                        block_counter = 0
                        try:
                            with open(partial_path, "w") as pf:
                                json.dump(results, pf)
                        except Exception:
                            pass

        task_list = [asyncio.create_task(_fetch_with_sem(login)) for login in unique_logins]

        async def _cancel_watcher():
            while True:
                await asyncio.sleep(0.2)
                if job.get("cancelled"):
                    for t in task_list:
                        if not t.done():
                            t.cancel()
                    return

        watcher = asyncio.create_task(_cancel_watcher())
        try:
            await asyncio.gather(*task_list, return_exceptions=True)
        finally:
            watcher.cancel()

        # B3: persist the terminal state in one awaited write so result/status/total
        # can't land out of order via fire-and-forget _JobProxy writes.
        await persist_job(job_id, result=results, status="done",
                          total_fetched=len(results), warnings=warnings)

        if job.get("cancelled"):
            await emit("status", {"message": f"Fetch stopped by user. {len(results)} users saved."})

        # Remove partial checkpoint file on successful / stopped completion
        if save_each_user and os.path.exists(partial_path):
            try:
                os.remove(partial_path)
            except Exception:
                pass

        await emit("done", {"total": len(results)})

    except Exception as exc:  # noqa: BLE001
        # S7: Log full exception server-side; store only a sanitised message in the job record.
        _logger.exception("Fetch job %s failed", job_id)
        sanitised_message = "An internal error occurred during fetch. Check server logs for details."
        # If save_each_user is enabled, try to salvage partial results rather than failing
        if save_each_user:
            if results:
                await persist_job(job_id, result=results, status="done",
                                  total_fetched=len(results), warnings=warnings)
                await emit("status", {"message": f"Fetch interrupted. Using {len(results)} users fetched so far."})
                await emit("done", {"total": len(results)})
                return
            if os.path.exists(partial_path):
                try:
                    with open(partial_path) as pf:
                        partial_results = json.load(pf)
                    await persist_job(job_id, result=partial_results, status="done",
                                      total_fetched=len(partial_results), warnings=warnings)
                    await emit("status", {"message": f"Fetch failed. Restored {len(partial_results)} users from last saved checkpoint."})
                    await emit("done", {"total": len(partial_results)})
                    return
                except Exception:
                    pass
        await persist_job(job_id, status="error", message=sanitised_message, warnings=warnings)
        await emit("error", {"message": sanitised_message})
        await emit("done", {})
