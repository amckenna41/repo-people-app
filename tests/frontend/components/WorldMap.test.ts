import { describe, it, expect } from 'vitest'
import { getSubRegion, getCountryNum } from '../../../frontend/src/components/WorldMap'

// Country click used to title the whole country after the first user's raw
// location string, so users spread across several cities all looked like they
// came from one. getSubRegion is what separates them.
describe('getSubRegion', () => {
  const DE = 276, US = 840, GB = 826, CN = 156

  it('strips the trailing country name', () => {
    expect(getSubRegion('Beijing, China', CN)).toBe('Beijing')
    expect(getSubRegion('Munich, Germany', DE)).toBe('Munich')
  })

  it('keeps intermediate segments', () => {
    expect(getSubRegion('San Francisco, CA, USA', US)).toBe('San Francisco, CA')
  })

  it('strips a trailing alpha-2 code for the same country', () => {
    expect(getSubRegion('London, UK', GB)).toBe('London')
    expect(getSubRegion('Berlin, DE', DE)).toBe('Berlin')
  })

  it('returns null when only the country was given', () => {
    expect(getSubRegion('Germany', DE)).toBeNull()
    expect(getSubRegion('  usa  ', US)).toBeNull()
  })

  it('keeps a bare city with no country suffix', () => {
    expect(getSubRegion('Berlin', DE)).toBe('Berlin')
  })

  it('preserves the original casing', () => {
    expect(getSubRegion('nEWCASTLE, uk', GB)).toBe('nEWCASTLE')
  })

  it('leaves a trailing segment that is a different country alone', () => {
    // "Georgia" the US state must not be popped when the country is the USA.
    expect(getSubRegion('Atlanta, Georgia', US)).toBe('Atlanta, Georgia')
  })
})

// "Newcastle, NSW" resolved to the UK: NSW matched nothing, so the fallback
// found the English Newcastle. State/province codes now decide the country.
describe('getCountryNum — subdivisions', () => {
  const AU = 36, US = 840, GB = 826, CA = 124, DE = 276, IL = 376

  it('reads Australian state codes', () => {
    expect(getCountryNum('Newcastle, NSW')).toBe(AU)
    expect(getCountryNum('newcastle, nsw')).toBe(AU)
    expect(getCountryNum('Newcastle, New South Wales')).toBe(AU)
    expect(getCountryNum('Perth, WA')).toBe(AU)
  })

  it('still prefers an explicit country name over a state code', () => {
    expect(getCountryNum('Sydney, NSW, Australia')).toBe(AU)
    expect(getCountryNum('London, UK')).toBe(GB)
    expect(getCountryNum('Yerevan, Armenia')).toBe(51)
  })

  it('breaks two-letter country/state ties with the city segment', () => {
    expect(getCountryNum('Chicago, IL')).toBe(US)      // Illinois, not Israel
    expect(getCountryNum('Toronto, CA')).toBe(CA)      // Canada, not California
    expect(getCountryNum('San Francisco, CA')).toBe(US)
    expect(getCountryNum('Munich, DE')).toBe(DE)
  })

  it('falls back to the country code when no city corroborates', () => {
    expect(getCountryNum('Haifa, IL')).toBe(IL)
  })

  it('leaves unambiguous cases alone', () => {
    expect(getCountryNum('Newcastle')).toBe(GB)
    expect(getCountryNum('San Francisco, CA, USA')).toBe(US)
    expect(getCountryNum('Germany')).toBe(DE)
  })
})
