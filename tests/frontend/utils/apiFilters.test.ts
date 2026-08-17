/**
 * apiFilters.test.ts — filters are serialised into the results query string.
 */
import { describe, expect, it } from 'vitest'
import { filtersToParams } from '../../../frontend/src/utils/api'

describe('filtersToParams', () => {
  it('produces an empty query for no filters', () => {
    expect(filtersToParams({}).toString()).toBe('')
  })

  it('omits empty strings so unset filters never reach the server', () => {
    expect(filtersToParams({ q: '', location: 'London' }).toString()).toBe('location=London')
  })

  it('omits false booleans but keeps true ones', () => {
    expect(filtersToParams({ hide_bots: false }).toString()).toBe('')
    expect(filtersToParams({ hide_bots: true }).toString()).toBe('hide_bots=true')
  })

  it('omits undefined values', () => {
    expect(filtersToParams({ q: undefined, company: 'ACME' }).toString()).toBe('company=ACME')
  })

  it('carries sorting through', () => {
    const params = filtersToParams({ sort_by: 'followers', sort_dir: 'desc' })
    expect(params.get('sort_by')).toBe('followers')
    expect(params.get('sort_dir')).toBe('desc')
  })

  it('url-encodes values', () => {
    expect(filtersToParams({ company: 'A&B Ltd' }).get('company')).toBe('A&B Ltd')
    expect(filtersToParams({ company: 'A&B Ltd' }).toString()).toBe('company=A%26B+Ltd')
  })

  it('keeps numeric bounds as strings', () => {
    expect(filtersToParams({ min_followers: '100' }).get('min_followers')).toBe('100')
  })
})
