/**
 * End-to-end check of the colour shim against the app's *real* built CSS.
 * The synthetic fixtures passed while the browser still failed, so this loads
 * the actual Tailwind output and asserts nothing unconvertible remains.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildColorVariableOverrides, hasUnsupportedColor } from '../../../frontend/src/utils/colors'

const assets = path.resolve(__dirname, '../../../frontend/dist/assets')
const cssFile = fs.existsSync(assets)
  ? fs.readdirSync(assets).find(f => f.endsWith('.css'))
  : undefined

describe.skipIf(!cssFile)('built stylesheet', () => {
  const css = fs.readFileSync(path.join(assets, cssFile!), 'utf8')

  it('contains oklch (i.e. the bug is reproducible from this file)', () => {
    expect(css).toContain('oklch(')
  })

  it('overrides every oklch custom property the real stylesheet defines', () => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    try {
      const out = buildColorVariableOverrides(document, () => 'rgb(9, 9, 9)')
      // Every --* declared with an oklch value must appear in the override.
      const declared = new Set(
        Array.from(css.matchAll(/(--[\w-]+)\s*:\s*oklch\(/g), m => m[1]),
      )
      expect(declared.size).toBeGreaterThan(0)
      const missing = [...declared].filter(v => !out.includes(`${v}:`))
      expect(missing).toEqual([])
      expect(hasUnsupportedColor(out)).toBe(false)
    } finally {
      style.remove()
    }
  })
})
