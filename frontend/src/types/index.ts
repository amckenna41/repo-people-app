export interface UserRecord {
  login: string
  id?: number
  node_id?: string
  type?: string
  name?: string
  company?: string
  company_normalized?: string
  location?: string
  location_normalized?: string
  email_public?: string
  email_domain?: string
  blog?: string
  blog_host?: string
  twitter?: string
  bio?: string
  avatar_url?: string
  html_url?: string
  hireable?: boolean
  site_admin?: boolean
  created_at?: string
  updated_at?: string
  followers?: number
  following?: number
  public_repos?: number
  public_gists?: number
  public_orgs?: string[]
  orgs_public_count?: number
  is_bot?: boolean
  last_public_event_at?: string
  has_public_email?: boolean
  has_blog?: boolean
  has_twitter?: boolean
  account_age_days?: number
  followers_following_ratio?: number
  repos_per_year?: number
  recently_active?: boolean
  top_languages?: [string, number][]
  total_public_stars_sampled?: number
  total_public_forks_sampled?: number
  ssh_keys_count?: number | null
  gpg_keys_count?: number | null
  starred_repos_sampled?: number | null
  social_accounts?: Record<string, string> | null
  is_collaborator?: boolean | null
  permission_on_repo?: string | null
  roles?: string[]
}

export interface JobInfo {
  job_id: string
  status: 'pending' | 'running' | 'done' | 'error' | 'stale'
  total_fetched: number
  label?: string  // user-assigned label like "owner/repo"
  timestamp?: string  // ISO string, set when job completes
  created_at?: string  // ISO string from DB
  tags?: string[]  // user-assigned tags
}

export interface SummaryData {
  total: number
  humans: number
  bots: number
  top_locations: { location: string; count: number }[]
  top_companies: { company: string; count: number }[]
  account_age_distribution: Record<string, number>
  role_distribution: Record<string, number>
}

export interface CompareResult {
  only_in_a: { login: string; avatar_url: string; html_url: string }[]
  only_in_b: { login: string; avatar_url: string; html_url: string }[]
  in_both: { login: string; avatar_url: string; html_url: string }[]
  stats: {
    count_a: number
    count_b: number
    only_in_a: number
    only_in_b: number
    in_both: number
    overlap_pct: number
  }
}

export interface MultiCompareResult {
  in_all: { login: string; avatar_url: string; html_url: string }[]
  shared: { login: string; avatar_url: string; html_url: string }[]
  exclusive_per_job: { login: string; avatar_url: string; html_url: string }[][]
  stats: {
    total_unique: number
    in_all_count: number
    shared_count: number
    exclusive_per_job: number[]
    per_job_totals: number[]
  }
}

export type View = 'fetch' | 'results' | 'compare'

export const ALL_ROLES = [
  'contributors',
  'maintainers',
  'stargazers',
  'watchers',
  'issue_authors',
  'pr_authors',
  'fork_owners',
  'commit_authors',
  'dependents',
] as const

export type Role = typeof ALL_ROLES[number]

export const ROLE_COLORS: Record<string, string> = {
  contributors: 'bg-emerald-800 text-emerald-200',
  maintainers: 'bg-purple-800 text-purple-200',
  stargazers: 'bg-yellow-800 text-yellow-200',
  watchers: 'bg-blue-800 text-blue-200',
  issue_authors: 'bg-red-800 text-red-200',
  pr_authors: 'bg-orange-800 text-orange-200',
  fork_owners: 'bg-cyan-800 text-cyan-200',
  commit_authors: 'bg-indigo-800 text-indigo-200',
  dependents: 'bg-pink-800 text-pink-200',
}
