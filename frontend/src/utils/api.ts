// In development, BASE is empty and Vite proxies API calls to localhost:8000.
// In production builds, VITE_API_BASE_URL points at the Cloud Run service URL.
const BASE = import.meta.env.VITE_API_BASE_URL ?? ''

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
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    logHttpError(url, res.status, res.statusText, err)
    throw new Error(err.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export async function fetchResults(jobId: string): Promise<Record<string, unknown>> {
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
  if (data && typeof data === 'object' && 'users' in data) {
    const allUsers: Record<string, unknown> = { ...data.users }
    const totalPages: number = data.pages ?? 1
    for (let page = 2; page <= totalPages; page++) {
      const pageRes = await fetch(`${url}?page=${page}`)
      if (!pageRes.ok) break
      const pageData = await pageRes.json()
      Object.assign(allUsers, pageData.users ?? {})
    }
    return allUsers
  }
  return data
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
  const url = `${BASE}/results/${jobId}/summary`
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => undefined)
    logHttpError(url, res.status, res.statusText, body)
    throw new Error(body?.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
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
