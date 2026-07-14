/**
 * errors.test.ts — Unit tests for src/utils/errors.ts
 */
import { describe, expect, it } from 'vitest'
import { friendlyFetchError } from '../../../frontend/src/utils/errors'

describe('friendlyFetchError', () => {
  it('maps HTTP 401 to an authentication failure message', () => {
    const msg = friendlyFetchError('HTTP 401')
    expect(msg.toLowerCase()).toContain('authentication failed')
    expect(msg).toContain('github.com/settings/tokens')
  })

  it('maps "Unauthorized" (case-insensitive) to auth failure', () => {
    const msg = friendlyFetchError('Unauthorized')
    expect(msg.toLowerCase()).toContain('authentication failed')
  })

  it('maps "bad credentials" to auth failure', () => {
    const msg = friendlyFetchError('Bad credentials')
    expect(msg.toLowerCase()).toContain('authentication failed')
  })

  it('maps rate limit message to rate-limit advice', () => {
    const msg = friendlyFetchError('403 rate limit exceeded')
    expect(msg.toLowerCase()).toContain('rate limit')
    expect(msg).toContain('5,000')
  })

  it('maps HTTP 429 to secondary rate limit message', () => {
    const msg = friendlyFetchError('HTTP 429')
    expect(msg.toLowerCase()).toContain('rate limit')
  })

  it('maps "secondary rate limit" to secondary rate limit message', () => {
    const msg = friendlyFetchError('secondary rate limit triggered')
    expect(msg.toLowerCase()).toContain('secondary rate limit')
  })

  it('maps HTTP 403 without rate-limit context to access-denied message', () => {
    const msg = friendlyFetchError('HTTP 403', 'acme', 'private-repo')
    expect(msg.toLowerCase()).toContain('access denied')
    expect(msg).toContain('acme/private-repo')
  })

  it('maps HTTP 404 to not-found message with owner/repo', () => {
    const msg = friendlyFetchError('HTTP 404', 'octocat', 'nonexistent')
    expect(msg.toLowerCase()).toContain('repository not found')
    expect(msg).toContain('octocat/nonexistent')
  })

  it('maps "repository not found" string to not-found message', () => {
    const msg = friendlyFetchError('Repository not found')
    expect(msg.toLowerCase()).toContain('repository not found')
  })

  it('maps HTTP 422 to invalid-request message', () => {
    const msg = friendlyFetchError('HTTP 422')
    expect(msg.toLowerCase()).toContain('invalid request')
  })

  it('maps HTTP 503 to temporary-unavailability message', () => {
    const msg = friendlyFetchError('HTTP 503')
    expect(msg.toLowerCase()).toContain('temporarily unavailable')
  })

  it('maps "Failed to fetch" to backend-unreachable message', () => {
    const msg = friendlyFetchError('Failed to fetch')
    expect(msg.toLowerCase()).toContain('could not reach')
  })

  it('maps "Load failed" (Safari network error) to backend-unreachable message', () => {
    const msg = friendlyFetchError('Load failed')
    expect(msg.toLowerCase()).toContain('could not reach')
  })

  it('maps "ECONNREFUSED" to backend-unreachable message', () => {
    const msg = friendlyFetchError('connect ECONNREFUSED 127.0.0.1:8000')
    expect(msg.toLowerCase()).toContain('could not reach')
  })

  it('returns the original message when no pattern matches', () => {
    const raw = 'Some completely unknown error occurred'
    expect(friendlyFetchError(raw)).toBe(raw)
  })

  it('omits owner/repo from 404 message when not provided', () => {
    const msg = friendlyFetchError('HTTP 404')
    expect(msg.toLowerCase()).toContain('repository not found')
    expect(msg).not.toContain('undefined')
  })
})
