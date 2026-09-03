// In development, BASE is empty and Vite proxies API calls to localhost:8000.
// In production builds, API_BASE_URL (or the legacy VITE_API_BASE_URL) points at the Cloud Run service URL.
const BASE = import.meta.env.API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? ''

export const API_BASE = BASE

// Sent on every mutating request. The backend rejects state-changing calls
// without it (see require_csrf_header in backend/main.py): a request carrying a
// custom header cannot be made cross-site without a preflight, and the preflight
// fails CORS for any origin that isn't allow-listed. Cookies are SameSite=None
// in the split deployment, so this is what stops a third-party page acting as
// the user.
export const CSRF_HEADER = { 'X-Requested-With': 'repo-people' } as const

// All API calls must send cookies so the backend can scope jobs to this
// browser/session (the rp_client / rp_session cookies). Cross-origin cookies
// additionally require the backend to set SameSite=None; Secure.
function req(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  // GETs stay "simple" so they don't pay for a preflight round trip.
  const headers = method === 'GET'
    ? init.headers
    : { ...CSRF_HEADER, ...init.headers }
  return fetch(url, { credentials: 'include', ...init, headers })
}

/** Open the SSE progress stream for a job.
 *
 * Must go through BASE and send credentials: in production the frontend is on
 * Vercel and the backend on Cloud Run, so a relative URL hits the frontend
 * origin (404), and without cookies the backend's ownership check rejects it. */
export function openJobStream(jobId: string): EventSource {
  return new EventSource(`${BASE}/fetch/${jobId}/stream`, { withCredentials: true })
}

/** Fire-and-forget cancel that survives page unload.
 *
 *  Uses fetch(keepalive) rather than sendBeacon: a beacon cannot set custom
 *  headers, so it could not send the CSRF header the backend now requires.
 *  keepalive gives the same outlive-the-page guarantee and does send cookies. */
export function beaconCancelJob(jobId: string): void {
  try {
    void fetch(`${BASE}/fetch/${jobId}/cancel`, {
      method: 'POST',
      credentials: 'include',
      headers: CSRF_HEADER,
      keepalive: true,
    }).catch(() => { /* page is going away — nothing to report */ })
  } catch {
    // Blocked or unsupported — the job will finish on its own.
  }
}

// ---------------------------------------------------------------------------
// Session-storage cache (TTL = 5 minutes)
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

function cacheGet<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const entry: CacheEntry<T> = JSON.parse(raw)
    if (Date.now() > entry.expiresAt) {
      sessionStorage.removeItem(key)
      return null
    }
    return entry.value
  } catch {
    return null
  }
}

function cacheSet<T>(key: string, value: T): void {
  try {
    const entry: CacheEntry<T> = { value, expiresAt: Date.now() + CACHE_TTL_MS }
    sessionStorage.setItem(key, JSON.stringify(entry))
  } catch {
    // sessionStorage full or unavailable — silently skip
  }
}

/** Invalidate all cached entries for a given job (e.g. after deletion). */
export function invalidateJobCache(jobId: string): void {
  const prefix = `rp:${jobId}:`
  const keysToRemove: string[] = []
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i)
    if (k && k.startsWith(prefix)) keysToRemove.push(k)
  }
  keysToRemove.forEach(k => sessionStorage.removeItem(k))
}

const HTTP_STATUS_DESCRIPTIONS: Record<number, string> = {
  400: 'Bad Request – the server could not understand the request.',
  401: 'Unauthorized – authentication is required or the token is invalid.',
  403: 'Forbidden – access to this resource is not allowed.',
  404: 'Not Found – the requested job or resource does not exist.',
  408: 'Request Timeout – the server timed out waiting for the request.',
  429: 'Too Many Requests – rate limit exceeded; try again later.',
  500: 'Internal Server Error – an unexpected error occurred on the server.',
  502: 'Bad Gateway – the server received an invalid response from an upstream service.',
  503: 'Service Unavailable – the server is temporarily unable to handle the request.',
  504: 'Gateway Timeout – the upstream server did not respond in time.',
}

function logHttpError(url: string, status: number, statusText: string, body?: unknown) {
  const description = HTTP_STATUS_DESCRIPTIONS[status] ?? 'Unexpected HTTP error.'
  console.error(
    `[repo-people] HTTP ${status} (${statusText || 'No status text'}) fetching ${url}\n` +
    `  Explanation: ${description}` +
    (body ? `\n  Response body: ${JSON.stringify(body)}` : '')
  )
}

