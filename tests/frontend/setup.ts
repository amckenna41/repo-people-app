import '@testing-library/jest-dom'
import createFetchMock from 'vitest-fetch-mock'
import { vi } from 'vitest'

const fetchMocker = createFetchMock(vi)
fetchMocker.enableMocks()
// Expose globally so tests can import it
;(globalThis as any).fetchMocker = fetchMocker
