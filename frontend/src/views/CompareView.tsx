import { useState } from 'react'
import { postCompare, postCompareMulti } from '../utils/api'
import type { CompareResult, MultiCompareResult, JobInfo } from '../types'
import { GitCompare, Loader2, ExternalLink, Plus, Trash2 }  from 'lucide-react'

interface Props {
  jobs: JobInfo[]
}

interface UserCard {
  login: string
  avatar_url: string
  html_url: string
}

export default function CompareView({ jobs }: Props) {
  const doneJobs = jobs.filter(j => j.status === 'done')

  const [mode, setMode] = useState<'two' | 'multi'>('two')

  // 2-way state
  const [jobIdA, setJobIdA] = useState('')
  const [jobIdB, setJobIdB] = useState('')
  const [result, setResult] = useState<CompareResult | null>(null)

  // Multi state
  const [multiJobIds, setMultiJobIds] = useState<string[]>(['', ''])
  const [multiResult, setMultiResult] = useState<MultiCompareResult | null>(null)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCompare() {
    if (!jobIdA || !jobIdB) { setError('Please select two jobs.'); return }
    if (jobIdA === jobIdB) { setError('Please select two different jobs.'); return }
    setError(null); setLoading(true)
    try {
      setResult(await postCompare(jobIdA, jobIdB))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  function addMultiSlot() {
    if (multiJobIds.length < 5) setMultiJobIds(prev => [...prev, ''])
  }
  function removeMultiSlot(i: number) {
    setMultiJobIds(prev => prev.filter((_, idx) => idx !== i))
  }
  function setMultiSlot(i: number, val: string) {
    setMultiJobIds(prev => prev.map((v, idx) => idx === i ? val : v))
  }

  async function handleMultiCompare() {
    const filled = multiJobIds.filter(Boolean)
    if (filled.length < 2) { setError('Select at least 2 jobs.'); return }
    if (new Set(filled).size !== filled.length) { setError('Duplicate jobs selected — each job must be unique.'); return }
    setError(null); setLoading(true)
    try {
      setMultiResult(await postCompareMulti(filled))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  const labelA = doneJobs.find(j => j.job_id === jobIdA)?.label ?? jobIdA
  const labelB = doneJobs.find(j => j.job_id === jobIdB)?.label ?? jobIdB
  const multiLabels = multiJobIds.filter(Boolean).map(id => doneJobs.find(j => j.job_id === id)?.label ?? id)

  if (doneJobs.length < 2) {
    return (
      <div className="text-center text-gray-500 mt-24">
        <GitCompare size={40} className="mx-auto mb-3 opacity-40" />
        <p>You need at least two completed jobs to compare. Go to <strong>Fetch</strong>.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold gradient-heading">Compare Repositories</h1>
        <div className="flex rounded-lg overflow-hidden text-sm" style={{ border: '1px solid rgba(139,92,246,0.25)' }}>
          {(['two', 'multi'] as const).map(m => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(null); setResult(null); setMultiResult(null) }}
              className="px-4 py-1.5 font-medium transition-all"
              style={mode === m ? {
                background: 'linear-gradient(135deg, #7c3aed, #2563eb)',
                color: '#fff',
              } : {
                background: 'rgba(255,255,255,0.04)',
                color: '#9ca3af',
              }}
            >
              {m === 'two' ? '2-Way' : 'Multi (3–5)'}
            </button>
          ))}
        </div>
      </div>

      {/* ── 2-Way form ── */}
      {mode === 'two' && (
        <>
          <div className="card grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Repo A</label>
              <select className="input" value={jobIdA} onChange={e => setJobIdA(e.target.value)}>
                <option value="">Select a job…</option>
                {doneJobs.map(j => (
                  <option key={j.job_id} value={j.job_id}>{j.label ?? j.job_id} ({j.total_fetched} users)</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Repo B</label>
              <select className="input" value={jobIdB} onChange={e => setJobIdB(e.target.value)}>
                <option value="">Select a job…</option>
                {doneJobs.map(j => (
                  <option key={j.job_id} value={j.job_id}>{j.label ?? j.job_id} ({j.total_fetched} users)</option>
                ))}
              </select>
            </div>
          </div>
          {error && <div className="text-red-400 bg-red-950 border border-red-800 rounded-lg p-3 text-sm">{error}</div>}
          <button onClick={handleCompare} className="btn-primary" disabled={loading}>
            {loading ? <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Comparing…</span> : 'Compare'}
          </button>
          {result && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard label="Users in A" value={result.stats.count_a} />
                <StatCard label="Users in B" value={result.stats.count_b} />
                <StatCard label="In both" value={result.stats.in_both} color="text-emerald-400" />
                <StatCard label="Overlap %" value={`${result.stats.overlap_pct}%`} color="text-brand-400" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <UserColumn title={`Only in ${labelA}`} count={result.stats.only_in_a} users={result.only_in_a} headerClass="text-orange-400" />
                <UserColumn title="In Both" count={result.stats.in_both} users={result.in_both} headerClass="text-emerald-400" />
                <UserColumn title={`Only in ${labelB}`} count={result.stats.only_in_b} users={result.only_in_b} headerClass="text-blue-400" />
              </div>
            </>
          )}
        </>
      )}

      {/* ── Multi overlap form ── */}
      {mode === 'multi' && (
        <>
          <div className="card space-y-3">
            <div className="text-sm text-gray-400 mb-1">Select 2–5 completed jobs to find user overlap across all of them.</div>
            {multiJobIds.map((jid, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="text-xs text-gray-600 w-5 text-right font-mono shrink-0">{i + 1}</div>
                <select className="input flex-1" value={jid} onChange={e => setMultiSlot(i, e.target.value)}>
                  <option value="">Select a job…</option>
                  {doneJobs.map(j => (
                    <option key={j.job_id} value={j.job_id}>{j.label ?? j.job_id} ({j.total_fetched} users)</option>
                  ))}
                </select>
                {multiJobIds.length > 2 && (
                  <button type="button" onClick={() => removeMultiSlot(i)} className="text-gray-600 hover:text-red-400 transition-colors p-1 shrink-0">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
            {multiJobIds.length < 5 && doneJobs.length > multiJobIds.length && (
              <button type="button" onClick={addMultiSlot} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors mt-1">
                <Plus size={13} /> Add another repo
              </button>
            )}
          </div>
          {error && <div className="text-red-400 bg-red-950 border border-red-800 rounded-lg p-3 text-sm">{error}</div>}
          <button onClick={handleMultiCompare} className="btn-primary" disabled={loading}>
            {loading ? <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Analysing…</span> : 'Analyse Overlap'}
          </button>

          {multiResult && (() => {
            const filled = multiJobIds.filter(Boolean)
            const n = filled.length
            return (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
                  <StatCard label="Total Unique Users" value={multiResult.stats.total_unique} />
                  <StatCard label={`In All ${n} Repos`} value={multiResult.stats.in_all_count} color="text-emerald-400" />
                  {n > 2 && <StatCard label="Shared (2+ repos)" value={multiResult.stats.shared_count} color="text-blue-400" />}
                  {multiResult.stats.exclusive_per_job.map((cnt, i) => (
                    <StatCard key={i} label={`Only in: ${multiLabels[i] ?? `Repo ${i + 1}`}`} value={cnt} color="text-orange-400" />
                  ))}
                </div>

                {/* Per-repo bar breakdown */}
                <div className="card">
                  <div className="text-xs text-gray-500 uppercase mb-3">Users per Repository</div>
                  <div className="space-y-2.5">
                    {multiResult.stats.per_job_totals.map((total, i) => {
                      const max = Math.max(...multiResult.stats.per_job_totals, 1)
                      return (
                        <div key={i} className="flex items-center gap-3">
                          <div className="text-xs text-gray-400 w-32 truncate shrink-0">{multiLabels[i] ?? `Repo ${i + 1}`}</div>
                          <div className="flex-1 rounded-full overflow-hidden h-2" style={{ background: 'rgba(255,255,255,0.06)' }}>
                            <div
                              className="h-full rounded-full transition-all"
                              style={{
                                width: `${Math.round((total / max) * 100)}%`,
                                background: `hsl(${250 + i * 35}, 70%, 65%)`,
                              }}
                            />
                          </div>
                          <div className="text-xs text-gray-500 w-10 text-right shrink-0">{total}</div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* User columns */}
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                  <UserColumn
                    title={`In all ${n} repos`}
                    count={multiResult.stats.in_all_count}
                    users={multiResult.in_all}
                    headerClass="text-emerald-400"
                  />
                  {n > 2 && (
                    <UserColumn
                      title="Shared (2+ but not all)"
                      count={multiResult.stats.shared_count}
                      users={multiResult.shared}
                      headerClass="text-blue-400"
                    />
                  )}
                  {multiResult.exclusive_per_job.map((excl, i) => (
                    <UserColumn
                      key={i}
                      title={`Exclusive: ${multiLabels[i] ?? `Repo ${i + 1}`}`}
                      count={multiResult.stats.exclusive_per_job[i]}
                      users={excl}
                      headerClass="text-orange-400"
                    />
                  ))}
                </div>
              </>
            )
          })()}
        </>
      )}
    </div>
  )
}

function StatCard({ label, value, color = 'text-white' }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="card">
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  )
}

function UserColumn({
  title,
  count,
  users,
  headerClass,
}: {
  title: string
  count: number
  users: UserCard[]
  headerClass: string
}) {
  return (
    <div className="card flex flex-col gap-2">
      <div className={`text-sm font-semibold ${headerClass}`}>
        {title} <span className="text-gray-500 font-normal">({count})</span>
      </div>
      <div className="flex-1 overflow-y-auto max-h-96 space-y-1.5 pr-1">
        {users.map(u => (
          <a
            key={u.login}
            href={u.html_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-gray-800 transition-colors group"
          >
            <img src={u.avatar_url} alt={u.login} className="w-7 h-7 rounded-full shrink-0" />
            <span className="text-sm text-gray-300 truncate group-hover:text-white">{u.login}</span>
            <ExternalLink size={10} className="shrink-0 text-gray-600 group-hover:text-gray-400 ml-auto" />
          </a>
        ))}
        {users.length === 0 && (
          <div className="text-gray-600 text-sm text-center py-4">None</div>
        )}
      </div>
    </div>
  )
}
