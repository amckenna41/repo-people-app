/**
 * localResults.test.ts — client-side filter/sort/summary for shared links.
 *
 * A `#share=TOKEN` recipient holds the rows but has no backend job, so
 * /results/{id} and /summary 404 and the entire Results block (gated behind
 * `summary &&`) never rendered. These functions replace that round trip, so
 * they must agree with backend/main.py's `_filter_sort_users` and `get_summary`.
 */
import { describe, expect, it } from 'vitest'
import { filterAndSortUsers, computeSummary } from '../../../frontend/src/utils/localResults'
import { EMPTY_FILTERS } from '../../../frontend/src/utils/segments'
import type { UserRecord } from '../../../frontend/src/types'

const u = (over: Partial<UserRecord> & { login: string }): UserRecord => ({ ...over })

const USERS: UserRecord[] = [
  u({ login: 'alice', name: 'Alice A', company: 'ACME', location: 'London',
      followers: 200, public_repos: 30, account_age_days: 3650,
      created_at: '2015-01-01T00:00:00Z', roles: ['contributors', 'stargazers'],
      location_normalized: 'United Kingdom', company_normalized: 'ACME' }),
  u({ login: 'bob', name: 'Bob B', company: 'Globex', location: 'New York',
      followers: 50, public_repos: 8, account_age_days: 730,
      created_at: '2022-06-01T00:00:00Z', roles: ['stargazers'],
      location_normalized: 'United States', company_normalized: 'Globex' }),
  u({ login: 'spam123456', followers: 0, public_repos: 0, account_age_days: 10,
      created_at: '2026-01-01T00:00:00Z', roles: ['stargazers'] }),
]

describe('filterAndSortUsers', () => {
  const base = { ...EMPTY_FILTERS }

  it('returns everything when nothing is set', () => {
    expect(filterAndSortUsers(USERS, base, '')).toHaveLength(3)
  })

  it('searches across login, name, company, location and bio', () => {
    expect(filterAndSortUsers(USERS, base, 'acme').map(x => x.login)).toEqual(['alice'])
    expect(filterAndSortUsers(USERS, base, 'new york').map(x => x.login)).toEqual(['bob'])
    expect(filterAndSortUsers(USERS, base, 'ALICE').map(x => x.login)).toEqual(['alice'])
  })

  it('filters by location and company substrings', () => {
    expect(filterAndSortUsers(USERS, { ...base, location: 'lond' }, '').map(x => x.login))
      .toEqual(['alice'])
    expect(filterAndSortUsers(USERS, { ...base, company: 'globex' }, '').map(x => x.login))
      .toEqual(['bob'])
  })

  it('applies follower bounds inclusively', () => {
    expect(filterAndSortUsers(USERS, { ...base, minFollowers: '50' }, '')).toHaveLength(2)
    expect(filterAndSortUsers(USERS, { ...base, maxFollowers: '50' }, '')).toHaveLength(2)
    expect(filterAndSortUsers(USERS, { ...base, minFollowers: '50', maxFollowers: '50' }, '')
      .map(x => x.login)).toEqual(['bob'])
  })

  it('filters by join date', () => {
    expect(filterAndSortUsers(USERS, { ...base, joinedAfter: '2020-01-01' }, '')
      .map(x => x.login)).toEqual(['bob', 'spam123456'])
    expect(filterAndSortUsers(USERS, { ...base, joinedBefore: '2020-01-01' }, '')
      .map(x => x.login)).toEqual(['alice'])
  })

  it('keeps users with no created_at, matching the server', () => {
    const rows = filterAndSortUsers([u({ login: 'x' })], { ...base, joinedAfter: '2020-01-01' }, '')
    expect(rows.map(r => r.login)).toEqual(['x'])
  })

  it('hides likely bots when asked', () => {
    const rows = filterAndSortUsers(USERS, { ...base, hideBots: true }, '')
    expect(rows.map(x => x.login)).not.toContain('spam123456')
    expect(rows).toHaveLength(2)
  })

  it('sorts numerically in both directions', () => {
    expect(filterAndSortUsers(USERS, base, '', 'followers', 'desc').map(x => x.login))
      .toEqual(['alice', 'bob', 'spam123456'])
    expect(filterAndSortUsers(USERS, base, '', 'followers', 'asc').map(x => x.login))
      .toEqual(['spam123456', 'bob', 'alice'])
  })

  it('sorts strings case-insensitively', () => {
    const rows = filterAndSortUsers(
      [u({ login: 'b', name: 'zeta' }), u({ login: 'a', name: 'Alpha' })],
      base, '', 'name', 'asc',
    )
    expect(rows.map(r => r.login)).toEqual(['a', 'b'])
  })

  it('sorts missing values last in both directions, like the server', () => {
    const rows = [u({ login: 'has', followers: 5 }), u({ login: 'none' })]
    expect(filterAndSortUsers(rows, base, '', 'followers', 'asc').map(r => r.login))
      .toEqual(['has', 'none'])
    expect(filterAndSortUsers(rows, base, '', 'followers', 'desc').map(r => r.login))
      .toEqual(['has', 'none'])
  })

  it('does not mutate its input', () => {
    // The array comes from render-derived state, which React 19 freezes.
    const frozen = Object.freeze([...USERS]) as UserRecord[]
    expect(() => filterAndSortUsers(frozen, base, '', 'followers', 'desc')).not.toThrow()
    expect(frozen[0].login).toBe('alice')
  })

  it('combines filters conjunctively', () => {
    const rows = filterAndSortUsers(USERS, { ...base, minFollowers: '10', location: 'london' }, '')
    expect(rows.map(r => r.login)).toEqual(['alice'])
  })
})

