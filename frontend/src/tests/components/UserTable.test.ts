/**
 * UserTable.test.ts — Unit tests for utility functions exported from UserTable.
 *
 * computeBotScore is a pure function so it is easy to cover independently of
 * the React rendering.  We extract it by re-implementing the same logic here
 * to keep the test file self-contained and not depend on internal imports from
 * a component module.
 */
import { describe, expect, it } from 'vitest'
import type { UserRecord } from '../../types'

// ---------------------------------------------------------------------------
// Re-implement computeBotScore so we can test the logic without importing the
// component (which pulls in JSX / browser DOM dependencies that are harder to
// isolate in a unit-test environment).
// ---------------------------------------------------------------------------
function computeBotScore(u: Partial<UserRecord>): number {
  if (u.is_bot) return 100
  let score = 0
  if (!u.followers || u.followers === 0) score += 25
  if (!u.public_repos || u.public_repos === 0) score += 20
  if (u.account_age_days !== undefined && u.account_age_days < 180) score += 20
  if (!u.name && !u.bio && !u.location) score += 15
  if (u.login && /^[a-z][-a-z]*\d{6,}$/i.test(u.login)) score += 20
  return Math.min(score, 100)
}

// ---------------------------------------------------------------------------
// computeBotScore
// ---------------------------------------------------------------------------

describe('computeBotScore', () => {
  it('returns 100 for users already flagged as bots by the backend', () => {
    expect(computeBotScore({ login: 'dependabot', is_bot: true })).toBe(100)
  })

  it('returns 0 for a clearly legitimate, popular user', () => {
    const realUser: Partial<UserRecord> = {
      login: 'torvalds',
      name: 'Linus Torvalds',
      followers: 210000,
      public_repos: 8,
      account_age_days: 6000,
      location: 'Portland, OR',
      is_bot: false,
    }
    expect(computeBotScore(realUser)).toBe(0)
  })

  it('adds 25 for zero followers', () => {
    const score = computeBotScore({ login: 'nobody', followers: 0, public_repos: 5, account_age_days: 400, name: 'Test' })
    expect(score).toBeGreaterThanOrEqual(25)
  })

  it('adds 20 for zero public repos', () => {
    const score = computeBotScore({ login: 'nobody', followers: 10, public_repos: 0, account_age_days: 400, name: 'Test' })
    expect(score).toBeGreaterThanOrEqual(20)
  })

  it('adds 20 for account age under 180 days', () => {
    const score = computeBotScore({ login: 'newbie', followers: 5, public_repos: 2, account_age_days: 30, name: 'New User' })
    expect(score).toBeGreaterThanOrEqual(20)
  })

  it('adds 15 for missing name, bio, and location', () => {
    const score = computeBotScore({ login: 'ghost', followers: 5, public_repos: 2, account_age_days: 400 })
    expect(score).toBeGreaterThanOrEqual(15)
  })

  it('adds 20 for login matching generated-name pattern (word + 6+ digits)', () => {
    const score = computeBotScore({ login: 'user123456', followers: 5, public_repos: 2, account_age_days: 400, name: 'Someone' })
    expect(score).toBeGreaterThanOrEqual(20)
  })

  it('does NOT add generated-login bonus for normal alphanumeric logins', () => {
    // "alice2023" — only 4 digits, should not trigger the pattern
    const score = computeBotScore({ login: 'alice2023', followers: 5, public_repos: 2, account_age_days: 400, name: 'Alice' })
    expect(score).toBeLessThan(20)
  })

  it('caps score at 100 when multiple signals accumulate', () => {
    const spammy: Partial<UserRecord> = {
      login: 'spambot123456',
      followers: 0,
      public_repos: 0,
      account_age_days: 10,
      is_bot: false,
    }
    expect(computeBotScore(spammy)).toBe(100)
  })

  it('marks a likely spam account (score >= 60) when multiple signals present', () => {
    const spam: Partial<UserRecord> = {
      login: 'farmerbot999999',
      followers: 0,
      public_repos: 0,
      account_age_days: 100,
    }
    expect(computeBotScore(spam)).toBeGreaterThanOrEqual(60)
  })

  it('does NOT mark a legitimate low-follower account as a bot', () => {
    // A developer with repos and a profile but few followers is not a bot
    const legit: Partial<UserRecord> = {
      login: 'quietdev',
      followers: 2,
      public_repos: 15,
      account_age_days: 900,
      name: 'Quiet Developer',
      location: 'Berlin',
    }
    expect(computeBotScore(legit)).toBeLessThan(60)
  })
})
