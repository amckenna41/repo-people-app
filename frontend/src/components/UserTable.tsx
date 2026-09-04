import { useMemo, useRef, useEffect, useState } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ExternalLink, ChevronUp, ChevronDown, ChevronsUpDown, Eye, X, CheckSquare,
  Square, Filter, AlertTriangle, Bookmark, Loader2, Trash2,
} from 'lucide-react'
import type { UserRecord } from '../types'
import RoleBadges from './RoleBadges'
import {
  type FilterState, type Segment, EMPTY_FILTERS,
  loadSegments, saveSegment, deleteSegment, activeFilterCount,
} from '../utils/segments'

interface Props {
  /** Rows for the pages loaded so far. Already filtered and sorted server-side. */
  users: UserRecord[]
  onRowClick: (user: UserRecord) => void
  /** Filtering, search and sort are controlled by the parent so they can be sent
   *  to the server. Applying them here would only ever see the loaded pages. */
  filters: FilterState
  onFiltersChange: (filters: FilterState) => void
  search: string
  onSearchChange: (search: string) => void
  sorting: SortingState
  onSortingChange: (sorting: SortingState) => void
  /** Total matching the current filters, server-side. */
  totalUsers: number
  /** Total ignoring filters — used for the "x of y" summary. */
  unfilteredTotal: number
  /** True while the parent is still pulling the remaining pages. */
  loadingMore: boolean
}

const col = createColumnHelper<UserRecord>()

const ROW_HEIGHT = 44 // px — approximate height of a single table row

// ---------------------------------------------------------------------------
// Bot-likelihood heuristic
// ---------------------------------------------------------------------------
// Returns a score 0–100. Score ≥ 60 = "likely bot / spam account".
// Mirrored server-side in main.py::_bot_score so the hide-bots filter agrees
// with the badge shown here.

function computeBotScore(u: UserRecord): number {
  if (u.is_bot) return 100
  let score = 0
  if (!u.followers || u.followers === 0) score += 25
  if (!u.public_repos || u.public_repos === 0) score += 20
  if (u.account_age_days !== undefined && u.account_age_days < 180) score += 20
  if (!u.name && !u.bio && !u.location) score += 15
  // Looks like a generated login: lower-case word(s) followed by 6+ digits
  if (u.login && /^[a-z][-a-z]*\d{6,}$/i.test(u.login)) score += 20
  return Math.min(score, 100)
}

const COL_VIS_KEY = 'repo-people-col-visibility'

const DEFAULT_COL_VISIBILITY: Record<string, boolean> = {
  bio: false,
  email_public: false,
  blog: false,
  twitter: false,
  public_gists: false,
  account_age_days: false,
  followers_following_ratio: false,
  repos_per_year: false,
  total_public_stars_sampled: false,
  total_public_forks_sampled: false,
  bot_score: false,
}

function loadColVisibility(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COL_VIS_KEY)
    return raw ? { ...DEFAULT_COL_VISIBILITY, ...JSON.parse(raw) } : DEFAULT_COL_VISIBILITY
  } catch {
    return DEFAULT_COL_VISIBILITY
  }
}

const inputStyle = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.10)',
  color: '#e5e7eb',
}

