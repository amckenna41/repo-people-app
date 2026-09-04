/**
 * Real-browser check for the PDF export.
 *
 * The jsdom suite cannot catch this class of bug. Three fixes shipped and
 * failed in a row — oklch, then color-mix, then oklab — because jsdom does not
 * resolve `color-mix()`, does not serialise computed colours in oklab, and does
 * not run CSS transitions, which is where the actual fault was: patching a
 * colour starts a `transition: all`, and a colour mid-transition is reported as
 * `oklab(...)` no matter what value was written.
 *
 * Renders every utility class the report code can emit — broader than any one
 * real report — then asserts that after the shim runs, no computed declaration
 * anywhere still holds a colour function html2canvas cannot parse, and that the
 * whole export path produces a PDF.
 *
 *   npm run build && npm run test:browser
 *
 * Skips (exit 0) when Playwright or its browser is not installed, so a normal
 * checkout is unaffected.
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend')
const skip = (why) => { console.log(`SKIP: ${why}`); process.exit(0) }

// Resolve from the frontend package, not from this file — node_modules lives
// there, and a bare specifier would resolve relative to tests/browser/.
let chromium
try {
  // Resolved by path, so this is the CJS entry: the named export lands on
  // `default` rather than at the top level.
  const mod = await import(pathToFileURL(
    createRequire(path.join(root, 'package.json')).resolve('playwright')).href)
  chromium = mod.chromium ?? mod.default?.chromium
} catch { /* fall through to the check below */ }
if (!chromium) skip('playwright not installed (cd frontend && npm i -D playwright)')

const assets = path.join(root, 'dist/assets')
if (!fs.existsSync(assets)) skip('no build found — run `npm run build` first')
const cssFile = fs.readdirSync(assets).find(f => f.endsWith('.css'))
if (!cssFile) skip('no stylesheet in dist/assets')

// ---------------------------------------------------------------------------
// Assemble a page that loads the real CSS, the real shim and the real libraries
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-pdf-'))
fs.copyFileSync(path.join(assets, cssFile), path.join(tmp, 'app.css'))
// Both libraries ship a browser build with no bare imports — usable as-is.
fs.copyFileSync(path.join(root, 'node_modules/html2canvas/dist/html2canvas.js'), path.join(tmp, 'html2canvas.js'))
fs.copyFileSync(path.join(root, 'node_modules/jspdf/dist/jspdf.umd.min.js'), path.join(tmp, 'jspdf.js'))

// The shim is TypeScript, so it needs compiling. Vite is already a dependency;
// its library build does this without pulling in a separate bundler.
const vite = await import(pathToFileURL(
  createRequire(path.join(root, 'package.json')).resolve('vite')).href)
for (const mod of ['colors', 'pdfPages', 'pdfTitlePage']) {
  await vite.build({
    root,
    configFile: false,
    logLevel: 'error',
    build: {
      outDir: tmp,
      emptyOutDir: false,
      lib: { entry: path.join(root, `src/utils/${mod}.ts`), formats: ['es'], fileName: () => `${mod}.js` },
    },
  })
}

// Every literal class the report can emit. Tailwind built the stylesheet from
// these same files, so each token has a real rule behind it.
const tokens = new Set()
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
for (const file of walk(path.join(root, 'src')).filter(f => /\.tsx?$/.test(f))) {
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(/className\s*=\s*"([^"]+)"/g)) m[1].split(/\s+/).forEach(t => tokens.add(t))
  for (const m of text.matchAll(/className\s*=\s*\{`([^`]*)`\}/g)) {
    m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).forEach(t => t && tokens.add(t))
  }
}
fs.writeFileSync(path.join(tmp, 'tokens.json'), JSON.stringify([...tokens].filter(t => t && !t.includes('{'))))
fs.writeFileSync(path.join(tmp, 'index.html'), PAGE())

// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  const file = path.join(tmp, (req.url ?? '/').split('?')[0].replace(/^\//, '') || 'index.html')
  if (!file.startsWith(tmp) || !fs.existsSync(file)) { res.writeHead(404).end(); return }
  const type = file.endsWith('.css') ? 'text/css'
    : file.endsWith('.js') ? 'text/javascript'
    : file.endsWith('.json') ? 'application/json' : 'text/html'
  res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(file))
})
await new Promise(r => server.listen(0, r))
const url = `http://localhost:${server.address().port}/index.html`

let browser
try { browser = await chromium.launch() } catch (e) { server.close(); skip(`cannot launch chromium — ${String(e).split('\n')[0]}\n  (cd frontend && npx playwright install chromium)`) }

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__ready, null, { timeout: 60_000 })

