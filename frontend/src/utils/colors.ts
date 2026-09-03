// Colour-function compatibility shim for html2canvas.
//
// Tailwind v4 emits its palette in `oklch()`. html2canvas 1.4.1 predates CSS
// Color 4 and throws `Attempting to parse an unsupported color function
// "oklch"` the moment it meets one, which killed the PDF export outright.
//
// Rather than swap in a fork, the colours are converted to `rgb()`/`rgba()` on
// the *cloned* document html2canvas hands us — the real page is untouched. The
// conversion is done by the browser itself (paint one pixel, read it back), so
// there is no colour-space maths here to get wrong, and it works for any
// function the browser understands, not just the ones enumerated below.

/** Colour functions html2canvas cannot parse. `color()` covers `color(display-p3 …)`. */
const UNSUPPORTED_FN = /\b(?:oklch|oklab|lch|lab|color)\(/i

/** Properties html2canvas reads that can carry a colour.
 *  `-webkit-text-fill-color` matters here: the header wordmark uses it. */
const COLOR_PROPS = [
  'color',
  'background-color',
  'background-image',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'box-shadow',
  'text-decoration-color',
  '-webkit-text-fill-color',
  'caret-color',
  'column-rule-color',
  'fill',
  'stroke',
] as const

export function hasUnsupportedColor(value: string): boolean {
  return !!value && UNSUPPORTED_FN.test(value)
}

/** Rewrite every unsupported colour function in a CSS value via `convert`.
 *
 *  Values are not always a bare colour — `box-shadow` and gradients embed one
 *  or more, so this scans for balanced parentheses rather than matching the
 *  whole string. Nesting (`color-mix(in oklch, …)`) is handled by depth
 *  counting, and anything outside a match is passed through untouched.
 */
export function replaceUnsupportedColors(
  value: string,
  convert: (color: string) => string,
): string {
  if (!hasUnsupportedColor(value)) return value

  const finder = /\b(?:oklch|oklab|lch|lab|color)\(/gi
  let out = ''
  let cursor = 0

  for (;;) {
    finder.lastIndex = cursor
    const match = finder.exec(value)
    if (!match) {
      out += value.slice(cursor)
      break
    }
    const start = match.index
    out += value.slice(cursor, start)

    // Walk to the parenthesis that closes this function.
    let depth = 0
    let end = start + match[0].length - 1
    for (; end < value.length; end++) {
      if (value[end] === '(') depth++
      else if (value[end] === ')' && --depth === 0) break
    }
    if (end >= value.length) {
      // Unbalanced — leave the remainder alone rather than corrupt it.
      out += value.slice(start)
      break
    }
    out += convert(value.slice(start, end + 1))
    cursor = end + 1
  }
  return out
}

/** Convert a CSS colour to `rgb()`/`rgba()` by painting it and reading the pixel.
 *
 *  Reading `ctx.fillStyle` back would be simpler, but browsers may serialise a
 *  wide-gamut colour as `color(srgb …)` — which html2canvas also cannot parse.
 *  Sampling the pixel always yields plain 8-bit channels. Results are memoised;
 *  a report repeats the same handful of palette colours thousands of times.
 */
export function createCanvasColorConverter(): (color: string) => string {
  const cache = new Map<string, string>()
  let ctx: CanvasRenderingContext2D | null | undefined

  return (color: string): string => {
    const cached = cache.get(color)
    if (cached !== undefined) return cached

    if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d')

    let result = color
    if (ctx) {
      try {
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = '#000'      // reset, so an unparseable colour is obvious
        ctx.fillStyle = color
        ctx.fillRect(0, 0, 1, 1)
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
        result = a === 255
          ? `rgb(${r}, ${g}, ${b})`
          : `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`
      } catch {
        // Canvas unavailable or tainted — keep the original and let
        // html2canvas decide. No worse than before this shim existed.
      }
    }
    cache.set(color, result)
    return result
  }
}

/** Collect `--custom-property: <unsupported colour>` declarations from a rule list.
 *
 *  Recurses into grouping rules — Tailwind v4 nests its theme inside
 *  `@layer theme`, so a flat scan finds nothing.
 */
function collectColorVariables(
  rules: CSSRuleList,
  convert: (color: string) => string,
  out: Map<string, string>,
): void {
  for (const rule of Array.from(rules)) {
    // A rule can be both: CSS nesting gives a CSSStyleRule its own `cssRules`,
    // and an empty CSSRuleList is still a truthy object — so treating "has
    // cssRules" as "is a grouping rule" silently skipped every declaration.
    const style = (rule as CSSStyleRule).style
    if (style) {
      for (let i = 0; i < style.length; i++) {
        const prop = style[i]
        if (!prop.startsWith('--')) continue
        const value = style.getPropertyValue(prop)
        if (!hasUnsupportedColor(value)) continue
        out.set(prop, replaceUnsupportedColors(value, convert))
      }
    }
    const nested = (rule as CSSGroupingRule).cssRules
    if (nested && nested.length) collectColorVariables(nested, convert, out)
  }
}

/** Build a stylesheet redefining every oklch-valued custom property as rgb().
 *
 *  This is the load-bearing half of the shim. Tailwind v4 puts its entire
 *  palette in `--color-*` custom properties and every utility reads them through
 *  `var()`, so converting the *variables* fixes every consumer at once —
 *  including `<html>` and `<body>`, whose background html2canvas inspects
 *  before it parses the target subtree.
 *
 *  The rule is emitted unlayered so it beats Tailwind's `@layer theme`
 *  regardless of source order.
 */
export function buildColorVariableOverrides(
  doc: Document,
  convert: (color: string) => string = createCanvasColorConverter(),
): string {
  const overrides = new Map<string, string>()
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = (sheet as CSSStyleSheet).cssRules
    } catch {
      continue // cross-origin stylesheet — not readable, and not ours
    }
    if (rules) collectColorVariables(rules, convert, overrides)
  }
  if (overrides.size === 0) return ''
  const body = Array.from(overrides, ([prop, value]) => `${prop}:${value}`).join(';')
  return `:root{${body}}`
}

/** Inline sRGB equivalents for every unsupported colour under `root`.
 *
 *  Intended for html2canvas's `onclone`, where `root` is the cloned subtree.
 *  Only writes when a computed value actually contains an unsupported function,
 *  so the clone stays close to the original. Returns the number of declarations
 *  patched (used by the tests).
 */
export function inlineComputedColors(
  root: HTMLElement,
  convert: (color: string) => string = createCanvasColorConverter(),
): number {
  const view = root.ownerDocument?.defaultView
  if (!view) return 0

  let patched = 0
  const elements: Element[] = [root, ...Array.from(root.querySelectorAll('*'))]
  const doc = root.ownerDocument
  // html2canvas reads the page background off <html> and <body> before it
  // touches the target subtree, so they must be covered even when the target
  // sits deep inside the document.
  if (doc?.documentElement && !elements.includes(doc.documentElement)) elements.push(doc.documentElement)
  if (doc?.body && !elements.includes(doc.body)) elements.push(doc.body)

  for (const el of elements) {
    const style = (el as HTMLElement).style
    if (!style) continue                       // e.g. SVG in older engines
    const computed = view.getComputedStyle(el)
    for (const prop of COLOR_PROPS) {
      const value = computed.getPropertyValue(prop)
      if (!hasUnsupportedColor(value)) continue
      style.setProperty(prop, replaceUnsupportedColors(value, convert))
      patched++
    }
  }
  return patched
}
