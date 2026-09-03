import { useRef, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

interface Props<T> {
  items: T[]
  /** Approximate row height in px. Rows may vary; the virtualizer measures them. */
  rowHeight: number
  /** Max height of the scroll container, e.g. "24rem" or "100%". */
  maxHeight?: string
  className?: string
  keyOf: (item: T) => string
  renderRow: (item: T) => ReactNode
  empty?: ReactNode
}

/**
 * Scroll container that mounts only the visible rows.
 *
 * The main results table has been virtualized for a while; these smaller lists
 * were not, and they render whatever `/compare` or a world-map country click
 * returns — uncapped. Comparing two large repos, or clicking a populous
 * country, mounted thousands of avatar rows synchronously and janked the UI.
 *
 * Below `VIRTUALIZE_THRESHOLD` rows the plain list is used, which keeps the DOM
 * natural for the common small case and avoids the absolute-positioning that
 * makes short lists awkward to style.
 */
export const VIRTUALIZE_THRESHOLD = 60

export default function VirtualList<T>({
  items, rowHeight, maxHeight = '24rem', className = '', keyOf, renderRow, empty,
}: Props<T>) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Hooks cannot be conditional, so the virtualizer is always created; it is
  // simply ignored for short lists.
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  })

  if (items.length === 0) {
    return <div className={`overflow-y-auto ${className}`} style={{ maxHeight }}>{empty}</div>
  }

  if (items.length < VIRTUALIZE_THRESHOLD) {
    return (
      <div ref={scrollRef} className={`overflow-y-auto ${className}`} style={{ maxHeight }}>
        {items.map(item => <div key={keyOf(item)}>{renderRow(item)}</div>)}
      </div>
    )
  }

  const virtualItems = virtualizer.getVirtualItems()
  return (
    <div ref={scrollRef} className={`overflow-y-auto ${className}`} style={{ maxHeight }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualItems.map(v => {
          const item = items[v.index]
          return (
            <div
              key={keyOf(item)}
              ref={virtualizer.measureElement}
              data-index={v.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${v.start}px)`,
              }}
            >
              {renderRow(item)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