const leaks = await page.evaluate(() => window.__checkLeaks())
const full = await page.evaluate(() => window.__fullExport())
// Keep the artefact so the layout can actually be looked at, not just asserted.
const dataUrl = await page.evaluate(() => window.__pdfDataUrl ?? '')
const outPdf = process.env.PDF_OUT
if (outPdf && dataUrl) fs.writeFileSync(outPdf, Buffer.from(dataUrl.split(',')[1], 'base64'))
await browser.close()
server.close()
fs.rmSync(tmp, { recursive: true, force: true })

const fail = []
if (leaks.before === 0) fail.push('harness is not reproducing the bug — 0 unsupported colours before the shim')
if (leaks.after !== 0) fail.push(`${leaks.after} declarations still hold an unsupported colour after the shim (${leaks.pseudo} on pseudo-elements)`)
if (leaks.restored !== leaks.before) fail.push(`undo left the page altered: ${leaks.restored} vs ${leaks.before}`)
if (full.error) fail.push(`export threw: ${full.error}`)
if (full.leaksDuring !== 0) fail.push(`${full.leaksDuring} leaks during the real export path`)
if (!full.bytes) fail.push('no PDF bytes produced')
// PNG cannot compress a dark gradient-heavy screenshot: the same pages were
// 68MB as PNG. A regression here means the encoding was switched back.
if (full.bytes > 20e6) fail.push(`PDF is ${(full.bytes / 1e6).toFixed(0)}MB — image encoding has regressed`)
if (full.pages < 2) fail.push(`expected a multi-page report, got ${full.pages}`)
if (full.pdfPages !== full.pages + 1) fail.push(`expected a cover page plus ${full.pages} content pages, got ${full.pdfPages}`)
if (full.worstFill < 0.75) fail.push(`a page is only ${(full.worstFill * 100).toFixed(0)}% full — page packing has regressed`)
if (full.spinnerRunning !== true) fail.push('the freeze stopped an animation outside the captured subtree (the export button spinner)')
if (full.reportFrozen !== true) fail.push('animations inside the captured subtree were not frozen — they will be captured mid-frame')
// A cut more than ~2px from a section edge means a card was sliced in half.
if (full.worstCutOffset > 2) fail.push(`a page break fell ${full.worstCutOffset.toFixed(0)}px from the nearest legal boundary — a card or chart was sliced`)

console.log(`unsupported colour declarations: ${leaks.before} before → ${leaks.after} after (${leaks.pseudo} pseudo)`)
console.log(`undo restored: ${leaks.restored === leaks.before ? 'yes' : 'NO'}`)
console.log(`full export: ${full.error ?? 'ok'} · ${full.w}×${full.h} canvas · ${full.pdfPages} page(s) incl. cover · ${(full.bytes / 1e6).toFixed(1)}MB`)
console.log(`page breaks: ${full.cuts} cut(s), worst ${full.worstCutOffset.toFixed(1)}px from a legal boundary`)
console.log(`page fill: ${full.fill.map(f => (f * 100).toFixed(0) + '%').join(', ')}`)
console.log(`during export: spinner outside still animating = ${full.spinnerRunning}, report animations frozen = ${full.reportFrozen}`)
for (const f of fail) console.error(`FAIL: ${f}`)
console.log(fail.length ? 'FAILED' : 'PASS')
process.exit(fail.length ? 1 : 0)

