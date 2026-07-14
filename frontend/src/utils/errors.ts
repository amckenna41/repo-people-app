/**
 * Friendly, context-aware error messages for GitHub API failures.
 *
 * Call friendlyFetchError(rawMsg, owner?, repo?) to convert a raw HTTP error
 * string (from api.ts or SSE events) into a user-facing explanation.
 */
export function friendlyFetchError(msg: string, owner?: string, repo?: string): string {
  const m = msg.toLowerCase()
  if (m.includes('401') || m.includes('unauthorized') || m.includes('bad credentials')) {
    return 'Authentication failed — your Personal Access Token is invalid or has expired. Regenerate it at github.com/settings/tokens.'
  }
  // Check secondary rate limit before the generic rate-limit branch (more specific first)
  if (m.includes('429') || m.includes('too many requests') || m.includes('secondary rate limit')) {
    return 'GitHub secondary rate limit hit. Wait a few minutes, reduce the worker count, or add a PAT.'
  }
  if (m.includes('rate limit') || (m.includes('403') && m.includes('rate'))) {
    return 'GitHub API rate limit exhausted. Add a PAT to raise the limit from 60 to 5,000 req/hr (see the token field above).'
  }
  if (m.includes('403') || m.includes('forbidden')) {
    return `Access denied to ${owner && repo ? `${owner}/${repo}` : 'this repository'}. If it is private, you need a PAT with the \`repo\` scope.`
  }
  if (m.includes('404') || m.includes('not found') || m.includes('repository not found')) {
    return `Repository not found: ${owner && repo ? `${owner}/${repo}` : 'the requested repo'}. Check the owner and name are spelled correctly.`
  }
  if (m.includes('422') || m.includes('unprocessable')) {
    return 'Invalid request — check the owner and repository name contain only valid characters.'
  }
  if (m.includes('503') || m.includes('service unavailable')) {
    return 'GitHub is temporarily unavailable. Try again in a few minutes.'
  }
  if (m.includes('network') || m.includes('failed to fetch') || m.includes('load failed') || m.includes('econnrefused')) {
    const base = import.meta.env.VITE_API_BASE_URL
    const target = base
      ? `the backend at ${base}`
      : 'the backend (VITE_API_BASE_URL is not set, so requests go to this site’s own origin)'
    return `Could not reach ${target}. Confirm the Cloud Run service is deployed and running, that VITE_API_BASE_URL points at its URL, and that your network/CORS allows the request.`
  }
  return msg
}
