import { describe, expect, it } from 'vitest'
import { DEFAULT_HELPER_ENDPOINT } from './shared/types'
import { normalizeEndpoint, parseOptionsFormState } from './options/settings'

describe('options settings', () => {
  it('normalizes helper endpoint and stores manual-only handoff settings', () => {
    expect(normalizeEndpoint(' http://127.0.0.1:17321/// ')).toBe(DEFAULT_HELPER_ENDPOINT)

    expect(parseOptionsFormState({
      endpoint: 'http://localhost:9999/',
      token: '  secret-token  ',
      enabled: false,
      manualOnly: true,
    })).toEqual({
      smartExtractEndpoint: 'http://localhost:9999',
      smartExtractToken: 'secret-token',
      smartExtractEnabled: false,
      smartExtractManualOnly: true,
    })
  })
})
