// Client-side equivalents of the server's results pipeline, for result sets the
// browser already holds and cannot re-fetch.
//
// The only such case today is a shared link (`#share=TOKEN`): the recipient
// receives the users from `GET /share/{token}` but has no job of their own, so
// `/results/{id}` and `/results/{id}/summary` would 404 and the whole Results
// view would refuse to render.
//
// These mirror `_filter_sort_users()` and `get_summary()` in backend/main.py.
// Keep them in step: a divergence shows up as a shared link disagreeing with the
// original.

import type { SummaryData, UserRecord } from '../types'
import type { FilterState } from './segments'

/** Same heuristic as the server's `_bot_score` / UserTable's `computeBotScore`. */
const BOT_LOGIN_RE = /^[a-z][-a-z]*\d{6,}$/i

function botScore(u: UserRecord): number {
  if (u.is_bot) return 100
  let score = 0
  if (!u.followers) score += 25
  if (!u.public_repos) score += 20
  if (u.account_age_days !== undefined && u.account_age_days < 180) score += 20
  if (!u.name && !u.bio && !u.location) score += 15
  if (u.login && BOT_LOGIN_RE.test(u.login)) score += 20
  return Math.min(score, 100)
}

const SEARCH_FIELDS = ['login', 'name', 'company', 'location', 'bio'] as const

function includes(value: unknown, needle: string): boolean {
  return String(value ?? '').toLowerCase().includes(needle)
}

/** Apply the same filters and sort the server would, over a local array. */
export function filterAndSortUsers(
  users: UserRecord[],
  filters: FilterState,
  search: string,
  sortBy?: string,
  sortDir: 'asc' | 'desc' = 'asc',
): UserRecord[] {
  let rows = users

  const q = search.trim().toLowerCase()
  if (q) rows = rows.filter(u => SEARCH_FIELDS.some(f => includes(u[f], q)))

  const loc = filters.location.trim().toLowerCase()
  if (loc) rows = rows.filter(u => includes(u.location, loc))

  const co = filters.company.trim().toLowerCase()
  if (co) rows = rows.filter(u => includes(u.company, co))

  if (filters.minFollowers !== '') {
    const min = Number(filters.minFollowers)
    if (Number.isFinite(min)) rows = rows.filter(u => (u.followers ?? 0) >= min)
  }
  if (filters.maxFollowers !== '') {
    const max = Number(filters.maxFollowers)
    if (Number.isFinite(max)) rows = rows.filter(u => (u.followers ?? 0) <= max)
  }
  // A user with no created_at is kept, matching the server.
  if (filters.joinedAfter) {
    rows = rows.filter(u => !u.created_at || String(u.created_at).slice(0, 10) >= filters.joinedAfter)
  }
  if (filters.joinedBefore) {
    rows = rows.filter(u => !u.created_at || String(u.created_at).slice(0, 10) <= filters.joinedBefore)
  }
  if (filters.hideBots) rows = rows.filter(u => botScore(u) < 60)

  if (sortBy) {
    const key = sortBy as keyof UserRecord
    // Copy first: sort() mutates, and `users` may be render-derived state.
    rows = [...rows].sort((a, b) => {
      const av = a[key]
      const bv = b[key]
      // Missing values sort last in both directions, as the server does.
      const aMissing = av === null || av === undefined
      const bMissing = bv === null || bv === undefined
      if (aMissing || bMissing) return aMissing && bMissing ? 0 : aMissing ? 1 : -1
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).toLowerCase().localeCompare(String(bv).toLowerCase())
      return sortDir === 'desc' ? -cmp : cmp
    })
  }
  return rows
}

/** Recreate the `/results/{id}/summary` payload from users held locally. */
export function computeSummary(users: UserRecord[]): SummaryData {
  const humans = users.filter(u => !u.is_bot).length

  const tally = (pick: (u: UserRecord) => string | undefined) => {
    const counts = new Map<string, number>()
    for (const u of users) {
      const key = pick(u)
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  }

  const bands: Record<string, number> = { '<1yr': 0, '1-5yr': 0, '5-10yr': 0, '>10yr': 0 }
  for (const u of users) {
    const years = (u.account_age_days ?? 0) / 365.25
    if (years < 1) bands['<1yr']++
    else if (years < 5) bands['1-5yr']++
    else if (years < 10) bands['5-10yr']++
    else bands['>10yr']++
  }

  const roles: Record<string, number> = {}
  for (const u of users) for (const r of u.roles ?? []) roles[r] = (roles[r] ?? 0) + 1

  return {
    total: users.length,
    humans,
    bots: users.length - humans,
    top_locations: tally(u => u.location_normalized || u.location)
      .map(([location, count]) => ({ location, count })),
    top_companies: tally(u => u.company_normalized || u.company)
      .map(([company, count]) => ({ company, count })),
    account_age_distribution: bands,
    role_distribution: roles,
  }
}
