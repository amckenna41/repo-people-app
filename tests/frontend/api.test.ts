/**
 * api.test.ts — Unit tests for src/utils/api.ts
 *
 * Uses vitest-fetch-mock to stub window.fetch. Each test asserts on the
 * correct URL, method, headers, body, and return value / thrown error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vitest-fetch-mock is initialised in setup.ts and exposed as globalThis.fetchMocker
const fetchMocker = (globalThis as any).fetchMocker
import {
  MAX_CLIENT_ROWS,
  validateGitHubToken,
  beaconCancelJob,
  cancelJob,
  fetchAllResultPages,
  deleteJob,
  fetchJobs,
  fetchSummary,
  fetchTop,
  invalidateJobCache,
  postCompare,
  postCompareMulti,
  postFetch,
  postImport,
  renameJob,
  updateJobTags,
} from '../../frontend/src/utils/api'

// ---------------------------------------------------------------------------
// CSRF header
// ---------------------------------------------------------------------------
// Mutating requests must carry X-Requested-With: the backend rejects them
// without it, which is what stops a third-party page driving the API with the
// user's SameSite=None cookies attached.

describe('CSRF header', () => {
  it.each([
    ['postFetch', () => postFetch({ owner: 'a', repo: 'b' })],
    ['postImport', () => postImport({ alice: {} })],
    ['deleteJob', () => deleteJob('job-1')],
    ['renameJob', () => renameJob('job-1', 'new name')],
    ['updateJobTags', () => updateJobTags('job-1', ['x'])],
    ['cancelJob', () => cancelJob('job-1')],
    ['postCompare', () => postCompare('a', 'b')],
  ])('%s sends X-Requested-With', async (_name, call) => {
    fetchMocker.mockResponseOnce(JSON.stringify({}))
    await call()
    expect(fetchMocker.requests()[0].headers.get('X-Requested-With')).toBe('repo-people')
  })

  it('does not send it on GETs, which would cost a preflight', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify([]))
    await fetchJobs()
    const req = fetchMocker.requests()[0]
    expect(req.method).toBe('GET')
    expect(req.headers.get('X-Requested-With')).toBeNull()
  })

  it('postFetch keeps its own headers alongside the CSRF one', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ job_id: 'x' }))
    await postFetch({ owner: 'a', repo: 'b' }, 'tok')
    const req = fetchMocker.requests()[0]
    expect(req.headers.get('Authorization')).toBe('Bearer tok')
    expect(req.headers.get('Content-Type')).toBe('application/json')
    expect(req.headers.get('X-Requested-With')).toBe('repo-people')
  })

  it('beaconCancelJob uses keepalive fetch so it can send the header', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({}))
    beaconCancelJob('job-1')
    const req = fetchMocker.requests()[0]
    expect(req.method).toBe('POST')
    expect(new URL(req.url).pathname).toBe('/fetch/job-1/cancel')
    expect(req.headers.get('X-Requested-With')).toBe('repo-people')
  })
})

// Re-enable fetch mocks and clear the session-storage cache before each test
beforeEach(() => {
  fetchMocker.resetMocks()
  sessionStorage.clear()
})

// ---------------------------------------------------------------------------
// postFetch
// ---------------------------------------------------------------------------

describe('postFetch', () => {
  it('calls POST /fetch with JSON body', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ job_id: 'abc-123' }))
    await postFetch({ owner: 'facebook', repo: 'react' }, 'tok')
    const req = fetchMocker.requests()[0]
    expect(new URL(req.url).pathname).toBe('/fetch')
    expect(req.method).toBe('POST')
    expect(req.headers.get('Content-Type')).toBe('application/json')
  })

  it('sends token as Authorization Bearer header', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ job_id: 'abc-123' }))
    await postFetch({ owner: 'facebook', repo: 'react' }, 'ghp_test')
    const req = fetchMocker.requests()[0]
    expect(req.headers.get('Authorization')).toBe('Bearer ghp_test')
  })

  it('omits Authorization header when no token provided', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ job_id: 'abc-123' }))
    await postFetch({ owner: 'facebook', repo: 'react' })
    const req = fetchMocker.requests()[0]
    expect(req.headers.get('Authorization')).toBeNull()
  })

  it('returns job_id from response', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ job_id: 'abc-123' }))
    const result = await postFetch({ owner: 'facebook', repo: 'react' }, 'tok')
    expect(result.job_id).toBe('abc-123')
  })

  it('throws on non-ok response with detail message', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ detail: 'Forbidden' }), { status: 403 })
    await expect(postFetch({ owner: 'x', repo: 'y' }, 't')).rejects.toThrow('Forbidden')
  })

  it('throws generic HTTP error when no detail field', async () => {
    fetchMocker.mockResponseOnce('{}', { status: 500 })
    await expect(postFetch({ owner: 'x', repo: 'y' }, 't')).rejects.toThrow('HTTP 500')
  })

  it('sends correct JSON body (no token in body)', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ job_id: 'xyz' }))
    await postFetch({ owner: 'octocat', repo: 'hello', limit: 5 }, 'ghp_test')
    const body = JSON.parse(await fetchMocker.requests()[0].text())
    expect(body.owner).toBe('octocat')
    expect(body.repo).toBe('hello')
    expect(body.limit).toBe(5)
    expect(body.token).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// fetchSummary
// ---------------------------------------------------------------------------

describe('fetchSummary', () => {
  it('calls GET /results/{id}/summary', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ total: 3 }))
    await fetchSummary('job-2')
    expect(new URL(fetchMocker.requests()[0].url).pathname).toBe('/results/job-2/summary')
  })

  it('returns summary object', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ total: 3, bots: 1, humans: 2 }))
    const data = await fetchSummary('job-2')
    expect(data.total).toBe(3)
  })

  it('throws on 404', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ detail: 'Job not found' }), { status: 404 })
    await expect(fetchSummary('bad-id')).rejects.toThrow('Job not found')
  })

  it('returns cached result on second call without fetching', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ total: 3, bots: 1, humans: 2 }))
    await fetchSummary('job-cached-sum')
    const requestCountAfterFirst = fetchMocker.requests().length
    await fetchSummary('job-cached-sum') // should hit cache
    expect(fetchMocker.requests().length).toBe(requestCountAfterFirst) // no new request
  })
})

// ---------------------------------------------------------------------------
// fetchTop
// ---------------------------------------------------------------------------

describe('fetchTop', () => {
  it('calls GET /results/{id}/top with correct query params', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify([]))
    await fetchTop('job-3', 'followers', 5)
    const u = new URL(fetchMocker.requests()[0].url)
    expect(u.pathname).toBe('/results/job-3/top')
    expect(u.searchParams.get('by')).toBe('followers')
    expect(u.searchParams.get('n')).toBe('5')
  })

  it('returns array', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify([{ login: 'alice' }]))
    const data = await fetchTop('job-3', 'followers', 1)
    expect(Array.isArray(data)).toBe(true)
    expect(data[0].login).toBe('alice')
  })

  it('throws on 422', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ detail: 'n must be >= 1' }), { status: 422 })
    await expect(fetchTop('job-3', 'followers', 0)).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// postCompare
// ---------------------------------------------------------------------------

describe('postCompare', () => {
  it('calls POST /compare with correct body', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ only_in_a: [], only_in_b: [], in_both: [], stats: {} }))
    await postCompare('job-a', 'job-b')
    const req = fetchMocker.requests()[0]
    expect(new URL(req.url).pathname).toBe('/compare')
    expect(req.method).toBe('POST')
    const body = JSON.parse(await req.text())
    expect(body.job_id_a).toBe('job-a')
    expect(body.job_id_b).toBe('job-b')
  })

  it('returns response data', async () => {
    const payload = { only_in_a: [{ login: 'alice' }], only_in_b: [], in_both: [], stats: { overlap_pct: 0 } }
    fetchMocker.mockResponseOnce(JSON.stringify(payload))
    const data = await postCompare('a', 'b')
    expect(data.only_in_a[0].login).toBe('alice')
  })

  it('throws on non-ok', async () => {
    fetchMocker.mockResponseOnce('{}', { status: 404 })
    await expect(postCompare('x', 'y')).rejects.toThrow('HTTP 404')
  })
})

// ---------------------------------------------------------------------------
// postCompareMulti
// ---------------------------------------------------------------------------

describe('postCompareMulti', () => {
  it('calls POST /compare/multi with job_ids array', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ in_all: [], shared: [], exclusive_per_job: [], stats: {} }))
    await postCompareMulti(['a', 'b', 'c'])
    const body = JSON.parse(await fetchMocker.requests()[0].text())
    expect(body.job_ids).toEqual(['a', 'b', 'c'])
  })

  it('throws with detail on error', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ detail: 'Max 5 job IDs' }), { status: 422 })
    await expect(postCompareMulti(['a', 'b', 'c', 'd', 'e', 'f'])).rejects.toThrow('Max 5 job IDs')
  })
})

// ---------------------------------------------------------------------------
// fetchJobs
// ---------------------------------------------------------------------------

describe('fetchJobs', () => {
  it('calls GET /jobs', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify([]))
    await fetchJobs()
    expect(new URL(fetchMocker.requests()[0].url).pathname).toBe('/jobs')
    expect(fetchMocker.requests()[0].method).toBe('GET')
  })

  it('returns array of jobs', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify([
      { job_id: 'j1', status: 'done', total_fetched: 5, tags: [] },
    ]))
    const data = await fetchJobs()
    expect(Array.isArray(data)).toBe(true)
    expect(data[0].job_id).toBe('j1')
  })

  it('throws on non-ok', async () => {
    fetchMocker.mockResponseOnce('{}', { status: 500 })
    await expect(fetchJobs()).rejects.toThrow('HTTP 500')
  })
})

// ---------------------------------------------------------------------------
// cancelJob
// ---------------------------------------------------------------------------

describe('cancelJob', () => {
  it('calls POST /fetch/{id}/cancel', async () => {
    fetchMocker.mockResponseOnce('{}')
    await cancelJob('job-99')
    expect(new URL(fetchMocker.requests()[0].url).pathname).toBe('/fetch/job-99/cancel')
    expect(fetchMocker.requests()[0].method).toBe('POST')
  })

  it('does not throw on network error (fire-and-forget)', async () => {
    fetchMocker.mockRejectOnce(new Error('network error'))
    // Should not throw
    await expect(cancelJob('job-99')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// renameJob
// ---------------------------------------------------------------------------

describe('renameJob', () => {
  it('calls PATCH /jobs/{id} with label', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ job_id: 'j1', label: 'new name' }))
    await renameJob('j1', 'new name')
    const req = fetchMocker.requests()[0]
    expect(new URL(req.url).pathname).toBe('/jobs/j1')
    expect(req.method).toBe('PATCH')
    const body = JSON.parse(await req.text())
    expect(body.label).toBe('new name')
  })
})

// ---------------------------------------------------------------------------
// deleteJob
// ---------------------------------------------------------------------------

describe('deleteJob', () => {
  it('calls DELETE /jobs/{id}', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ deleted: true }))
    await deleteJob('j1')
    const req = fetchMocker.requests()[0]
    expect(new URL(req.url).pathname).toBe('/jobs/j1')
    expect(req.method).toBe('DELETE')
  })
})

// ---------------------------------------------------------------------------
// updateJobTags
// ---------------------------------------------------------------------------

describe('updateJobTags', () => {
  it('calls PATCH /jobs/{id}/tags with tags array', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ job_id: 'j1', tags: ['production'] }))
    await updateJobTags('j1', ['production'])
    const req = fetchMocker.requests()[0]
    expect(new URL(req.url).pathname).toBe('/jobs/j1/tags')
    expect(req.method).toBe('PATCH')
    const body = JSON.parse(await req.text())
    expect(body.tags).toEqual(['production'])
  })

  it('sends empty array to clear tags', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ job_id: 'j1', tags: [] }))
    await updateJobTags('j1', [])
    const body = JSON.parse(await fetchMocker.requests()[0].text())
    expect(body.tags).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// postImport
// ---------------------------------------------------------------------------

describe('postImport', () => {
  it('calls POST /import with JSON body', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ job_id: 'imp-1', total_imported: 2 }))
    await postImport({ alice: { login: 'alice' }, bob: { login: 'bob' } })
    const req = fetchMocker.requests()[0]
    expect(new URL(req.url).pathname).toBe('/import')
    expect(req.method).toBe('POST')
    expect(req.headers.get('Content-Type')).toBe('application/json')
  })

  it('returns job_id and total_imported', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ job_id: 'imp-1', total_imported: 2 }))
    const result = await postImport({ alice: { login: 'alice' }, bob: { login: 'bob' } })
    expect(result.job_id).toBe('imp-1')
    expect(result.total_imported).toBe(2)
  })

  it('sends the payload as JSON body', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ job_id: 'imp-2', total_imported: 1 }))
    const payload = { alice: { login: 'alice', followers: 10 } }
    await postImport(payload)
    const body = JSON.parse(await fetchMocker.requests()[0].text())
    expect(body.alice.followers).toBe(10)
  })

  it('throws on non-ok response with detail message', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ detail: 'Payload too large — maximum 5 MB' }), { status: 413 })
    await expect(postImport({ alice: { login: 'alice' } })).rejects.toThrow('Payload too large')
  })

  it('throws HTTP error when no detail field', async () => {
    fetchMocker.mockResponseOnce('{}', { status: 500 })
    await expect(postImport({ x: {} })).rejects.toThrow('HTTP 500')
  })
})

// ---------------------------------------------------------------------------
// invalidateJobCache
// ---------------------------------------------------------------------------

describe('invalidateJobCache', () => {
  it('removes cached results and summary for the given job', async () => {
    // Populate cache via a real function call
    fetchMocker.mockResponseOnce(JSON.stringify({ total: 1 }))
    await fetchSummary('job-del')

    // Verify entries are present
    const keysBefore = Object.keys(sessionStorage).filter(k => k.startsWith('rp:job-del:'))
    expect(keysBefore.length).toBeGreaterThan(0)

    invalidateJobCache('job-del')

    const keysAfter = Object.keys(sessionStorage).filter(k => k.startsWith('rp:job-del:'))
    expect(keysAfter.length).toBe(0)
  })

  it('does not remove cache entries for other jobs', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ total: 5 }))
    await fetchSummary('job-keep')

    invalidateJobCache('job-other')

    const keysAfter = Object.keys(sessionStorage).filter(k => k.startsWith('rp:job-keep:'))
    expect(keysAfter.length).toBeGreaterThan(0)
  })
})


// ---------------------------------------------------------------------------
// fetchAllResultPages
// ---------------------------------------------------------------------------
// Charts, the quick-stat badges and every client-side export aggregate the rows
// the view holds. Holding only page one made them silently describe a fraction
// of the result set, so this walk has to reach the last page.

function pageOf(logins: string[], total: number) {
  return JSON.stringify({
    users: Object.fromEntries(logins.map(l => [l, { login: l }])),
    total,
    unfiltered_total: total,
    page: 1,
    pages: 1,
  })
}

describe('fetchAllResultPages', () => {
  it('walks every page and returns the union', async () => {
    fetchMocker.mockResponseOnce(pageOf(['a', 'b'], 4))
    fetchMocker.mockResponseOnce(pageOf(['c', 'd'], 4))
    const rows = await fetchAllResultPages('job-1', {}, { total: 4, pageSize: 2 })
    expect(rows.map(r => r.login)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('deduplicates the first page against the overlapping page 1 refetch', async () => {
    // The view renders 200 rows, then this walks from page 1 at a larger page
    // size — so page 1 necessarily repeats rows already held.
    fetchMocker.mockResponseOnce(pageOf(['a', 'b', 'c'], 3))
    const rows = await fetchAllResultPages('job-1', {}, {
      firstPage: [{ login: 'a' }],
      total: 3,
      pageSize: 3,
    })
    expect(rows.map(r => r.login)).toEqual(['a', 'b', 'c'])
  })

  it('does not stop early when the last page is a partial one', async () => {
    // total=3 with pageSize=2 means page 2 returns a single row; an
    // offset-based loop overshoots here and drops it.
    fetchMocker.mockResponseOnce(pageOf(['a', 'b'], 3))
    fetchMocker.mockResponseOnce(pageOf(['c'], 3))
    const rows = await fetchAllResultPages('job-1', {}, { total: 3, pageSize: 2 })
    expect(rows).toHaveLength(3)
  })

  it('stops at MAX_CLIENT_ROWS rather than loading an unbounded set', async () => {
    const pageSize = MAX_CLIENT_ROWS / 2
    const big = (offset: number) =>
      pageOf(Array.from({ length: pageSize }, (_, i) => `u${offset + i}`), MAX_CLIENT_ROWS * 10)
    fetchMocker.mockResponseOnce(big(0))
    fetchMocker.mockResponseOnce(big(pageSize))
    const rows = await fetchAllResultPages('job-1', {}, {
      total: MAX_CLIENT_ROWS * 10,
      pageSize,
    })
    expect(rows).toHaveLength(MAX_CLIENT_ROWS)
    expect(fetchMocker.requests()).toHaveLength(2)
  })

  it('abandons the walk when shouldContinue goes false', async () => {
    // The view bumps a token on every new query; a walk for a superseded query
    // must not keep fetching or emit rows into the newer one.
    fetchMocker.mockResponseOnce(pageOf(['a'], 3))
    let live = true
    const onPage = vi.fn(() => { live = false })
    const rows = await fetchAllResultPages('job-1', {}, {
      total: 3, pageSize: 1, shouldContinue: () => live, onPage,
    })
    expect(rows.map(r => r.login)).toEqual(['a'])
    expect(fetchMocker.requests()).toHaveLength(1)
  })

  it('reports progress after each page so the table fills in as it loads', async () => {
    fetchMocker.mockResponseOnce(pageOf(['a'], 2))
    fetchMocker.mockResponseOnce(pageOf(['b'], 2))
    const sizes: number[] = []
    await fetchAllResultPages('job-1', {}, {
      total: 2, pageSize: 1, onPage: rows => sizes.push(rows.length),
    })
    expect(sizes).toEqual([1, 2])
  })

  it('forwards the active filters to each page request', async () => {
    fetchMocker.mockResponseOnce(pageOf(['a'], 1))
    await fetchAllResultPages('job-1', { q: 'alice', hide_bots: true }, { total: 1, pageSize: 1 })
    const url = new URL(fetchMocker.requests()[0].url)
    expect(url.searchParams.get('q')).toBe('alice')
    expect(url.searchParams.get('hide_bots')).toBe('true')
  })
})


// ---------------------------------------------------------------------------
// validateGitHubToken
// ---------------------------------------------------------------------------
// Talks straight to api.github.com (which sends CORS `*` and exposes the scope
// and rate-limit headers), so no backend endpoint is involved.

function ghResponse(
  body: unknown,
  init: { status?: number; scopes?: string | null; remaining?: string; limit?: string } = {},
) {
  const headers: Record<string, string> = {}
  if (init.scopes !== null) headers['x-oauth-scopes'] = init.scopes ?? 'read:user, public_repo'
  headers['x-ratelimit-limit'] = init.limit ?? '5000'
  headers['x-ratelimit-remaining'] = init.remaining ?? '4999'
  return [JSON.stringify(body), { status: init.status ?? 200, headers }] as [string, object]
}

describe('validateGitHubToken', () => {
  it('does not call the network for an empty token', async () => {
    const res = await validateGitHubToken('   ')
    expect(res.valid).toBe(false)
    expect(fetchMocker.requests()).toHaveLength(0)
  })

  it('calls GitHub with a Bearer header and no cookies', async () => {
    fetchMocker.mockResponseOnce(...ghResponse({ login: 'octocat' }))
    await validateGitHubToken('ghp_abc')
    const req = fetchMocker.requests()[0]
    expect(req.url).toBe('https://api.github.com/user')
    expect(req.headers.get('Authorization')).toBe('Bearer ghp_abc')
    // Our own API's cookie/CSRF machinery must not leak to github.com.
    expect(req.credentials).not.toBe('include')
    expect(req.headers.get('X-Requested-With')).toBeNull()
  })

  it('reports a valid classic token with login, scopes and rate limit', async () => {
    fetchMocker.mockResponseOnce(...ghResponse({ login: 'octocat' }))
    const res = await validateGitHubToken('ghp_abc')
    expect(res.valid).toBe(true)
    expect(res.login).toBe('octocat')
    expect(res.scopes).toEqual(['read:user', 'public_repo'])
    expect(res.missingScopes).toEqual([])
    expect(res.rateLimit).toEqual({ limit: 5000, remaining: 4999 })
  })

  it('flags a required scope the token is missing', async () => {
    fetchMocker.mockResponseOnce(...ghResponse({ login: 'octocat' }, { scopes: 'read:user' }))
    const res = await validateGitHubToken('ghp_abc')
    expect(res.valid).toBe(true)
    expect(res.missingScopes).toEqual(['public_repo'])
  })

  it('treats a token with no classic scopes as fine-grained, not as missing scopes', async () => {
    // Fine-grained PATs and App tokens report an empty scope header. Warning
    // "missing public_repo" there would be wrong — the token may work fine.
    fetchMocker.mockResponseOnce(...ghResponse({ login: 'octocat' }, { scopes: '' }))
    const res = await validateGitHubToken('github_pat_abc')
    expect(res.valid).toBe(true)
    expect(res.fineGrained).toBe(true)
    expect(res.missingScopes).toEqual([])
  })

  it('treats an absent scope header the same way', async () => {
    fetchMocker.mockResponseOnce(...ghResponse({ login: 'octocat' }, { scopes: null }))
    const res = await validateGitHubToken('github_pat_abc')
    expect(res.fineGrained).toBe(true)
    expect(res.missingScopes).toEqual([])
  })

  it('reports an expired or invalid token on 401', async () => {
    fetchMocker.mockResponseOnce(...ghResponse({ message: 'Bad credentials' }, { status: 401 }))
    const res = await validateGitHubToken('ghp_bad')
    expect(res.valid).toBe(false)
    expect(res.error).toMatch(/invalid or has expired/i)
  })

  it('distinguishes a rate-limited 403 from a refused one', async () => {
    fetchMocker.mockResponseOnce(...ghResponse({}, { status: 403, remaining: '0' }))
    const limited = await validateGitHubToken('ghp_abc')
    expect(limited.valid).toBe(false)
    expect(limited.error).toMatch(/rate limit/i)

    fetchMocker.mockResponseOnce(...ghResponse({}, { status: 403, remaining: '100' }))
    const refused = await validateGitHubToken('ghp_abc')
    expect(refused.valid).toBe(false)
    expect(refused.error).toMatch(/refused/i)
  })

  it('does not claim a rate limit when GitHub sends no rate-limit headers', async () => {
    // A real 401 carries none, and Number(null) is 0 — so an absent header must
    // not be read as "zero requests remaining".
    fetchMocker.mockResponseOnce(JSON.stringify({ message: 'Forbidden' }), { status: 403 })
    const res = await validateGitHubToken('ghp_abc')
    expect(res.valid).toBe(false)
    expect(res.rateLimit).toBeUndefined()
    expect(res.error).toMatch(/refused/i)
    expect(res.error).not.toMatch(/rate limit/i)
  })

  it('omits rateLimit entirely when the headers are absent on a 401', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
    const res = await validateGitHubToken('ghp_bad')
    expect(res.rateLimit).toBeUndefined()
  })

  it('surfaces an unexpected status rather than claiming validity', async () => {
    fetchMocker.mockResponseOnce(...ghResponse({}, { status: 500 }))
    const res = await validateGitHubToken('ghp_abc')
    expect(res.valid).toBe(false)
    expect(res.error).toMatch(/HTTP 500/)
  })

  it('handles a network failure without throwing', async () => {
    fetchMocker.mockRejectOnce(new Error('Failed to fetch'))
    const res = await validateGitHubToken('ghp_abc')
    expect(res.valid).toBe(false)
    expect(res.error).toMatch(/Could not reach GitHub/i)
  })

  it('trims surrounding whitespace before sending', async () => {
    fetchMocker.mockResponseOnce(...ghResponse({ login: 'octocat' }))
    await validateGitHubToken('  ghp_abc  ')
    expect(fetchMocker.requests()[0].headers.get('Authorization')).toBe('Bearer ghp_abc')
  })
})