describe('computeSummary', () => {
  it('matches the shape the /summary endpoint returns', () => {
    const s = computeSummary(USERS)
    expect(Object.keys(s).sort()).toEqual([
      'account_age_distribution', 'bots', 'humans',
      'role_distribution', 'top_companies', 'top_locations', 'total',
    ])
  })

  it('counts totals, humans and bots', () => {
    const s = computeSummary([...USERS, u({ login: 'botty', is_bot: true })])
    expect(s.total).toBe(4)
    expect(s.bots).toBe(1)
    expect(s.humans).toBe(3)
  })

  it('prefers the normalised location and company', () => {
    const s = computeSummary(USERS)
    expect(s.top_locations.map(l => l.location)).toContain('United Kingdom')
    expect(s.top_companies.map(c => c.company)).toContain('ACME')
  })

  it('falls back to the raw value when no normalised one exists', () => {
    const s = computeSummary([u({ login: 'x', location: 'Reykjavik', company: 'Solo' })])
    expect(s.top_locations[0]).toEqual({ location: 'Reykjavik', count: 1 })
    expect(s.top_companies[0]).toEqual({ company: 'Solo', count: 1 })
  })

  it('orders locations by count, descending', () => {
    const many = [
      u({ login: 'a', location_normalized: 'X' }),
      u({ login: 'b', location_normalized: 'Y' }),
      u({ login: 'c', location_normalized: 'Y' }),
    ]
    expect(computeSummary(many).top_locations[0]).toEqual({ location: 'Y', count: 2 })
  })

  it('caps the top lists at ten', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      u({ login: `u${i}`, location_normalized: `C${i}` }))
    expect(computeSummary(many).top_locations).toHaveLength(10)
  })

  it('bands account ages the same way the server does', () => {
    const s = computeSummary([
      u({ login: 'a', account_age_days: 100 }),     // <1yr
      u({ login: 'b', account_age_days: 800 }),     // 1-5yr
      u({ login: 'c', account_age_days: 2200 }),    // 5-10yr
      u({ login: 'd', account_age_days: 5000 }),    // >10yr
    ])
    expect(s.account_age_distribution).toEqual({ '<1yr': 1, '1-5yr': 1, '5-10yr': 1, '>10yr': 1 })
  })

  it('counts a user once per role they hold', () => {
    const s = computeSummary(USERS)
    expect(s.role_distribution).toEqual({ contributors: 1, stargazers: 3 })
  })

  it('handles an empty set without dividing by zero', () => {
    const s = computeSummary([])
    expect(s.total).toBe(0)
    expect(s.top_locations).toEqual([])
    expect(s.account_age_distribution['<1yr']).toBe(0)
  })
})
