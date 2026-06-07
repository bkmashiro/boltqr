import type {
  CandidateSearchSettings,
  HelperSettings,
  OpenBehavior,
  ResultDisplayMode,
  ResultDisplaySettings,
  StoredCandidateSearchSettings,
  StoredHelperSettings,
  StoredResultDisplaySettings,
} from '../shared/types'
import { DEFAULT_HELPER_ENDPOINT } from '../shared/types'

export interface OptionsFormState {
  endpoint: string
  token: string
  enabled: boolean
  manualOnly: boolean
  resultDisplayMode: ResultDisplayMode
  openBehavior: OpenBehavior
  inlineOverlayEnabled: boolean
  grayQrOnResult: boolean
  showHelperStatusInResult: boolean
  candidateSearchEnabled: boolean
}

export type StoredSettingsBundle = StoredHelperSettings & StoredResultDisplaySettings & StoredCandidateSearchSettings

export function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim() || DEFAULT_HELPER_ENDPOINT
  return trimmed.replace(/\/+$/, '')
}

export function normalizeResultDisplayMode(value: string): ResultDisplayMode {
  if (value === 'toast' || value === 'both') return value
  return 'inline'
}

export function normalizeOpenBehavior(value: string): OpenBehavior {
  return value === 'same-tab' ? 'same-tab' : 'new-tab'
}

export function normalizeCandidateSearchEnabled(value: unknown): boolean {
  return value !== false
}

export const DEFAULT_RESULT_DISPLAY_SETTINGS: ResultDisplaySettings = {
  resultDisplayMode: 'inline',
  openBehavior: 'new-tab',
  inlineOverlayEnabled: true,
  grayQrOnResult: true,
  showHelperStatusInResult: false,
}

export const DEFAULT_CANDIDATE_SEARCH_SETTINGS: CandidateSearchSettings = {
  candidateSearchEnabled: true,
}

export function parseOptionsFormState(form: OptionsFormState): StoredSettingsBundle {
  return {
    smartExtractEndpoint: normalizeEndpoint(form.endpoint),
    smartExtractToken: form.token.trim(),
    smartExtractEnabled: form.enabled,
    smartExtractManualOnly: form.manualOnly,
    resultDisplayMode: normalizeResultDisplayMode(form.resultDisplayMode),
    openBehavior: normalizeOpenBehavior(form.openBehavior),
    inlineOverlayEnabled: form.inlineOverlayEnabled,
    grayQrOnResult: form.grayQrOnResult,
    showHelperStatusInResult: form.showHelperStatusInResult,
    smartExtractCandidateSearchEnabled: normalizeCandidateSearchEnabled(form.candidateSearchEnabled),
  }
}

export function toRuntimeDisplaySettings(stored: Partial<StoredResultDisplaySettings>): ResultDisplaySettings {
  return {
    resultDisplayMode: normalizeResultDisplayMode(stored.resultDisplayMode || DEFAULT_RESULT_DISPLAY_SETTINGS.resultDisplayMode),
    openBehavior: normalizeOpenBehavior(stored.openBehavior || DEFAULT_RESULT_DISPLAY_SETTINGS.openBehavior),
    inlineOverlayEnabled: stored.inlineOverlayEnabled ?? DEFAULT_RESULT_DISPLAY_SETTINGS.inlineOverlayEnabled,
    grayQrOnResult: stored.grayQrOnResult ?? DEFAULT_RESULT_DISPLAY_SETTINGS.grayQrOnResult,
    showHelperStatusInResult: stored.showHelperStatusInResult ?? DEFAULT_RESULT_DISPLAY_SETTINGS.showHelperStatusInResult,
  }
}

export function toRuntimeCandidateSearchSettings(stored: Partial<StoredCandidateSearchSettings>): CandidateSearchSettings {
  return {
    candidateSearchEnabled: normalizeCandidateSearchEnabled(stored.smartExtractCandidateSearchEnabled),
  }
}

export function toRuntimeSettings(stored: Partial<StoredHelperSettings>): HelperSettings {
  return {
    endpoint: normalizeEndpoint(stored.smartExtractEndpoint || DEFAULT_HELPER_ENDPOINT),
    token: stored.smartExtractToken || '',
    enabled: stored.smartExtractEnabled !== false,
    manualOnly: stored.smartExtractManualOnly !== false,
  }
}
