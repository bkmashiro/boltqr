import { describe, expect, it } from 'vitest'
import { DEFAULT_HELPER_ENDPOINT } from './shared/types'
import {
  DEFAULT_CANDIDATE_SEARCH_SETTINGS,
  DEFAULT_RESULT_DISPLAY_SETTINGS,
  normalizeEndpoint,
  normalizeOpenBehavior,
  normalizeResultDisplayMode,
  parseOptionsFormState,
  toRuntimeCandidateSearchSettings,
  toRuntimeDisplaySettings,
} from './options/settings'

describe('options settings', () => {
  it('normalizes helper endpoint and stores manual-only handoff settings', () => {
    expect(normalizeEndpoint(' http://127.0.0.1:17321/// ')).toBe(DEFAULT_HELPER_ENDPOINT)

    expect(parseOptionsFormState({
      endpoint: 'http://localhost:9999/',
      token: '  secret-token  ',
      enabled: false,
      manualOnly: true,
      candidateSearchEnabled: false,
      resultDisplayMode: 'both',
      openBehavior: 'same-tab',
      inlineOverlayEnabled: true,
      grayQrOnResult: false,
      showHelperStatusInResult: true,
    })).toEqual({
      smartExtractEndpoint: 'http://localhost:9999',
      smartExtractToken: 'secret-token',
      smartExtractEnabled: false,
      smartExtractManualOnly: true,
      smartExtractCandidateSearchEnabled: false,
      resultDisplayMode: 'both',
      openBehavior: 'same-tab',
      inlineOverlayEnabled: true,
      grayQrOnResult: false,
      showHelperStatusInResult: true,
    })
  })

  it('defaults to immersive inline display and safe new-tab opening', () => {
    expect(toRuntimeDisplaySettings({})).toEqual(DEFAULT_RESULT_DISPLAY_SETTINGS)
    expect(normalizeResultDisplayMode('unknown')).toBe('inline')
    expect(normalizeOpenBehavior('unknown')).toBe('new-tab')
  })

  it('defaults password candidate search on but can disable page text scanning explicitly', () => {
    expect(toRuntimeCandidateSearchSettings({})).toEqual(DEFAULT_CANDIDATE_SEARCH_SETTINGS)
    expect(toRuntimeCandidateSearchSettings({ smartExtractCandidateSearchEnabled: false })).toEqual({
      candidateSearchEnabled: false,
    })
  })
})
