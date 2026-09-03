import { useEffect, useRef } from 'react'

/**
 * Close a modal on Escape, and lock background scroll while it is open.
 *
 * Only GlobalSearchModal handled Escape; the help, recent-results,
 * token-missing, export-picker and world-map country modals all trapped the
 * user into reaching for a close button. Sharing one hook keeps them
 * consistent — and consistent is the whole point of an Escape key.
 *
 * Pass `null` when the modal is closed. Most of these modals are inline JSX
 * conditionals inside a larger component rather than components of their own,
 * so the hook has to be callable unconditionally; a null handler simply
 * registers nothing.
 *
 * `capture: true` so the handler runs ahead of anything that stops
 * propagation, and the listener is scoped to the open state so stacked modals
 * close from the top down rather than all at once.
 */
export function useModalEscape(
  onClose: (() => void) | null,
  opts: { lockScroll?: boolean } = {},
) {
  const { lockScroll = true } = opts
  const isOpen = onClose !== null

  // Held in a ref so an inline arrow at the call site does not re-subscribe the
  // listener on every render.
  const handlerRef = useRef(onClose)
  handlerRef.current = onClose

  useEffect(() => {
    if (!isOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      handlerRef.current?.()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || !lockScroll) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [isOpen, lockScroll])
}
