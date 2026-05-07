import { useEffect, useRef } from 'react'

/**
 * Requests Notification permission on mount (if not already decided).
 * Returns a function to fire a notification — silently no-ops if permission
 * was denied or the Notification API is unavailable.
 */
export function useNotification() {
  const permissionRef = useRef<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  )

  useEffect(() => {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'default') {
      Notification.requestPermission().then(p => {
        permissionRef.current = p
      })
    } else {
      permissionRef.current = Notification.permission
    }
  }, [])

  function notify(title: string, options?: NotificationOptions) {
    if (typeof Notification === 'undefined') return
    if (permissionRef.current !== 'granted') return
    // Only fire when the tab is hidden
    if (!document.hidden) return
    new Notification(title, {
      icon: '/octocat.svg',
      badge: '/octocat.svg',
      ...options,
    })
  }

  return { notify }
}
