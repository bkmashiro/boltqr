import type { HelperSettings, StoredHelperSettings } from '../shared/types'
import { DEFAULT_HELPER_ENDPOINT } from '../shared/types'

export interface OptionsFormState {
  endpoint: string
  token: string
  enabled: boolean
  manualOnly: boolean
}

export function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim() || DEFAULT_HELPER_ENDPOINT
  return trimmed.replace(/\/+$/, '')
}

export function parseOptionsFormState(form: OptionsFormState): StoredHelperSettings {
  return {
    smartExtractEndpoint: normalizeEndpoint(form.endpoint),
    smartExtractToken: form.token.trim(),
    smartExtractEnabled: form.enabled,
    smartExtractManualOnly: form.manualOnly,
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
