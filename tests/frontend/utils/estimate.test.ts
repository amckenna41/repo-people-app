/**
 * estimate.test.ts — pre-flight fetch cost.
 *
 * A self-hosted install can run FETCH_LIMIT=0, which removes the server ceiling
 * entirely; the estimate is what stands between a stray role selection and an
 * hours-long crawl. Numbers are deliberately rough — the tests pin the shape and
 * the boundaries, not the constants.
 */
import { describe, expect, it } from 'vitest'
import {
  estimateFetch,
  humaniseDuration,
  predictUsersFromStars,
  isLargeRun,
  LARGE_RUN_THRESHOLD,
} from '../../../frontend/src/utils/estimate'

const base = { roleCount: 3, perRoleLimit: 100, serverCap: 0, workers: 5, repoCount: 1 }

describe('estimateFetch', () => {
  it('flags an unbounded run when neither cap is set', () => {
    const e = estimateFetch({ ...base, perRoleLimit: null, serverCap: 0 })
    expect(e.unbounded).toBe(true)
    expect(e.users).toBeNull()
    expect(e.seconds).toBeNull()
  })

  it('is not unbounded when the server caps the run', () => {
    const e = estimateFetch({ ...base, perRoleLimit: null, serverCap: 500 })
    expect(e.unbounded).toBe(false)
    expect(e.users).toBe(500)
  })

  it('prefers the server cap over the per-role limit', () => {
    // The server enforces its cap regardless of what the user asked for.
    const e = estimateFetch({ ...base, perRoleLimit: 10_000, serverCap: 500 })
    expect(e.users).toBe(500)
  })

  it('assumes worst-case no overlap between roles', () => {
    const e = estimateFetch({ ...base, perRoleLimit: 100, roleCount: 3, serverCap: 0 })
    expect(e.users).toBe(300)
  })

  it('scales with the number of repositories', () => {
    const one = estimateFetch({ ...base, repoCount: 1 })
    const three = estimateFetch({ ...base, repoCount: 3 })
    expect(three.users).toBe(one.users! * 3)
  })

  it('gets faster with more workers', () => {
    const slow = estimateFetch({ ...base, workers: 1 })
    const fast = estimateFetch({ ...base, workers: 10 })
    expect(fast.seconds!).toBeLessThan(slow.seconds!)
  })

  it('never divides by zero on a nonsensical worker count', () => {
    const e = estimateFetch({ ...base, workers: 0 })
    expect(Number.isFinite(e.seconds!)).toBe(true)
    expect(e.seconds!).toBeGreaterThan(0)
  })

  it('reports API calls as a multiple of profiles', () => {
    const e = estimateFetch({ ...base, perRoleLimit: 100, roleCount: 1 })
    expect(e.apiCalls!).toBeGreaterThan(e.users!)
  })

  it('treats a zero role count as at least one', () => {
    const e = estimateFetch({ ...base, roleCount: 0, perRoleLimit: 100 })
    expect(e.users).toBe(100)
  })
})

describe('humaniseDuration', () => {
  it.each([
    [10, /seconds/],
    [200, /minutes?/],
    [7200, /hours/],
  ])('describes %i seconds in sensible units', (secs, pattern) => {
    expect(humaniseDuration(secs)).toMatch(pattern)
  })

  it('never claims zero seconds', () => {
    expect(humaniseDuration(1)).toMatch(/\d/)
    expect(humaniseDuration(1)).not.toMatch(/\b0 seconds/)
  })

  it('uses the singular for one minute', () => {
    expect(humaniseDuration(60)).not.toContain('minutes')
  })
})

describe('predictUsersFromStars', () => {
  const opts = { roleCount: 3, perRoleLimit: null, serverCap: 0 }

  it('uses the star count as the prediction when nothing caps the run', () => {
    expect(predictUsersFromStars(1200, opts)).toBe(1200)
  })

  it('caps at limit x roles when a per-role limit is set', () => {
    expect(predictUsersFromStars(10_000, { ...opts, perRoleLimit: 100 })).toBe(300)
  })

  it('does not inflate a small repo up to the per-role cap', () => {
    expect(predictUsersFromStars(12, { ...opts, perRoleLimit: 100 })).toBe(12)
  })

  it('respects the server cap', () => {
    expect(predictUsersFromStars(10_000, { ...opts, serverCap: 500 })).toBe(500)
  })

  it('treats a zero-star repo as zero users', () => {
    expect(predictUsersFromStars(0, opts)).toBe(0)
  })
})

describe('isLargeRun', () => {
  it('flags a repo at the star threshold', () => {
    expect(isLargeRun(LARGE_RUN_THRESHOLD, 10)).toBe(true)
  })

  it('flags a run whose predicted users cross the threshold', () => {
    // Few stars can still mean a big run once every role is summed.
    expect(isLargeRun(10, LARGE_RUN_THRESHOLD)).toBe(true)
  })

  it('leaves a small repo alone', () => {
    expect(isLargeRun(3, 3)).toBe(false)
  })

  it('does not flag just below the threshold', () => {
    expect(isLargeRun(LARGE_RUN_THRESHOLD - 1, LARGE_RUN_THRESHOLD - 1)).toBe(false)
  })
})
