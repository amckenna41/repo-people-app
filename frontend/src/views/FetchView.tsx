import { useState, useRef, useEffect } from 'react'
import { AlertCircle, CheckCircle2, Loader2, X, ExternalLink, Key, ShieldAlert, Upload, FileJson, Plus, Trash2, CopyCheck, Info, StopCircle, RotateCcw } from 'lucide-react'
import { postFetch, postImport, cancelJob } from '../utils/api'
import type { JobInfo } from '../types'
import { ALL_ROLES, ROLE_COLORS } from '../types'
import { useNotification } from '../hooks/useNotification'

interface Props {
  onJobCreated: (job: JobInfo) => void
  onJobUpdate: (job_id: string, patch: Partial<JobInfo>) => void
  onViewResults: () => void
  onGroupJobIds: (ids: string[]) => void
}

interface ProgressEvent {
  fetched: number
  total: number
  login: string | null
  eta_seconds: number | null
  rate_limit_remaining: number | null
}

interface LogLine {
  text: string
  ts: number
}

const MAX_REPOS = 5

export default function FetchView({ onJobCreated, onJobUpdate, onViewResults, onGroupJobIds }: Props) {
  const { notify } = useNotification()
  const [repos, setRepos] = useState<{ owner: string; repo: string }[]>([{ owner: '', repo: '' }])
  const [token, setToken] = useState('')
  const [roles, setRoles] = useState<Set<string>>(new Set(ALL_ROLES))
  const [limit, setLimit] = useState<string>('')
  const [excludeBots, setExcludeBots] = useState(false)
  const [includeSocial, setIncludeSocial] = useState(false)
  const [saveEachUser, setSaveEachUser] = useState(false)
  const [workers, setWorkers] = useState(5)

  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stoppedByUser, setStoppedByUser] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [done, setDone] = useState(false)
  const [showTokenModal, setShowTokenModal] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importDragOver, setImportDragOver] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  const logRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)
  const doneRef = useRef(false)
  const startTimeRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const currentJobIdRef = useRef<string | null>(null)
  const stoppingRef = useRef(false)
  const currentResolveRef = useRef<((v: string | null) => void) | null>(null)

  // Cancel the active job if the user refreshes or closes the tab
  useEffect(() => {
    const handleUnload = () => {
      if (currentJobIdRef.current) {
        // Use sendBeacon so the request fires even as the page unloads
        navigator.sendBeacon(`/fetch/${currentJobIdRef.current}/cancel`)
      }
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => window.removeEventListener('beforeunload', handleUnload)
  }, [])

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [log])

  useEffect(() => {
    if (running) {
      startTimeRef.current = Date.now()
      setElapsed(0)
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - (startTimeRef.current ?? Date.now())) / 1000))
      }, 1000)
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [running])

  function formatTime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }

  function resetForm() {
    setRepos([{ owner: '', repo: '' }])
    setToken('')
    setRoles(new Set(ALL_ROLES))
    setLimit('')
    setExcludeBots(false)
    setIncludeSocial(false)
    setSaveEachUser(false)
    setWorkers(5)
    setError(null)
    setProgress(null)
    setLog([])
    setDone(false)
    doneRef.current = false
    stoppingRef.current = false
    setStopping(false)
    setStoppedByUser(false)
  }

  function handleStop() {
    stoppingRef.current = true
    setStopping(true)
    setStoppedByUser(true)
    // Close the SSE stream immediately
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
    // Fire-and-forget cancel request to backend
    if (currentJobIdRef.current) {
      cancelJob(currentJobIdRef.current)
    }
    // Force-resolve the pending collectOneRepo promise so the UI unblocks
    if (currentResolveRef.current) {
      currentResolveRef.current(null)
      currentResolveRef.current = null
    }
    setLog(prev => [...prev, { text: '⏹ Fetch stopped.', ts: Date.now() }])
  }

  async function handleImportFile(file: File) {
    setImportError(null)
    if (!file.name.endsWith('.json')) {
      setImportError('Only JSON files are supported.')
      return
    }
    setImporting(true)
    try {
      const text = await file.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error('Invalid JSON — could not parse the file.')
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('File must contain a JSON object mapping logins to user records.')
      }
      const { job_id, total_imported } = await postImport(parsed as Record<string, unknown>)
      // Derive a label from the filename (strip extension)
      const label = file.name.replace(/\.json$/i, '')
      onJobCreated({ job_id, status: 'done', total_fetched: total_imported, label: `📂 ${label}` })
      onViewResults()
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  function addRepo() {
    if (repos.length < MAX_REPOS) setRepos(prev => [...prev, { owner: '', repo: '' }])
  }
  function removeRepo(i: number) {
    setRepos(prev => prev.filter((_, idx) => idx !== i))
  }
  function updateRepo(i: number, field: 'owner' | 'repo', value: string) {
    setRepos(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r))
  }
  function copyOwnerToAll() {
    const owner = repos[0]?.owner ?? ''
    if (!owner) return
    setRepos(prev => prev.map(r => ({ ...r, owner })))
  }

  function toggleRole(r: string) {
    setRoles(prev => {
      const next = new Set(prev)
      next.has(r) ? next.delete(r) : next.add(r)
      return next
    })
  }

  // Fetch a single repo, returns the job_id on success or null on failure.
  // Logs progress inline. Designed to be awaited sequentially.
  function fetchOneRepo(
    owner: string,
    repo: string,
    resolvedToken: string,
    repoIndex: number,
    totalRepos: number,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      currentResolveRef.current = resolve
      const prefix = totalRepos > 1 ? `[${repoIndex + 1}/${totalRepos}] ` : ''
      setProgress(null)
      setLog(prev => [...prev, { text: `${prefix}Starting fetch for ${owner}/${repo}…`, ts: Date.now() }])

      postFetch({
        owner,
        repo,
        roles: Array.from(roles),
        limit: limit ? parseInt(limit, 10) : null,
        exclude_bots: excludeBots,
        include_social_accounts: includeSocial,
        save_each_user: saveEachUser,
        workers,
      }, resolvedToken || undefined).then(({ job_id }) => {
        currentJobIdRef.current = job_id
        onJobCreated({ job_id, status: 'running', total_fetched: 0, label: `${owner}/${repo}` })

        let repoDone = false
        let reconnectAttempts = 0
        const MAX_RECONNECT = 3

        function connectSSE() {
          const es = new EventSource(`/fetch/${job_id}/stream`)
          esRef.current = es

          es.addEventListener('status', (ev) => {
            const data = JSON.parse(ev.data)
            setLog(prev => [...prev, { text: `${prefix}${data.message}`, ts: Date.now() }])
          })

          es.addEventListener('progress', (ev) => {
            const data: ProgressEvent = JSON.parse(ev.data)
            setProgress(data)
            if (data.login) {
              setLog(prev => [...prev, { text: `${prefix}Fetching: ${data.login} (${data.fetched}/${data.total})`, ts: Date.now() }])
            }
          })

          es.addEventListener('error', (ev) => {
            const data = JSON.parse((ev as MessageEvent).data)
            setLog(prev => [...prev, { text: `${prefix}Error: ${data.message}`, ts: Date.now() }])
            onJobUpdate(job_id, { status: 'error' })
            repoDone = true
            es.close()
            currentResolveRef.current = null
            resolve(null)
          })

          es.addEventListener('done', (ev) => {
            const data = JSON.parse((ev as MessageEvent).data)
            repoDone = true
            es.close()
            currentResolveRef.current = null
            onJobUpdate(job_id, { status: 'done', total_fetched: data.total ?? 0 })
            setLog(prev => [...prev, { text: `${prefix}Done: ${owner}/${repo} — ${data.total ?? 0} users fetched`, ts: Date.now() }])
            notify(stoppingRef.current ? `Fetch stopped: ${owner}/${repo}` : `Fetch complete: ${owner}/${repo}`, {
              body: `${data.total ?? 0} users fetched successfully.`,
            })
            resolve(job_id)
          })

          // B7: Reconnect on connection loss (up to MAX_RECONNECT times).
          es.onerror = () => {
            if (!repoDone) {
              es.close()
              if (reconnectAttempts < MAX_RECONNECT && !stoppingRef.current) {
                reconnectAttempts++
                const delay = reconnectAttempts * 1000
                setLog(prev => [...prev, { text: `${prefix}Connection lost, reconnecting (${reconnectAttempts}/${MAX_RECONNECT})…`, ts: Date.now() }])
                setTimeout(connectSSE, delay)
              } else {
                setLog(prev => [...prev, { text: `${prefix}Connection lost for ${owner}/${repo}`, ts: Date.now() }])
                repoDone = true
                currentResolveRef.current = null
                resolve(null)
              }
            }
          }
        }

        connectSSE()
      }).catch(err => {
        setLog(prev => [...prev, { text: `${prefix}Failed to start ${owner}/${repo}: ${err instanceof Error ? err.message : String(err)}`, ts: Date.now() }])
        resolve(null)
      })
    })
  }

  async function runAllFetches(resolvedToken: string) {
    setRunning(true)
    stoppingRef.current = false
    setStopping(false)
    const validRepos = repos.filter(r => r.owner.trim() && r.repo.trim())
    const fetchedJobIds: string[] = []
    try {
      for (let i = 0; i < validRepos.length; i++) {
        if (stoppingRef.current) break
        const { owner, repo } = validRepos[i]
        const jobId = await fetchOneRepo(owner.trim(), repo.trim(), resolvedToken, i, validRepos.length)
        if (jobId) fetchedJobIds.push(jobId)
      }
    } finally {
      doneRef.current = true
      setRunning(false)
      setDone(true)
      stoppingRef.current = false
      setStopping(false)
      // stoppedByUser is intentionally left unchanged here so the label persists
      onGroupJobIds(fetchedJobIds)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLog([])
    setProgress(null)
    setDone(false)
    setStoppedByUser(false)
    doneRef.current = false
    startTimeRef.current = null

    const valid = repos.filter(r => r.owner.trim() && r.repo.trim())
    if (valid.length === 0) {
      setError('Please enter at least one repository owner and repository name.')
      return
    }
    if (!token) {
      setShowTokenModal(true)
      return
    }

    await runAllFetches(token)
  }

  function continueWithoutToken() {
    setShowTokenModal(false)
    setError(null)
    setLog([])
    setProgress(null)
    setDone(false)
    setStoppedByUser(false)
    doneRef.current = false
    startTimeRef.current = null
    runAllFetches('')
  }

  const progressPct = progress && progress.total > 0
    ? Math.round((progress.fetched / progress.total) * 100)
    : 0

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold gradient-heading">Fetch Repository Users</h1>

      <form onSubmit={handleSubmit} className="card space-y-5">
        {/* Repo rows */}
        <div className="space-y-3">
          {repos.map((r, i) => (
            <div key={i} className="grid grid-cols-2 gap-3">
              <div>
                {i === 0 && (
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-sm text-gray-400">Repository owner</label>
                    {repos.length > 1 && repos[0].owner && (
                      <button
                        type="button"
                        onClick={copyOwnerToAll}
                        disabled={running}
                        title="Copy this owner to all rows"
                        className="flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 transition-colors disabled:opacity-40"
                      >
                        <CopyCheck size={11} />
                        Copy to all
                      </button>
                    )}
                  </div>
                )}
                <input
                  className="input"
                  placeholder="e.g. amckenna41"
                  value={r.owner}
                  onChange={e => updateRepo(i, 'owner', e.target.value)}
                  disabled={running}
                />
              </div>
              <div>
                {i === 0 && <label className="block text-sm text-gray-400 mb-1">Repository name</label>}
                <div className="flex gap-2">
                  <input
                    className="input flex-1"
                    placeholder="e.g. iso3166-2"
                    value={r.repo}
                    onChange={e => updateRepo(i, 'repo', e.target.value)}
                    disabled={running}
                  />
                  {i > 0 && (
                    <button
                      type="button"
                      onClick={() => removeRepo(i)}
                      disabled={running}
                      title="Remove this repo"
                      className="flex-shrink-0 p-2 rounded-lg text-gray-500 hover:text-red-400 transition-colors disabled:opacity-40"
                      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
          {repos.length < MAX_REPOS && !running && (
            <button
              type="button"
              onClick={addRepo}
              className="flex items-center gap-1.5 text-sm text-brand-400 hover:text-brand-300 transition-colors"
            >
              <Plus size={14} />
              Add additional repo
              <span className="text-xs text-gray-600 ml-0.5">({repos.length}/{MAX_REPOS})</span>
            </button>
          )}
        </div>

        {/* Token */}
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <label className="text-sm text-gray-400">GitHub Personal Access Token</label>
            <div className="relative group">
              <Info size={13} className="text-gray-500 hover:text-gray-300 cursor-default transition-colors" />
              <div
                className="pointer-events-none absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 rounded-xl p-3 text-xs text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
                style={{
                  background: 'rgba(15,12,35,0.97)',
                  border: '1px solid rgba(139,92,246,0.3)',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                }}
              >
                <p className="font-semibold text-white mb-1.5 flex items-center gap-1"><Key size={11} /> How to get a token</p>
                <ol className="space-y-1 text-gray-400">
                  <li><span className="text-purple-400 font-bold">1.</span> Go to <span className="text-blue-400">github.com/settings/tokens/new</span></li>
                  <li><span className="text-purple-400 font-bold">2.</span> Give it a name &amp; set an expiry</li>
                  <li><span className="text-purple-400 font-bold">3.</span> Select the <code className="bg-white/10 px-1 rounded">public_repo</code> scope</li>
                  <li><span className="text-purple-400 font-bold">4.</span> Click <strong className="text-white">Generate token</strong> and paste it here</li>
                </ol>
                <p className="mt-1.5 text-gray-500">A token raises the rate limit from 60 to 5,000 req/hr.</p>
              </div>
            </div>
          </div>
          <input
            type="password"
            className="input"
            placeholder="ghp_••••••••••••••••••••"
            value={token}
            onChange={e => setToken(e.target.value.replace(/[^\x20-\x7E]/g, '').trim())}
            disabled={running}
            autoComplete="off"
          />
          <p className="text-xs text-gray-500 mt-1">Token is sent to your local backend only and never stored.</p>
        </div>

        {/* Roles */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-gray-400">Roles to fetch</label>
            <button
              type="button"
              disabled={running}
              onClick={() => setRoles(roles.size === ALL_ROLES.length ? new Set() : new Set(ALL_ROLES))}
              className="text-xs text-purple-400 hover:text-purple-300 transition-colors disabled:opacity-40"
            >
              {roles.size === ALL_ROLES.length ? 'Deselect all' : 'Select all'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {ALL_ROLES.map(r => (
              <button
                key={r}
                type="button"
                onClick={() => toggleRole(r)}
                disabled={running}
                className={`badge cursor-pointer transition-all ${
                  roles.has(r)
                    ? ROLE_COLORS[r]
                    : 'bg-gray-800/50 text-gray-500 border border-gray-700'
                }`}
                style={roles.has(r) ? { boxShadow: '0 0 8px rgba(139,92,246,0.3)' } : {}}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Limit + workers row */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Limit per role (optional)</label>
            <input
              type="number"
              className="input"
              placeholder="No limit"
              value={limit}
              onChange={e => setLimit(e.target.value)}
              min={1}
              disabled={running}
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Workers: {workers}</label>
            <input
              type="range"
              min={1}
              max={20}
              value={workers}
              onChange={e => setWorkers(Number(e.target.value))}
              disabled={running}
              className="w-full accent-brand-500"
            />
          </div>
        </div>

        {/* Toggles */}
        <div className="flex flex-col gap-2.5">
          {/* Tooltip helper */}
          {(
            [
              {
                checked: excludeBots, onChange: setExcludeBots, label: 'Exclude bots',
                tip: 'Filters out GitHub bot accounts (e.g. dependabot, renovate) from the results.',
              },
              {
                checked: includeSocial, onChange: setIncludeSocial, label: 'Include social accounts',
                tip: 'Fetches linked social platform accounts (Twitter/X, LinkedIn, etc.) for each user. Requires extra API calls and increases fetch time.',
              },
              {
                checked: saveEachUser, onChange: setSaveEachUser, label: 'Save each user',
                tip: `Incrementally saves fetched user data in blocks of 25 during a fetch. If the fetch fails or is interrupted, results from the last saved checkpoint are used so no progress is lost.`,
              },
            ] as { checked: boolean; onChange: (v: boolean) => void; label: string; tip: string }[]
          ).map(({ checked, onChange, label, tip }) => (
            <label key={label} className="flex items-center gap-2 cursor-pointer select-none w-fit">
              <input
                type="checkbox"
                checked={checked}
                onChange={e => onChange(e.target.checked)}
                disabled={running}
                className="accent-brand-500"
              />
              <span className="text-sm text-gray-300">{label}</span>
              <div className="relative group">
                <Info size={12} className="text-gray-500 hover:text-gray-300 cursor-default transition-colors" />
                <div
                  className="pointer-events-none absolute z-50 bottom-full left-0 mb-2 w-60 rounded-xl p-3 text-xs text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{
                    background: 'rgba(15,12,35,0.97)',
                    border: '1px solid rgba(139,92,246,0.3)',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                  }}
                >
                  {tip}
                </div>
              </div>
            </label>
          ))}
        </div>

        {error && (
          <div className="flex items-start gap-2 text-red-400 bg-red-950 border border-red-800 rounded-lg p-3 text-sm">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button type="submit" className="btn-primary flex-1" disabled={running}>
            {running ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 size={16} className="animate-spin" />
                Fetching…
              </span>
            ) : 'Start Fetch'}
          </button>
          {!running && (repos[0]?.owner || repos[0]?.repo || token || log.length > 0 || done) && (
            <button
              type="button"
              onClick={resetForm}
              className="btn-secondary flex items-center gap-1.5 px-4"
              title="Reset all fields"
            >
              <RotateCcw size={14} />
              Reset
            </button>
          )}
        </div>
      </form>

      {/* Progress panel */}
      {(running || done) && (
        <div className="card space-y-3" style={{ borderColor: 'rgba(124,58,237,0.3)', boxShadow: '0 0 24px rgba(124,58,237,0.12)' }}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-300">
              {done ? (stoppedByUser ? 'Fetch stopped' : 'Fetch complete') : stopping ? 'Stopping…' : 'Fetching users…'}
            </span>
            <div className="flex items-center gap-2">
              {running && !stopping && (
                <button
                  type="button"
                  onClick={handleStop}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg text-red-400 hover:text-red-300 transition-colors"
                  style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)' }}
                  title="Stop fetch"
                >
                  <StopCircle size={13} />
                  Stop
                </button>
              )}
              {done
                ? <CheckCircle2 size={18} className="text-emerald-400" />
                : <Loader2 size={18} className="animate-spin text-brand-500" />
              }
            </div>
          </div>

          {progress && (
            <>
              <div className="w-full bg-gray-800/60 rounded-full h-2">
                <div
                  className="h-2 rounded-full transition-all"
                  style={{
                    width: `${progressPct}%`,
                    background: 'linear-gradient(90deg, #7c3aed, #2563eb, #0ea5e9)',
                    boxShadow: '0 0 8px rgba(124,58,237,0.6)',
                  }}
                />
              </div>
              <div className="flex justify-between text-xs text-gray-400">
                <span>{progress.fetched} / {progress.total || '?'} users fetched</span>
                <span className="flex gap-3">
                  <span>Elapsed: {formatTime(elapsed)}</span>
                  {progress.eta_seconds != null && (
                    <span>ETA: {formatTime(progress.eta_seconds)}</span>
                  )}
                  {progress.rate_limit_remaining != null && (
                    <span>RL: {progress.rate_limit_remaining}</span>
                  )}
                </span>
              </div>
            </>
          )}

          {/* Scrollable log */}
          <div
            ref={logRef}
            className="rounded-lg p-3 h-48 overflow-y-auto font-mono text-xs text-emerald-300/80 space-y-0.5"
            style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(52,211,153,0.15)' }}
          >
            {log.map((l, i) => (
              <div key={i}>{l.text}</div>
            ))}
            {running && <div className="text-brand-400 animate-pulse">▋</div>}
          </div>

          {done && (
            <button
              type="button"
              onClick={onViewResults}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              View Results →
            </button>
          )}
        </div>
      )}

      {/* Import from file card */}
      <div
        className="card space-y-3"
        style={{ borderColor: 'rgba(56,189,248,0.25)', boxShadow: '0 0 20px rgba(56,189,248,0.06)' }}
      >
        <div className="flex items-center gap-2">
          <FileJson size={16} className="text-sky-400" />
          <h2 className="text-sm font-semibold text-gray-200">Import Previously Exported Data</h2>
        </div>
        <p className="text-xs text-gray-500">
          Upload a <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.07)' }}>.json</code> file
          exported from a previous collection to visualise the data without re-running a collection.
        </p>

        {/* Drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); setImportDragOver(true) }}
          onDragLeave={() => setImportDragOver(false)}
          onDrop={e => {
            e.preventDefault()
            setImportDragOver(false)
            const file = e.dataTransfer.files[0]
            if (file) handleImportFile(file)
          }}
          onClick={() => importInputRef.current?.click()}
          className="rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 py-8 cursor-pointer transition-all select-none"
          style={{
            borderColor: importDragOver ? 'rgba(56,189,248,0.7)' : 'rgba(56,189,248,0.25)',
            background: importDragOver ? 'rgba(56,189,248,0.06)' : 'rgba(255,255,255,0.02)',
          }}
        >
          {importing
            ? <Loader2 size={24} className="text-sky-400 animate-spin" />
            : <Upload size={24} className={importDragOver ? 'text-sky-300' : 'text-sky-500'} />
          }
          <span className="text-sm text-gray-400">
            {importing ? 'Importing…' : 'Drop a JSON file here, or click to browse'}
          </span>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0]
              if (file) handleImportFile(file)
            }}
          />
        </div>

        {importError && (
          <div className="flex items-start gap-2 text-red-400 bg-red-950 border border-red-800 rounded-lg p-3 text-sm">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            {importError}
          </div>
        )}
      </div>

      {/* Token missing modal */}
      {showTokenModal && (
        <>
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
            onClick={() => setShowTokenModal(false)}
          >
            <div
              className="relative w-full max-w-lg rounded-2xl p-6 space-y-5"
              style={{
                background: 'rgba(18,14,40,0.96)',
                border: '1px solid rgba(139,92,246,0.3)',
                boxShadow: '0 0 60px rgba(124,58,237,0.2)',
              }}
              onClick={e => e.stopPropagation()}
            >
              {/* Close */}
              <button
                onClick={() => setShowTokenModal(false)}
                className="absolute top-4 right-4 text-gray-500 hover:text-gray-200 transition-colors"
              >
                <X size={18} />
              </button>

              {/* Header */}
              <div className="flex items-start gap-3">
                <div className="rounded-xl p-2 mt-0.5 flex-shrink-0" style={{ background: 'rgba(251,191,36,0.12)' }}>
                  <ShieldAlert size={22} className="text-amber-400" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white">GitHub Token Recommended</h2>
                  <p className="text-sm text-gray-400 mt-0.5">
                    Without a Personal Access Token, GitHub limits unauthenticated requests to
                    <span className="text-amber-400 font-medium"> 60 requests/hour</span>.
                    Most repositories will hit this limit almost immediately, causing the collection to fail or return incomplete data.
                  </p>
                </div>
              </div>

              {/* How-to */}
              <div className="rounded-xl p-4 space-y-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: '#a78bfa' }}>
                  <Key size={15} />
                  How to create a GitHub Personal Access Token
                </div>
                <ol className="space-y-2 text-sm text-gray-300">
                  <li className="flex gap-2">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full text-xs flex items-center justify-center font-bold text-white" style={{ background: 'linear-gradient(135deg,#7c3aed,#2563eb)' }}>1</span>
                    <span>Go to <a href="https://github.com/settings/tokens/new" target="_blank" rel="noopener noreferrer" className="underline decoration-dotted hover:text-white inline-flex items-center gap-0.5" style={{ color: '#60a5fa' }}>github.com/settings/tokens/new <ExternalLink size={11} /></a></span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full text-xs flex items-center justify-center font-bold text-white" style={{ background: 'linear-gradient(135deg,#7c3aed,#2563eb)' }}>2</span>
                    <span>Give it a name (e.g. <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.08)' }}>repo-people-explorer</code>) and set an expiry.</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full text-xs flex items-center justify-center font-bold text-white" style={{ background: 'linear-gradient(135deg,#7c3aed,#2563eb)' }}>3</span>
                    <span>Select the <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.08)' }}>public_repo</code> scope (read-only access to public repos is all that's needed).</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full text-xs flex items-center justify-center font-bold text-white" style={{ background: 'linear-gradient(135deg,#7c3aed,#2563eb)' }}>4</span>
                    <span>Click <strong className="text-white">Generate token</strong>, then copy it and paste it into the token field.</span>
                  </li>
                </ol>
                <p className="text-xs text-gray-500 pt-1">
                  With a token, the rate limit increases to <span className="text-emerald-400 font-medium">5,000 requests/hour</span>. Your token is only sent to your local backend and never stored.
                </p>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-1">
                <a
                  href="https://github.com/settings/tokens/new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-primary flex items-center gap-2 text-sm flex-1 justify-center"
                  onClick={() => setShowTokenModal(false)}
                >
                  <ExternalLink size={14} /> Get a Token
                </a>
                <button
                  type="button"
                  onClick={() => setShowTokenModal(false)}
                  className="btn-secondary text-sm flex-1"
                >
                  I'll enter it now
                </button>
              </div>
              <button
                type="button"
                onClick={continueWithoutToken}
                className="w-full text-xs text-gray-500 hover:text-gray-300 transition-colors pt-1"
              >
                Continue anyway (severe rate limiting likely)
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
