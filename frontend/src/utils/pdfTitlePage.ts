// Cover page for the PDF export.
//
// The report used to open straight into the summary cards, so a saved or
// forwarded PDF carried no statement of which repository it described, when it
// was collected, or how complete it was. All of that already exists in the job
// record — it just never reached the file.

import type { JobInfo, SummaryData } from '../types'

export interface TitlePageInfo {
  job?: JobInfo | null
  summary?: SummaryData | null
  /** Usernames contributed per role, as persisted with the job. */
  roleCounts?: Record<string, number>
  /** Warnings recorded during the fetch — why the set may be short. */
  warnings?: string[]
  /** Total users in the exported set (after filters, if any are applied). */
  totalUsers?: number
  /** Total before filters, so a filtered export says so. */
  unfilteredTotal?: number
  now?: Date
}

/** Reduce a string to what jsPDF's built-in fonts can actually encode.
 *
 *  The standard PDF fonts are WinAnsi (Latin-1). Anything outside it is emitted
 *  as mojibake — the warning strings all begin with "⚠️", which rendered as
 *  "&þ" and threw off the spacing of the rest of the line. Dropping those
 *  characters is right here: they are decoration, and the words carry the
 *  meaning. Common typographic punctuation is folded to its ASCII equivalent
 *  rather than deleted, so an em dash does not silently vanish mid-sentence.
 */
export function toLatin1(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00a0/g, ' ')
    // Emoji and their variation selectors / zero-width joiners.
    .replace(/[^\u0020-\u00ff]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function formatDate(value?: string | Date): string {
  if (!value) return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/** The repository this report covers, e.g. `amckenna41/iso3166-2`. */
export function repoLabel(job?: JobInfo | null): string {
  const label = job?.label?.trim()
  if (label) return label
  return job?.job_id ?? 'Unknown repository'
}

/**
 * The cover page's key/value rows, in order.
 *
 * Pure, so the wording and the "which fields are present" logic are testable
 * without a PDF. Rows with nothing to say are omitted rather than rendered as
 * an em dash, so a small job does not read as a form full of blanks.
 */
export function titlePageRows(info: TitlePageInfo): Array<[string, string]> {
  const { job, summary, roleCounts, warnings, totalUsers, unfilteredTotal } = info
  const rows: Array<[string, string]> = []

  rows.push(['Repository', repoLabel(job)])
  rows.push(['Collected', formatDate(job?.created_at ?? job?.timestamp)])
  rows.push(['Exported', formatDate(info.now ?? new Date())])

  const total = totalUsers ?? summary?.total
  if (total != null) {
    // A filtered export describes a subset; saying "45 users" when the job held
    // 500 would misrepresent the file.
    const filtered = unfilteredTotal != null && unfilteredTotal !== total
    rows.push(['Users in this report', filtered
      ? `${total.toLocaleString()} of ${unfilteredTotal.toLocaleString()} (filtered)`
      : total.toLocaleString()])
  }
  const roles = Object.entries(roleCounts ?? {})
  if (roles.length > 0) {
    const collected = roles.filter(([, n]) => n > 0)
    rows.push(['Roles collected', collected.length > 0
      ? collected.sort((a, b) => b[1] - a[1])
          .map(([r, n]) => `${r.replace(/_/g, ' ')} ${n}`).join(', ')
      : 'none'])
    // A role that returned nothing is the quiet failure worth putting on the
    // cover — it is why a report is short, and it is invisible in the charts.
    const empty = roles.filter(([, n]) => n === 0).map(([r]) => r.replace(/_/g, ' '))
    if (empty.length > 0) rows.push(['Roles that returned nothing', empty.join(', ')])
  }

  if (warnings && warnings.length > 0) {
    rows.push(['Warnings', `${warnings.length} — see below`])
  }
  return rows
}

/** Minimal surface of jsPDF used here, so this module needs no jsPDF import. */
interface PdfLike {
  internal: { pageSize: { getWidth(): number; getHeight(): number } }
  setFillColor(r: number, g: number, b: number): void
  setTextColor(r: number, g: number, b: number): void
  setFont(name: string, style?: string): void
  setFontSize(size: number): void
  setDrawColor(r: number, g: number, b: number): void
  setLineWidth(w: number): void
  rect(x: number, y: number, w: number, h: number, style?: string): void
  line(x1: number, y1: number, x2: number, y2: number): void
  text(text: string | string[], x: number, y: number): void
  splitTextToSize(text: string, maxWidth: number): string[]
}

/** Draw the cover onto the current page. */
export function drawTitlePage(pdf: PdfLike, info: TitlePageInfo, marginMm: number): void {
  const W = pdf.internal.pageSize.getWidth()
  const H = pdf.internal.pageSize.getHeight()
  const left = marginMm + 6
  const width = W - (marginMm + 6) * 2

  pdf.setFillColor(5, 5, 16)               // the app's page background
  pdf.rect(0, 0, W, H, 'F')

  let y = 55
  pdf.setTextColor(167, 139, 250)
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(11)
  pdf.text('REPO-PEOPLE REPORT', left, y)

  y += 16
  pdf.setTextColor(255, 255, 255)
  pdf.setFontSize(26)
  // A long owner/repo has to wrap rather than run off the page.
  const titleLines = pdf.splitTextToSize(toLatin1(repoLabel(info.job)), width)
  pdf.text(titleLines, left, y)
  y += titleLines.length * 11

  y += 4
  pdf.setDrawColor(139, 92, 246)
  pdf.setLineWidth(0.6)
  pdf.line(left, y, left + 40, y)

  y += 16
  pdf.setFontSize(10)
  for (const [label, value] of titlePageRows(info)) {
    if (y > H - 40) break                  // never spill onto the charts
    pdf.setFont('helvetica', 'normal')
    pdf.setTextColor(148, 163, 184)
    pdf.text(toLatin1(label), left, y)
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(229, 231, 235)
    const valueLines = pdf.splitTextToSize(toLatin1(value), width - 52)
    pdf.text(valueLines, left + 52, y)
    y += Math.max(7, valueLines.length * 5.2)
  }

  const warnings = info.warnings ?? []
  if (warnings.length > 0 && y < H - 45) {
    y += 6
    pdf.setFont('helvetica', 'bold')
    pdf.setTextColor(252, 211, 77)
    pdf.setFontSize(9)
    pdf.text('Warnings', left, y)
    y += 6
    pdf.setFont('helvetica', 'normal')
    for (const w of warnings) {
      if (y > H - 30) break
      const lines = pdf.splitTextToSize(`- ${toLatin1(w)}`, width)
      pdf.text(lines, left, y)
      y += lines.length * 4.6
    }
  }

  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(8)
  pdf.setTextColor(107, 114, 128)
  pdf.text('Generated by repo-people', left, H - marginMm - 6)
}
