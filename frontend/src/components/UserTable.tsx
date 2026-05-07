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
import { ExternalLink, ChevronUp, ChevronDown, ChevronsUpDown, Eye, X, CheckSquare, Square } from 'lucide-react'
import type { UserRecord } from '../types'
import RoleBadges from './RoleBadges'

interface Props {
  users: UserRecord[]
  onRowClick: (user: UserRecord) => void
}

const col = createColumnHelper<UserRecord>()

export default function UserTable({ users, onRowClick }: Props) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [selectedLogin, setSelectedLogin] = useState<string | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [dropdownSearch, setDropdownSearch] = useState('')
  const comboRef = useRef<HTMLDivElement>(null)

  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({
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
  })
  const [showVisibilityMenu, setShowVisibilityMenu] = useState(false)
  const [visibilitySearch, setVisibilitySearch] = useState('')
  const visMenuRef = useRef<HTMLDivElement>(null)
  const PAGE_SIZE = 50
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

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

  // Reset visible count whenever filters or sorting change
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [globalFilter, selectedLogin, sorting])

  // Table data: if a specific user is selected, show only them
  const tableData = useMemo(() =>
    selectedLogin ? users.filter(u => u.login === selectedLogin) : users
  , [users, selectedLogin])

  function clearAllFilters() {
    setSelectedLogin(null)
    setDropdownSearch('')
    setGlobalFilter('')
    setDropdownOpen(false)
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
      cell: info => (
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
      ),
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
              className="flex-1 bg-transparent outline-none text-sm py-2 min-w-0"
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
                className="text-gray-500 hover:text-gray-200 flex-shrink-0 transition-colors"
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
                    <span className="font-mono text-xs text-gray-400 flex-shrink-0">{u.login}</span>
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
                className="w-full bg-transparent outline-none text-xs px-2 py-1.5 rounded-md"
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
          {table.getFilteredRowModel().rows.length} users
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
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
          <tbody>
            {(() => {
              const allRows = table.getRowModel().rows
              const visibleRows = allRows.slice(0, visibleCount)
              return (
                <>
                  {visibleRows.map(row => (
                    <tr
                      key={row.id}
                      className="border-b cursor-pointer transition-colors"
                      style={{ borderColor: 'rgba(255,255,255,0.05)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(139,92,246,0.06)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      onClick={() => onRowClick(row.original)}
                    >
                      {row.getVisibleCells().map(cell => (
                        <td key={cell.id} className="px-3 py-2.5 whitespace-nowrap">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {allRows.length === 0 && (
                    <tr>
                      <td colSpan={columns.length} className="text-center text-gray-500 py-8">
                        No users match the current filter.
                      </td>
                    </tr>
                  )}
                </>
              )
            })()}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      {(() => {
        const total = table.getFilteredRowModel().rows.length
        if (total <= PAGE_SIZE) return null
        const showing = Math.min(visibleCount, total)
        const hasMore = visibleCount < total
        return (
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs text-gray-500">
              Showing {showing} of {total} users
            </span>
            <div className="flex gap-2">
              {visibleCount > PAGE_SIZE && (
                <button
                  type="button"
                  onClick={() => setVisibleCount(PAGE_SIZE)}
                  className="btn-secondary text-xs px-3 py-1.5"
                >
                  Show less
                </button>
              )}
              {hasMore && (
                <button
                  type="button"
                  onClick={() => setVisibleCount(v => Math.min(v + PAGE_SIZE, total))}
                  className="btn-primary text-xs px-3 py-1.5"
                >
                  See more ({Math.min(PAGE_SIZE, total - visibleCount)} more)
                </button>
              )}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
