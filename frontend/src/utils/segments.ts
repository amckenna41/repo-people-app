// Saved filter segments — named, reusable sets of table filters.
//
// ponytail: stored in localStorage, not on the server. Segments are a personal
// view preference with no cross-device requirement today; move them into a
// table alongside job tags if users start asking to share them.

export interface FilterState {
  location: string
  company: string
  minFollowers: string
  maxFollowers: string
  joinedAfter: string
  joinedBefore: string
  hideBots: boolean
}

export const EMPTY_FILTERS: FilterState = {
  location: '',
  company: '',
  minFollowers: '',
  maxFollowers: '',
  joinedAfter: '',
  joinedBefore: '',
  hideBots: false,
}

export interface Segment {
  name: string
  filters: FilterState
}

const SEGMENTS_KEY = 'repo-people-segments'
const MAX_SEGMENTS = 20

export function loadSegments(): Segment[] {
  try {
    const raw = localStorage.getItem(SEGMENTS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persist(segments: Segment[]): Segment[] {
  try {
    localStorage.setItem(SEGMENTS_KEY, JSON.stringify(segments))
  } catch {
    // Storage full or unavailable — the in-memory list still works this session.
  }
  return segments
}

/** Add or replace a segment by name. Newest first, capped at MAX_SEGMENTS. */
export function saveSegment(name: string, filters: FilterState, prev: Segment[]): Segment[] {
  const trimmed = name.trim()
  if (!trimmed) return prev
  const without = prev.filter(s => s.name.toLowerCase() !== trimmed.toLowerCase())
  return persist([{ name: trimmed, filters }, ...without].slice(0, MAX_SEGMENTS))
}

export function deleteSegment(name: string, prev: Segment[]): Segment[] {
  return persist(prev.filter(s => s.name !== name))
}

/** How many filters in a state are actually set — drives the count badge. */
export function activeFilterCount(f: FilterState): number {
  return [
    f.location,
    f.company,
    f.minFollowers,
    f.maxFollowers,
    f.joinedAfter,
    f.joinedBefore,
    f.hideBots ? 'x' : '',
  ].filter(Boolean).length
}
