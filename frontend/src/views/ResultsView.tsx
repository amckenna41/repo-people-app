import { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react'
import {
  fetchResultsPage, fetchAllResultPages, MAX_CLIENT_ROWS,
  fetchSummary, fetchTop, renameJob, createShareToken, refreshJob,
  fetchJobHistory, fetchSchedules, createSchedule, setScheduleEnabled, deleteSchedule,
  type ResultFilters, type JobHistory, type Schedule,
} from '../utils/api'
import type { JobInfo, UserRecord, SummaryData } from '../types'
import { ROLE_COLORS, ROLE_FUNNEL_ORDER } from '../types'
import UserTable from '../components/UserTable'
import type { SortingState } from '@tanstack/react-table'
import { type FilterState, EMPTY_FILTERS } from '../utils/segments'
import { toCsv, xlsxCell, downloadText } from '../utils/csv'
import { inlineComputedColors, buildColorVariableOverrides } from '../utils/colors'
import { filterAndSortUsers, computeSummary } from '../utils/localResults'
import { useModalEscape } from '../hooks/useModalEscape'
const UserDrawer = lazy(() => import('../components/UserDrawer'))
const WorldMap = lazy(() => import('../components/WorldMap'))
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, AreaChart, Area, LineChart, Line,
} from 'recharts'
import { Download, Loader2, Users, Bot, MapPin, Building2, Star, Activity, Globe, Code2, GitBranch, Mail, Shield, FileText, Share2, FileDown, ChevronDown, Info, Pencil, Check, X as XIcon, Trash2, Clock, Layers, TrendingUp, Link, RefreshCw, CalendarClock, UserPlus, UserMinus, Play, Pause } from 'lucide-react'

interface Props {
  jobs: JobInfo[]
  activeJobId: string | null
  setActiveJobId: (id: string) => void
  groupJobIds: string[]
  onUsersLoaded?: (jobId: string, users: UserRecord[]) => void
  onJobUpdate?: (job_id: string, patch: Partial<JobInfo>) => void
  onJobDelete?: (job_id: string) => void
  onJobTagsUpdate?: (job_id: string, tags: string[]) => void
  onJobRefresh?: (newJobId: string, label: string) => void
  /** Result sets held only in the browser, keyed by job id.
   *  A shared link (`#share=TOKEN`) has no job on the backend, so its rows
   *  arrive this way and must never be fetched over the network. */
  localJobUsers?: Record<string, UserRecord[]>
}

// The table renders the first page immediately, then the rest streams in behind
// it. Everything derived from `users` — every chart, the quick-stat badges and
// all client-side exports — used to describe only the pages the user had
// happened to scroll through, silently under-reporting on any job over one page.
const FIRST_PAGE_SIZE = 200
// ponytail: a flat cap (MAX_CLIENT_ROWS, from api.ts), not windowed aggregation.
// Move the aggregates server-side if anyone actually explores six-figure result
// sets in this UI.
const PAGE_SIZE = 1000

