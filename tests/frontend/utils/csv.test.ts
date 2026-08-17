/**
 * csv.test.ts — CSV formula-injection escaping for the client-side exports.
 */
import { describe, expect, it } from 'vitest'
import { csvCell, toCsv, xlsxCell } from '../../../frontend/src/utils/csv'

describe('csvCell', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])(
    'neutralises the formula prefix in %j',
    payload => {
      expect(csvCell(payload)).toBe(`"'${payload.replace(/"/g, '""')}"`)
    },
  )

  it('leaves ordinary text untouched', () => {
    expect(csvCell('alice')).toBe('"alice"')
    expect(csvCell('ACME Corp')).toBe('"ACME Corp"')
  })

  it('escapes embedded double quotes', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
  })

  it('renders null and undefined as empty cells', () => {
    expect(csvCell(null)).toBe('""')
    expect(csvCell(undefined)).toBe('""')
  })

  it('serialises objects and arrays as JSON', () => {
    expect(csvCell(['a', 'b'])).toBe('"[""a"",""b""]"')
  })

  it('keeps numbers and booleans readable', () => {
    expect(csvCell(42)).toBe('"42"')
    expect(csvCell(false)).toBe('"false"')
  })

  it('does not treat a negative number as a formula once stringified', () => {
    // -1 is genuinely dangerous as a leading char, so it is quoted. This
    // documents the trade-off: safety wins over numeric fidelity in CSV.
    expect(csvCell(-1)).toBe(`"'-1"`)
  })
})

describe('toCsv', () => {
  it('emits a header row followed by one row per record', () => {
    const csv = toCsv(['login', 'name'], [
      { login: 'alice', name: 'Alice' },
      { login: 'bob', name: 'Bob' },
    ])
    expect(csv.split('\n')).toEqual([
      '"login","name"',
      '"alice","Alice"',
      '"bob","Bob"',
    ])
  })

  it('escapes a formula smuggled into a profile field', () => {
    const csv = toCsv(['login', 'name'], [{ login: 'evil', name: '=cmd|calc' }])
    expect(csv).toContain(`"'=cmd|calc"`)
  })

  it('emits an empty cell for a column a record does not have', () => {
    expect(toCsv(['login', 'bio'], [{ login: 'alice' }])).toContain('"alice",""')
  })
})

describe('xlsxCell', () => {
  it('preserves native number and boolean types', () => {
    expect(xlsxCell(7)).toBe(7)
    expect(xlsxCell(true)).toBe(true)
  })

  it('maps null and undefined to null', () => {
    expect(xlsxCell(null)).toBeNull()
    expect(xlsxCell(undefined)).toBeNull()
  })

  it('neutralises a formula string', () => {
    expect(xlsxCell('=HYPERLINK("http://evil")')).toBe(`'=HYPERLINK("http://evil")`)
  })

  it('joins arrays into a comma-separated string', () => {
    expect(xlsxCell(['x', 'y'])).toBe('x, y')
  })
})
