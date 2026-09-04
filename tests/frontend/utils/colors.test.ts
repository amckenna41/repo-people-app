/**
 * colors.test.ts — the html2canvas colour shim.
 *
 * Tailwind v4 emits `oklch()`, which html2canvas 1.4.1 throws on rather than
 * degrading — so the PDF export died outright. These cover the value-rewriting
 * logic; the canvas-based converter is injected so the tests need no real
 * canvas (jsdom has none).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  hasUnsupportedColor,
  replaceUnsupportedColors,
  inlineComputedColors,
  inlineColorsWithUndo,
  buildColorVariableOverrides,
} from '../../../frontend/src/utils/colors'

/** Stand-in for the browser: every colour function becomes a marker. */
const convert = (c: string) => `rgb(1, 2, 3)/*${c.slice(0, c.indexOf('('))}*/`

describe('hasUnsupportedColor', () => {
  it.each(['oklch(0.7 0.1 200)', 'oklab(0.5 0 0)', 'lch(50% 40 30)', 'lab(50% 20 -30)', 'color(display-p3 1 0 0)'])(
    'flags %s', v => expect(hasUnsupportedColor(v)).toBe(true),
  )

  it.each(['rgb(1, 2, 3)', 'rgba(1, 2, 3, 0.5)', '#a78bfa', 'transparent', 'none', ''])(
    'leaves %s alone', v => expect(hasUnsupportedColor(v)).toBe(false),
  )

  it('does not match a word merely containing a function name', () => {
    // "colorful(" and "flab(" must not be mistaken for color()/lab().
    expect(hasUnsupportedColor('colorful(1)')).toBe(false)
    expect(hasUnsupportedColor('flab(1)')).toBe(false)
  })
})

describe('replaceUnsupportedColors', () => {
  it('returns supported values untouched, without calling the converter', () => {
    const spy = vi.fn(convert)
    expect(replaceUnsupportedColors('rgb(1, 2, 3)', spy)).toBe('rgb(1, 2, 3)')
    expect(spy).not.toHaveBeenCalled()
  })

  it('converts a bare colour', () => {
    expect(replaceUnsupportedColors('oklch(0.7 0.1 200)', () => 'rgb(9, 9, 9)'))
      .toBe('rgb(9, 9, 9)')
  })

  it('converts every occurrence inside a gradient, keeping the rest verbatim', () => {
    const out = replaceUnsupportedColors(
      'linear-gradient(90deg, oklch(0.7 0.1 200) 0%, oklch(0.5 0.2 300) 100%)',
      () => 'rgb(9, 9, 9)',
    )
    expect(out).toBe('linear-gradient(90deg, rgb(9, 9, 9) 0%, rgb(9, 9, 9) 100%)')
  })

  it('converts the colour embedded in a box-shadow and preserves the offsets', () => {
    const out = replaceUnsupportedColors('0 0 14px oklch(0.6 0.2 280)', () => 'rgb(9, 9, 9)')
    expect(out).toBe('0 0 14px rgb(9, 9, 9)')
  })

  it('consumes a whole color-mix, nested parentheses and all', () => {
    // The scanner must count depth; a naive match to the first ")" would cut
    // this in half and emit invalid CSS. color-mix is itself unsupported, so
    // the entire function is replaced rather than only its inner oklch — the
    // browser resolves the mix for us when the converter paints it.
    const src = 'color-mix(in oklch, oklch(0.7 0.1 200 / calc(1 * 0.5)) 50%, white)'
    expect(replaceUnsupportedColors(src, () => 'RGB')).toBe('RGB')
  })

  it('converts a Tailwind opacity modifier', () => {
    // Every `bg-white/5`-style utility compiles to this; `color(` does not
    // match `color-mix(`, so these used to sail through the gate untouched.
    const src = 'color-mix(in oklab, rgb(255, 255, 255) 5%, transparent)'
    expect(hasUnsupportedColor(src)).toBe(true)
    expect(replaceUnsupportedColors(src, () => 'rgba(255, 255, 255, 0.05)'))
      .toBe('rgba(255, 255, 255, 0.05)')
  })

  it('keeps a color-mix embedded in a larger value in place', () => {
    const src = 'linear-gradient(#fff, color-mix(in oklab, red 50%, blue))'
    expect(replaceUnsupportedColors(src, () => 'RGB'))
      .toBe('linear-gradient(#fff, RGB)')
  })

  it('leaves an unbalanced value alone rather than corrupting it', () => {
    const src = 'oklch(0.7 0.1 200'
    expect(replaceUnsupportedColors(src, () => 'RGB')).toBe(src)
  })

  it('passes the full function text to the converter', () => {
    const spy = vi.fn(() => 'RGB')
    replaceUnsupportedColors('1px solid oklch(0.7 0.1 200 / 50%)', spy)
    expect(spy).toHaveBeenCalledWith('oklch(0.7 0.1 200 / 50%)')
  })

  it('does not match a function name embedded in a longer word', () => {
    // The gate passes because of the oklch(), so the scanner runs over the
    // whole value — it must not then treat the "lab(" inside "flab(" as a
    // colour. Only reachable in a mixed value like this one.
    const out = replaceUnsupportedColors('linear-gradient(oklch(0.5 0.1 200), flab(1))', () => 'RGB')
    expect(out).toBe('linear-gradient(RGB, flab(1))')
  })

  it('mixes supported and unsupported colours in one value', () => {
    const out = replaceUnsupportedColors(
      'linear-gradient(#fff, oklch(0.5 0.2 300))',
      () => 'RGB',
    )
    expect(out).toBe('linear-gradient(#fff, RGB)')
  })
})

