import { useMemo, useState } from 'react'
import { ComposableMap, Geographies, Geography, ZoomableGroup } from 'react-simple-maps'
import { X } from 'lucide-react'
import type { UserRecord } from '../types'

// Natural Earth 110m TopoJSON — tiny, no server required
const GEO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json'

// Mapping of common location strings (lowercase) → ISO numeric country code
// These are the strings that typically appear in location_normalized
const COUNTRY_NAME_TO_NUM: Record<string, number> = {
  'united states': 840, 'usa': 840, 'u.s.': 840, 'us': 840, 'united states of america': 840,
  'united kingdom': 826, 'uk': 826, 'england': 826, 'great britain': 826,
  'germany': 276, 'deutschland': 276,
  'france': 250,
  'canada': 124,
  'australia': 36,
  'india': 356,
  'china': 156,
  'brazil': 76,
  'japan': 392,
  'netherlands': 528,
  'sweden': 752,
  'switzerland': 756,
  'spain': 724,
  'italy': 380,
  'russia': 643,
  'poland': 616,
  'ukraine': 804,
  'turkey': 792,
  'south korea': 410, 'korea': 410,
  'argentina': 32,
  'mexico': 484,
  'indonesia': 360,
  'norway': 578,
  'denmark': 208,
  'finland': 246,
  'austria': 40,
  'belgium': 56,
  'portugal': 620,
  'czech republic': 203, 'czechia': 203,
  'romania': 642,
  'hungary': 348,
  'greece': 300,
  'israel': 376,
  'singapore': 702,
  'new zealand': 554,
  'south africa': 710,
  'nigeria': 566,
  'egypt': 818,
  'pakistan': 586,
  'bangladesh': 50,
  'vietnam': 704,
  'thailand': 764,
  'malaysia': 458,
  'philippines': 608,
  'iran': 364,
  'colombia': 170,
  'chile': 152,
  'peru': 604,
  'venezuela': 862,
  'slovakia': 703,
  'bulgaria': 100,
  'croatia': 191,
  'serbia': 688,
  'taiwan': 158,
  'hong kong': 344,
  'ireland': 372,
  'scotland': 826,
  'wales': 826,
  'iceland': 352,
  'luxembourg': 442,
  'estonia': 233,
  'latvia': 428,
  'lithuania': 440,
  'slovenia': 705,
  'kenya': 404,
  'ghana': 288,
  'ethiopia': 231,
  'morocco': 504,
  'tunisia': 788,
  'algeria': 12,
  'saudi arabia': 682,
  'uae': 784, 'united arab emirates': 784,
  'qatar': 634,
  'jordan': 400,
  'cuba': 192,
  'ecuador': 218,
  'bolivia': 68,
  'uruguay': 858,
  'costa rica': 188,
  'sri lanka': 144,
  'nepal': 524,
  'kazakhstan': 398,
  'uzbekistan': 860,
  'belarus': 112,
  'moldova': 498,
}

function numericToAlpha3(num: number): string {
  // World Atlas uses ISO 3166-1 numeric — the TopoJSON stores them as string keys
  return String(num)
}

function getCountryNum(location: string): number | null {
  const lower = location.toLowerCase().trim()
  // Direct match
  if (COUNTRY_NAME_TO_NUM[lower] !== undefined) return COUNTRY_NAME_TO_NUM[lower]
  // Try matching any known country name that appears within the location string
  for (const [name, num] of Object.entries(COUNTRY_NAME_TO_NUM)) {
    if (lower.includes(name)) return num
  }
  return null
}

// Interpolate between two hex colours
function interpolateColor(from: string, to: string, t: number): string {
  const parse = (h: string) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ]
  const a = parse(from)
  const b = parse(to)
  const r = Math.round(a[0] + (b[0] - a[0]) * t)
  const g = Math.round(a[1] + (b[1] - a[1]) * t)
  const bl = Math.round(a[2] + (b[2] - a[2]) * t)
  return `rgb(${r},${g},${bl})`
}

interface Props {
  users: UserRecord[]
}

const MIN_ZOOM = 1
const MAX_ZOOM = 8

