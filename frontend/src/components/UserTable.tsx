import { useState, useMemo, useRef, useEffect } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ExternalLink, ChevronUp, ChevronDown, ChevronsUpDown, Eye, X, CheckSquare, Square, Filter, AlertTriangle } from 'lucide-react'
import type { UserRecord } from '../types'
import RoleBadges from './RoleBadges'

interface Props {
  users: UserRecord[]
  onRowClick: (user: UserRecord) => void
}

const col = createColumnHelper<UserRecord>()

const ROW_HEIGHT = 44 // px — approximate height of a single table row

// ---------------------------------------------------------------------------
// Bot-likelihood heuristic
// ---------------------------------------------------------------------------
// Returns a score 0–100. Score ≥ 60 = "likely bot / spam account".
// The score is purely client-side and is only used to power the hide-bots toggle.

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

// ---------------------------------------------------------------------------
// Advanced filter state
// ---------------------------------------------------------------------------

interface FilterState {
  location: string
  company: string
  minFollowers: string
  maxFollowers: string
  joinedAfter: string   // YYYY-MM-DD
  joinedBefore: string  // YYYY-MM-DD
  hideBots: boolean
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

export default function UserTable({ users, onRowClick }: Props) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [selectedLogin, setSelectedLogin] = useState<string | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [dropdownSearch, setDropdownSearch] = useState('')
  const comboRef = useRef<HTMLDivElement>(null)

  // Advanced filter panel
  const [showFilterPanel, setShowFilterPanel] = useState(false)
  const [filters, setFilters] = useState<FilterState>({
    location: '',
    company: '',
    minFollowers: '',
    maxFollowers: '',
    joinedAfter: '',
    joinedBefore: '',
    hideBots: false,
  })

  function resetFilters() {
    setFilters({ location: '', company: '', minFollowers: '', maxFollowers: '', joinedAfter: '', joinedBefore: '', hideBots: false })
  }

  // Count how many advanced filters are active (for badge on Filters button)
  const activeFilterCount = useMemo(() => [
    filters.location,
    filters.company,
    filters.minFollowers,
    filters.maxFollowers,
    filters.joinedAfter,
    filters.joinedBefore,
    filters.hideBots ? 'x' : '',
  ].filter(Boolean).length, [filters])

  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>(loadColVisibility)
  const [showVisibilityMenu, setShowVisibilityMenu] = useState(false)
  const [visibilitySearch, setVisibilitySearch] = useState('')
  const visMenuRef = useRef<HTMLDivElement>(null)
  const tableBodyRef = useRef<HTMLDivElement>(null)

  // Persist column visibility to localStorage whenever it changes
  useEffect(() => {
    try { localStorage.setItem(COL_VIS_KEY, JSON.stringify(columnVisibility)) } catch { /* storage full */ }
  }, [columnVisibility])

