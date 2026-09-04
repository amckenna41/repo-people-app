// Page-break planning for the PDF export.
//
// The export used to slice the report canvas every `pageHeight` pixels, which
// puts a cut wherever the arithmetic lands: through the middle of a summary
// card, halfway down a chart, mid-table-row. The report is a vertical stack of
// sections with a gap between each, so there is a correct answer available —
// cut in the gaps.

export interface PageSlice {
  /** Top of this slice, in canvas pixels from the top of the content. */
  y: number
  /** Height of the slice. Never taller than a page; the last one is usually shorter. */
  height: number
}

/**
 * Split `contentHeight` into page-sized slices, preferring to cut at one of
 * `breaks` (the bottom edge of each section, in the same units).
 *
 * A section taller than a page has no usable break inside it, so it is cut at
 * the page limit — better a split chart than an infinite loop or a blank page.
 */
export function planPages(opts: {
  contentHeight: number
  pageHeight: number
  /** Candidate cut positions, ascending. Values outside the content are ignored. */
  breaks: number[]
}): PageSlice[] {
  const { contentHeight, pageHeight } = opts
  if (!(contentHeight > 0) || !(pageHeight > 0)) return []

  const breaks = [...opts.breaks]
    .filter(b => Number.isFinite(b) && b > 0 && b < contentHeight)
    .sort((a, b) => a - b)

  const pages: PageSlice[] = []
  let y = 0
  // Bounded by construction — every iteration advances `y` by at least one
  // pixel — but a guard keeps a rounding surprise from hanging the tab.
  while (y < contentHeight && pages.length < 200) {
    const limit = y + pageHeight
    if (limit >= contentHeight) {
      pages.push({ y, height: contentHeight - y })
      break
    }
    // The last candidate that still fits on this page. `> y` so a break exactly
    // at the top of the page cannot produce a zero-height slice.
    let cut = 0
    for (const b of breaks) {
      if (b > y && b <= limit) cut = b
      else if (b > limit) break
    }
    if (cut <= y) cut = limit          // section taller than a page: hard cut
    pages.push({ y, height: cut - y })
    y = cut
  }
  return pages
}
