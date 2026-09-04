import { describe, expect, it } from 'vitest'
import { planPages } from '../../../frontend/src/utils/pdfPages'

/** Slices must tile the content exactly: no gap, no overlap, nothing dropped. */
function assertTiles(pages: { y: number; height: number }[], contentHeight: number) {
  expect(pages[0].y).toBe(0)
  for (let i = 1; i < pages.length; i++) {
    expect(pages[i].y).toBe(pages[i - 1].y + pages[i - 1].height)
  }
  const last = pages[pages.length - 1]
  expect(last.y + last.height).toBe(contentHeight)
  expect(pages.every(p => p.height > 0)).toBe(true)
}

describe('planPages', () => {
  it('cuts at section boundaries rather than at the page limit', () => {
    // Sections end at 90 and 190; a naive slice would cut at 100 and 200,
    // through the middle of the second and third sections.
    const pages = planPages({ contentHeight: 250, pageHeight: 100, breaks: [90, 190, 250] })
    expect(pages.map(p => p.y)).toEqual([0, 90, 190])
    assertTiles(pages, 250)
  })

  it('never returns a slice taller than a page', () => {
    const pages = planPages({ contentHeight: 1000, pageHeight: 100, breaks: [95, 180, 300, 640] })
    expect(pages.every(p => p.height <= 100)).toBe(true)
    assertTiles(pages, 1000)
  })

  it('hard-cuts a section taller than one page', () => {
    // One 250-tall section: no break fits, so it splits at the page limit.
    const pages = planPages({ contentHeight: 250, pageHeight: 100, breaks: [250] })
    expect(pages.map(p => p.height)).toEqual([100, 100, 50])
    assertTiles(pages, 250)
  })

  it('fits everything on one page when it already fits', () => {
    expect(planPages({ contentHeight: 80, pageHeight: 100, breaks: [40, 80] }))
      .toEqual([{ y: 0, height: 80 }])
  })

  it('ends on the content, not on a full-height blank page', () => {
    // The old loop drew a whole page for a 7px remainder.
    const pages = planPages({ contentHeight: 207, pageHeight: 100, breaks: [100, 200] })
    expect(pages[pages.length - 1]).toEqual({ y: 200, height: 7 })
  })

  it('ignores breaks outside the content', () => {
    const pages = planPages({ contentHeight: 150, pageHeight: 100, breaks: [-5, 0, 90, 150, 900] })
    expect(pages.map(p => p.y)).toEqual([0, 90])
    assertTiles(pages, 150)
  })

  it('tolerates unsorted breaks', () => {
    const pages = planPages({ contentHeight: 250, pageHeight: 100, breaks: [190, 90] })
    expect(pages.map(p => p.y)).toEqual([0, 90, 190])
  })

  it('returns nothing for empty content', () => {
    expect(planPages({ contentHeight: 0, pageHeight: 100, breaks: [] })).toEqual([])
    expect(planPages({ contentHeight: 100, pageHeight: 0, breaks: [] })).toEqual([])
  })
})