function PAGE() {
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./app.css"><script src="./html2canvas.js"><\/script><script src="./jspdf.js"><\/script></head>
<body><div id="report"></div><script type="module">
import { inlineColorsWithUndo, buildColorVariableOverrides, inlineComputedColors, hasUnsupportedColor } from './colors.js'
const report = document.getElementById('report')
// Same shape as the real report: a space-y-6 stack of card sections. The page
// planner cuts in those gaps, so the structure has to be there to test it.
report.className = 'space-y-6'
const tokens = await (await fetch('./tokens.json')).json()
const perSection = Math.ceil(tokens.length / 12)
for (let i = 0; i < 12; i++) {
  const card = document.createElement('div')
  card.className = 'card'
  card.style.minHeight = (120 + i * 40) + 'px'
  for (const t of tokens.slice(i * perSection, (i + 1) * perSection)) {
    const el = document.createElement('span'); el.className = t; el.textContent = t + ' '; card.appendChild(el)
  }
  report.appendChild(card)
}
// Stands in for the export button's spinner: outside the captured subtree, and
// it must keep animating while the export runs.
const spinner = document.createElement('div')
spinner.className = 'animate-spin'
spinner.id = 'spinner'
document.body.appendChild(spinner)

const rows = document.createElement('div')
rows.className = 'card'
const rowStack = document.createElement('div')
rowStack.className = 'space-y-2'
rowStack.setAttribute('data-pdf-rows', '')
for (let i = 0; i < 40; i++) {
  const r = document.createElement('div')
  r.className = 'flex items-center gap-3 p-2 rounded-lg'
  r.style.height = '28px'
  r.textContent = 'row ' + i
  rowStack.appendChild(r)
}
rows.appendChild(rowStack)
report.appendChild(rows)

report.firstElementChild.insertAdjacentHTML('beforeend',
  '<input class="input" placeholder="p"><ul class="list-disc"><li>m</li></ul>' +
  '<svg width="40" height="20"><rect width="40" height="20" class="fill-current text-purple-400"/></svg>')

/** Every computed declaration still holding a colour html2canvas cannot parse —
 *  including pseudo-elements, which no inline style can reach. */
function findLeaks(root) {
  const out = []
  const els = [document.documentElement, document.body, root, ...root.querySelectorAll('*')]
  for (const el of els) for (const pseudo of [null, ':before', ':after']) {
    let cs; try { cs = getComputedStyle(el, pseudo) } catch { continue }
    for (let i = 0; i < cs.length; i++) {
      const v = cs.getPropertyValue(cs[i])
      if (hasUnsupportedColor(v)) out.push({ pseudo, prop: cs[i], v })
    }
  }
  return out
}
const onclone = (doc, el) => {
  const ov = buildColorVariableOverrides(document) || buildColorVariableOverrides(doc)
  if (ov) { const s = doc.createElement('style'); s.textContent = ov; doc.head.appendChild(s) }
  inlineComputedColors(el)
}
window.__checkLeaks = () => {
  const before = findLeaks(report).length
  const undo = inlineColorsWithUndo(report)
  const list = findLeaks(report)
  undo()
  return { before, after: list.length, pseudo: list.filter(l => l.pseudo).length, restored: findLeaks(report).length,
           sample: list.slice(0, 10) }
}
// The real export path over the whole <body> — the worst case, since it pulls in
// body::before (content:"") which html2canvas parses as a pseudo-element.
window.__fullExport = async () => {
  const { jsPDF } = window.jspdf
  const { planPages } = await import('./pdfPages.js')
  const { drawTitlePage } = await import('./pdfTitlePage.js')
  const MARGIN = 8
  let undo = null, error = null, bytes = 0, leaksDuring = -1, canvas = null, pages = [], pdfPageCount = 0
  let spinnerRunning = null, reportFrozen = null, pdf0W = 210, pdf0H = 297
  try {
    undo = inlineColorsWithUndo(report)
    leaksDuring = findLeaks(report).length
    // Sampled while the freeze is active — the window in which the spinner used
    // to stop dead.
    spinnerRunning = document.getElementById('spinner').getAnimations().length > 0
    reportFrozen = report.querySelector('.animate-spin')?.getAnimations().length === 0
    canvas = await html2canvas(report, { scale: 2, useCORS: true, backgroundColor: '#050510', logging: false, onclone })
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const pdfW = pdf.internal.pageSize.getWidth(), pdfH = pdf.internal.pageSize.getHeight()
    pdf0W = pdfW; pdf0H = pdfH
    const usableW = pdfW - MARGIN * 2, usableH = pdfH - MARGIN * 2
    const pxPerMm = canvas.width / usableW
    const reportTop = report.getBoundingClientRect().top
    const cssToCanvas = canvas.height / report.getBoundingClientRect().height
    const toCanvasY = y => (y - reportTop) * cssToCanvas
    const breaks = []
    for (const section of Array.from(report.children)) {
      breaks.push(toCanvasY(section.getBoundingClientRect().top))
      for (const row of Array.from(section.querySelectorAll('[data-pdf-rows] > *'))) {
        breaks.push(toCanvasY(row.getBoundingClientRect().top))
      }
    }
    pages = planPages({ contentHeight: canvas.height, pageHeight: Math.floor(usableH * pxPerMm), breaks })
    drawTitlePage(pdf, {
      job: { job_id: 'abc123', label: 'amckenna41/iso3166-2', created_at: '2026-09-01T10:00:00Z', total_fetched: 45 },
      summary: { total: 45, humans: 44, bots: 1, top_locations: [{ location: 'germany', count: 6 }],
                 top_companies: [{ company: 'multiply', count: 2 }], account_age_distribution: {}, role_distribution: {} },
      roleCounts: { stargazers: 33, issue_authors: 9, dependents: 7, contributors: 2, watchers: 0, maintainers: 0 },
      warnings: ['\u26a0\ufe0f stargazers: Access denied \u2014 repository may be private or token lacks scope.'],
      totalUsers: 45, unfilteredTotal: 45,
    }, MARGIN)
    const slice = document.createElement('canvas'), sctx = slice.getContext('2d')
    for (const page of pages) {
      pdf.addPage()
      slice.width = canvas.width; slice.height = Math.round(page.height)
      sctx.fillStyle = '#050510'; sctx.fillRect(0, 0, slice.width, slice.height)
      sctx.drawImage(canvas, 0, Math.round(page.y), canvas.width, slice.height, 0, 0, canvas.width, slice.height)
      pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', MARGIN, MARGIN, usableW, slice.height / pxPerMm)
    }
    pdfPageCount = pdf.internal.getNumberOfPages()
    const buf = pdf.output('arraybuffer')
    bytes = buf.byteLength
    window.__pdfDataUrl = pdf.output('datauristring')
  } catch (e) { error = e?.message ?? String(e) } finally { undo?.() }
  // How far each cut sits from the nearest legal boundary — a section edge, or
  // a row inside a container marked splittable. Anything above a pixel or two
  // means a page was cut through the middle of a card or a chart.
  const reportTop2 = report.getBoundingClientRect().top
  const cssToCanvas2 = (canvas?.height ?? 0) / report.getBoundingClientRect().height
  const toY = y => (y - reportTop2) * cssToCanvas2
  const edges = []
  for (const section of Array.from(report.children)) {
    edges.push(toY(section.getBoundingClientRect().top), toY(section.getBoundingClientRect().bottom))
    for (const row of Array.from(section.querySelectorAll('[data-pdf-rows] > *'))) {
      edges.push(toY(row.getBoundingClientRect().top))
    }
  }
  const cuts = pages.slice(1).map(p => p.y)
  const offBy = cuts.map(c => Math.min(...edges.map(e => Math.abs(e - c))))
  const pageH = Math.floor((pdf0H - MARGIN * 2) * (canvas?.width ?? 1) / (pdf0W - MARGIN * 2))
  const fill = pages.map(p => p.height / pageH)
  return { error, bytes, leaksDuring, spinnerRunning, reportFrozen, pages: pages.length, pdfPages: pdfPageCount, w: canvas?.width, h: canvas?.height,
           fill, worstFill: fill.length > 1 ? Math.min(...fill.slice(0, -1)) : 1,
           worstCutOffset: offBy.length ? Math.max(...offBy) : 0, cuts: cuts.length }
}

window.__ready = true
<\/script></body></html>`
}