describe('inlineComputedColors', () => {
  it('patches an element whose computed colour is unsupported', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    // jsdom returns whatever was set inline, which is enough to drive the walk.
    el.style.setProperty('color', 'oklch(0.7 0.1 200)')

    const patched = inlineComputedColors(el, () => 'rgb(9, 9, 9)')

    expect(patched).toBeGreaterThan(0)
    expect(el.style.getPropertyValue('color')).toBe('rgb(9, 9, 9)')
    el.remove()
  })

  it('walks descendants, not just the root', () => {
    const root = document.createElement('div')
    const child = document.createElement('span')
    child.style.setProperty('background-color', 'oklch(0.5 0.2 300)')
    root.appendChild(child)
    document.body.appendChild(root)

    inlineComputedColors(root, () => 'rgb(9, 9, 9)')

    expect(child.style.getPropertyValue('background-color')).toBe('rgb(9, 9, 9)')
    root.remove()
  })

  it('leaves supported colours untouched and reports zero patches', () => {
    const el = document.createElement('div')
    el.style.setProperty('color', 'rgb(1, 2, 3)')
    document.body.appendChild(el)

    const spy = vi.fn(() => 'RGB')
    expect(inlineComputedColors(el, spy)).toBe(0)
    expect(spy).not.toHaveBeenCalled()
    expect(el.style.getPropertyValue('color')).toBe('rgb(1, 2, 3)')
    el.remove()
  })

  it('patches properties the old hand-written list missed', () => {
    // accent-color (the table checkboxes) and text-shadow were not in the
    // enumerated list, so an oklch value on either reached html2canvas and
    // failed the export. The scan is derived from the computed style now.
    const el = document.createElement('input')
    el.style.setProperty('accent-color', 'oklch(0.5 0.2 300)')
    el.style.setProperty('text-shadow', '0 1px 2px oklch(0.2 0.1 20)')
    document.body.appendChild(el)

    inlineComputedColors(el, () => 'rgb(9, 9, 9)')

    expect(el.style.getPropertyValue('accent-color')).toBe('rgb(9, 9, 9)')
    expect(el.style.getPropertyValue('text-shadow')).toBe('0 1px 2px rgb(9, 9, 9)')
    el.remove()
  })

  it('returns 0 for a detached element rather than throwing', () => {
    // No ownerDocument.defaultView when the node is not in a live document.
    const orphan = document.implementation.createHTMLDocument().createElement('div')
    Object.defineProperty(orphan.ownerDocument, 'defaultView', { value: null })
    expect(() => inlineComputedColors(orphan, () => 'RGB')).not.toThrow()
  })
})

describe('inlineColorsWithUndo', () => {
  it('freezes animations only inside the captured subtree', () => {
    // A blanket `*` freeze also stopped the export button's own spinner — the
    // only thing telling the user the export was running.
    const report = document.createElement('div')
    const outside = document.createElement('div')
    outside.className = 'animate-spin'
    document.body.append(report, outside)

    const undo = inlineColorsWithUndo(report, () => 'rgb(9, 9, 9)')
    const css = [...document.querySelectorAll('style[data-h2c-freeze]')].map(s => s.textContent).join('')
    expect(css).toContain('animation:none')
    expect(css).not.toMatch(/^\*,/)                 // not a blanket selector
    expect(report.hasAttribute('data-rp-freeze')).toBe(true)
    expect(outside.hasAttribute('data-rp-freeze')).toBe(false)

    undo()
    expect(document.querySelector('style[data-h2c-freeze]')).toBeNull()
    expect(report.hasAttribute('data-rp-freeze')).toBe(false)
    report.remove(); outside.remove()
  })

  it('restores the inline styles it overwrote', () => {
    const el = document.createElement('div')
    el.style.setProperty('color', 'oklch(0.5 0.2 300)')
    el.style.setProperty('background-color', 'rgb(1, 2, 3)')
    document.body.appendChild(el)

    const undo = inlineColorsWithUndo(el, () => 'rgb(9, 9, 9)')
    expect(el.style.getPropertyValue('color')).toBe('rgb(9, 9, 9)')

    undo()
    expect(el.style.getPropertyValue('color')).toBe('oklch(0.5 0.2 300)')
    expect(el.style.getPropertyValue('background-color')).toBe('rgb(1, 2, 3)')
    el.remove()
  })

  it('removes a property that had no inline value to begin with', () => {
    // The patch must not leave a declaration behind on the live page.
    const el = document.createElement('div')
    document.body.appendChild(el)
    el.style.setProperty('color', 'oklch(0.5 0.2 300)')
    const before = el.getAttribute('style')

    inlineColorsWithUndo(el, () => 'rgb(9, 9, 9)')()

    expect(el.getAttribute('style')).toBe(before)
    el.remove()
  })

  it('converts the oklab a Tailwind opacity utility resolves to', () => {
    // --color-white is #fff, not oklch, so the palette override never touches
    // it — yet `bg-white/10` computes to oklab(). This is the value that broke
    // the export after the variable overrides were already in place.
    const el = document.createElement('div')
    el.style.setProperty('background-color', 'oklab(1 0 0 / 0.1)')
    document.body.appendChild(el)

    inlineColorsWithUndo(el, () => 'rgba(255, 255, 255, 0.1)')

    expect(el.style.getPropertyValue('background-color')).toBe('rgba(255, 255, 255, 0.1)')
    el.remove()
  })
})

