// Pre-flight cost estimate for a fetch.
//
// A self-hosted install can run with FETCH_LIMIT=0, which removes the server's
// ceiling entirely — there is otherwise nothing between a stray role selection
// and an hours-long crawl that burns the whole API quota. The numbers are
// deliberately rough: the point is order of magnitude, not precision.

/** Profiles fetched per second, per worker. Derived from the observed rate of
 *  roughly one profile request per worker per ~600ms against a warm token. */
const PROFILES_PER_WORKER_PER_SEC = 1.6

/** Each profile costs about this many GitHub API calls (profile + orgs + repos
 *  sampling), so quota drain is roughly this multiple of the user count. */
const API_CALLS_PER_PROFILE = 3

export interface FetchEstimate {
  /** Upper bound on unique profiles, or null when genuinely unbounded. */
  users: number | null
  seconds: number | null
  apiCalls: number | null
  /** True when nothing caps the run — worth an explicit confirmation. */
  unbounded: boolean
}

export function estimateFetch(opts: {
  roleCount: number
  perRoleLimit: number | null
  serverCap: number
  workers: number
  repoCount: number
}): FetchEstimate {
  const { roleCount, perRoleLimit, serverCap, workers, repoCount } = opts
  const safeWorkers = Math.max(1, workers)

  // The server cap wins when set; otherwise the per-role limit bounds each role.
  let users: number | null = null
  if (serverCap > 0) users = serverCap * Math.max(1, repoCount)
  else if (perRoleLimit && perRoleLimit > 0) {
    // Worst case: no overlap between roles.
    users = perRoleLimit * Math.max(1, roleCount) * Math.max(1, repoCount)
  }

  if (users === null) {
    return { users: null, seconds: null, apiCalls: null, unbounded: true }
  }
  return {
    users,
    seconds: Math.ceil(users / (safeWorkers * PROFILES_PER_WORKER_PER_SEC)),
    apiCalls: users * API_CALLS_PER_PROFILE,
    unbounded: false,
  }
}

/** "about 4 minutes", "about 25 seconds", "over an hour". */
export function humaniseDuration(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} seconds`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = seconds / 3600
  return hours < 1.5 ? 'over an hour' : `about ${Math.round(hours)} hours`
}