  // Close dropdowns on outside click
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
      if (visMenuRef.current && !visMenuRef.current.contains(e.target as Node)) {
        setShowVisibilityMenu(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  // Sorted list of all logins for the dropdown
  const sortedLogins = useMemo(() =>
    [...users]
      .sort((a, b) => (a.login ?? '').localeCompare(b.login ?? ''))
      .map(u => ({ login: u.login, name: u.name }))
  , [users])

  // Filtered dropdown entries (by what user typed)
  const dropdownEntries = useMemo(() => {
    const q = dropdownSearch.toLowerCase()
    if (!q) return sortedLogins
    return sortedLogins.filter(u =>
      u.login.toLowerCase().includes(q) || (u.name ?? '').toLowerCase().includes(q)
    )
  }, [sortedLogins, dropdownSearch])

  // Reset scroll position when filters or sorting change
  useEffect(() => {
    if (tableBodyRef.current) tableBodyRef.current.scrollTop = 0
  }, [globalFilter, selectedLogin, sorting])

  // Table data: apply login select + advanced filters
  const tableData = useMemo(() => {
    let rows = selectedLogin ? users.filter(u => u.login === selectedLogin) : users

    if (filters.location) {
      const q = filters.location.toLowerCase()
      rows = rows.filter(u => (u.location ?? '').toLowerCase().includes(q))
    }
    if (filters.company) {
      const q = filters.company.toLowerCase()
      rows = rows.filter(u => (u.company ?? '').toLowerCase().includes(q))
    }
    if (filters.minFollowers !== '') {
      const min = Number(filters.minFollowers)
      rows = rows.filter(u => (u.followers ?? 0) >= min)
    }
    if (filters.maxFollowers !== '') {
      const max = Number(filters.maxFollowers)
      rows = rows.filter(u => (u.followers ?? 0) <= max)
    }
    if (filters.joinedAfter) {
      const after = new Date(filters.joinedAfter).getTime()
      rows = rows.filter(u => u.created_at ? new Date(u.created_at).getTime() >= after : true)
    }
    if (filters.joinedBefore) {
      const before = new Date(filters.joinedBefore).getTime()
      rows = rows.filter(u => u.created_at ? new Date(u.created_at).getTime() <= before : true)
    }
    if (filters.hideBots) {
      rows = rows.filter(u => computeBotScore(u) < 60)
    }

    return rows
  }, [users, selectedLogin, filters])

  function clearAllFilters() {
    setSelectedLogin(null)
    setDropdownSearch('')
    setGlobalFilter('')
    setDropdownOpen(false)
    resetFilters()
  }

  function selectUser(login: string) {
    setSelectedLogin(login)
    setDropdownSearch('')
    setDropdownOpen(false)
    setGlobalFilter('')
  }

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
    {
      id: 'bot_score',
      header: 'Bot Score',
      accessorFn: (u: UserRecord) => computeBotScore(u),
      cell: (info: any) => {
        const score = info.getValue() as number
        const color = score >= 60 ? '#fbbf24' : score >= 30 ? '#94a3b8' : '#34d399'
        return <span style={{ color, fontVariantNumeric: 'tabular-nums' }}>{score}</span>
      },
    },
  ], [])

