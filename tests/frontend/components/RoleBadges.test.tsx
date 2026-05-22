/**
 * RoleBadges.test.tsx — Unit tests for the RoleBadges component
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import RoleBadges from '../../../frontend/src/components/RoleBadges'

describe('RoleBadges', () => {
  it('renders nothing when roles is empty', () => {
    const { container } = render(<RoleBadges roles={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when roles is undefined/null', () => {
    // @ts-expect-error — testing null/undefined guards
    const { container } = render(<RoleBadges roles={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a badge for each role', () => {
    render(<RoleBadges roles={['contributors', 'stargazers']} />)
    expect(screen.getByText('contributors')).toBeInTheDocument()
    expect(screen.getByText('stargazers')).toBeInTheDocument()
  })

  it('renders a single role badge', () => {
    render(<RoleBadges roles={['watchers']} />)
    expect(screen.getByText('watchers')).toBeInTheDocument()
  })

  it('applies known role color class for contributors', () => {
    render(<RoleBadges roles={['contributors']} />)
    const badge = screen.getByText('contributors')
    expect(badge.className).toContain('bg-emerald-800')
  })

  it('applies known role color class for stargazers', () => {
    render(<RoleBadges roles={['stargazers']} />)
    const badge = screen.getByText('stargazers')
    expect(badge.className).toContain('bg-yellow-800')
  })

  it('applies fallback gray class for unknown roles', () => {
    render(<RoleBadges roles={['unknown-role']} />)
    const badge = screen.getByText('unknown-role')
    expect(badge.className).toContain('bg-gray-700')
  })

  it('renders all known roles without error', () => {
    const allRoles = [
      'contributors', 'maintainers', 'stargazers', 'watchers',
      'issue_authors', 'pr_authors', 'fork_owners', 'commit_authors', 'dependents',
    ]
    render(<RoleBadges roles={allRoles} />)
    for (const role of allRoles) {
      expect(screen.getByText(role)).toBeInTheDocument()
    }
  })

  it('wraps badges in a flex container', () => {
    const { container } = render(<RoleBadges roles={['contributors']} />)
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.className).toContain('flex')
  })

  it('each badge is a span element', () => {
    render(<RoleBadges roles={['contributors', 'stargazers']} />)
    const badges = screen.getAllByText(/contributors|stargazers/)
    for (const badge of badges) {
      expect(badge.tagName.toLowerCase()).toBe('span')
    }
  })
})