export async function postFetch(body: object, token?: string): Promise<{ job_id: string }> {
  // S1: Token sent as Authorization: Bearer header, not in request body.
  const url = `${BASE}/fetch`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const res = await req(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    credentials: 'include',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    logHttpError(url, res.status, res.statusText, err)
    throw new Error(err.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

/** Filters applied server-side, across the whole result set rather than only
 *  the pages already loaded into the table. */
export interface ResultFilters {
  q?: string
  location?: string
  company?: string
  role?: string
  min_followers?: string
  max_followers?: string
  joined_after?: string
  joined_before?: string
  hide_bots?: boolean
  sort_by?: string
  sort_dir?: 'asc' | 'desc'
}

/** Drop empty values so the URL only carries filters that are actually set. */
export function filtersToParams(filters: ResultFilters = {}): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '' || value === false) continue
    params.set(key, String(value))
  }
  return params
}

/** Fetch a single page of results — used for incremental "load more" UX. */
export async function fetchResultsPage(
  jobId: string,
  page: number,
  pageSize: number = 200,
  filters: ResultFilters = {},
): Promise<{
  users: Record<string, unknown>
  /** Why the set may be short — e.g. a role that needed a token. Persisted with
   *  the job, so it survives the fetch's SSE stream. */
  warnings?: string[]
  total: number
  unfiltered_total: number
  page: number
  pages: number
}> {
  const params = filtersToParams(filters)
  params.set('page', String(page))
  params.set('page_size', String(pageSize))
  const url = `${BASE}/results/${jobId}?${params}`
  const res = await req(url)
  if (!res.ok) {
    const body = await res.json().catch(() => undefined)
    logHttpError(url, res.status, res.statusText, body)
    throw new Error(body?.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

/** Rows the browser will hold for one query. The hosted FETCH_LIMIT is 500, so
 *  this only binds on local installs running uncapped fetches. */
export const MAX_CLIENT_ROWS = 10000

/** Walk every page of a query, deduplicating by login.
 *
 *  Charts, quick-stat badges and client-side exports all aggregate the rows the
 *  view is holding, so holding only page one made them silently describe a
 *  fraction of the result set. `onPage` is called with the running total after
 *  each page so the table fills in progressively; returning false from
 *  `shouldContinue` abandons the walk (the caller's query has moved on) without
 *  emitting anything further.
 */
export async function fetchAllResultPages(
  jobId: string,
  filters: ResultFilters,
  opts: {
    firstPage?: UserLike[]
    total: number
    pageSize?: number
    shouldContinue?: () => boolean
    onPage?: (rows: UserLike[]) => void
  },
): Promise<UserLike[]> {
  const pageSize = opts.pageSize ?? 1000
  const shouldContinue = opts.shouldContinue ?? (() => true)
  const collected = [...(opts.firstPage ?? [])]
  const seen = new Set(collected.map(u => u.login))
  const cap = Math.min(opts.total, MAX_CLIENT_ROWS)
  // Walk from page 1 at the full page size. That re-covers the rows already
  // rendered, which costs one overlapping page and buys not having to reconcile
  // two different page sizes against each other.
  const lastPage = Math.ceil(cap / pageSize)

  for (let page = 1; page <= lastPage; page++) {
    if (!shouldContinue()) return collected
    const data = await fetchResultsPage(jobId, page, pageSize, filters)
    if (!shouldContinue()) return collected
    const rows = Object.values(data.users) as UserLike[]
    if (!rows.length) break
    for (const row of rows) {
      if (seen.has(row.login)) continue
      seen.add(row.login)
      collected.push(row)
    }
    opts.onPage?.(collected)
  }
  return collected
}

/** Minimal shape fetchAllResultPages needs — callers cast to their own record type. */
interface UserLike { login: string }

// ---------------------------------------------------------------------------
// GitHub token validation
// ---------------------------------------------------------------------------

/** Scopes the app asks for on a classic PAT (mirrors the help text in FetchView). */
export const REQUIRED_SCOPES = ['read:user', 'public_repo'] as const

export interface TokenValidation {
  valid: boolean
  login?: string
  /** Classic-PAT scopes. Empty for fine-grained tokens, which don't use them. */
  scopes?: string[]
  /** Required scopes absent from a classic PAT. Never populated for fine-grained. */
  missingScopes?: string[]
  /** True when GitHub reports no classic scopes — a fine-grained PAT or App token. */
  fineGrained?: boolean
  rateLimit?: { remaining: number; limit: number }
  error?: string
}

/** Check a PAT against GitHub directly from the browser.
 *
 *  Goes straight to api.github.com rather than through our backend: GitHub sends
 *  `access-control-allow-origin: *` and exposes `X-OAuth-Scopes` and the
 *  rate-limit headers via `access-control-expose-headers`, so the browser can
 *  read everything needed. That avoids adding an endpoint whose only job would
 *  be to relay a credential we would then have to rate-limit and log around.
 *
 *  Deliberately a bare fetch — no `credentials`, no CSRF header. Those belong to
 *  our own API; sending our session cookie to github.com would be wrong.
 */
export async function validateGitHubToken(token: string): Promise<TokenValidation> {
  const trimmed = token.trim()
  if (!trimmed) return { valid: false, error: 'Enter a token first.' }

  let res: Response
  try {
    res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${trimmed}`,
        Accept: 'application/vnd.github+json',
      },
    })
  } catch {
    return { valid: false, error: 'Could not reach GitHub. Check your connection.' }
  }

  // GitHub omits these entirely on some errors (a real 401 carries none), and
  // Number(null) is 0 — so read them as "absent" rather than "zero", otherwise a
  // header-less 403 gets reported as a rate limit that was never hit.
  const num = (name: string): number | null => {
    const raw = res.headers.get(name)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  const limit = num('x-ratelimit-limit')
  const remaining = num('x-ratelimit-remaining')
  const rateLimit =
    limit !== null && remaining !== null && limit > 0 ? { limit, remaining } : undefined

  if (res.status === 401) {
    return { valid: false, error: 'Token is invalid or has expired.', rateLimit }
  }
  if (res.status === 403) {
    return {
      valid: false,
      rateLimit,
      error: remaining === 0
        ? 'Rate limit exceeded for this token — wait for the reset.'
        : 'GitHub refused this token (it may be blocked or SSO-restricted).',
    }
  }
  if (!res.ok) {
    return { valid: false, error: `GitHub returned HTTP ${res.status}.`, rateLimit }
  }

  const user = await res.json().catch(() => ({} as { login?: string }))

  // Fine-grained PATs and GitHub App tokens report no classic scopes. An empty
  // header therefore means "cannot tell", not "no permissions" — warning about
  // missing scopes there would be wrong, and the token may work perfectly.
  const raw = res.headers.get('x-oauth-scopes')
  const scopes = (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const fineGrained = scopes.length === 0

  return {
    valid: true,
    login: user.login,
    scopes,
    fineGrained,
    missingScopes: fineGrained ? [] : REQUIRED_SCOPES.filter(s => !scopes.includes(s)),
    rateLimit,
  }
}

// ---------------------------------------------------------------------------
// Churn / retention history
// ---------------------------------------------------------------------------

export interface HistoryRun {
  job_id: string
  label: string | null
  created_at: string
  total: number
  joined: string[]
  left: string[]
  joined_count: number
  left_count: number
  retention_pct: number | null
}

export interface JobHistory {
  repo: string
  runs: HistoryRun[]
  total_runs: number
  net_change?: number
  core_members?: number
}

/** Diff every completed run of this job's repo. Returns null when the job has
 *  no repo recorded (imported jobs) or the backend is unavailable. */
export async function fetchJobHistory(jobId: string): Promise<JobHistory | null> {
  const res = await req(`${BASE}/jobs/${jobId}/history`)
  if (!res.ok) return null
  return res.json()
}

// ---------------------------------------------------------------------------
// Scheduled re-fetch
// ---------------------------------------------------------------------------

export interface Schedule {
  schedule_id: string
  source_job_id: string
  label: string | null
  interval_hours: number
  next_run_at: string
  last_run_at: string | null
  last_job_id: string | null
  enabled: boolean
}

export async function fetchSchedules(): Promise<Schedule[]> {
  const res = await req(`${BASE}/schedules`)
  if (!res.ok) return []
  return res.json()
}

export async function createSchedule(jobId: string, intervalHours: number): Promise<Schedule> {
  const res = await req(`${BASE}/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, interval_hours: intervalHours }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function setScheduleEnabled(scheduleId: string, enabled: boolean): Promise<void> {
  await req(`${BASE}/schedules/${scheduleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

export async function deleteSchedule(scheduleId: string): Promise<void> {
  await req(`${BASE}/schedules/${scheduleId}`, { method: 'DELETE' })
}

/** Create a short-lived (24h) shareable read token for a job. */
export async function createShareToken(jobId: string): Promise<{ token: string; url: string; expires_at: string }> {
  const url = `${BASE}/results/${jobId}/share`
  const res = await req(url, { method: 'POST' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

/** Fetch paginated results from a share token (no authentication required). */
export async function fetchSharedJob(
  token: string,
  page: number = 1,
  pageSize: number = 200,
): Promise<{ users: Record<string, unknown>; total: number; page: number; pages: number; job_label: string; expires_at: string }> {
  const url = `${BASE}/share/${token}?page=${page}&page_size=${pageSize}`
  const res = await req(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function postImport(data: Record<string, unknown>): Promise<{ job_id: string; total_imported: number }> {
  const res = await req(`${BASE}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function fetchSummary(jobId: string) {
  // C1: Return from session-storage cache when available (TTL = 5 min).
  const cacheKey = `rp:${jobId}:summary`
  const cached = cacheGet<unknown>(cacheKey)
  if (cached) return cached

  const url = `${BASE}/results/${jobId}/summary`
  const res = await req(url)
  if (!res.ok) {
    const body = await res.json().catch(() => undefined)
    logHttpError(url, res.status, res.statusText, body)
    throw new Error(body?.detail ?? `HTTP ${res.status}`)
  }
  const data = await res.json()
  cacheSet(cacheKey, data)
  return data
}

export async function fetchTop(jobId: string, by: string, n: number) {
  const url = `${BASE}/results/${jobId}/top?by=${by}&n=${n}`
  const res = await req(url)
  if (!res.ok) {
    const body = await res.json().catch(() => undefined)
    logHttpError(url, res.status, res.statusText, body)
    throw new Error(body?.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function postCompare(jobIdA: string, jobIdB: string) {
  const res = await req(`${BASE}/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id_a: jobIdA, job_id_b: jobIdB }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function postCompareMulti(jobIds: string[]) {
  const res = await req(`${BASE}/compare/multi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_ids: jobIds }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function fetchJobs() {
  const res = await req(`${BASE}/jobs`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function cancelJob(jobId: string): Promise<void> {
  await req(`${BASE}/fetch/${jobId}/cancel`, { method: 'POST' }).catch(() => {})
}

export async function renameJob(jobId: string, label: string): Promise<void> {
  await req(`${BASE}/jobs/${jobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  })
}

export async function deleteJob(jobId: string): Promise<void> {
  await req(`${BASE}/jobs/${jobId}`, { method: 'DELETE' })
}

/** Re-run a job with its original fetch parameters, returning the new job. */
export async function refreshJob(jobId: string, token?: string): Promise<{ job_id: string; refreshed_from: string }> {
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await req(`${BASE}/jobs/${jobId}/refresh`, { method: 'POST', headers })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function updateJobTags(jobId: string, tags: string[]): Promise<void> {
  await req(`${BASE}/jobs/${jobId}/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  })
}

// ---------------------------------------------------------------------------
// Auth (GitHub OAuth)
// ---------------------------------------------------------------------------

import type { AuthUser } from '../types'

/** Open the GitHub OAuth popup. Returns the popup window (or null if blocked). */
export function openAuthPopup(): Window | null {
  const w = 600, h = 700
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2)
  const top = Math.round(window.screenY + (window.outerHeight - h) / 2)
  const loginUrl = `${BASE}/auth/login`
  return window.open(
    loginUrl,
    'github-oauth',
    `popup,width=${w},height=${h},left=${left},top=${top}`,
  )
}

/** Fetch the currently authenticated user, or null if not logged in. */
export async function fetchAuthMe(): Promise<AuthUser | null> {
  const res = await req(`${BASE}/auth/me`, { credentials: 'include' })
  if (!res.ok) return null
  const data = await res.json()
  if (!data.authenticated) return null
  return { login: data.login, name: data.name ?? null, avatar_url: data.avatar_url ?? null }
}

/** Log out the current session. */
export async function logoutAuth(): Promise<void> {
  await req(`${BASE}/auth/logout`, { method: 'POST', credentials: 'include' })
}
