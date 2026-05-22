// In development, BASE is empty and Vite proxies API calls to localhost:8000.
// In production builds, VITE_API_BASE_URL points at the Cloud Run service URL.
const BASE = import.meta.env.VITE_API_BASE_URL ?? ''

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
  const res = await fetch(url, {
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

export async function fetchResults(jobId: string): Promise<Record<string, unknown>> {
  // C1: Return from session-storage cache when available (TTL = 5 min).
  const cacheKey = `rp:${jobId}:results`
  const cached = cacheGet<Record<string, unknown>>(cacheKey)
  if (cached) return cached

  // P3: Backend now returns paginated response. Transparently fetch all pages.
  const url = `${BASE}/results/${jobId}`
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => undefined)
    logHttpError(url, res.status, res.statusText, body)
    throw new Error(body?.detail ?? `HTTP ${res.status}`)
  }
  const data = await res.json()
  // Merge all pages into a flat dict keyed by login.
  let result: Record<string, unknown>
  if (data && typeof data === 'object' && 'users' in data) {
    const allUsers: Record<string, unknown> = { ...data.users }
    const totalPages: number = data.pages ?? 1
    for (let page = 2; page <= totalPages; page++) {
      const pageRes = await fetch(`${url}?page=${page}`)
      if (!pageRes.ok) break
      const pageData = await pageRes.json()
      Object.assign(allUsers, pageData.users ?? {})
    }
    result = allUsers
  } else {
    result = data
  }
  cacheSet(cacheKey, result)
  return result
}

/** Fetch a single page of results — used for incremental "load more" UX. */
export async function fetchResultsPage(
  jobId: string,
  page: number,
  pageSize: number = 200,
): Promise<{ users: Record<string, unknown>; total: number; page: number; pages: number }> {
  const url = `${BASE}/results/${jobId}?page=${page}&page_size=${pageSize}`
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => undefined)
    logHttpError(url, res.status, res.statusText, body)
    throw new Error(body?.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

/** Create a short-lived (24h) shareable read token for a job. */
export async function createShareToken(jobId: string): Promise<{ token: string; url: string; expires_at: string }> {
  const url = `${BASE}/results/${jobId}/share`
  const res = await fetch(url, { method: 'POST' })
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
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function postImport(data: Record<string, unknown>): Promise<{ job_id: string; total_imported: number }> {
  const res = await fetch(`${BASE}/import`, {
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
  const res = await fetch(url)
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
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => undefined)
    logHttpError(url, res.status, res.statusText, body)
    throw new Error(body?.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function postCompare(jobIdA: string, jobIdB: string) {
  const res = await fetch(`${BASE}/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id_a: jobIdA, job_id_b: jobIdB }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function postCompareMulti(jobIds: string[]) {
  const res = await fetch(`${BASE}/compare/multi`, {
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
  const res = await fetch(`${BASE}/jobs`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function cancelJob(jobId: string): Promise<void> {
  await fetch(`${BASE}/fetch/${jobId}/cancel`, { method: 'POST' }).catch(() => {})
}

export async function renameJob(jobId: string, label: string): Promise<void> {
  await fetch(`${BASE}/jobs/${jobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  })
}

export async function deleteJob(jobId: string): Promise<void> {
  await fetch(`${BASE}/jobs/${jobId}`, { method: 'DELETE' })
}

export async function updateJobTags(jobId: string, tags: string[]): Promise<void> {
  await fetch(`${BASE}/jobs/${jobId}/tags`, {
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
  const res = await fetch(`${BASE}/auth/me`, { credentials: 'include' })
  if (!res.ok) return null
  const data = await res.json()
  if (!data.authenticated) return null
  return { login: data.login, name: data.name ?? null, avatar_url: data.avatar_url ?? null }
}

/** Log out the current session. */
export async function logoutAuth(): Promise<void> {
  await fetch(`${BASE}/auth/logout`, { method: 'POST', credentials: 'include' })
}
