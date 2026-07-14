import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Development-only cache-clear route.
// Visiting /clear_cache calls the backend to delete all jobs, wipes
// client-side storage, then redirects to the app root.
if (window.location.pathname === '/clear_cache') {
  // Dev-only reset. The backend endpoint is a guarded POST (enabled via
  // ALLOW_DEV_CLEAR); it 403s in production, which we ignore here.
  fetch('/clear_cache', { method: 'POST' })
    .catch(() => {/* backend may already be empty or disabled — continue regardless */})
    .finally(() => {
      sessionStorage.clear()
      localStorage.removeItem('repo-people-jobs')
      localStorage.removeItem('repo-people-search-history')
      window.location.replace('/')
    })
} else if (window.opener && window.location.hash.startsWith('#auth=success')) {
  // This page is running inside the OAuth popup.
  // Notify the opener window that authentication completed, then close.
  window.opener.postMessage({ type: 'oauth-success' }, window.location.origin)
  window.close()
} else {
  // Strip the #auth=success hash fragment (non-popup fallback path).
  if (window.location.hash.startsWith('#auth=')) {
    history.replaceState(null, '', window.location.pathname + window.location.search)
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
