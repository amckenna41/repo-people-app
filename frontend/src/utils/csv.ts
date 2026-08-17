// Shared CSV serialisation for the client-side exports.
//
// Exported data is attacker-influenced: /import accepts arbitrary records, and
// GitHub profile fields (name, bio, company, location) are free text. A cell
// starting with =, +, -, @, tab or CR is executed as a formula when the file is
// opened in Excel or Google Sheets, so those values are prefixed with a single
// quote to force literal text.

const FORMULA_PREFIX = /^[=+\-@\t\r]/

/** Convert one value to its CSV cell text, neutralising formula injection. */
export function csvCell(value: unknown): string {
  const raw =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
  const safe = FORMULA_PREFIX.test(raw) ? `'${raw}` : raw
  return `"${safe.replace(/"/g, '""')}"`
}

/** Build a CSV document from a header list and row objects. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const header = columns.map(csvCell).join(',')
  const body = rows.map(row => columns.map(col => csvCell(row[col])).join(','))
  return [header, ...body].join('\n')
}

/** Excel cells keep their native type, so only strings need neutralising. */
export function xlsxCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean' || typeof value === 'number') return value
  const raw = Array.isArray(value)
    ? value.map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ')
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value)
  return FORMULA_PREFIX.test(raw) ? `'${raw}` : raw
}

/** Trigger a browser download for generated text content. */
export function downloadText(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
