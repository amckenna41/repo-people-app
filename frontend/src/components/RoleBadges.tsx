import { ROLE_COLORS } from '../types'

interface Props {
  roles: string[]
}

export default function RoleBadges({ roles }: Props) {
  if (!roles?.length) return null
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map(r => (
        <span key={r} className={`badge ${ROLE_COLORS[r] ?? 'bg-gray-700 text-gray-300'}`}>
          {r}
        </span>
      ))}
    </div>
  )
}
