import { useState, useEffect } from 'react'
import { Github, BarChart2, GitCompare, Search, HelpCircle, X, Key, PlayCircle, BarChart, GitCompare as GitCompareIcon, Download } from 'lucide-react'
import FetchView from './views/FetchView'
import ResultsView from './views/ResultsView'
import CompareView from './views/CompareView'
import GlobalSearchModal from './components/GlobalSearchModal'
import ErrorBoundary from './components/ErrorBoundary'
import type { JobInfo, UserRecord, View, AuthUser } from './types'
import { fetchJobs, deleteJob, updateJobTags, invalidateJobCache, fetchAuthMe, logoutAuth, openAuthPopup, fetchSharedJob } from './utils/api'

function HelpModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])
  const steps = [
    {
      icon: <Key size={20} />,
      color: '#f59e0b',
      title: 'Get a GitHub Personal Access Token',
      desc: "Without a token you're limited to 60 API requests/hour. A token raises this to 5,000/hour — essential for any real repository.",
      bullets: [
        'Go to github.com/settings/tokens/new',
        'Give it a name (e.g. "repo-people")',
        'Grant the read:user and public_repo scopes (required for profile data and repository access)',
        'Copy the token and paste it into the Token field on the Fetch page',
      ],
    },
    {
      icon: <PlayCircle size={20} />,
      color: '#10b981',
      title: 'Fetch Users from a Repository',
      desc: 'Enter a repo owner and name, select which user roles to fetch, then start the fetch.',
      bullets: [
        'Owner — the GitHub username or organisation (e.g. "facebook")',
        'Repo — the repository name (e.g. "react")',
        'Roles — choose from Contributors, Stargazers, Forkers, Watchers, Issue Authors, PR Authors, Maintainers',
        'Click Start Fetch and watch the live progress log',
        "Once done you're automatically taken to the Results page",
      ],
    },
    {
      icon: <BarChart size={20} />,
      color: '#8b5cf6',
      title: 'Explore Results',
      desc: 'The Results page shows rich analytics and a searchable table for every fetched user.',
      bullets: [
        'Summary cards — total users, humans vs bots, top location, company, and role',
        'Charts — role distribution bar chart and account age pie chart',
        'Top 10 leaderboard — rank users by followers, repos, account age, or stars',
        'Full data table — sort and filter by any column, click a row to open a detail drawer',
        'Overlap analysis — role co-occurrence and community health score',
        'Geographic world map — see where contributors are located globally',
        'Email domain and social presence analysis by role',
        'Shareable URL — copy a 24-hour read link to share results with teammates',
        'Export — download the full dataset as JSON, CSV, Markdown, or PDF',
      ],
    },
    {
      icon: <Github size={20} />,
      color: '#6366f1',
      title: 'Sign in with GitHub (OAuth)',
      desc: 'Sign in once and fetch data without managing tokens manually.',
      bullets: [
        'Click \"Sign in\" in the top-right header to open the GitHub OAuth popup',
        'Authorise the app — your session is stored securely server-side for 30 days',
        'No token copy-paste needed — the backend uses your session automatically',
        'Sign out at any time using the button next to your avatar',
      ],
    },
    {
      icon: <GitCompareIcon size={20} />,
      color: '#0ea5e9',
      title: 'Compare Two Repositories',
      desc: 'Run fetches on two repos then use the Compare page to see who overlaps.',
      bullets: [
        'Fetch users from Repo A, then fetch users from Repo B',
        'Navigate to the Compare tab',
        'Select Job A and Job B from the dropdowns',
        'See users unique to each repo and users present in both',
        'Overlap percentage is calculated automatically',
      ],
    },
    {
      icon: <Download size={20} />,
      color: '#60a5fa',
      title: 'Export & Use Your Data',
      desc: 'All fetched data can be exported for use in your own tools or reports.',
      bullets: [
        'JSON export — full nested user objects preserving all fields',
        'CSV export — flat table with list/object fields serialised as JSON strings',
        'Each row represents one GitHub user with 40+ profile fields',
      ],
    },
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl"
        style={{
          background: 'rgba(14,10,32,0.97)',
          border: '1px solid rgba(139,92,246,0.25)',
          boxShadow: '0 0 60px rgba(124,58,237,0.3), 0 24px 48px rgba(0,0,0,0.6)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div>
            <h2 className="text-xl font-bold" style={{
              background: 'linear-gradient(90deg, #a78bfa, #60a5fa)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}>
              How to use repo-people
            </h2>
            <p className="text-sm text-gray-400 mt-0.5">Fetch, analyse, and compare GitHub repository users</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-gray-400 hover:text-white transition-colors"
            style={{ background: 'rgba(255,255,255,0.06)' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Steps */}
        <div className="px-6 py-5 space-y-5">
          {steps.map((step, i) => (
            <div
              key={i}
              className="rounded-xl p-4"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.07)',
              }}
            >
              <div className="flex items-center gap-3 mb-2">
                {/* Step number badge */}
                <div className="flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold text-white flex-shrink-0"
                  style={{ background: `linear-gradient(135deg, ${step.color}99, ${step.color}44)`, border: `1px solid ${step.color}55` }}>
                  {i + 1}
                </div>
                <div className="flex items-center gap-2" style={{ color: step.color }}>
                  {step.icon}
                  <span className="font-semibold text-white">{step.title}</span>
                </div>
              </div>
              <p className="text-sm text-gray-400 mb-3 ml-10">{step.desc}</p>
              <ul className="space-y-1.5 ml-10">
                {step.bullets.map((b, j) => (
                  <li key={j} className="flex items-start gap-2 text-sm text-gray-300">
                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: step.color }} />
                    {b}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {/* Tip box */}
          <div className="rounded-xl p-4 mt-2" style={{
            background: 'rgba(124,58,237,0.08)',
            border: '1px solid rgba(124,58,237,0.2)',
          }}>
            <p className="text-sm text-purple-300">
              <span className="font-semibold text-purple-200">Tip:</span> Large repositories (thousands of users) can take several minutes. The live log shows each user as they're fetched. Leave the tab open — the fetch runs in the background on the server.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

const VALID_VIEWS: View[] = ['fetch', 'results', 'compare']

function hashToView(hash: string): View {
  const v = hash.replace(/^#/, '') as View
  return VALID_VIEWS.includes(v) ? v : 'fetch'
}

export default function App() {
  // FE1: Hash-based URL routing so views are bookmarkable and browser back/forward work.
  const [view, setView] = useState<View>(() => hashToView(window.location.hash))
  const [jobs, setJobs] = useState<JobInfo[]>(() => {
    try {
      const saved = localStorage.getItem('repo-people-jobs')
      return saved ? JSON.parse(saved) : []
    } catch { return [] }
  })
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [groupJobIds, setGroupJobIds] = useState<string[]>([])
  const [showHelp, setShowHelp] = useState(false)
  const [showGlobalSearch, setShowGlobalSearch] = useState(false)
  const [allJobUsers, setAllJobUsers] = useState<Record<string, UserRecord[]>>({})
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)

  // Persist jobs to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('repo-people-jobs', JSON.stringify(jobs))
  }, [jobs])

  // FE1: Keep URL hash in sync with current view.
  useEffect(() => {
    window.location.hash = view
  }, [view])

  // FE1: Sync view from browser back/forward navigation.
  useEffect(() => {
    function onHashChange() {
      setView(hashToView(window.location.hash))
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // On mount: check OAuth session
  useEffect(() => {
    fetchAuthMe().then(user => setAuthUser(user)).catch(() => {})
  }, [])

  // On mount: handle shared job links (#share=TOKEN)
  useEffect(() => {
    const hash = window.location.hash
    if (!hash.startsWith('#share=')) return
    const token = hash.slice('#share='.length)
    if (!token) return
    fetchSharedJob(token, 1, 200).then(data => {
      const tempId = `shared-${token.slice(0, 8)}`
      const newJob: JobInfo = {
        job_id: tempId,
        status: 'done',
        label: data.job_label || `Shared result`,
        total_fetched: data.total,
        timestamp: new Date().toISOString(),
        tags: [],
      }
      setJobs(prev => [...prev, newJob])
      setActiveJobId(tempId)
      setAllJobUsers(prev => ({
        ...prev,
        [tempId]: Object.values(data.users) as UserRecord[],
      }))
      setView('results')
      window.location.hash = 'results'
    }).catch(() => { /* invalid/expired token — ignore */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Listen for the popup signalling that OAuth completed.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return
      if (e.data?.type === 'oauth-success') {
        fetchAuthMe().then(user => setAuthUser(user)).catch(() => {})
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // On mount: reconcile with backend to validate saved jobs
  useEffect(() => {
    fetchJobs().then((backendJobs: { job_id: string; status: string; total_fetched: number; label?: string; created_at?: string; tags?: string[] }[]) => {
      const backendMap = Object.fromEntries(backendJobs.map(j => [j.job_id, j]))
      setJobs(prev => {
        const updated = prev.map(j => {
          const b = backendMap[j.job_id]
          if (b) return { ...j, status: b.status as JobInfo['status'], total_fetched: b.total_fetched, created_at: b.created_at, tags: b.tags ?? [] }
          return { ...j, status: 'stale' as const }
        })
        const localIds = new Set(prev.map(j => j.job_id))
        const fromBackend = backendJobs
          .filter(j => !localIds.has(j.job_id))
          .map(j => ({ ...j, status: j.status as JobInfo['status'], timestamp: new Date().toISOString() }))
        return [...updated, ...fromBackend]
      })
    }).catch(() => { /* backend unavailable */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Open global search with Cmd/Ctrl+K
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setShowGlobalSearch(v => !v)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  function addJob(job: JobInfo) {
    setJobs(prev => [...prev, { ...job, timestamp: new Date().toISOString() }])
    setActiveJobId(job.job_id)
  }

  function updateJob(job_id: string, patch: Partial<JobInfo>) {
    setJobs(prev => prev.map(j => j.job_id === job_id ? { ...j, ...patch } : j))
  }

  function updateJobTagsHandler(job_id: string, tags: string[]) {
    setJobs(prev => prev.map(j => j.job_id === job_id ? { ...j, tags } : j))
    updateJobTags(job_id, tags).catch(() => {})
  }

  function removeJob(job_id: string) {
    deleteJob(job_id).catch(() => {})
    invalidateJobCache(job_id)
    setJobs(prev => prev.filter(j => j.job_id !== job_id))
    setAllJobUsers(prev => { const next = { ...prev }; delete next[job_id]; return next })
    if (activeJobId === job_id) {
      const remaining = jobs.filter(j => j.job_id !== job_id)
      setActiveJobId(remaining.length > 0 ? remaining[remaining.length - 1].job_id : null)
    }
  }

  function handleGroupJobIds(ids: string[]) {
    setGroupJobIds(ids)
    if (ids.length > 0) setActiveJobId(ids[0])
  }

  function handleUsersLoaded(jobId: string, users: UserRecord[]) {
    setAllJobUsers(prev => ({ ...prev, [jobId]: users }))
  }

  const navItems: { id: View; label: string; icon: React.ReactNode }[] = [
    { id: 'fetch', label: 'Fetch', icon: <Search size={16} /> },
    { id: 'results', label: 'Results', icon: <BarChart2 size={16} /> },
    { id: 'compare', label: 'Compare', icon: <GitCompare size={16} /> },
  ]

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-40" style={{
        background: 'rgba(10,8,24,0.75)',
        borderBottom: '1px solid rgba(139,92,246,0.2)',
        backdropFilter: 'blur(16px)',
        boxShadow: '0 0 40px rgba(124,58,237,0.08)',
      }}>
        <div className="max-w-screen-xl mx-auto px-4 h-14 flex items-center">
          {/* Left: logo */}
          <div className="flex-1 flex items-center">
            <button
              onClick={() => setView('fetch')}
              className="flex items-center gap-2 font-bold text-lg transition-opacity hover:opacity-80"
              style={{
                background: 'linear-gradient(90deg, #a78bfa, #60a5fa)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              <Github size={22} style={{ color: '#a78bfa', fill: 'none' }} />
              <span>repo-people</span>
            </button>
          </div>
          {/* Center: nav */}
          <nav className="flex gap-1">
            {navItems.map(item => (
              <button
                key={item.id}
                onClick={() => setView(item.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  view === item.id
                    ? 'text-white'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
                style={view === item.id ? {
                  background: 'linear-gradient(135deg, #7c3aed, #2563eb)',
                  boxShadow: '0 0 12px rgba(124,58,237,0.4)',
                } : {
                  background: 'rgba(255,255,255,0.05)',
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>
          {/* Right: actions */}
          <div className="flex-1 flex justify-end items-center gap-2">
            {/* GitHub repo link */}
            <a
              href="https://github.com/amckenna41/repo-people"
              target="_blank"
              rel="noopener noreferrer"
              title="View on GitHub"
              className="flex items-center justify-center w-8 h-8 rounded-full text-gray-400 hover:text-white transition-all"
              style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(139,92,246,0.25)' }}
            >
              <Github size={16} />
            </a>
            {/* Global search */}
            <button
              onClick={() => setShowGlobalSearch(true)}
              title="Search users (⌘K)"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white transition-all"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(139,92,246,0.2)' }}
            >
              <Search size={14} />
              <span className="hidden sm:inline text-xs">Search users</span>
              <kbd className="hidden sm:inline text-xs px-1 py-0.5 rounded opacity-50" style={{ background: 'rgba(255,255,255,0.08)' }}>⌘K</kbd>
            </button>
            {/* GitHub OAuth auth button */}
            {authUser ? (
              <div className="flex items-center gap-1.5">
                {authUser.avatar_url && (
                  <img
                    src={authUser.avatar_url}
                    alt={authUser.login}
                    className="w-7 h-7 rounded-full"
                    style={{ border: '1px solid rgba(139,92,246,0.4)' }}
                  />
                )}
                <span className="hidden sm:inline text-xs text-gray-300">@{authUser.login}</span>
                <button
                  onClick={() => logoutAuth().then(() => setAuthUser(null))}
                  title="Sign out"
                  className="text-xs text-gray-500 hover:text-red-400 transition-colors px-1"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <button
                onClick={() => openAuthPopup()}
                title="Sign in with GitHub"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-300 hover:text-white transition-all"
                style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(139,92,246,0.25)' }}
              >
                <Github size={14} />
                <span className="hidden sm:inline text-xs">Sign in</span>
              </button>
            )}
            <button
              onClick={() => setShowHelp(true)}
              title="How to use"
              className="flex items-center justify-center w-8 h-8 rounded-full text-gray-400 hover:text-white transition-all"
              style={{
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(139,92,246,0.25)',
              }}
            >
              <HelpCircle size={16} />
            </button>
          </div>
        </div>
      </header>
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {showGlobalSearch && (
        <GlobalSearchModal
          allJobUsers={allJobUsers}
          jobs={jobs}
          onClose={() => setShowGlobalSearch(false)}
        />
      )}

      {/* Main content */}
      <main className="flex-1 max-w-screen-xl mx-auto w-full px-4 py-6">
        <div className={view !== 'fetch' ? 'hidden' : ''}>
          <ErrorBoundary>
            <FetchView
              jobs={jobs}
              onJobCreated={addJob}
              onJobUpdate={updateJob}
              onViewResults={() => setView('results')}
              onGroupJobIds={handleGroupJobIds}
              authUser={authUser}
            />
          </ErrorBoundary>
        </div>
        <div className={view !== 'results' ? 'hidden' : ''}>
          <ErrorBoundary>
            <ResultsView jobs={jobs} activeJobId={activeJobId} setActiveJobId={setActiveJobId} groupJobIds={groupJobIds} onUsersLoaded={handleUsersLoaded} onJobUpdate={updateJob} onJobDelete={removeJob} onJobTagsUpdate={updateJobTagsHandler} />
          </ErrorBoundary>
        </div>
        <div className={view !== 'compare' ? 'hidden' : ''}>
          <ErrorBoundary>
            <CompareView jobs={jobs} />
          </ErrorBoundary>
        </div>
      </main>

      {/* Footer */}
      <footer
        className="w-full px-6 py-3 flex items-center"
        style={{
          borderTop: '1px solid rgba(139,92,246,0.12)',
          background: 'rgba(10,8,24,0.6)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <span className="text-xs text-gray-600">
          © {new Date().getFullYear()} AJ McKenna
        </span>
        <a
          href="https://github.com/amckenna41/repo-people"
          target="_blank"
          rel="noopener noreferrer"
          title="View repo-people on GitHub"
          className="ml-auto flex items-center gap-1.5 text-gray-500 hover:text-gray-300 transition-colors text-xs"
        >
          <Github size={15} />
          <span className="hidden sm:inline">amckenna41/repo-people</span>
        </a>
      </footer>
    </div>
  )
}
