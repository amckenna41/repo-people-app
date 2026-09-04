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

/** Colour functions html2canvas cannot parse.
 *
 *  `color()` covers `color(display-p3 …)`, which is how some engines serialise a
 *  wide-gamut computed value. `color-mix()` is listed ahead of it because
 *  Tailwind v4 compiles every opacity modifier (`bg-white/5`, `hover:bg-white/10`
 *  — used all over this app) to `color-mix(in oklab, …)`, and `color\(` does not
 *  match `color-mix(`. */
const UNSUPPORTED_FN_SOURCE = '\\b(?:color-mix|oklch|oklab|lch|lab|color)\\('
const UNSUPPORTED_FN = new RegExp(UNSUPPORTED_FN_SOURCE, 'i')

/** Whether a computed-style property name can plausibly carry a colour.
 *
 *  This used to be a hand-written list, which is a guessing game: it missed
 *  `accent-color`, `text-shadow`, `border-image-source` and every logical
 *  border longhand, and each miss is an oklch value reaching html2canvas and
 *  killing the export with no clue which property was at fault. Matching on the
 *  name instead is self-maintaining — a property added by a future Tailwind
 *  release is covered without touching this file. */
const COLORISH_PROP = /color|shadow|fill|stroke|background|border|outline|gradient|image|caret|accent|emphasis|decoration|column-rule/

/** Memo for the name test. A document enumerates the same ~340 property names
 *  on every element, so the regex runs a few hundred times in total rather than
 *  a few hundred times per element. */
const _colorish = new Map<string, boolean>()

function isColorish(name: string): boolean {
  let hit = _colorish.get(name)
  if (hit === undefined) {
    hit = COLORISH_PROP.test(name)
    _colorish.set(name, hit)
  }
  return hit
}

/** The colour-carrying property names an element's computed style enumerates.
 *
 *  Derived per element rather than once for the document: a real browser
 *  enumerates every longhand on every element, but jsdom enumerates only what
 *  was actually declared, so sampling one element there would miss properties
 *  set on its siblings. `isColorish` keeps the extra passes cheap. */
function colorishProps(computed: CSSStyleDeclaration): string[] {
  const props: string[] = []
  for (let i = 0; i < computed.length; i++) {
    const name = computed[i]
    if (isColorish(name)) props.push(name)
  }
  return props
}

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

  // Same pattern as the gate above — the two drifting apart is how a function
  // passes `hasUnsupportedColor` and is then never rewritten.
  const finder = new RegExp(UNSUPPORTED_FN_SOURCE, 'gi')
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

/** Inline sRGB equivalents for every unsupported colour under `root`, returning
 *  a function that puts the inline styles back exactly as they were.
 *
 *  Intended to wrap the html2canvas call on the **live** document. The earlier
 *  approach patched html2canvas's clone instead, which is only correct if the
 *  clone's stylesheets have parsed by the time `onclone` fires — inside the
 *  cloner's iframe a production build's <link> often has not, so every computed
 *  value read there is a browser default, nothing matches, and the scan is a
 *  silent no-op. The live document is always styled.
 *
 *  Patching the real page is safe here because the substitution is exact: the
 *  replacement is the same colour sampled through a canvas, so nothing changes
 *  on screen. The undo runs in a `finally`, so a failed export still restores.
 */
/** Suspends every transition and animation in a document.
 *
 *  Load-bearing, not a nicety. Patching a colour is itself a style change, and
 *  anything under `transition: all` — `.btn-primary`, `.btn-secondary` and every
 *  `transition-all` in this app — responds by *animating* from the old colour to
 *  the new one. A colour mid-transition is interpolated in oklab, and that is
 *  what `getComputedStyle` reports, so the element reads back as
 *  `oklab(0.928 …)` however correct the value we just wrote. html2canvas then
 *  parses the interpolating value and throws. Freezing first makes the patch
 *  take effect instantly.
 *
 *  It also stops `animate-spin`/`animate-pulse` being captured mid-frame.
 */
const FREEZE_ATTR = 'data-rp-freeze'

function freezeAnimations(root: HTMLElement): () => void {
  const doc = root.ownerDocument
  if (!doc) return () => {}
  root.setAttribute(FREEZE_ATTR, '')
  const style = doc.createElement('style')
  style.setAttribute('data-h2c-freeze', '')
  // Scoped to the subtree being captured, plus <html>/<body> whose colours are
  // patched too. A blanket `*` rule also froze the export button's own spinner,
  // so the one thing on screen telling the user the export was running sat
  // motionless for its entire duration.
  style.textContent =
    `[${FREEZE_ATTR}],[${FREEZE_ATTR}] *,[${FREEZE_ATTR}] *::before,[${FREEZE_ATTR}] *::after,` +
    'html,body,html::before,body::before,html::after,body::after' +
    '{transition:none!important;animation:none!important}'
  doc.head?.appendChild(style)
  return () => {
    style.remove()
    root.removeAttribute(FREEZE_ATTR)
  }
}

export function inlineColorsWithUndo(
  root: HTMLElement,
  convert: (color: string) => string = createCanvasColorConverter(),
): () => void {
  const unfreeze = freezeAnimations(root)
  const saved = patchColors(root, convert)
  return () => {
    // Reverse order, so an element patched twice ends on its original value.
    for (let i = saved.length - 1; i >= 0; i--) {
      const [el, prop, previous] = saved[i]
      if (previous) el.style.setProperty(prop, previous)
      else el.style.removeProperty(prop)
    }
    unfreeze()
  }
}

/** Inline sRGB equivalents for every unsupported colour under `root`.
 *
 *  The non-reverting form, for html2canvas's `onclone` where `root` is a
 *  throwaway clone. Returns the number of declarations patched.
 */
export function inlineComputedColors(
  root: HTMLElement,
  convert: (color: string) => string = createCanvasColorConverter(),
): number {
  return patchColors(root, convert).length
}

/** The shared walk. Returns what it overwrote: `[element, property, previous
 *  inline value]` for each declaration, which is everything an undo needs. */
function patchColors(
  root: HTMLElement,
  convert: (color: string) => string,
): Array<[HTMLElement, string, string]> {
  const saved: Array<[HTMLElement, string, string]> = []
  const view = root.ownerDocument?.defaultView
  if (!view) return saved

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
    for (const prop of colorishProps(computed)) {
      const value = computed.getPropertyValue(prop)
      if (!hasUnsupportedColor(value)) continue
      saved.push([el as HTMLElement, prop, style.getPropertyValue(prop)])
      style.setProperty(prop, replaceUnsupportedColors(value, convert))
    }
  }
  return saved
}