export default function WorldMap({ users }: Props) {
  const [tooltip, setTooltip] = useState<{ country: string; count: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [selected, setSelected] = useState<{ label: string; users: UserRecord[] } | null>(null)

  function zoomIn() { setZoom(z => Math.min(z * 1.5, MAX_ZOOM)) }
  function zoomOut() { setZoom(z => Math.max(z / 1.5, MIN_ZOOM)) }
  function resetZoom() { setZoom(1) }

  // Build country → count from location_normalized
  const countryCounts = useMemo(() => {
    const counts: Record<number, number> = {}
    for (const u of users) {
      const loc = u.location_normalized ?? u.location
      if (!loc) continue
      const num = getCountryNum(loc)
      if (num !== null) counts[num] = (counts[num] ?? 0) + 1
    }
    return counts
  }, [users])

  // Build country → users list
  const countryUsers = useMemo(() => {
    const map: Record<number, UserRecord[]> = {}
    for (const u of users) {
      const loc = u.location_normalized ?? u.location
      if (!loc) continue
      const num = getCountryNum(loc)
      if (num !== null) {
        if (!map[num]) map[num] = []
        map[num].push(u)
      }
    }
    return map
  }, [users])

  const maxCount = useMemo(() => Math.max(1, ...Object.values(countryCounts)), [countryCounts])

  // Build tooltip-friendly name map (numeric → first location string that matched it)
  const countryLabel = useMemo(() => {
    const m: Record<number, string> = {}
    for (const u of users) {
      const loc = u.location_normalized ?? u.location
      if (!loc) continue
      const num = getCountryNum(loc)
      if (num !== null && !m[num]) m[num] = loc
    }
    return m
  }, [users])

  if (Object.keys(countryCounts).length === 0) return null

  return (
    <div className="card">
      <h3 className="text-sm font-semibold gradient-heading mb-1 flex items-center gap-1.5">
        🌍 World Map
      </h3>
      <p className="text-xs text-gray-500 mb-3">User density by country. Scroll to zoom, drag to pan.</p>

      {/* Legend + zoom controls */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>0</span>
          <div className="w-32 h-2 rounded" style={{
            background: 'linear-gradient(to right, #1e1b4b, #7c3aed)',
          }} />
          <span>{maxCount} users</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={zoomOut}
            disabled={zoom <= MIN_ZOOM}
            className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all text-base leading-none"
            title="Zoom out"
          >−</button>
          <button
            onClick={resetZoom}
            className="px-2 h-7 rounded text-xs text-gray-400 hover:text-white hover:bg-white/10 transition-all font-mono"
            title="Reset zoom"
          >{zoom.toFixed(1)}×</button>
          <button
            onClick={zoomIn}
            disabled={zoom >= MAX_ZOOM}
            className="w-7 h-7 rounded flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all text-base leading-none"
            title="Zoom in"
          >+</button>
        </div>
      </div>

      {tooltip && (
        <div
          className="absolute z-50 text-xs rounded-lg px-3 py-1.5 pointer-events-none"
          style={{
            background: 'rgba(14,10,36,0.95)',
            border: '1px solid rgba(139,92,246,0.3)',
            color: '#e5e7eb',
          }}
        >
          <span className="font-semibold">{tooltip.country}</span>: {tooltip.count} user{tooltip.count !== 1 ? 's' : ''}
        </div>
      )}

      <div className="relative w-full overflow-hidden rounded-lg" style={{ background: 'rgba(255,255,255,0.02)' }}>
        <ComposableMap
          projection="geoNaturalEarth1"
          style={{ width: '100%', height: 'auto' }}
        >
          <ZoomableGroup zoom={zoom} onMoveEnd={({ zoom: z }) => setZoom(z)} minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM}>
            <Geographies geography={GEO_URL}>
              {({ geographies }) =>
                geographies.map(geo => {
                  const num = parseInt(geo.id, 10)
                  const count = countryCounts[num] ?? 0
                  const t = count > 0 ? Math.pow(count / maxCount, 0.5) : 0
                  const fill = count > 0
                    ? interpolateColor('#2e1065', '#a855f7', t)
                    : 'rgba(255,255,255,0.04)'
                  const stroke = 'rgba(255,255,255,0.08)'

                  return (
                    <Geography
                      key={geo.rsmKey}
                      geography={geo}
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={0.5}
                      style={{
                        default: { outline: 'none' },
                        hover: { outline: 'none', fill: count > 0 ? interpolateColor('#2e1065', '#c084fc', t) : 'rgba(255,255,255,0.08)', cursor: count > 0 ? 'pointer' : 'default' },
                        pressed: { outline: 'none' },
                      }}
                      onMouseEnter={() => {
                        if (count > 0) setTooltip({ country: countryLabel[num] ?? String(num), count })
                      }}
                      onMouseLeave={() => setTooltip(null)}
                      onClick={() => {
                        if (count > 0) {
                          setSelected({ label: countryLabel[num] ?? String(num), users: countryUsers[num] ?? [] })
                        }
                      }}
                    />
                  )
                })
              }
            </Geographies>
          </ZoomableGroup>
        </ComposableMap>
      </div>

      {/* Country users modal */}
      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
          onClick={() => setSelected(null)}
        >
          <div
            className="relative w-full max-w-lg max-h-[80vh] flex flex-col rounded-2xl overflow-hidden"
            style={{ background: '#0f0a1e', border: '1px solid rgba(139,92,246,0.25)' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
              <div>
                <h2 className="text-sm font-semibold text-white capitalize">{selected.label}</h2>
                <p className="text-xs text-gray-500 mt-0.5">{selected.users.length} user{selected.users.length !== 1 ? 's' : ''}</p>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/10 transition-all"
              >
                <X size={16} />
              </button>
            </div>

            {/* User list */}
            <div className="overflow-y-auto flex-1 px-3 py-3 space-y-1">
              {selected.users.map(u => (
                <a
                  key={u.login}
                  href={u.html_url ?? `https://github.com/${u.login}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 transition-all group"
                >
                  {u.avatar_url
                    ? <img src={u.avatar_url} alt={u.login} className="w-8 h-8 rounded-full flex-shrink-0 opacity-90 group-hover:opacity-100" />
                    : <div className="w-8 h-8 rounded-full flex-shrink-0 bg-purple-900/50 flex items-center justify-center text-xs text-purple-300">{u.login[0].toUpperCase()}</div>
                  }
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white font-medium truncate group-hover:text-purple-300 transition-colors">
                      {u.name || u.login}
                    </div>
                    <div className="text-xs text-gray-500 truncate">@{u.login}{u.company_normalized ? ` · ${u.company_normalized}` : ''}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    {u.followers != null && (
                      <span className="text-xs text-gray-500">{u.followers.toLocaleString()} followers</span>
                    )}
                    {u.roles && u.roles.length > 0 && (
                      <div className="flex gap-1 flex-wrap justify-end">
                        {u.roles.slice(0, 2).map(r => (
                          <span key={r} className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-900/50 text-purple-300">{r}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