  const table = useReactTable({
    data: tableData,
    columns,
    state: { sorting, globalFilter, columnVisibility },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

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

        {/* User combobox */}
        <div ref={comboRef} className="relative max-w-xs w-full" style={{ minWidth: 200 }}>
          <div
            className="input flex items-center gap-1.5 pr-2 cursor-text"
            style={{ padding: '0 8px' }}
            onClick={() => { setDropdownOpen(true); }}
          >
            <input
              className="flex-1 bg-transparent outline-hidden text-sm py-2 min-w-0"
              placeholder={selectedLogin ? '' : 'Filter users…'}
              value={dropdownSearch}
              onChange={e => { setDropdownSearch(e.target.value); setDropdownOpen(true); setSelectedLogin(null) }}
              onFocus={() => setDropdownOpen(true)}
            />
            {selectedLogin && (
              <span className="text-xs font-medium truncate max-w-[120px]" style={{ color: '#a78bfa' }}>
                {selectedLogin}
              </span>
            )}
            {(selectedLogin || dropdownSearch) && (
              <button
                type="button"
                className="text-gray-500 hover:text-gray-200 shrink-0 transition-colors"
                onPointerDown={e => { e.preventDefault(); clearAllFilters() }}
              >
                <X size={13} />
              </button>
            )}
          </div>

          {dropdownOpen && (
            <div
              className="absolute left-0 right-0 top-full mt-1 rounded-lg z-30 overflow-y-auto"
              style={{
                maxHeight: 240,
                background: 'rgba(14,10,36,0.97)',
                border: '1px solid rgba(139,92,246,0.3)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                backdropFilter: 'blur(12px)',
              }}
            >
              {dropdownEntries.length === 0 ? (
                <div className="text-xs text-gray-500 px-3 py-2">No users found</div>
              ) : (
                dropdownEntries.map(u => (
                  <button
                    key={u.login}
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors"
                    style={selectedLogin === u.login ? {
                      background: 'rgba(139,92,246,0.18)',
                      color: '#a78bfa',
                    } : {}}
                    onMouseEnter={e => { if (selectedLogin !== u.login) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)' }}
                    onMouseLeave={e => { if (selectedLogin !== u.login) (e.currentTarget as HTMLElement).style.background = '' }}
                    onPointerDown={e => { e.preventDefault(); selectUser(u.login) }}
                  >
                    <span className="font-mono text-xs text-gray-400 shrink-0">{u.login}</span>
                    {u.name && <span className="text-gray-500 text-xs truncate">{u.name}</span>}
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Clear filters */}
        {(selectedLogin || globalFilter) && (
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
          {activeFilterCount > 0 && (
            <span
              className="absolute -top-1.5 -right-1.5 text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center"
              style={{ background: '#7c3aed', color: '#fff' }}
            >
              {activeFilterCount}
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
            <div className="absolute left-0 top-full mt-1 rounded-lg shadow-xl z-20 p-3 space-y-2 min-w-56" style={{
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
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  color: '#e5e7eb',
                }}
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
              <div className="grid grid-cols-2 gap-1">
                {table.getAllLeafColumns()
                  .filter(col => col.id !== 'avatar_url' && col.id.toLowerCase().includes(visibilitySearch.toLowerCase()))
                  .map(col => (
                  <label key={col.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={col.getIsVisible()}
                      onChange={col.getToggleVisibilityHandler()}
                      className="accent-brand-500"
                    />
                    {col.id}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <span className="text-sm text-gray-500 ml-auto">
          {allRows.length} users
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
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', color: '#e5e7eb' }}
                placeholder="e.g. London"
                value={filters.location}
                onChange={e => setFilters(f => ({ ...f, location: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Company contains</label>
              <input
                type="text"
                className="w-full text-sm rounded-md px-2 py-1.5 outline-hidden"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', color: '#e5e7eb' }}
                placeholder="e.g. Google"
                value={filters.company}
                onChange={e => setFilters(f => ({ ...f, company: e.target.value }))}
              />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs text-gray-400 mb-1">Min followers</label>
                <input
                  type="number"
                  min={0}
                  className="w-full text-sm rounded-md px-2 py-1.5 outline-hidden"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', color: '#e5e7eb' }}
                  placeholder="0"
                  value={filters.minFollowers}
                  onChange={e => setFilters(f => ({ ...f, minFollowers: e.target.value }))}
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-gray-400 mb-1">Max followers</label>
                <input
                  type="number"
                  min={0}
                  className="w-full text-sm rounded-md px-2 py-1.5 outline-hidden"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', color: '#e5e7eb' }}
                  placeholder="∞"
                  value={filters.maxFollowers}
                  onChange={e => setFilters(f => ({ ...f, maxFollowers: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Joined after</label>
              <input
                type="date"
                className="w-full text-sm rounded-md px-2 py-1.5 outline-hidden"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', color: '#e5e7eb', colorScheme: 'dark' }}
                value={filters.joinedAfter}
                onChange={e => setFilters(f => ({ ...f, joinedAfter: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Joined before</label>
              <input
                type="date"
                className="w-full text-sm rounded-md px-2 py-1.5 outline-hidden"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', color: '#e5e7eb', colorScheme: 'dark' }}
                value={filters.joinedBefore}
                onChange={e => setFilters(f => ({ ...f, joinedBefore: e.target.value }))}
              />
            </div>
            <div className="flex flex-col justify-end">
              <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
                <input
                  type="checkbox"
                  className="accent-amber-400"
                  checked={filters.hideBots}
                  onChange={e => setFilters(f => ({ ...f, hideBots: e.target.checked }))}
                />
                <span className="text-gray-300 flex items-center gap-1">
                  <AlertTriangle size={12} className="text-amber-400" />
                  Hide likely bots
                </span>
              </label>
              <p className="text-[10px] text-gray-600 mt-0.5 ml-5">Hides accounts scoring ≥ 60 on the spam heuristic</p>
            </div>
          </div>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={resetFilters}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
            >
              <X size={11} /> Reset all filters
            </button>
          )}
        </div>
      )}

      {/* Virtualised table — only visible rows are rendered in the DOM */}      <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
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
              <tbody style={{ display: 'block', height: totalVirtualHeight, position: 'relative' }}>
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
        <div className="text-xs text-gray-600 text-right pt-1">
          {allRows.length < users.length
            ? `Showing ${allRows.length} of ${users.length} users — scroll to navigate`
            : `Showing all ${allRows.length} users — scroll to navigate`}
        </div>
      )}
    </div>
  )
}
