import { useState, useMemo, useEffect, useRef, useDeferredValue } from 'react'
import { X, ExternalLink, Search } from 'lucide-react'
import type { UserRecord, JobInfo } from '../types'
import RoleBadges from './RoleBadges'

interface Props {
  allJobUsers: Record<string, UserRecord[]>
  jobs: JobInfo[]
  onClose: () => void
  onSelectUser?: (user: UserRecord) => void
}

export default function GlobalSearchModal({ allJobUsers, jobs, onClose, onSelectUser }: Props) {
  const [query, setQuery] = useState('')
  // P6: useDeferredValue defers expensive filtering until the browser is idle,
  // keeping the input responsive on every keystroke.
  const deferredQuery = useDeferredValue(query)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const results = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    if (!q) return []
    const out: { user: UserRecord; jobId: string; label: string }[] = []
    for (const [jobId, users] of Object.entries(allJobUsers)) {
      const label = jobs.find(j => j.job_id === jobId)?.label ?? jobId
      for (const u of users) {
        if (
          (u.login ?? '').toLowerCase().includes(q) ||
          (u.name ?? '').toLowerCase().includes(q) ||
          (u.location ?? '').toLowerCase().includes(q) ||
          (u.company ?? '').toLowerCase().includes(q) ||
          (u.bio ?? '').toLowerCase().includes(q) ||
          (u.email_public ?? '').toLowerCase().includes(q)
        ) {
          out.push({ user: u, jobId, label })
        }
      }
    }
    // Sort: exact login match first, then by login alphabetically
    out.sort((a, b) => {
      const aExact = a.user.login?.toLowerCase() === q ? 0 : 1
      const bExact = b.user.login?.toLowerCase() === q ? 0 : 1
      if (aExact !== bExact) return aExact - bExact
      return (a.user.login ?? '').localeCompare(b.user.login ?? '')
    })
    return out.slice(0, 50)
  }, [deferredQuery, allJobUsers, jobs])

  const totalUsers = useMemo(() =>
    Object.values(allJobUsers).reduce((s, arr) => s + arr.length, 0),
  [allJobUsers])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4"
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl overflow-hidden flex flex-col"
        style={{
          maxHeight: 'calc(100vh - 8rem)',
          background: 'rgba(14,10,32,0.97)',
          border: '1px solid rgba(139,92,246,0.3)',
          boxShadow: '0 0 60px rgba(124,58,237,0.3), 0 24px 48px rgba(0,0,0,0.6)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <Search size={18} className="text-gray-500 shrink-0" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent outline-none text-sm text-white placeholder-gray-500"
            placeholder={`Search across ${totalUsers.toLocaleString()} users from ${Object.keys(allJobUsers).length} job${Object.keys(allJobUsers).length !== 1 ? 's' : ''}…`}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Results */}
        <div className="overflow-y-auto flex-1">
          {query.trim() === '' && (
            <div className="px-4 py-10 text-center text-gray-600 text-sm">
              Type to search login, name, location, company, bio, or email
            </div>
          )}
          {query.trim() !== '' && results.length === 0 && (
            <div className="px-4 py-10 text-center text-gray-600 text-sm">No users found matching "{query}"</div>
          )}
          {results.map(({ user, label }, i) => (
            <button
              key={`${user.login}-${i}`}
              className="w-full text-left px-4 py-3 flex items-center gap-3 transition-colors"
              style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(139,92,246,0.08)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              onClick={() => { onSelectUser?.(user); onClose() }}
            >
              <img
                src={user.avatar_url ?? ''}
                alt=""
                className="w-8 h-8 rounded-full shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-white">{user.name || user.login}</span>
                  <span className="text-xs text-gray-500">@{user.login}</span>
                  {user.roles && <RoleBadges roles={user.roles} />}
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-500 flex-wrap">
                  {user.location && <span>{user.location}</span>}
                  {user.company && <span>{user.company}</span>}
                  <span
                    className="px-1.5 py-0.5 rounded text-xs font-mono"
                    style={{ background: 'rgba(139,92,246,0.15)', color: '#a78bfa' }}
                  >
                    {label}
                  </span>
                </div>
              </div>
              <a
                href={user.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-600 hover:text-gray-300 shrink-0 transition-colors"
                onClick={e => e.stopPropagation()}
              >
                <ExternalLink size={13} />
              </a>
            </button>
          ))}
          {results.length === 50 && (
            <div className="px-4 py-2 text-xs text-gray-600 text-center">Showing first 50 results — refine your search</div>
          )}
        </div>
      </div>
    </div>
  )
}
