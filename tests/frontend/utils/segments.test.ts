/**
 * segments.test.ts — saved filter segments (localStorage-backed).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  EMPTY_FILTERS,
  activeFilterCount,
  deleteSegment,
  loadSegments,
  saveSegment,
  type FilterState,
} from '../../../frontend/src/utils/segments'

const LONDON: FilterState = { ...EMPTY_FILTERS, location: 'London' }
const BOTS: FilterState = { ...EMPTY_FILTERS, hideBots: true }

describe('saved segments', () => {
  beforeEach(() => localStorage.clear())

  it('starts empty', () => {
    expect(loadSegments()).toEqual([])
  })

  it('round-trips a saved segment through localStorage', () => {
    saveSegment('London devs', LONDON, [])
    expect(loadSegments()).toEqual([{ name: 'London devs', filters: LONDON }])
  })

  it('puts the newest segment first', () => {
    const one = saveSegment('first', LONDON, [])
    const two = saveSegment('second', BOTS, one)
    expect(two.map(s => s.name)).toEqual(['second', 'first'])
  })

  it('replaces a segment with the same name, case-insensitively', () => {
    const prev = saveSegment('Team', LONDON, [])
    const next = saveSegment('team', BOTS, prev)
    expect(next).toHaveLength(1)
    expect(next[0].filters).toEqual(BOTS)
  })

  it('ignores a blank name', () => {
    expect(saveSegment('   ', LONDON, [])).toEqual([])
  })

  it('trims whitespace around the name', () => {
    expect(saveSegment('  spaced  ', LONDON, [])[0].name).toBe('spaced')
  })

  it('deletes by exact name', () => {
    const prev = saveSegment('gone', LONDON, saveSegment('kept', BOTS, []))
    expect(deleteSegment('gone', prev).map(s => s.name)).toEqual(['kept'])
  })

  it('caps the stored list at 20', () => {
    let segments = loadSegments()
    for (let i = 0; i < 25; i++) segments = saveSegment(`seg-${i}`, LONDON, segments)
    expect(segments).toHaveLength(20)
    expect(segments[0].name).toBe('seg-24')
  })

  it('survives corrupt storage', () => {
    localStorage.setItem('repo-people-segments', 'not json')
    expect(loadSegments()).toEqual([])
  })
})

describe('activeFilterCount', () => {
  it('counts nothing for an empty filter state', () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0)
  })

  it('counts each populated field', () => {
    expect(activeFilterCount({
      ...EMPTY_FILTERS, location: 'London', company: 'ACME', hideBots: true,
    })).toBe(3)
  })

  it('does not count hideBots when it is false', () => {
    expect(activeFilterCount({ ...EMPTY_FILTERS, hideBots: false })).toBe(0)
  })
})