export default function UserTable({
  users, onRowClick, filters, onFiltersChange, search, onSearchChange,
  sorting, onSortingChange, totalUsers, unfilteredTotal, loadingMore,
}: Props) {
  const [showFilterPanel, setShowFilterPanel] = useState(false)
  const [segments, setSegments] = useState<Segment[]>(loadSegments)
  const [segmentName, setSegmentName] = useState('')

  const activeCount = useMemo(() => activeFilterCount(filters), [filters])

  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>(loadColVisibility)
  const [showVisibilityMenu, setShowVisibilityMenu] = useState(false)
  const [visibilitySearch, setVisibilitySearch] = useState('')
  const visMenuRef = useRef<HTMLDivElement>(null)
  const tableBodyRef = useRef<HTMLDivElement>(null)

  function patchFilters(patch: Partial<FilterState>) {
    onFiltersChange({ ...filters, ...patch })
  }

  function resetFilters() {
    onFiltersChange({ ...EMPTY_FILTERS })
  }

  function clearAllFilters() {
    onSearchChange('')
    resetFilters()
  }

  // Persist column visibility to localStorage whenever it changes
  useEffect(() => {
    try { localStorage.setItem(COL_VIS_KEY, JSON.stringify(columnVisibility)) } catch { /* storage full */ }
  }, [columnVisibility])

  // Close the column menu on outside click
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (visMenuRef.current && !visMenuRef.current.contains(e.target as Node)) {
        setShowVisibilityMenu(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  // Jump back to the top whenever the server returns a different result set.
  useEffect(() => {
    if (tableBodyRef.current) tableBodyRef.current.scrollTop = 0
  }, [search, filters, sorting])

  const columns = useMemo(() => [
    col.accessor('avatar_url', {
      header: '',
      enableSorting: false,
      cell: info => (
        <img
          src={info.getValue() ?? ''}
          alt=""
          className="w-7 h-7 rounded-full"
        />
      ),
    }),
    col.accessor('login', {
      header: 'Login',
      cell: info => {
        const score = computeBotScore(info.row.original)
        return (
          <span className="flex items-center gap-1.5">
            {score >= 60 && (
              <span title={`Likely bot/spam (score ${score})`}>
                <AlertTriangle size={11} className="text-amber-400 shrink-0" />
              </span>
            )}
            <a
              href={info.row.original.html_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="text-brand-400 hover:underline flex items-center gap-1"
              style={{ color: '#a78bfa' }}
            >
              {info.getValue()} <ExternalLink size={10} />
            </a>
          </span>
        )
      },
    }),
    col.accessor('name', { header: 'Name', cell: i => i.getValue() || '–' }),
    col.accessor('location', { header: 'Location', cell: i => i.getValue() || '–' }),
    col.accessor('company', { header: 'Company', cell: i => i.getValue() || '–' }),
    col.accessor('followers', { header: 'Followers', cell: i => i.getValue() ?? '–' }),
    col.accessor('public_repos', { header: 'Repos', cell: i => i.getValue() ?? '–' }),
    col.accessor('top_languages', {
      header: 'Top Languages',
      enableSorting: false,
      cell: info => {
        const langs = info.getValue() ?? []
        return (
          <div className="flex flex-wrap gap-1">
            {langs.slice(0, 3).map(([lang]) => (
              <span key={lang} className="badge bg-gray-700 text-gray-300">{lang}</span>
            ))}
          </div>
        )
      },
    }),
    col.accessor('roles', {
      header: 'Roles',
      enableSorting: false,
      cell: info => <RoleBadges roles={info.getValue() ?? []} />,
    }),
    col.accessor('recently_active', {
      header: 'Active',
      cell: info => (
        <span
          className={`inline-block w-2.5 h-2.5 rounded-full ${info.getValue() ? 'bg-emerald-400' : 'bg-gray-600'}`}
          title={info.getValue() ? 'Recently active' : 'Inactive'}
        />
      ),
    }),
    // Hidden by default columns
    col.accessor('bio', { header: 'Bio', cell: i => i.getValue() || '–' }),
    col.accessor('email_public', { header: 'Email', cell: i => i.getValue() || '–' }),
    col.accessor('blog', { header: 'Blog', cell: i => i.getValue() || '–' }),
    col.accessor('twitter', { header: 'Twitter', cell: i => i.getValue() || '–' }),
    col.accessor('public_gists', { header: 'Gists', cell: i => i.getValue() ?? '–' }),
    col.accessor('account_age_days', { header: 'Age (days)', cell: i => i.getValue() ?? '–' }),
    col.accessor('followers_following_ratio', { header: 'F/F Ratio', cell: i => i.getValue()?.toFixed(2) ?? '–' }),
    col.accessor('repos_per_year', { header: 'Repos/yr', cell: i => i.getValue()?.toFixed(2) ?? '–' }),
    col.accessor('total_public_stars_sampled', { header: 'Stars', cell: i => i.getValue() ?? '–' }),
    col.accessor('total_public_forks_sampled', { header: 'Forks', cell: i => i.getValue() ?? '–' }),
    // Computed column — bot heuristic score (0–100). Hidden by default.
    // Sorted client-side only, since the server has no such stored field.
    {
      id: 'bot_score',
      header: 'Bot Score',
      enableSorting: false,
      accessorFn: (u: UserRecord) => computeBotScore(u),
      cell: (info: { getValue: () => unknown }) => {
        const score = info.getValue() as number
        const color = score >= 60 ? '#fbbf24' : score >= 30 ? '#94a3b8' : '#34d399'
        return <span style={{ color, fontVariantNumeric: 'tabular-nums' }}>{score}</span>
      },
    },
  ], [])

  const table = useReactTable({
    data: users,
    columns,
    state: { sorting, columnVisibility },
    // Sorting is applied by the server across the whole result set; the client
    // model would only reorder the pages already loaded.
    manualSorting: true,
    onSortingChange: updater => {
      onSortingChange(typeof updater === 'function' ? updater(sorting) : updater)
    },
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
  })

  function showAllColumns() {
    const allVisible: Record<string, boolean> = {}
    table.getAllLeafColumns().forEach(c => { allVisible[c.id] = true })
    setColumnVisibility(allVisible)
  }

  function hideAllColumns() {
    const allHidden: Record<string, boolean> = {}
    table.getAllLeafColumns().forEach(c => { allHidden[c.id] = c.id === 'avatar_url' })
    setColumnVisibility(allHidden)
  }

  const allRows = table.getRowModel().rows
  const virtualizer = useVirtualizer({
    count: allRows.length,
    getScrollElement: () => tableBodyRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const totalVirtualHeight = virtualizer.getTotalSize()

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">

        {/* Search — matches login, name, company, location and bio server-side */}
        <div className="relative max-w-xs w-full" style={{ minWidth: 200 }}>
          <div className="input flex items-center gap-1.5 pr-2" style={{ padding: '0 8px' }}>
            <input
              className="flex-1 bg-transparent outline-hidden text-sm py-2 min-w-0"
              placeholder="Search all users…"
              value={search}
              onChange={e => onSearchChange(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="text-gray-500 hover:text-gray-200 shrink-0 transition-colors"
                onPointerDown={e => { e.preventDefault(); onSearchChange('') }}
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>

        {/* Clear filters */}
        {(search || activeCount > 0) && (
          <button
            type="button"
            onClick={clearAllFilters}
            className="btn-secondary flex items-center gap-1.5 text-sm"
          >
            <X size={13} /> Clear Filters
          </button>
        )}

        {/* Advanced filters toggle */}
        <button
          type="button"
          onClick={() => setShowFilterPanel(v => !v)}
          className="btn-secondary flex items-center gap-1.5 text-sm relative"
          style={showFilterPanel ? { borderColor: 'rgba(139,92,246,0.5)', color: '#c4b5fd' } : {}}
        >
          <Filter size={13} />
          Filters
          {activeCount > 0 && (
            <span
              className="absolute -top-1.5 -right-1.5 text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center"
              style={{ background: '#7c3aed', color: '#fff' }}
            >
              {activeCount}
            </span>
          )}
        </button>

        {/* Column visibility */}
        <div ref={visMenuRef} className="relative">
          <button
            className="btn-secondary flex items-center gap-1.5 text-sm"
            onClick={() => setShowVisibilityMenu(v => !v)}
          >
            <Eye size={14} /> Columns
          </button>
          {showVisibilityMenu && (
            <div className="absolute left-0 top-full mt-1 rounded-lg shadow-xl z-20 p-3 space-y-2 w-[30rem] max-w-[calc(100vw-2rem)]" style={{
              background: 'rgba(20,16,48,0.97)',
              border: '1px solid rgba(255,255,255,0.10)',
              backdropFilter: 'blur(12px)',
            }}>
              {/* Search bar */}
              <input
                type="text"
                placeholder="Search columns…"
                value={visibilitySearch}
                onChange={e => setVisibilitySearch(e.target.value)}
                className="w-full bg-transparent outline-hidden text-xs px-2 py-1.5 rounded-md"
                style={inputStyle}
              />
              {/* Select / Deselect all columns buttons */}
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className="flex-1 flex items-center gap-1.5 text-xs text-left px-2 py-1.5 rounded-md transition-colors"
                  style={{ background: 'rgba(139,92,246,0.12)', color: '#a78bfa' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(139,92,246,0.22)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'rgba(139,92,246,0.12)')}
                  onClick={showAllColumns}
                >
                  <CheckSquare size={12} /> Select All
                </button>
                <button
                  type="button"
                  className="flex-1 flex items-center gap-1.5 text-xs text-left px-2 py-1.5 rounded-md transition-colors"
                  style={{ background: 'rgba(75,85,99,0.18)', color: '#9ca3af' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(75,85,99,0.32)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'rgba(75,85,99,0.18)')}
                  onClick={hideAllColumns}
                >
                  <Square size={12} /> Deselect All
                </button>
              </div>
              <div className="grid grid-cols-3 gap-x-2 gap-y-0.5 max-h-72 overflow-y-auto">
                {table.getAllLeafColumns()
                  .filter(c => c.id !== 'avatar_url' && c.id.toLowerCase().includes(visibilitySearch.toLowerCase()))
                  .map(c => (
                  <label
                    key={c.id}
                    title={c.id}
                    className="flex items-center gap-2 text-xs cursor-pointer min-w-0 px-1 py-0.5 rounded-sm hover:bg-white/5"
                  >
                    <input
                      type="checkbox"
                      checked={c.getIsVisible()}
                      onChange={c.getToggleVisibilityHandler()}
                      className="accent-brand-500 shrink-0"
                    />
                    {/* Ids like `location_normalized` and `account_age_days` are
                        longer than a narrow grid cell; without min-w-0 the flex
                        item refuses to shrink and the text runs into its
                        neighbour instead of truncating. */}
                    <span className="truncate">{c.id}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <span className="text-sm text-gray-500 ml-auto">
          {totalUsers.toLocaleString()}
          {totalUsers !== unfilteredTotal && ` of ${unfilteredTotal.toLocaleString()}`} users
        </span>
      </div>

      {/* Advanced filter panel */}
      {showFilterPanel && (
        <div
          className="rounded-xl p-4 space-y-3"
          style={{ background: 'rgba(20,16,48,0.95)', border: '1px solid rgba(139,92,246,0.25)' }}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Location contains</label>
              <input
                type="text"
                className="w-full text-sm rounded-md px-2 py-1.5 outline-hidden"
                style={inputStyle}
                placeholder="e.g. London"
                value={filters.location}
                onChange={e => patchFilters({ location: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Company contains</label>
              <input
                type="text"
                className="w-full text-sm rounded-md px-2 py-1.5 outline-hidden"
                style={inputStyle}
                placeholder="e.g. Google"
                value={filters.company}
                onChange={e => patchFilters({ company: e.target.value })}
              />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs text-gray-400 mb-1">Min followers</label>
                <input
                  type="number"
                  min={0}
                  className="w-full text-sm rounded-md px-2 py-1.5 outline-hidden"
                  style={inputStyle}
                  placeholder="0"
                  value={filters.minFollowers}
                  onChange={e => patchFilters({ minFollowers: e.target.value })}
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-gray-400 mb-1">Max followers</label>
                <input
                  type="number"
                  min={0}
                  className="w-full text-sm rounded-md px-2 py-1.5 outline-hidden"
                  style={inputStyle}
                  placeholder="∞"
                  value={filters.maxFollowers}
                  onChange={e => patchFilters({ maxFollowers: e.target.value })}
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Joined after</label>
              <input
                type="date"
                className="w-full text-sm rounded-md px-2 py-1.5 outline-hidden"
                style={{ ...inputStyle, colorScheme: 'dark' }}
                value={filters.joinedAfter}
                onChange={e => patchFilters({ joinedAfter: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Joined before</label>
              <input
                type="date"
                className="w-full text-sm rounded-md px-2 py-1.5 outline-hidden"
                style={{ ...inputStyle, colorScheme: 'dark' }}
                value={filters.joinedBefore}
                onChange={e => patchFilters({ joinedBefore: e.target.value })}
              />
            </div>
            <div className="flex flex-col justify-end">
              <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
                <input
                  type="checkbox"
                  className="accent-amber-400"
                  checked={filters.hideBots}
                  onChange={e => patchFilters({ hideBots: e.target.checked })}
                />
                <span className="text-gray-300 flex items-center gap-1">
                  <AlertTriangle size={12} className="text-amber-400" />
                  Hide likely bots
                </span>
              </label>
              <p className="text-[10px] text-gray-600 mt-0.5 ml-5">Hides accounts scoring ≥ 60 on the spam heuristic</p>
            </div>
          </div>

          {/* Saved segments */}
          <div className="pt-3 space-y-2" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-500 flex items-center gap-1">
                <Bookmark size={11} /> Saved segments
              </span>
              {segments.length === 0 && (
                <span className="text-xs text-gray-600">none yet — set some filters and save them</span>
              )}
              {segments.map(seg => (
                <span
                  key={seg.name}
                  className="flex items-center gap-1 text-xs rounded-full pl-2.5 pr-1 py-0.5"
                  style={{ background: 'rgba(139,92,246,0.14)', border: '1px solid rgba(139,92,246,0.35)' }}
                >
                  <button
                    type="button"
                    onClick={() => onFiltersChange({ ...seg.filters })}
                    className="text-purple-300 hover:text-white transition-colors"
                    title={`Apply "${seg.name}"`}
                  >
                    {seg.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSegments(prev => deleteSegment(seg.name, prev))}
                    className="text-gray-500 hover:text-red-400 transition-colors p-0.5"
                    title={`Delete "${seg.name}"`}
                  >
                    <Trash2 size={10} />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                className="text-sm rounded-md px-2 py-1.5 outline-hidden w-48"
                style={inputStyle}
                placeholder="Name this filter set…"
                value={segmentName}
                onChange={e => setSegmentName(e.target.value)}
                onKeyDown={e => {
                  if (e.key !== 'Enter' || !segmentName.trim()) return
                  setSegments(prev => saveSegment(segmentName, filters, prev))
                  setSegmentName('')
                }}
              />
              <button
                type="button"
                disabled={!segmentName.trim() || activeCount === 0}
                onClick={() => {
                  setSegments(prev => saveSegment(segmentName, filters, prev))
                  setSegmentName('')
                }}
                className="btn-secondary text-xs disabled:opacity-40 disabled:cursor-not-allowed"
                title={activeCount === 0 ? 'Set at least one filter first' : 'Save these filters'}
              >
                Save segment
              </button>
              {activeCount > 0 && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1 ml-auto"
                >
                  <X size={11} /> Reset all filters
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Virtualised table — only visible rows are rendered in the DOM */}
      <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
        {/* Fixed header */}
        <table className="w-full text-sm">
          <thead style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            {table.getHeaderGroups().map(hg => (
              <tr key={hg.id}>
                {hg.headers.map(header => (
                  <th
                    key={header.id}
                    className="text-left px-3 py-2.5 text-xs text-gray-400 font-medium whitespace-nowrap select-none"
                    onClick={header.column.getToggleSortingHandler()}
                    style={{ cursor: header.column.getCanSort() ? 'pointer' : 'default' }}
                  >
                    <div className="flex items-center gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getCanSort() && (
                        header.column.getIsSorted() === 'asc' ? <ChevronUp size={12} /> :
                        header.column.getIsSorted() === 'desc' ? <ChevronDown size={12} /> :
                        <ChevronsUpDown size={12} className="text-gray-600" />
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
        </table>
        {/* Scrollable virtual body */}
        <div
          ref={tableBodyRef}
          className="overflow-y-auto overflow-x-auto"
          style={{ maxHeight: 520 }}
        >
          {allRows.length === 0 ? (
            <div className="text-center text-gray-500 py-8 text-sm">
              No users match the current filter.
            </div>
          ) : (
            <table className="w-full text-sm">
              {/* data-pdf-rows: the PDF export may start a page at any row here. */}
              <tbody data-pdf-rows style={{ display: 'block', height: totalVirtualHeight, position: 'relative' }}>
                {virtualItems.map(vi => {
                  const row = allRows[vi.index]
                  return (
                    <tr
                      key={row.id}
                      data-index={vi.index}
                      ref={virtualizer.measureElement}
                      className="border-b cursor-pointer transition-colors"
                      style={{
                        borderColor: 'rgba(255,255,255,0.05)',
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${vi.start}px)`,
                        display: 'table',
                        tableLayout: 'fixed',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(139,92,246,0.06)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      onClick={() => onRowClick(row.original)}
                    >
                      {row.getVisibleCells().map(cell => (
                        <td key={cell.id} className="px-3 py-2.5 whitespace-nowrap overflow-hidden text-ellipsis">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {allRows.length > 0 && (
        <div className="text-xs text-gray-600 text-right pt-1 flex items-center justify-end gap-2">
          {loadingMore && <Loader2 size={11} className="animate-spin text-brand-500" />}
          {loadingMore
            ? `Loaded ${allRows.length.toLocaleString()} of ${totalUsers.toLocaleString()} matching users…`
            : `Showing all ${allRows.length.toLocaleString()} matching users`}
        </div>
      )}
    </div>
  )
}
