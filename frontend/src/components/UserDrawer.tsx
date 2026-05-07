import type { UserRecord } from '../types'
import RoleBadges from './RoleBadges'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { X, ExternalLink } from 'lucide-react'

interface Props {
  user: UserRecord
  onClose: () => void
}

const FIELD_ORDER: (keyof UserRecord)[] = [
  'login', 'name', 'type', 'bio', 'location', 'company', 'email_public', 'blog',
  'twitter', 'followers', 'following', 'public_repos', 'public_gists',
  'account_age_days', 'followers_following_ratio', 'repos_per_year',
  'recently_active', 'is_bot', 'total_public_stars_sampled', 'total_public_forks_sampled',
  'has_public_email', 'has_blog', 'has_twitter', 'orgs_public_count',
  'created_at', 'updated_at', 'last_public_event_at',
]

export default function UserDrawer({ user, onClose }: Props) {
  const langData = (user.top_languages ?? []).map(([lang, count]) => ({ lang, count }))

  return (
    <div className="fixed inset-y-0 right-0 w-96 z-50 flex flex-col shadow-2xl" style={{
      background: 'rgba(10,8,24,0.85)',
      borderLeft: '1px solid rgba(139,92,246,0.2)',
      backdropFilter: 'blur(20px)',
    }}>
      {/* Header */}
      <div className="flex items-center gap-3 p-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <img
          src={user.avatar_url ?? 'https://github.com/ghost.png'}
          alt={user.login}
          className="w-10 h-10 rounded-full"
        />
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">{user.name || user.login}</div>
          <a
            href={user.html_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs flex items-center gap-1 hover:underline"
            style={{ color: '#a78bfa' }}
          >
            @{user.login} <ExternalLink size={10} />
          </a>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-200">
          <X size={18} />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Roles */}
        {user.roles?.length ? (
          <div>
            <div className="text-xs text-gray-500 uppercase mb-2">Roles</div>
            <RoleBadges roles={user.roles} />
          </div>
        ) : null}

        {/* Top languages mini chart */}
        {langData.length > 0 && (
          <div>
            <div className="text-xs text-gray-500 uppercase mb-2">Top Languages</div>
            <ResponsiveContainer width="100%" height={120}>
              <BarChart data={langData} layout="vertical" margin={{ left: 0, right: 8, top: 0, bottom: 0 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="lang" width={90} tick={{ fill: '#9ca3af', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 6 }}
                  labelStyle={{ color: '#e5e7eb' }}
                />
                <Bar dataKey="count" fill="#0ea5e9" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* All fields */}
        <div>
          <div className="text-xs text-gray-500 uppercase mb-2">Profile Fields</div>
          <dl className="space-y-1.5 text-sm">
            {FIELD_ORDER.map(key => {
              const val = user[key]
              if (val === null || val === undefined || val === '') return null
              return (
                <div key={key} className="flex gap-2">
                  <dt className="text-gray-500 w-52 shrink-0 break-words">{key}</dt>
                  <dd className="text-gray-200 break-all min-w-0">{String(val)}</dd>
                </div>
              )
            })}
            {/* Social accounts */}
            {user.social_accounts && (
              <div className="flex gap-2">
                <dt className="text-gray-500 w-52 shrink-0 break-words">social_accounts</dt>
                <dd className="text-gray-200 break-all min-w-0">{JSON.stringify(user.social_accounts)}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>
    </div>
  )
}