describe('buildColorVariableOverrides', () => {
  /** Attach a stylesheet to the live document and hand back a cleanup fn.
   *
   *  It must be the *live* document: `createHTMLDocument()` has no browsing
   *  context, so jsdom never turns its <style> elements into styleSheets and
   *  every assertion silently sees an empty result.
   */
  function withCss<T>(css: string, run: (doc: Document) => T): T {
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    try {
      return run(document)
    } finally {
      style.remove()
    }
  }

  it('converts an oklch custom property to rgb', () => {
    const out = withCss(':root{--color-red-400:oklch(70.4% .191 22.216)}',
      d => buildColorVariableOverrides(d, () => 'rgb(9, 9, 9)'))
    expect(out.startsWith(':root{')).toBe(true)
    expect(out).toContain('--color-red-400:rgb(9, 9, 9)')
  })

  it('finds variables nested inside @layer', () => {
    // Why the first attempt at this fix did not help: Tailwind v4 puts its whole
    // palette inside `@layer theme`, so a flat scan of cssRules finds nothing.
    const out = withCss('@layer theme{:root{--color-gray-100:oklch(96.7% .003 264.542)}}',
      d => buildColorVariableOverrides(d, () => 'rgb(9, 9, 9)'))
    expect(out).toContain('--color-gray-100:rgb(9, 9, 9)')
  })

  it('finds variables nested inside @media inside @layer', () => {
    const out = withCss('@layer theme{@media (min-width:1px){:root{--color-deep:oklch(50% .1 200)}}}',
      d => buildColorVariableOverrides(d, () => 'RGB'))
    expect(out).toContain('--color-deep:RGB')
  })

  it('ignores custom properties that are not unsupported colours', () => {
    const out = withCss(':root{--spacing-x:4px;--color-fine:#a78bfa;--radius-x:6px}',
      d => buildColorVariableOverrides(d, () => 'RGB'))
    expect(out).not.toContain('--spacing-x')
    expect(out).not.toContain('--color-fine')
  })

  it('ignores non-custom properties', () => {
    // Regular declarations are the element walk's job, not this one's.
    const out = withCss('.probe-a{color:oklch(50% .1 200)}',
      d => buildColorVariableOverrides(d, () => 'RGB'))
    expect(out).toBe('')
  })

  it('returns empty string when there is nothing to override', () => {
    expect(withCss('.probe-b{color:red}', d => buildColorVariableOverrides(d, () => 'RGB'))).toBe('')
  })

  it('collects several variables into one unlayered :root rule', () => {
    // Unlayered, so it outranks Tailwind's @layer theme regardless of order.
    const out = withCss('@layer theme{:root{--probe-a:oklch(1 0 0);--probe-b:lch(50% 40 30)}}',
      d => buildColorVariableOverrides(d, () => 'RGB'))
    expect(out.startsWith(':root{')).toBe(true)
    expect(out).toContain('--probe-a:RGB')
    expect(out).toContain('--probe-b:RGB')
  })

  it('skips stylesheets that throw on access instead of aborting the scan', () => {
    // A cross-origin sheet throws on .cssRules; the scan must continue.
    withCss(':root{--probe-c:oklch(50% .1 200)}', d => {
      const hostile = { get cssRules(): CSSRuleList { throw new Error('cross-origin') } }
      const real = Array.from(d.styleSheets)
      const spy = vi.spyOn(d, 'styleSheets', 'get')
        .mockReturnValue([hostile, ...real] as unknown as StyleSheetList)
      try {
        expect(buildColorVariableOverrides(d, () => 'RGB')).toContain('--probe-c:RGB')
      } finally {
        spy.mockRestore()
      }
    })
  })
})