function relativeTime(iso?: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}yr ago`
}

// Recharts' hover defaults assume a light theme and are unreadable on this dark
// card: the tooltip label renders in #000 (1.18:1 against the #111827 tooltip —
// effectively invisible) and the bar cursor is an opaque #ccc band that washes
// out the hovered row. These restore contrast; #e5e7eb on #111827 is 14.3:1.
const TOOLTIP_BASE = {
  contentStyle: { background: '#111827', border: '1px solid #374151', borderRadius: 6 },
  labelStyle: { color: '#e5e7eb' },
} as const

/** Subtle highlight for the hovered category, replacing the opaque #ccc default. */
const BAR_CURSOR = { fill: 'rgba(255,255,255,0.07)' } as const

const PIE_COLORS = ['#0ea5e9', '#6366f1', '#10b981', '#f59e0b']
const FUNNEL_COLORS = ['#7c3aed','#6d28d9','#2563eb','#0284c7','#0d9488','#059669','#65a30d','#ca8a04']

const TOP_BY_OPTIONS = [
  { key: 'followers', label: 'Followers' },
  { key: 'public_repos', label: 'Repos' },
  { key: 'account_age_days', label: 'Account Age' },
  { key: 'total_public_stars_sampled', label: 'Stars' },
]

export default function ResultsView({ jobs, activeJobId, setActiveJobId, groupJobIds, onUsersLoaded, onJobUpdate, onJobDelete, onJobTagsUpdate, onJobRefresh, localJobUsers }: Props) {
  const [users, setUsers] = useState<UserRecord[]>([])
  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [topUsers, setTopUsers] = useState<UserRecord[]>([])
  const [topBy, setTopBy] = useState('followers')
  const [selectedUser, setSelectedUser] = useState<UserRecord | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [totalUsers, setTotalUsers] = useState(0)
  const [unfilteredTotal, setUnfilteredTotal] = useState(0)
  // Bumped on every new query; a background page loop that finds its token
  // stale drops its results instead of mixing them into a newer query.
  const loadTokenRef = useRef(0)
  // Filtering, search and sorting live here (not in UserTable) because they are
  // applied server-side across the whole result set.
  const [filters, setFilters] = useState<FilterState>({ ...EMPTY_FILTERS })
  const [search, setSearch] = useState('')
  const [sorting, setSorting] = useState<SortingState>([])
  const [history, setHistory] = useState<JobHistory | null>(null)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [scheduleInterval, setScheduleInterval] = useState(168)
  const [schedulingBusy, setSchedulingBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [shareLoading, setShareLoading] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)
  const [showRoleExport, setShowRoleExport] = useState(false)
  const [exportPickerFormat, setExportPickerFormat] = useState<'json' | 'csv' | 'xlsx' | null>(null)
  const [exportPickerFields, setExportPickerFields] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  // Persisted per-job fetch warnings, e.g. a role that collected nothing.
  const [jobWarnings, setJobWarnings] = useState<string[]>([])
  const [renamingJobId, setRenamingJobId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [taggingJobId, setTaggingJobId] = useState<string | null>(null)
  const [tagInput, setTagInput] = useState('')
  const reportRef = useRef<HTMLDivElement>(null)
  const roleExportRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)

  async function commitRename() {
    if (!renamingJobId) return
    const trimmed = renameValue.trim()
    if (trimmed) {
      onJobUpdate?.(renamingJobId, { label: trimmed })
      renameJob(renamingJobId, trimmed).catch(() => {/* best-effort */})
    }
    setRenamingJobId(null)
  }

  function getTagColor(tag: string): string {
    const PALETTE = [
      '#7c3aed','#2563eb','#0d9488','#b45309','#be185d',
      '#1d4ed8','#059669','#dc2626','#9333ea','#0891b2',
    ]
    let h = 0
    for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0
    return PALETTE[h % PALETTE.length]
  }

  function openTagEditor(jobId: string) {
    const job = jobs.find(j => j.job_id === jobId)
    setTagInput((job?.tags ?? []).join(', '))
    setTaggingJobId(jobId)
    setTimeout(() => tagInputRef.current?.focus(), 50)
  }

  function commitTags() {
    if (!taggingJobId) return
    const tags = tagInput.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
    onJobTagsUpdate?.(taggingJobId, tags)
    setTaggingJobId(null)
    setTagInput('')
  }

  // Close role export dropdown on outside click
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (roleExportRef.current && !roleExportRef.current.contains(e.target as Node)) {
        setShowRoleExport(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  const doneJobs = jobs.filter(j => j.status === 'done')
  const allTags = useMemo(() => {
    const s = new Set<string>()
    jobs.forEach(j => (j.tags ?? []).forEach(t => s.add(t)))
    return Array.from(s).sort()
  }, [jobs])
  const filteredDoneJobs = tagFilter.length === 0
    ? doneJobs
    : doneJobs.filter(j => tagFilter.some(t => (j.tags ?? []).includes(t)))

  /** Map the UI filter state onto the server's query parameters. */
  const serverFilters = useMemo<ResultFilters>(() => ({
    q: search || undefined,
    location: filters.location || undefined,
    company: filters.company || undefined,
    min_followers: filters.minFollowers || undefined,
    max_followers: filters.maxFollowers || undefined,
    joined_after: filters.joinedAfter || undefined,
    joined_before: filters.joinedBefore || undefined,
    hide_bots: filters.hideBots || undefined,
    sort_by: sorting[0]?.id,
    sort_dir: sorting[0] ? (sorting[0].desc ? 'desc' : 'asc') : undefined,
  }), [search, filters, sorting])

  const activeJobIsDone = jobs.find(j => j.job_id === activeJobId)?.status === 'done'

  // Rows the chart aggregates read.
  //
  // The background page-walk calls setUsers() once per fetched page, and nine
  // O(n) aggregates below are keyed on `users` — so every page re-ran all nine
  // over the whole set so far. They now key on a snapshot that only advances
  // when loading settles, so the charts compute once per query rather than once
  // per page. `users` itself still drives the table, which should stream in.
  const [chartUsers, setChartUsers] = useState<UserRecord[]>([])
  useEffect(() => {
    if (loadingMore) return
    setChartUsers(users)
  }, [users, loadingMore])


  // GET /schedules returns every schedule for the session, across all repos.
  // Rendering them unfiltered meant switching the Job dropdown changed nothing,
  // and one repo's panel offered pause/delete for another repo's schedule —
  // distinguishable only by reading the label.
  // A shared link's job exists only in this browser — the backend never created
  // it. Every owner control (rename, delete, refresh, schedule, share) would
  // 404 against that id, so they are hidden rather than left to fail.
  const isReadOnly = !!(activeJobId && localJobUsers?.[activeJobId])

  useModalEscape(exportPickerFormat ? () => setExportPickerFormat(null) : null)

  const jobSchedules = useMemo(
    () => schedules.filter(s => s.source_job_id === activeJobId),
    [schedules, activeJobId],
  )


  // The result set is bigger than we are willing to hold in the browser.
  const truncated = totalUsers > MAX_CLIENT_ROWS
  // Every row we are ever going to have for this query is in `users`. Derived
  // from the row count rather than tracked in state, so a page load that fails
  // part-way is correctly reported as incomplete instead of claiming success.
  const coverageComplete =
    totalUsers === 0 || users.length >= Math.min(totalUsers, MAX_CLIENT_ROWS)

  // Reload page 1 whenever the job or the server-side query changes. Debounced
  // so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    if (!activeJobId || !activeJobIsDone) return
    const handle = setTimeout(() => { loadJob(activeJobId, serverFilters) }, 250)
    return () => clearTimeout(handle)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId, activeJobIsDone, serverFilters])

  // Reset the query when switching jobs — filters from the previous repo rarely
  // make sense for the next one.
  useEffect(() => {
    setFilters({ ...EMPTY_FILTERS })
    setSearch('')
    setSorting([])
  }, [activeJobId])

  useEffect(() => {
    if (!activeJobId || !activeJobIsDone) return
    loadTop(activeJobId, topBy)
  }, [topBy, activeJobId, activeJobIsDone])

  // Churn history + schedules for the active job.
  useEffect(() => {
    if (!activeJobId || !activeJobIsDone) { setHistory(null); return }
    fetchJobHistory(activeJobId).then(setHistory).catch(() => setHistory(null))
  }, [activeJobId, activeJobIsDone])

  useEffect(() => {
    fetchSchedules().then(setSchedules).catch(() => {})
  }, [activeJobId])

  async function loadJob(jobId: string, query: ResultFilters) {
    const token = ++loadTokenRef.current
    setLoading(true)
    setError(null)

    // Shared links carry their rows with them and have no backend job, so
    // hitting /results/{id} would 404 and leave the whole view blank.
    const local = localJobUsers?.[jobId]
    if (local) {
      const rows = filterAndSortUsers(
        local, filters, search, sorting[0]?.id,
        sorting[0] ? (sorting[0].desc ? 'desc' : 'asc') : 'asc',
      )
      setUsers(rows)
      setTotalUsers(rows.length)
      setUnfilteredTotal(local.length)
      setSummary(computeSummary(rows))
      setJobWarnings([])
      setLoading(false)
      return
    }

    try {
      // Load first page immediately for fast render; summary fetched in parallel.
      const [pageData, sum] = await Promise.all([
        fetchResultsPage(jobId, 1, FIRST_PAGE_SIZE, query),
        fetchSummary(jobId),
      ])
      if (loadTokenRef.current !== token) return
      const loadedUsers = Object.values(pageData.users) as UserRecord[]
      setUsers(loadedUsers)
      setTotalUsers(pageData.total)
      setUnfilteredTotal(pageData.unfiltered_total ?? pageData.total)
      setJobWarnings(pageData.warnings ?? [])
      setSummary(sum)
      onUsersLoaded?.(jobId, loadedUsers)
      if (loadedUsers.length < pageData.total) {
        void loadRemaining(jobId, query, token, loadedUsers, pageData.total)
      }
    } catch (e: unknown) {
      if (loadTokenRef.current !== token) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (loadTokenRef.current === token) setLoading(false)
    }
  }

  /** Pull the remaining pages of the current query in the background, so every
   *  aggregate below reflects the whole result set rather than page one. */
  async function loadRemaining(
    jobId: string,
    query: ResultFilters,
    token: number,
    firstPage: UserRecord[],
    total: number,
  ) {
    setLoadingMore(true)
    try {
      const all = await fetchAllResultPages(jobId, query, {
        firstPage,
        total,
        pageSize: PAGE_SIZE,
        shouldContinue: () => loadTokenRef.current === token,
        onPage: rows => setUsers([...(rows as UserRecord[])]),
      })
      if (loadTokenRef.current !== token) return
      onUsersLoaded?.(jobId, all as UserRecord[])
    } catch (_) {
      // Non-fatal: the table keeps what it has. `coverageComplete` is derived
      // from the row count, so a partial load stays labelled as partial and the
      // client-side exports stay disabled without needing a flag set here.
    } finally {
      if (loadTokenRef.current === token) setLoadingMore(false)
    }
  }

  async function handleCreateSchedule() {
    if (!activeJobId) return
    setSchedulingBusy(true)
    try {
      const created = await createSchedule(activeJobId, scheduleInterval)
      setSchedules(prev => [...prev, created])
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not create schedule.')
    } finally {
      setSchedulingBusy(false)
    }
  }

  async function handleToggleSchedule(schedule: Schedule) {
    setSchedules(prev => prev.map(s =>
      s.schedule_id === schedule.schedule_id ? { ...s, enabled: !s.enabled } : s))
    await setScheduleEnabled(schedule.schedule_id, !schedule.enabled).catch(() => {})
  }

  async function handleDeleteSchedule(scheduleId: string) {
    setSchedules(prev => prev.filter(s => s.schedule_id !== scheduleId))
    await deleteSchedule(scheduleId).catch(() => {})
  }

  async function loadTop(jobId: string, by: string) {
    try {
      const top = await fetchTop(jobId, by, 10)
      setTopUsers(Array.isArray(top) ? top : [])
    } catch (_) {
      // non-fatal
    }
  }

  async function handleShare() {
    if (!activeJobId) return
    setShareLoading(true)
    try {
      const { url } = await createShareToken(activeJobId)
      await navigator.clipboard.writeText(url)
      setShareCopied(true)
      setTimeout(() => setShareCopied(false), 3000)
    } catch (_) {
      // non-fatal — clipboard may be blocked
    } finally {
      setShareLoading(false)
    }
  }

  async function exportPdf() {
    if (!reportRef.current) return
    setExporting(true)
    try {
      const html2canvas = (await import('html2canvas')).default
      const { jsPDF } = await import('jspdf')
      const canvas = await html2canvas(reportRef.current, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#050510',
        logging: false,
        // Tailwind v4 emits its palette in oklch(), which html2canvas 1.4.1
        // cannot parse — it throws rather than degrading, so the whole export
        // failed. Both steps run on the clone; the live page is untouched.
        onclone: (clonedDoc, element) => {
          // 1. Redefine the oklch custom properties as rgb(). Every Tailwind
          //    utility reads the palette through var(), so this fixes all of
          //    them at once — including <html>/<body>, whose background
          //    html2canvas inspects before parsing this subtree.
          const overrides = buildColorVariableOverrides(clonedDoc)
          if (overrides) {
            const style = clonedDoc.createElement('style')
            style.textContent = overrides
            clonedDoc.head.appendChild(style)
          }
          // 2. Safety net for any non-var oklch (none today, but a hand-written
          //    rule or an inline style would slip past step 1).
          inlineComputedColors(element)
        },
      })
      const imgData = canvas.toDataURL('image/png')
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      const pdfW = pdf.internal.pageSize.getWidth()
      const pdfH = pdf.internal.pageSize.getHeight()
      const imgH = (canvas.height * pdfW) / canvas.width
      let remaining = imgH
      let offset = 0
      while (remaining > 0) {
        if (offset > 0) pdf.addPage()
        pdf.addImage(imgData, 'PNG', 0, -offset, pdfW, imgH)
        offset += pdfH
        remaining -= pdfH
      }
      const label = doneJobs.find(j => j.job_id === activeJobId)?.label ?? activeJobId ?? 'report'
      pdf.save(`repo-people_${label.replace(/\//g, '_')}_report.pdf`)
    } catch (e) {
      console.error('PDF export failed:', e)
      alert(`PDF export failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(false)
    }
  }

  // Per-role CSV export (client-side)
  function downloadRoleCsv(role: string) {
    const roleUsers = users.filter(u => u.roles?.includes(role))
    if (!roleUsers.length) return
    const keys = Array.from(new Set(roleUsers.flatMap(u => Object.keys(u))))
    const label = doneJobs.find(j => j.job_id === activeJobId)?.label ?? activeJobId ?? 'repo'
    downloadText(
      `${label.replace(/\//g, '_')}_${role}.csv`,
      toCsv(keys, roleUsers as unknown as Record<string, unknown>[]),
      'text/csv',
    )
  }

  // All unique field keys present in the current user set (login is always exported as the key / first column)
  const allUserFields = useMemo(
    () => Array.from(new Set(users.flatMap(u => Object.keys(u))))
      .filter(f => f !== 'login')
      .sort((a, b) => a.localeCompare(b)),
    [users]
  )

  function openExportPicker(format: 'json' | 'csv' | 'xlsx') {
    setExportPickerFields(allUserFields)
    setExportPickerFormat(format)
  }

  function runFilteredExport() {
    if (!exportPickerFormat || !exportPickerFields.length) return
    const label = doneJobs.find(j => j.job_id === activeJobId)?.label ?? activeJobId ?? 'repo'
    const safeLabel = label.replace(/\//g, '_')
    const fields = exportPickerFields

    if (exportPickerFormat === 'xlsx') {
      // P7: Lazy-load xlsx only when an Excel export is actually requested.
      import('xlsx').then((XLSX) => {
      // Excel: login is first column; arrays expanded into comma-separated strings; objects JSON-stringified
      const allCols = ['login', ...fields]
      const wsData = [
        allCols, // header row
        ...users.map(u =>
          allCols.map(f => xlsxCell((u as unknown as Record<string, unknown>)[f]))
        ),
      ]
      const ws = XLSX.utils.aoa_to_sheet(wsData)
      // Auto-width columns (cap at 50 chars)
      ws['!cols'] = allCols.map((col, ci) => {
        const maxLen = Math.min(
          50,
          Math.max(col.length, ...wsData.slice(1).map(row => String(row[ci] ?? '').length))
        )
        return { wch: maxLen }
      })
      const wb = XLSX.utils.book_new()
      const sheetName = (doneJobs.find(j => j.job_id === activeJobId)?.label ?? 'Users').slice(0, 31)
      XLSX.utils.book_append_sheet(wb, ws, sheetName)
      XLSX.writeFile(wb, `${safeLabel}_users.xlsx`)
      }).catch(err => console.error('xlsx load failed:', err))
    } else if (exportPickerFormat === 'json') {
      // Output: { "login": { ...selectedFields } }
      const data: Record<string, Record<string, unknown>> = {}
      for (const u of users) {
        const obj: Record<string, unknown> = {}
        for (const f of fields) obj[f] = (u as unknown as Record<string, unknown>)[f] ?? null
        data[u.login] = obj
      }
      downloadText(`${safeLabel}_users.json`, JSON.stringify(data, null, 2), 'application/json')
    } else {
      // CSV: login is always first column
      downloadText(
        `${safeLabel}_users.csv`,
        toCsv(['login', ...fields], users as unknown as Record<string, unknown>[]),
        'text/csv',
      )
    }

    setExportPickerFormat(null)
  }

  // Markdown report export (client-side)
  function exportMarkdown() {
    if (!summary) return
    const label = doneJobs.find(j => j.job_id === activeJobId)?.label ?? activeJobId ?? 'repo'
    const date = new Date().toISOString().split('T')[0]
    const lines: string[] = []
    lines.push(`# repo-people Report: ${label}`)
    lines.push(`> Generated on ${date} by [repo-people](https://github.com/amckenna41/repo-people)`)
    lines.push('')
    lines.push('## Summary')
    lines.push('')
    lines.push('| Metric | Value |')
    lines.push('|--------|-------|')
    lines.push(`| Total Users | ${summary.total} |`)
    lines.push(`| Humans | ${summary.humans} |`)
    lines.push(`| Bots | ${summary.bots} |`)
    if (summary.top_locations[0]) lines.push(`| Top Location | ${summary.top_locations[0].location} |`)
    if (summary.top_companies[0]) lines.push(`| Top Company | ${summary.top_companies[0].company} |`)
    if (healthScore) {
      lines.push(`| Recently Active | ${healthScore.activeCount} (${healthScore.activeRatio}%) |`)
      lines.push(`| Health Score | ${healthScore.score}/100 |`)
      lines.push(`| Avg Account Age | ${healthScore.avgAge} years |`)
      lines.push(`| Avg Followers | ${healthScore.avgFollowers} |`)
    }
    lines.push('')
    lines.push('## Role Distribution')
    lines.push('')
    lines.push('| Role | Count |')
    lines.push('|------|-------|')
    // Copy before sorting: sort() mutates, and roleDistData is derived during
    // render (React 19 freezes it, so an in-place sort throws).
    const rolesByCount = [...roleDistData].sort((a, b) => b.count - a.count)
    rolesByCount.forEach(r => {
      lines.push(`| ${r.role} | ${r.count} |`)
    })
    lines.push('')
    lines.push('## Top 10 Users by Followers')
    lines.push('')
    lines.push('| # | Login | Name | Followers | Repos | Active |')
    lines.push('|---|-------|------|-----------|-------|--------|')
    topUsers.slice(0, 10).forEach((u, i) => {
      lines.push(`| ${i + 1} | [@${u.login}](${u.html_url}) | ${u.name || '–'} | ${u.followers ?? '–'} | ${u.public_repos ?? '–'} | ${u.recently_active ? '✅' : '❌'} |`)
    })
    lines.push('')
    if (summary.top_locations.length) {
      lines.push('## Top Locations')
      lines.push('')
      lines.push('| Location | Count |')
      lines.push('|----------|-------|')
      summary.top_locations.slice(0, 10).forEach(l => lines.push(`| ${l.location} | ${l.count} |`))
      lines.push('')
    }
    if (summary.top_companies.length) {
      lines.push('## Top Companies')
      lines.push('')
      lines.push('| Company | Count |')
      lines.push('|---------|-------|')
      summary.top_companies.slice(0, 10).forEach(c => lines.push(`| ${c.company} | ${c.count} |`))
      lines.push('')
    }
    if (history && history.total_runs > 1) {
      lines.push('## Membership Over Time')
      lines.push('')
      lines.push('| Run | Date | Members | Joined | Left | Retention |')
      lines.push('|-----|------|---------|--------|------|-----------|')
      history.runs.forEach((r, i) => {
        lines.push(
          `| ${i + 1} | ${(r.created_at ?? '').slice(0, 10)} | ${r.total} | ` +
          `+${r.joined_count} | -${r.left_count} | ` +
          `${r.retention_pct === null ? '–' : `${r.retention_pct}%`} |`
        )
      })
      lines.push('')
    }
    downloadText(
      `repo-people_${label.replace(/\//g, '_')}_report.md`,
      lines.join('\n'),
      'text/markdown',
    )
  }

  const roleDistData = summary
    ? Object.entries(summary.role_distribution).map(([role, count]) => ({ role, count }))
    : []

  const ageDistData = summary
    ? Object.entries(summary.account_age_distribution).map(([band, count]) => ({ band, count }))
    : []

  const locationData = useMemo(() => {
    const counts: Record<string, number> = {}
    chartUsers.forEach(u => { if (u.location_normalized) counts[u.location_normalized] = (counts[u.location_normalized] || 0) + 1 })
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([location, count]) => ({ location, count }))
  }, [chartUsers])

  const languageData = useMemo(() => {
    const counts: Record<string, number> = {}
    chartUsers.forEach(u => { ;(u.top_languages ?? []).forEach(([lang]) => { if (lang) counts[lang] = (counts[lang] || 0) + 1 }) })
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([language, count]) => ({ language, count }))
  }, [chartUsers])

  const orgData = useMemo(() => {
    const counts: Record<string, number> = {}
    chartUsers.forEach(u => { ;(u.public_orgs ?? []).forEach(org => { if (org) counts[org] = (counts[org] || 0) + 1 }) })
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([org, count]) => ({ org, count }))
  }, [chartUsers])

  const emailDomainData = useMemo(() => {
    const PERSONAL = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','protonmail.com','me.com','live.com','qq.com','163.com'])
    let academic = 0, corporate = 0, personal = 0, none = 0
    chartUsers.forEach(u => {
      const d = u.email_domain
      if (!d) { none++; return }
      if (d.endsWith('.edu') || d.endsWith('.ac.uk')) { academic++; return }
      if (PERSONAL.has(d)) { personal++; return }
      corporate++
    })
    return [
      { type: 'Academic', count: academic, color: '#10b981' },
      { type: 'Corporate', count: corporate, color: '#8b5cf6' },
      { type: 'Personal', count: personal, color: '#0ea5e9' },
      { type: 'No Email', count: none, color: '#4b5563' },
    ].filter(d => d.count > 0)
  }, [chartUsers])

  const healthScore = useMemo(() => {
    if (!chartUsers.length) return null
    const activeCount = chartUsers.filter(u => u.recently_active).length
    const activeRatio = activeCount / chartUsers.length
    const avgAge = chartUsers.reduce((s, u) => s + (u.account_age_days ?? 0), 0) / chartUsers.length
    const avgFollowers = chartUsers.reduce((s, u) => s + (u.followers ?? 0), 0) / chartUsers.length
    const avgRepos = chartUsers.reduce((s, u) => s + (u.public_repos ?? 0), 0) / chartUsers.length
    const score = Math.round(
      Math.min(activeRatio, 1) * 40 +
      Math.min(avgAge / (365 * 5), 1) * 20 +
      Math.min(avgFollowers / 100, 1) * 20 +
      Math.min(avgRepos / 20, 1) * 20
    )
    return {
      score,
      activeCount,
      activeRatio: Math.round(activeRatio * 100),
      avgAge: Math.round((avgAge / 365) * 10) / 10,
      avgFollowers: Math.round(avgFollowers),
      avgRepos: Math.round(avgRepos * 10) / 10,
    }
  }, [chartUsers])

  const funnelData = useMemo(() => {
    const ORDER = ROLE_FUNNEL_ORDER
    const dist = summary?.role_distribution ?? {}
    const items = ORDER.map(role => ({ role, count: dist[role] ?? 0 })).filter(d => d.count > 0)
    const max = Math.max(...items.map(d => d.count), 1)
    return items.map(d => ({ ...d, pct: Math.round((d.count / max) * 100) }))
  }, [summary])

  const socialPresenceData = useMemo(() => {
    const ROLE_ORDER = ROLE_FUNNEL_ORDER
    const SIGNALS = [
      { key: 'has_public_email', label: 'Email', color: '#10b981' },
      { key: 'has_blog',         label: 'Blog',  color: '#0ea5e9' },
      { key: 'has_twitter',      label: 'Twitter', color: '#3b82f6' },
      { key: 'has_orgs',         label: 'Orgs',  color: '#a78bfa' },
    ]
    // Collect per-role counts
    const roleCounts: Record<string, Record<string, number>> = {}
    const roleTotals: Record<string, number> = {}
    chartUsers.forEach(u => {
      const roles = u.roles ?? []
      if (!roles.length) return
      roles.forEach(role => {
        if (!roleCounts[role]) roleCounts[role] = { has_public_email: 0, has_blog: 0, has_twitter: 0, has_orgs: 0 }
        roleTotals[role] = (roleTotals[role] ?? 0) + 1
        if (u.has_public_email) roleCounts[role].has_public_email++
        if (u.has_blog) roleCounts[role].has_blog++
        if (u.has_twitter) roleCounts[role].has_twitter++
        if ((u.orgs_public_count ?? 0) > 0) roleCounts[role].has_orgs++
      })
    })
    const presentRoles = ROLE_ORDER.filter(r => roleTotals[r] > 0)
    if (presentRoles.length === 0) return { rows: [], signals: SIGNALS }
    const rows = presentRoles.map(role => {
      const total = roleTotals[role] || 1
      const entry: Record<string, number | string> = { role: role.replace(/_/g, ' ') }
      SIGNALS.forEach(s => {
        entry[s.label] = Math.round(((roleCounts[role]?.[s.key] ?? 0) / total) * 100)
      })
      return entry
    })
    return { rows, signals: SIGNALS }
  }, [chartUsers])

  // Overlap analysis — users that appear in 2+ roles are the most engaged.
  const overlapData = useMemo(() => {
    const multiRole = users
      .filter(u => (u.roles?.length ?? 0) >= 2)
      .sort((a, b) => (b.roles?.length ?? 0) - (a.roles?.length ?? 0))
    // Role pair co-occurrence matrix for the heatmap data
    const pairCounts: Record<string, number> = {}
    chartUsers.forEach(u => {
      const roles = u.roles ?? []
      for (let i = 0; i < roles.length; i++) {
        for (let j = i + 1; j < roles.length; j++) {
          const key = [roles[i], roles[j]].sort().join('|')
          pairCounts[key] = (pairCounts[key] ?? 0) + 1
        }
      }
    })
    const pairs = Object.entries(pairCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([key, count]) => {
        const [a, b] = key.split('|')
        return { pair: `${a.replace(/_/g, ' ')} + ${b.replace(/_/g, ' ')}`, count }
      })
    return { multiRole, pairs, totalMultiRole: multiRole.length }
  }, [chartUsers])

  // Growth over time — cumulative users by GitHub account creation month.
  const growthData = useMemo(() => {
    const monthCounts: Record<string, number> = {}
    chartUsers.forEach(u => {
      const ts = u.created_at
      if (!ts) return
      const month = ts.slice(0, 7) // "YYYY-MM"
      monthCounts[month] = (monthCounts[month] ?? 0) + 1
    })
    const sorted = Object.entries(monthCounts).sort(([a], [b]) => a.localeCompare(b))
    if (sorted.length < 2) return []
    let cumulative = 0
    return sorted.map(([month, count]) => {
      cumulative += count
      return { month, new: count, cumulative }
    })
  }, [chartUsers])

  if (doneJobs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center mt-24 space-y-4">
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center"
          style={{ background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.2)' }}
        >
          <Users size={28} style={{ color: '#a78bfa' }} />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-200">No results yet</h2>
          <p className="text-sm text-gray-500 mt-1 max-w-xs">
            Run a fetch to collect GitHub users from a repository. Results will appear here once complete.
          </p>
        </div>
        <button
          onClick={() => window.location.hash = 'fetch'}
          className="btn-primary flex items-center gap-2 text-sm mt-2"
        >
          Go to Fetch →
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Multi-repo tabs — shown when the latest fetch covered >1 repo */}
      {groupJobIds.length > 1 && (
        <div>
          <div className="text-xs text-gray-500 mb-1.5">Fetch run — select a repository:</div>
          <div className="flex gap-1.5 flex-wrap">
            {groupJobIds.map(jid => {
              const job = jobs.find(j => j.job_id === jid)
              if (!job) return null
              const isActive = activeJobId === jid
              return (
                <button
                  key={jid}
                  onClick={() => setActiveJobId(jid)}
                  className="text-sm px-3.5 py-1.5 rounded-lg font-medium transition-all"
                  style={isActive ? {
                    background: 'linear-gradient(135deg, #7c3aed, #2563eb)',
                    color: '#fff',
                    boxShadow: '0 0 12px rgba(124,58,237,0.4)',
                  } : {
                    background: 'rgba(255,255,255,0.06)',
                    color: '#9ca3af',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  {job.label ?? jid}
                  {job.total_fetched > 0 && (
                    <span className="ml-1.5 text-xs opacity-70">({job.total_fetched})</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 shrink-0">Filter by tag:</span>
          {allTags.map(tag => {
            const active = tagFilter.includes(tag)
            const color = getTagColor(tag)
            return (
              <button
                key={tag}
                onClick={() => setTagFilter(prev =>
                  prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
                )}
                className="text-xs px-2 py-0.5 rounded-full font-medium transition-all"
                style={{
                  background: active ? color : 'rgba(255,255,255,0.07)',
                  color: active ? '#fff' : '#9ca3af',
                  border: `1px solid ${active ? color : 'rgba(255,255,255,0.12)'}`,
                  boxShadow: active ? `0 0 8px ${color}55` : 'none',
                }}
              >
                {tag}
              </button>
            )
          })}
          {tagFilter.length > 0 && (
            <button
              onClick={() => setTagFilter([])}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors ml-1"
            >
              clear
            </button>
          )}
        </div>
      )}

      {/* Job selector */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm text-gray-400">Job:</label>
        <select
          className="input max-w-xs"
          value={activeJobId ?? ''}
          onChange={e => setActiveJobId(e.target.value)}
        >
          {filteredDoneJobs.map(j => (
            <option key={j.job_id} value={j.job_id}>
              {j.label ?? j.job_id} ({j.total_fetched} users)
            </option>
          ))}
        </select>
        {isReadOnly && (
          <span
            className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-md"
            style={{ background: 'rgba(56,189,248,0.10)', border: '1px solid rgba(56,189,248,0.3)', color: '#7dd3fc' }}
            title="Opened from a share link. This result set lives in your browser only — it is not saved to your account."
          >
            <Link size={11} /> Shared · read-only
          </span>
        )}
        {/* Relative timestamp for active job */}
        {activeJobId && (() => {
          const activeJob = doneJobs.find(j => j.job_id === activeJobId)
          const ts = activeJob?.created_at ?? activeJob?.timestamp
          return ts ? (
            <span className="flex items-center gap-1 text-xs text-gray-500">
              <Clock size={11} />{relativeTime(ts)}
            </span>
          ) : null
        })()
        }
        {/* Refresh active job — re-run with its original fetch parameters */}
        {activeJobId && onJobRefresh && !isReadOnly && (
          <button
            title="Refresh — re-fetch this repository with the same settings"
            disabled={refreshing}
            onClick={async () => {
              const job = doneJobs.find(j => j.job_id === activeJobId)
              setRefreshing(true)
              try {
                const { job_id } = await refreshJob(activeJobId)
                onJobRefresh(job_id, job?.label ?? activeJobId)
              } catch (e) {
                alert(e instanceof Error ? e.message : 'Refresh failed. Imported jobs cannot be refreshed.')
              } finally {
                setRefreshing(false)
              }
            }}
            className="p-1.5 rounded-sm text-gray-600 hover:text-blue-400 transition-colors disabled:opacity-40"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </button>
        )}
        {/* Delete active job */}
        {activeJobId && !isReadOnly && (
          <button
            title="Delete this job"
            onClick={() => {
              if (confirm('Delete this job and all its data? This cannot be undone.')) {
                onJobDelete?.(activeJobId)
              }
            }}
            className="p-1.5 rounded-sm text-gray-600 hover:text-red-400 transition-colors"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <Trash2 size={13} />
          </button>
        )}
        {/* Inline rename */}
        {activeJobId && !isReadOnly && (
          renamingJobId === activeJobId ? (
            <div className="flex items-center gap-1">
              <input
                ref={renameInputRef}
                className="input text-sm py-1 px-2 w-52"
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setRenamingJobId(null)
                }}
                autoFocus
                maxLength={120}
              />
              <button
                onClick={commitRename}
                title="Save name"
                className="p-1 rounded-sm text-green-400 hover:text-green-300 transition-colors"
              >
                <Check size={14} />
              </button>
              <button
                onClick={() => setRenamingJobId(null)}
                title="Cancel"
                className="p-1 rounded-sm text-gray-500 hover:text-gray-300 transition-colors"
              >
                <XIcon size={14} />
              </button>
            </div>
          ) : (
            <button
              title="Rename this job"
              onClick={() => {
                const current = doneJobs.find(j => j.job_id === activeJobId)?.label ?? ''
                setRenameValue(current)
                setRenamingJobId(activeJobId)
              }}
              className="p-1.5 rounded-sm text-gray-500 hover:text-gray-300 transition-colors"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              <Pencil size={13} />
            </button>
          )
        )}
        {/* Tag chips + edit */}
        {activeJobId && (() => {
          const activeJob = jobs.find(j => j.job_id === activeJobId)
          const tags = activeJob?.tags ?? []
          return (
            <div className="flex items-center gap-1.5 flex-wrap">
              {tags.map(tag => (
                <span
                  key={tag}
                  className="text-xs px-2 py-0.5 rounded-full font-medium"
                  style={{
                    background: `${getTagColor(tag)}22`,
                    color: getTagColor(tag),
                    border: `1px solid ${getTagColor(tag)}55`,
                  }}
                >
                  {tag}
                </span>
              ))}
              {taggingJobId === activeJobId ? (
                <div className="flex items-center gap-1">
                  <input
                    ref={tagInputRef}
                    className="input text-sm py-1 px-2 w-48"
                    placeholder="tag1, tag2, ..."
                    value={tagInput}
                    onChange={e => setTagInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitTags()
                      if (e.key === 'Escape') { setTaggingJobId(null); setTagInput('') }
                    }}
                  />
                  <button onClick={commitTags} title="Save tags" className="p-1 rounded-sm text-green-400 hover:text-green-300 transition-colors">
                    <Check size={14} />
                  </button>
                  <button onClick={() => { setTaggingJobId(null); setTagInput('') }} title="Cancel" className="p-1 rounded-sm text-gray-500 hover:text-gray-300 transition-colors">
                    <XIcon size={14} />
                  </button>
                </div>
              ) : (
                <button
                  title={tags.length > 0 ? 'Edit tags' : 'Add tags'}
                  onClick={() => openTagEditor(activeJobId)}
                  className="text-xs px-2 py-0.5 rounded-full transition-colors"
                  style={{ background: 'rgba(255,255,255,0.05)', color: '#6b7280', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  {tags.length > 0 ? '✎' : '＋ tag'}
                </button>
              )}
            </div>
          )
        })()}
        {loading && <Loader2 size={16} className="animate-spin text-brand-500" />}
        {/* Export buttons */}
        {activeJobId && (
          <div className="flex gap-2 ml-auto flex-wrap items-center">
            {/* Client-side exports serialise whatever is in `users`, so they
                stay disabled until the full result set has streamed in —
                otherwise the file silently contains only the loaded pages. */}
            {(['json', 'csv', 'xlsx'] as const).map(format => (
              <button
                key={format}
                onClick={() => openExportPicker(format)}
                disabled={!coverageComplete}
                title={!coverageComplete ? 'Waiting for the full result set to load…' : undefined}
                className="btn-secondary flex items-center gap-1.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Download size={14} /> {format === 'xlsx' ? 'Excel' : format.toUpperCase()}
              </button>
            ))}
            {/* Per-role CSV dropdown */}
            {users.length > 0 && (
              <div ref={roleExportRef} className="relative">
                <button
                  className="btn-secondary flex items-center gap-1.5 text-sm"
                  onClick={() => setShowRoleExport(v => !v)}
                >
                  <FileDown size={14} /> By Role <ChevronDown size={12} />
                </button>
                {showRoleExport && (
                  <div
                    className="absolute right-0 top-full mt-1 rounded-lg z-20 py-1 min-w-40"
                    style={{
                      background: 'rgba(14,10,36,0.97)',
                      border: '1px solid rgba(139,92,246,0.25)',
                      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                      backdropFilter: 'blur(12px)',
                    }}
                  >
                    {Array.from(new Set(users.flatMap(u => u.roles ?? []))).sort().map(role => (
                      <button
                        key={role}
                        className="w-full text-left text-sm px-3 py-1.5 transition-colors text-gray-300 hover:text-white"
                        style={{ background: 'transparent' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(139,92,246,0.12)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        onClick={() => { downloadRoleCsv(role); setShowRoleExport(false) }}
                      >
                        {role}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* Markdown export */}
            {summary && (
              <button
                onClick={exportMarkdown}
                className="btn-secondary flex items-center gap-1.5 text-sm"
              >
                <FileText size={14} /> Markdown
              </button>
            )}
            {/* Share (copy link) — needs a backend job, so not for shared views. */}
            {activeJobId && !isReadOnly && (
              <button
                onClick={handleShare}
                disabled={shareLoading}
                className="btn-secondary flex items-center gap-1.5 text-sm"
                title="Copy a 24-hour shareable link to clipboard"
              >
                {shareLoading
                  ? <Loader2 size={14} className="animate-spin" />
                  : shareCopied ? <Check size={14} className="text-emerald-400" /> : <Link size={14} />
                }
                {shareCopied ? 'Copied!' : 'Share'}
              </button>
            )}
            <button
              onClick={exportPdf}
              disabled={exporting || !summary}
              className="btn-primary flex items-center gap-1.5 text-sm disabled:opacity-50"
            >
              {exporting ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
              {exporting ? 'Generating…' : 'Export PDF'}
            </button>
          </div>
        )}
      </div>

      {error && <div className="text-red-400 bg-red-950 border border-red-800 rounded-lg p-3 text-sm">{error}</div>}

      {summary && (
        <div ref={reportRef} className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <SummaryCard icon={<Users size={18} />} label="Total" value={summary.total} gradient="linear-gradient(90deg,#a78bfa,#60a5fa)" />
            <SummaryCard icon={<Users size={18} />} label="Humans" value={summary.humans} gradient="linear-gradient(90deg,#34d399,#10b981)" />
            <SummaryCard icon={<Bot size={18} />} label="Bots" value={summary.bots} gradient="linear-gradient(90deg,#f87171,#ef4444)" />
            <SummaryCard
              icon={<MapPin size={18} />}
              label="Top Location"
              value={summary.top_locations[0]?.location
                ? summary.top_locations[0].location.charAt(0).toUpperCase() + summary.top_locations[0].location.slice(1)
                : '–'}
              gradient="linear-gradient(90deg,#fbbf24,#f59e0b)"
              small
            />
            <SummaryCard
              icon={<Building2 size={18} />}
              label="Top Company"
              value={summary.top_companies[0]?.company ?? '–'}
              gradient="linear-gradient(90deg,#c084fc,#a78bfa)"
              small
            />
            <SummaryCard
              icon={<Star size={18} />}
              label="Top Role"
              value={[...roleDistData].sort((a, b) => b.count - a.count)[0]?.role ?? '–'}
              gradient="linear-gradient(90deg,#38bdf8,#0ea5e9)"
              small
            />
          </div>

          {/* Ecosystem health badges */}
          {healthScore && (
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-xs text-gray-500 flex items-center gap-1 mr-1"><Shield size={11} /> Quick stats</span>
              {([
                // The server's count for the current filters — `users.length` is
                // whatever has streamed in so far, which contradicted the
                // summary card above it while pages were still loading.
                { label: 'total users', value: totalUsers.toLocaleString(), bg: '#7c3aed' },
                { label: 'active', value: `${healthScore.activeCount} (${healthScore.activeRatio}%)`, bg: '#059669' },
                { label: 'health score', value: `${healthScore.score}/100`, bg: healthScore.score >= 70 ? '#059669' : healthScore.score >= 40 ? '#d97706' : '#dc2626' },
                { label: 'avg account age', value: `${healthScore.avgAge}yr`, bg: '#0284c7' },
                { label: 'avg followers', value: String(healthScore.avgFollowers), bg: '#b45309' },
                { label: 'avg repos', value: String(healthScore.avgRepos), bg: '#6d28d9' },
              ] as { label: string; value: string; bg: string }[]).map(b => (
                <div key={b.label} className="flex items-stretch rounded-sm overflow-hidden text-xs font-mono select-none">
                  <div className="px-2 py-1 bg-gray-700 text-gray-300">{b.label}</div>
                  <div className="px-2 py-1 text-white font-bold" style={{ background: b.bg }}>{b.value}</div>
                </div>
              ))}
            </div>
          )}

          {jobWarnings.length > 0 && (
            <div
              className="rounded-lg px-3 py-2 text-xs"
              style={{
                background: 'rgba(217,119,6,0.1)',
                border: '1px solid rgba(217,119,6,0.25)',
                color: '#fcd34d',
              }}
            >
              <div className="flex items-center gap-1.5 font-medium mb-1">
                <Info size={12} className="shrink-0" />
                This fetch reported {jobWarnings.length} warning{jobWarnings.length === 1 ? '' : 's'} — the result set may be incomplete.
              </div>
              <ul className="space-y-0.5 ml-5 list-disc">
                {jobWarnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          {/* Everything below aggregates `users`, so say plainly when that is
              not yet (or cannot be) the whole result set. */}
          {(!coverageComplete || truncated) && (
            <div
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
              style={{
                background: truncated ? 'rgba(217,119,6,0.1)' : 'rgba(124,58,237,0.08)',
                border: `1px solid ${truncated ? 'rgba(217,119,6,0.25)' : 'rgba(124,58,237,0.2)'}`,
                color: truncated ? '#fcd34d' : '#c4b5fd',
              }}
            >
              {!coverageComplete
                ? <><Loader2 size={12} className="animate-spin shrink-0" />
                    Loading the full result set — charts below cover{' '}
                    {users.length.toLocaleString()} of {totalUsers.toLocaleString()} users so far.</>
                : <><Info size={12} className="shrink-0" />
                    This result set is larger than {MAX_CLIENT_ROWS.toLocaleString()} users. Charts and
                    exports cover the first {users.length.toLocaleString()} of{' '}
                    {totalUsers.toLocaleString()} matching users.</>}
            </div>
          )}

          {/* Charts row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Role distribution */}
            <div className="card">
              <h3 className="text-sm font-semibold gradient-heading mb-3 flex items-center gap-1.5">
                Role Distribution
                <ChartInfo text="Shows how many users fall into each fetched role (e.g. stargazers, contributors, maintainers)." />
              </h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={roleDistData} layout="vertical" margin={{ left: 10, right: 16 }}>
                  <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 11 }} />
                  <YAxis type="category" dataKey="role" width={100} tick={{ fill: '#9ca3af', fontSize: 11 }} />
                  <Tooltip
                    {...TOOLTIP_BASE}
                    cursor={BAR_CURSOR}
                    // Single series, so the bar colour carries no extra meaning
                    // in the tooltip — and several of the palette colours fall
                    // below 4.5:1 as text (purple 4.19, indigo 3.97).
                    itemStyle={{ color: '#e5e7eb' }}
                  />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {roleDistData.map(entry => (
                      <Cell
                        key={entry.role}
                        fill={ROLE_COLORS[entry.role]?.includes('emerald') ? '#10b981' :
                               ROLE_COLORS[entry.role]?.includes('purple') ? '#8b5cf6' :
                               ROLE_COLORS[entry.role]?.includes('yellow') ? '#f59e0b' :
                               ROLE_COLORS[entry.role]?.includes('blue') ? '#3b82f6' :
                               ROLE_COLORS[entry.role]?.includes('red') ? '#ef4444' :
                               ROLE_COLORS[entry.role]?.includes('orange') ? '#f97316' :
                               ROLE_COLORS[entry.role]?.includes('cyan') ? '#06b6d4' :
                               ROLE_COLORS[entry.role]?.includes('indigo') ? '#6366f1' :
                               '#ec4899'}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Account age distribution */}
            <div className="card">
              <h3 className="text-sm font-semibold gradient-heading mb-3 flex items-center gap-1.5">
                Account Age Distribution
                <ChartInfo text="Breaks down users by how long their GitHub account has been active." />
              </h3>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={ageDistData}
                    dataKey="count"
                    nameKey="band"
                    cx="50%"
                    cy="44%"
                    outerRadius={72}
                  >
                    {ageDistData.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 6 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, color: '#9ca3af' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Health score + Contributor funnel */}
          {(healthScore || funnelData.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {healthScore && (
                <div className="card">
                  <h3 className="text-sm font-semibold gradient-heading mb-4 flex items-center gap-1.5">
                    <Activity size={14} /> Community Health Score
                    <ChartInfo text="A composite score (0–100) reflecting the community’s activity level, average account age, followers, and public repo count." />
                  </h3>
                  <div className="flex items-center gap-6">
                    <div className="relative shrink-0">
                      <svg width="100" height="100" viewBox="0 0 100 100">
                        <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="9" />
                        <circle cx="50" cy="50" r="40" fill="none"
                          stroke={healthScore.score >= 70 ? '#10b981' : healthScore.score >= 40 ? '#f59e0b' : '#ef4444'}
                          strokeWidth="9" strokeLinecap="round"
                          strokeDasharray={`${2 * Math.PI * 40}`}
                          strokeDashoffset={`${2 * Math.PI * 40 * (1 - healthScore.score / 100)}`}
                          transform="rotate(-90 50 50)"
                        />
                      </svg>
                      <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="text-2xl font-bold text-white">{healthScore.score}</span>
                        <span className="text-xs text-gray-500">/ 100</span>
                      </div>
                    </div>
                    <div className="flex-1 space-y-2">
                      {([
                        { label: 'Recently active', value: `${healthScore.activeRatio}%`, sub: `${healthScore.activeCount} users`, color: '#10b981' },
                        { label: 'Avg account age', value: `${healthScore.avgAge} yr`, color: '#0ea5e9' },
                        { label: 'Avg followers', value: String(healthScore.avgFollowers), color: '#a78bfa' },
                        { label: 'Avg public repos', value: String(healthScore.avgRepos), color: '#f59e0b' },
                      ] as { label: string; value: string; sub?: string; color: string }[]).map(item => (
                        <div key={item.label} className="flex items-center justify-between gap-2">
                          <span className="text-xs text-gray-400">
                            {item.label}
                            {item.sub && <span className="text-gray-600 ml-1">({item.sub})</span>}
                          </span>
                          <span className="text-xs font-semibold" style={{ color: item.color }}>{item.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {funnelData.length > 0 && (
                <div className="card">
                  <h3 className="text-sm font-semibold gradient-heading mb-4 flex items-center gap-1.5">
                    <GitBranch size={14} /> Contributor Funnel
                    <ChartInfo text="Visualises engagement depth across roles — from casual stargazers at the top to active maintainers at the bottom." />
                  </h3>
                  <div className="space-y-2">
                    {funnelData.map((d, i) => (
                      <div key={d.role} className="flex items-center gap-2 text-xs">
                        <span className="text-gray-400 w-24 text-right truncate capitalize">{d.role.replace(/_/g, ' ')}</span>
                        <div className="flex-1 h-5 rounded-sm overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                          <div className="h-full rounded-sm" style={{ width: `${d.pct}%`, background: FUNNEL_COLORS[i % FUNNEL_COLORS.length] }} />
                        </div>
                        <span className="text-gray-300 w-10 text-right font-mono">{d.count.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Geographic distribution + Language landscape */}
          {(locationData.length > 0 || languageData.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {locationData.length > 0 && (
                <div className="card">
                  <h3 className="text-sm font-semibold gradient-heading mb-3 flex items-center gap-1.5">
                    <Globe size={14} /> Geographic Distribution
                    <ChartInfo text="Shows the most common locations of users based on their public GitHub profile." />
                  </h3>
                  <ResponsiveContainer width="100%" height={Math.min(locationData.length * 24 + 20, 300)}>
                    <BarChart data={locationData} layout="vertical" margin={{ left: 0, right: 36, top: 2, bottom: 2 }}>
                      <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                      <YAxis type="category" dataKey="location" width={140} tick={{ fill: '#9ca3af', fontSize: 10 }} />
                      <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 6 }} />
                      <Bar dataKey="count" fill="#0ea5e9" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              {languageData.length > 0 && (
                <div className="card">
                  <h3 className="text-sm font-semibold gradient-heading mb-3 flex items-center gap-1.5">
                    <Code2 size={14} /> Language Landscape
                    <ChartInfo text="Displays the most common programming languages used across users\u2019 public repositories." />
                  </h3>
                  <ResponsiveContainer width="100%" height={Math.min(languageData.length * 24 + 20, 300)}>
                    <BarChart data={languageData} layout="vertical" margin={{ left: 0, right: 36, top: 2, bottom: 2 }}>
                      <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                      <YAxis type="category" dataKey="language" width={140} tick={{ fill: '#9ca3af', fontSize: 10 }} />
                      <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 6 }} />
                      <Bar dataKey="count" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          )}

          {/* Org mapping + Email domain analysis */}
          {(orgData.length > 0 || emailDomainData.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {orgData.length > 0 && (
                <div className="card">
                  <h3 className="text-sm font-semibold gradient-heading mb-3 flex items-center gap-1.5">
                    <Building2 size={14} /> Organisational Mapping
                    <ChartInfo text="Lists the most common GitHub organisations that users are publicly members of." />
                  </h3>
                  <ResponsiveContainer width="100%" height={Math.min(orgData.length * 24 + 20, 280)}>
                    <BarChart data={orgData} layout="vertical" margin={{ left: 0, right: 36, top: 2, bottom: 2 }}>
                      <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                      <YAxis type="category" dataKey="org" width={140} tick={{ fill: '#9ca3af', fontSize: 10 }} />
                      <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 6 }} />
                      <Bar dataKey="count" fill="#f59e0b" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              {emailDomainData.length > 0 && (
                <div className="card">
                  <h3 className="text-sm font-semibold gradient-heading mb-3 flex items-center gap-1.5">
                    <Mail size={14} /> Email Domain Analysis
                    <ChartInfo text="Categorises users by email domain type: academic (.edu/.ac.uk), corporate, personal (Gmail etc.), or no email listed." />
                  </h3>
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie data={emailDomainData} dataKey="count" nameKey="type" cx="50%" cy="45%" outerRadius={80}>
                        {emailDomainData.map((entry, i) => (
                          <Cell key={entry.type + i} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 6 }} />
                      <Legend wrapperStyle={{ fontSize: 12, color: '#9ca3af' }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          )}

          {/* Social Presence by Role */}
          {socialPresenceData.rows.length > 0 && (
            <div className="card">
              <h3 className="text-sm font-semibold gradient-heading mb-3 flex items-center gap-1.5">
                <Share2 size={14} /> Social Presence by Role
                <ChartInfo text="Shows the percentage of users in each role with a public blog, Twitter/X, email, or GitHub org membership." />
              </h3>
              <p className="text-xs text-gray-500 mb-3">% of users in each role with a public blog, Twitter, email, or org membership</p>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={socialPresenceData.rows} margin={{ left: 0, right: 16, top: 4, bottom: 56 }}>
                  <XAxis
                    dataKey="role"
                    interval={0}
                    tick={(props: any) => (
                      <g transform={`translate(${props.x},${props.y})`}>
                        <text
                          x={0} y={0} dy={4}
                          textAnchor="end"
                          fill="#9ca3af"
                          fontSize={10}
                          transform="rotate(-35)"
                        >
                          {props.payload.value}
                        </text>
                      </g>
                    )}
                  />
                  <YAxis tickFormatter={(v: number) => `${v}%`} tick={{ fill: '#9ca3af', fontSize: 10 }} domain={[0, 100]} />
                  <Tooltip
                    formatter={(value: any, name: any) => [`${value}%`, name]}
                    contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 6 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, color: '#9ca3af' }} />
                  {socialPresenceData.signals.map(s => (
                    <Bar key={s.key} dataKey={s.label} stackId="a" fill={s.color} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Overlap analysis + Growth over time */}
          {(overlapData.totalMultiRole > 0 || growthData.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Overlap: role pair co-occurrence */}
              {overlapData.pairs.length > 0 && (
                <div className="card">
                  <h3 className="text-sm font-semibold gradient-heading mb-1 flex items-center gap-1.5">
                    <Layers size={14} /> Overlap Analysis
                    <ChartInfo text="Shows the most common role combinations. Users appearing in multiple roles are your most engaged community members." />
                  </h3>
                  <p className="text-xs text-gray-500 mb-3">
                    {overlapData.totalMultiRole} user{overlapData.totalMultiRole !== 1 ? 's' : ''} appear in 2+ roles
                  </p>
                  <ResponsiveContainer width="100%" height={Math.min(overlapData.pairs.length * 28 + 20, 260)}>
                    <BarChart data={overlapData.pairs} layout="vertical" margin={{ left: 0, right: 36, top: 2, bottom: 2 }}>
                      <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                      <YAxis type="category" dataKey="pair" width={190} tick={{ fill: '#9ca3af', fontSize: 10 }} />
                      <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 6 }} />
                      <Bar dataKey="count" fill="#a78bfa" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                  {overlapData.multiRole.length > 0 && (
                    <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                      <p className="text-xs text-gray-500 mb-2">Most engaged (most roles):</p>
                      <div className="flex flex-wrap gap-2">
                        {overlapData.multiRole.slice(0, 8).map(u => (
                          <a
                            key={u.login}
                            href={u.html_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors"
                            style={{
                              background: 'rgba(167,139,250,0.1)',
                              border: '1px solid rgba(167,139,250,0.25)',
                              color: '#c4b5fd',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(167,139,250,0.2)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(167,139,250,0.1)')}
                          >
                            <img src={u.avatar_url ?? ''} alt="" className="w-4 h-4 rounded-full" />
                            {u.login}
                            <span className="opacity-60">×{u.roles?.length}</span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Growth over time */}
              {growthData.length > 0 && (
                <div className="card">
                  <h3 className="text-sm font-semibold gradient-heading mb-1 flex items-center gap-1.5">
                    <TrendingUp size={14} /> Growth Over Time
                    <ChartInfo text="Cumulative count of users by their GitHub account creation date. Spikes indicate periods of high community growth." />
                  </h3>
                  <p className="text-xs text-gray-500 mb-3">
                    Cumulative user joins by GitHub account creation date
                  </p>
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={growthData} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
                      <defs>
                        <linearGradient id="growthGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="month"
                        tick={{ fill: '#6b7280', fontSize: 9 }}
                        tickFormatter={(v: string) => v.slice(0, 7)}
                        interval="preserveStartEnd"
                      />
                      <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} width={40} />
                      <Tooltip
                        contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 6 }}
                        labelFormatter={(l: any) => `Month: ${l}`}
                        formatter={(value: any, name: any) => [Number(value).toLocaleString(), name === 'cumulative' ? 'Total' : 'New']}
                      />
                      <Area
                        type="monotone"
                        dataKey="cumulative"
                        stroke="#8b5cf6"
                        strokeWidth={2}
                        fill="url(#growthGrad)"
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          )}

          {/* Membership over time — joiners, leavers and retention across runs */}
          {history && history.total_runs > 1 && (
            <div className="card">
              <h3 className="text-sm font-semibold gradient-heading mb-3 flex items-center gap-1.5">
                <TrendingUp size={14} /> Membership Over Time
                <ChartInfo text="Compares every completed fetch of this repository: who joined, who left, and what share of the previous run's members are still present." />
              </h3>
              <div className="flex flex-wrap gap-2 items-center mb-3">
                {([
                  { label: 'runs', value: String(history.total_runs), bg: '#7c3aed' },
                  { label: 'net change', value: `${(history.net_change ?? 0) >= 0 ? '+' : ''}${history.net_change ?? 0}`, bg: (history.net_change ?? 0) >= 0 ? '#059669' : '#dc2626' },
                  { label: 'core members', value: String(history.core_members ?? 0), bg: '#0284c7' },
                ] as { label: string; value: string; bg: string }[]).map(b => (
                  <div key={b.label} className="flex items-stretch rounded-sm overflow-hidden text-xs font-mono select-none">
                    <div className="px-2 py-1 bg-gray-700 text-gray-300">{b.label}</div>
                    <div className="px-2 py-1 text-white font-bold" style={{ background: b.bg }}>{b.value}</div>
                  </div>
                ))}
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart
                  data={history.runs.map((r, i) => ({
                    run: `#${i + 1}`,
                    total: r.total,
                    joined: r.joined_count,
                    left: -r.left_count,
                    retention: r.retention_pct,
                  }))}
                  margin={{ left: 0, right: 16, top: 4, bottom: 2 }}
                >
                  <XAxis dataKey="run" tick={{ fill: '#9ca3af', fontSize: 11 }} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 6 }} />
                  <Legend wrapperStyle={{ fontSize: 11, color: '#9ca3af' }} />
                  <Line type="monotone" dataKey="total" name="Members" stroke="#a78bfa" strokeWidth={2} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="joined" name="Joined" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="left" name="Left" stroke="#ef4444" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
              {/* Most recent delta, named */}
              {(() => {
                const latest = history.runs[history.runs.length - 1]
                if (!latest || (!latest.joined.length && !latest.left.length)) return null
                return (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                    {([
                      { icon: <UserPlus size={11} />, title: 'Joined since last run', logins: latest.joined, color: '#10b981' },
                      { icon: <UserMinus size={11} />, title: 'Left since last run', logins: latest.left, color: '#ef4444' },
                    ] as { icon: React.ReactNode; title: string; logins: string[]; color: string }[]).map(group => (
                      <div key={group.title}>
                        <div className="text-xs mb-1.5 flex items-center gap-1" style={{ color: group.color }}>
                          {group.icon} {group.title} ({group.logins.length})
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {group.logins.slice(0, 24).map(login => (
                            <span
                              key={login}
                              className="badge text-xs font-mono"
                              style={{ background: `${group.color}18`, color: group.color, border: `1px solid ${group.color}44` }}
                            >
                              {login}
                            </span>
                          ))}
                          {group.logins.length > 24 && (
                            <span className="text-xs text-gray-600 self-center">+{group.logins.length - 24} more</span>
                          )}
                          {group.logins.length === 0 && <span className="text-xs text-gray-600">none</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
          )}

          {/* Scheduled re-fetch — requires a backend job, so hidden for a
              read-only shared view whose id the server never created. */}
          {!isReadOnly && (
          <div className="card">
            <h3 className="text-sm font-semibold gradient-heading mb-3 flex items-center gap-1.5">
              <CalendarClock size={14} /> Scheduled Re-fetch
              <ChartInfo text="Re-runs this fetch automatically on a fixed interval. Each run becomes a new job, so Membership Over Time builds up a history without you doing anything." />
            </h3>
            {history === null && (
              <p className="text-xs text-gray-500 mb-3">
                Imported jobs have no saved fetch parameters, so they cannot be scheduled.
              </p>
            )}
            {history !== null && (
              <div className="flex items-center gap-2 flex-wrap mb-3">
                <label className="text-xs text-gray-400">Run every</label>
                <select
                  className="input text-sm py-1 px-2 w-36"
                  value={scheduleInterval}
                  onChange={e => setScheduleInterval(Number(e.target.value))}
                >
                  <option value={24}>day</option>
                  <option value={168}>week</option>
                  <option value={336}>2 weeks</option>
                  <option value={720}>30 days</option>
                </select>
                <button
                  onClick={handleCreateSchedule}
                  disabled={schedulingBusy}
                  className="btn-secondary flex items-center gap-1.5 text-sm disabled:opacity-40"
                >
                  {schedulingBusy ? <Loader2 size={13} className="animate-spin" /> : <CalendarClock size={13} />}
                  Schedule
                </button>
              </div>
            )}
            {jobSchedules.length === 0 ? (
              <p className="text-xs text-gray-600">
                No schedule for this job yet.
                {schedules.length > 0 && ` (${schedules.length} on other jobs)`}
              </p>
            ) : (
              <div className="space-y-1.5">
                {jobSchedules.map(s => (
                  <div
                    key={s.schedule_id}
                    className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
                  >
                    <span className="font-mono text-xs text-gray-200 truncate flex-1">
                      {s.label ?? s.source_job_id}
                    </span>
                    <span className="text-xs text-gray-500 shrink-0">
                      every {s.interval_hours}h · next {(s.next_run_at ?? '').slice(0, 16).replace('T', ' ')}
                    </span>
                    <button
                      onClick={() => handleToggleSchedule(s)}
                      title={s.enabled ? 'Pause' : 'Resume'}
                      className="p-1 rounded-sm text-gray-500 hover:text-white transition-colors"
                    >
                      {s.enabled ? <Pause size={13} /> : <Play size={13} />}
                    </button>
                    <button
                      onClick={() => handleDeleteSchedule(s.schedule_id)}
                      title="Delete schedule"
                      className="p-1 rounded-sm text-gray-600 hover:text-red-400 transition-colors"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          )}

          {/* Top N leaderboard */}
          <div className="card">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h3 className="text-sm font-semibold gradient-heading">Top 10 Users</h3>
              <div className="flex gap-1">
                {TOP_BY_OPTIONS.map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => setTopBy(opt.key)}
                    className="text-xs px-3 py-1 rounded-lg transition-all text-white"
                    style={topBy === opt.key ? {
                      background: 'linear-gradient(135deg, #7c3aed, #2563eb)',
                      boxShadow: '0 0 10px rgba(124,58,237,0.35)',
                    } : {
                      background: 'rgba(255,255,255,0.07)',
                      color: '#9ca3af',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              {Array.isArray(topUsers) && topUsers.map((u, i) => {
                const stat = (u as unknown as Record<string, unknown>)[topBy]
                return (
                  <div
                    key={u.login}
                    className="flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors"
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(139,92,246,0.08)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    onClick={() => setSelectedUser(u)}
                  >
                    <span className="text-gray-500 text-sm w-5 text-right">{i + 1}</span>
                    <img src={u.avatar_url ?? ''} alt="" className="w-7 h-7 rounded-full" crossOrigin="anonymous" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{u.name || u.login}</div>
                      <div className="text-xs text-gray-500">@{u.login}</div>
                    </div>
                    <div className="text-sm font-semibold" style={{
                      background: 'linear-gradient(90deg, #a78bfa, #60a5fa)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                    }}>
                      {typeof stat === 'number' ? stat.toLocaleString() : String(stat ?? '–')}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* World Map */}
          {users.length > 0 && (
            <Suspense fallback={null}>
              <WorldMap users={users} />
            </Suspense>
          )}

          {/* Data table — filters, search and sort are applied server-side */}
          <div className="card">
            <h3 className="text-sm font-semibold gradient-heading mb-3">All Users</h3>
            <UserTable
              users={users}
              onRowClick={setSelectedUser}
              filters={filters}
              onFiltersChange={setFilters}
              search={search}
              onSearchChange={setSearch}
              sorting={sorting}
              onSortingChange={setSorting}
              totalUsers={totalUsers}
              unfilteredTotal={unfilteredTotal}
              loadingMore={loadingMore}
            />
          </div>
        </div>
      )}

      {/* Export field picker modal */}
      {exportPickerFormat && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
          onClick={() => setExportPickerFormat(null)}
        >
          <div
            className="relative w-full max-w-lg flex flex-col rounded-2xl overflow-hidden"
            style={{ background: '#0f0a1e', border: '1px solid rgba(139,92,246,0.25)', maxHeight: '85vh' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
              <div>
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Download size={14} className="text-purple-400" />
                  Export as {exportPickerFormat.toUpperCase()}
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">Select which fields to include — {exportPickerFields.length} / {allUserFields.length} selected · <span className="text-purple-400 font-medium">login</span> always included</p>
              </div>
              <button
                onClick={() => setExportPickerFormat(null)}
                className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/10 transition-all"
              >
                <XIcon size={16} />
              </button>
            </div>

            {/* Select all / none */}
            <div className="flex gap-2 px-5 py-2.5 border-b border-white/5">
              <button
                className="text-xs px-3 py-1 rounded-lg transition-all"
                style={{ background: 'rgba(139,92,246,0.15)', color: '#c4b5fd' }}
                onClick={() => setExportPickerFields(allUserFields)}
              >
                Select all
              </button>
              <button
                className="text-xs px-3 py-1 rounded-lg transition-all"
                style={{ background: 'rgba(255,255,255,0.06)', color: '#9ca3af' }}
                onClick={() => setExportPickerFields([])}
              >
                Deselect all
              </button>
            </div>

            {/* Field checklist */}
            <div className="overflow-y-auto flex-1 px-3 py-3 grid grid-cols-2 gap-0.5">
              {allUserFields.map(field => {
                const checked = exportPickerFields.includes(field)
                return (
                  <button
                    key={field}
                    onClick={() => setExportPickerFields(prev =>
                      checked ? prev.filter(f => f !== field) : [...prev, field]
                    )}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-all"
                    style={{ background: checked ? 'rgba(139,92,246,0.1)' : 'transparent' }}
                    onMouseEnter={e => { if (!checked) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = checked ? 'rgba(139,92,246,0.1)' : 'transparent' }}
                  >
                    <div
                      className="w-4 h-4 rounded-sm shrink-0 flex items-center justify-center border"
                      style={{
                        borderColor: checked ? '#7c3aed' : 'rgba(255,255,255,0.15)',
                        background: checked ? '#7c3aed' : 'transparent',
                      }}
                    >
                      {checked && <Check size={10} strokeWidth={3} className="text-white" />}
                    </div>
                    <span className="text-xs font-mono truncate" style={{ color: checked ? '#e2d9f3' : '#9ca3af' }}>{field}</span>
                  </button>
                )
              })}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-white/5">
              <button
                onClick={() => setExportPickerFormat(null)}
                className="text-sm px-4 py-2 rounded-lg transition-all"
                style={{ background: 'rgba(255,255,255,0.06)', color: '#9ca3af' }}
              >
                Cancel
              </button>
              <button
                onClick={runFilteredExport}
                disabled={exportPickerFields.length === 0}
                className="text-sm px-4 py-2 rounded-lg font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                style={{ background: 'linear-gradient(135deg, #7c3aed, #2563eb)', color: 'white' }}
              >
                <Download size={13} /> Download {exportPickerFormat.toUpperCase()}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* User detail drawer */}
      {selectedUser && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setSelectedUser(null)} />
          <Suspense fallback={null}>
            <UserDrawer user={selectedUser} onClose={() => setSelectedUser(null)} />
          </Suspense>
        </>
      )}
    </div>
  )
}

function SummaryCard({
  icon,
  label,
  value,
  gradient,
  small = false,
}: {
  icon: React.ReactNode
  label: string
  value: string | number
  gradient?: string
  small?: boolean
  color?: string
}) {
  return (
    <div className="card flex flex-col gap-1" style={{ background: 'rgba(255,255,255,0.04)' }}>
      <div className="flex items-center gap-1.5 text-gray-400 text-xs">{icon}{label}</div>
      <div
        className={`font-bold ${small ? 'text-sm truncate' : 'text-2xl'}`}
        title={small && typeof value === 'string' ? value : undefined}
        style={gradient ? {
          background: gradient,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        } : {}}
      >
        {value}
      </div>
    </div>
  )
}

function ChartInfo({ text }: { text: string }) {
  return (
    <div className="relative group ml-auto shrink-0">
      <Info size={12} className="text-gray-500 hover:text-gray-300 cursor-default transition-colors" />
      <div
        className="pointer-events-none absolute z-50 right-0 bottom-full mb-2 w-56 rounded-xl p-3 text-xs text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{
          background: 'rgba(15,12,35,0.97)',
          border: '1px solid rgba(139,92,246,0.3)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}
      >
        {text}
      </div>
    </div>
  )
}
