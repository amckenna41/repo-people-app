/**
 * api.test.ts — Unit tests for src/utils/api.ts
 *
 * Uses vitest-fetch-mock to stub window.fetch. Each test asserts on the
 * correct URL, method, headers, body, and return value / thrown error.
 */
import { beforeEach, describe, expect, it } from 'vitest'

// vitest-fetch-mock is initialised in setup.ts and exposed as globalThis.fetchMocker
const fetchMocker = (globalThis as any).fetchMocker
import {
  cancelJob,
  deleteJob,
  fetchJobs,
  fetchResults,
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
// fetchResults
// ---------------------------------------------------------------------------

describe('fetchResults', () => {
  it('calls GET /results/{id}', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({
      users: { alice: { login: 'alice' } }, total: 1, page: 1, page_size: 200, pages: 1,
    }))
    await fetchResults('job-1')
    expect(new URL(fetchMocker.requests()[0].url).pathname).toBe('/results/job-1')
    expect(fetchMocker.requests()[0].method).toBe('GET')
  })

  it('returns flat user dict from paginated response', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({
      users: { alice: { login: 'alice', followers: 10 } }, total: 1, page: 1, page_size: 200, pages: 1,
    }))
    const data = await fetchResults('job-1')
    expect((data as any).alice.followers).toBe(10)
  })

  it('merges multiple pages into a single dict', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({
      users: { alice: { login: 'alice' } }, total: 2, page: 1, page_size: 1, pages: 2,
    }))
    fetchMocker.mockResponseOnce(JSON.stringify({
      users: { bob: { login: 'bob' } }, total: 2, page: 2, page_size: 1, pages: 2,
    }))
    const data = await fetchResults('job-1')
    expect(Object.keys(data)).toContain('alice')
    expect(Object.keys(data)).toContain('bob')
  })

  it('throws with detail on non-ok', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({ detail: 'Job status: pending' }), { status: 409 })
    await expect(fetchResults('job-1')).rejects.toThrow('Job status: pending')
  })

  it('returns cached result on second call without fetching', async () => {
    fetchMocker.mockResponseOnce(JSON.stringify({
      users: { alice: { login: 'alice' } }, total: 1, page: 1, page_size: 200, pages: 1,
    }))
    await fetchResults('job-cached')
    const requestCountAfterFirst = fetchMocker.requests().length
    await fetchResults('job-cached') // should hit cache
    expect(fetchMocker.requests().length).toBe(requestCountAfterFirst) // no new request
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
    // Populate cache via real function calls
    fetchMocker.mockResponseOnce(JSON.stringify({
      users: { alice: { login: 'alice' } }, total: 1, page: 1, page_size: 200, pages: 1,
    }))
    fetchMocker.mockResponseOnce(JSON.stringify({ total: 1 }))
    await fetchResults('job-del')
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
