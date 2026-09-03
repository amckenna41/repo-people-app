/**
 * contrast.test.ts — chart tooltip legibility.
 *
 * Recharts' defaults assume a light theme: tooltip label text is #000 and the
 * bar cursor is an opaque #ccc band. On this dark card that made the label
 * effectively invisible (1.18:1) and washed out the hovered row. These pin the
 * replacements so a future palette change cannot quietly undo it.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const parts = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
  const lin = parts.map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const TOOLTIP_BG = '#111827'   // set by contentStyle
const LABEL = '#e5e7eb'

const source = fs.readFileSync(
  path.resolve(__dirname, '../../../frontend/src/views/ResultsView.tsx'), 'utf8',
)

describe('contrast maths', () => {
  it('matches known WCAG reference values', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 1)
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 2)
  })
})

describe('tooltip legibility', () => {
  it('the recharts default label colour would fail badly', () => {
    // Documents why the override exists.
    expect(contrast('#000000', TOOLTIP_BG)).toBeLessThan(1.5)
  })

  it('the chosen label colour clears WCAG AA for normal text', () => {
    expect(contrast(LABEL, TOOLTIP_BG)).toBeGreaterThanOrEqual(4.5)
  })

  it('clears AAA too, since these are small labels', () => {
    expect(contrast(LABEL, TOOLTIP_BG)).toBeGreaterThanOrEqual(7)
  })
})

describe('ResultsView tooltip wiring', () => {
  it('defines a shared tooltip style with an explicit label colour', () => {
    expect(source).toMatch(/TOOLTIP_BASE\s*=/)
    expect(source).toMatch(/labelStyle:\s*\{\s*color:\s*'#e5e7eb'\s*\}/)
  })

  it('overrides the opaque #ccc bar cursor', () => {
    expect(source).toMatch(/BAR_CURSOR\s*=/)
    // Whatever the value, it must not be the light default.
    expect(source).not.toMatch(/BAR_CURSOR\s*=\s*\{\s*fill:\s*'#ccc'/)
  })

  it('applies both to the Role Distribution chart', () => {
    const chart = source.slice(source.indexOf('Role Distribution'))
    expect(chart).toMatch(/\{\.\.\.TOOLTIP_BASE\}/)
    expect(chart).toMatch(/cursor=\{BAR_CURSOR\}/)
  })
})
