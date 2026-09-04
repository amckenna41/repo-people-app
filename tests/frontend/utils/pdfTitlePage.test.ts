import { describe, expect, it } from 'vitest'
import { titlePageRows, repoLabel, toLatin1 } from '../../../frontend/src/utils/pdfTitlePage'
import type { JobInfo, SummaryData } from '../../../frontend/src/types'

const job = {
  job_id: 'abc123', status: 'done', total_fetched: 45,
  label: 'amckenna41/iso3166-2', created_at: '2026-09-01T10:00:00Z',
} as JobInfo

const summary = {
  total: 45, humans: 44, bots: 1,
  top_locations: [{ location: 'germany', count: 6 }],
  top_companies: [{ company: 'multiply', count: 2 }],
  account_age_distribution: {}, role_distribution: {},
} as SummaryData

const rowMap = (info: Parameters<typeof titlePageRows>[0]) =>
  Object.fromEntries(titlePageRows(info))

describe('repoLabel', () => {
  it('uses the job label', () => expect(repoLabel(job)).toBe('amckenna41/iso3166-2'))
  it('falls back to the job id', () =>
    expect(repoLabel({ ...job, label: undefined } as JobInfo)).toBe('abc123'))
  it('survives no job at all', () => expect(repoLabel(null)).toBe('Unknown repository'))
})

describe('titlePageRows', () => {
  it('names the repository and both timestamps', () => {
    const rows = rowMap({ job, now: new Date('2026-09-04T12:00:00Z') })
    expect(rows.Repository).toBe('amckenna41/iso3166-2')
    expect(rows.Collected).toContain('2026')
    expect(rows.Exported).toContain('2026')
  })

  it('says so when the export is filtered', () => {
    // "45 users" on a report that actually holds 12 would misdescribe the file.
    expect(rowMap({ job, totalUsers: 12, unfilteredTotal: 45 })['Users in this report'])
      .toBe('12 of 45 (filtered)')
    expect(rowMap({ job, totalUsers: 45, unfilteredTotal: 45 })['Users in this report'])
      .toBe('45')
  })

  it('lists collected roles by size and calls out the empty ones', () => {
    // A role that returned nothing is why a report is short, and it is invisible
    // in the charts — so it belongs on the cover.
    const rows = rowMap({
      job, summary,
      roleCounts: { stargazers: 0, contributors: 2, issue_authors: 9, watchers: 0 },
    })
    expect(rows['Roles collected']).toBe('issue authors 9, contributors 2')
    expect(rows['Roles that returned nothing']).toBe('stargazers, watchers')
  })

  it('reports "none" when every role came back empty', () => {
    const rows = rowMap({ job, roleCounts: { stargazers: 0, watchers: 0 } })
    expect(rows['Roles collected']).toBe('none')
  })

  it('omits rows it has nothing to say about', () => {
    const rows = rowMap({ job })
    expect(rows).not.toHaveProperty('Roles collected')
    expect(rows).not.toHaveProperty('Warnings')
  })

  it('includes the warning count when present', () => {
    expect(rowMap({ job, summary, warnings: ['a', 'b'] }).Warnings).toBe('2 — see below')
  })

  it('leaves the demographic breakdowns to the charts', () => {
    // Humans/bots, top location and top company were dropped from the cover:
    // the charts inside the report already carry them.
    const rows = rowMap({ job, summary, warnings: ['a'] })
    expect(rows).not.toHaveProperty('Humans / bots')
    expect(rows).not.toHaveProperty('Top location')
    expect(rows).not.toHaveProperty('Top company')
  })

  it('renders an unparseable timestamp as a dash, not "Invalid Date"', () => {
    expect(rowMap({ job: { ...job, created_at: 'nonsense' } as JobInfo }).Collected).toBe('—')
  })
})

describe('toLatin1', () => {
  it('drops emoji that jsPDF cannot encode', () => {
    // The warning strings all start with this; it rendered as "&þ" and threw
    // off the letter spacing of the whole line.
    expect(toLatin1('⚠️ stargazers: Access denied')).toBe('stargazers: Access denied')
  })

  it('folds typographic punctuation to ASCII rather than deleting it', () => {
    expect(toLatin1('token — invalid')).toBe('token - invalid')
    expect(toLatin1('the repo’s owner')).toBe("the repo's owner")
    expect(toLatin1('and so on…')).toBe('and so on...')
  })

  it('keeps accented Latin-1 characters, which the fonts do have', () => {
    expect(toLatin1('Café Zürich')).toBe('Café Zürich')
  })

  it('collapses the gap left behind by a stripped character', () => {
    expect(toLatin1('a 🎉 b')).toBe('a b')
  })
})
