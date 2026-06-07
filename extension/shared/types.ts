export interface QRCandidate {
  value: string
  scoreHint?: number
  source: string
  reason?: string
  context?: string
}

export interface CandidateBundle {
  schemaVersion: 1
  producer: 'boltqr'
  pageUrl: string
  pageTitle?: string
  qrText: string
  qrUrl?: string
  downloadUrl?: string
  fileName?: string
  imageUrl?: string
  imageMime?: string
  createdAt: string
  candidates: QRCandidate[]
}

export interface IngestSummary {
  ok: boolean
  bundleId?: number | string
  stored?: number
  helperEndpoint: string
  error?: string
}

export interface HelperSettings {
  endpoint: string
  token: string
  enabled: boolean
  manualOnly: boolean
}

export interface CandidateSearchSettings {
  candidateSearchEnabled: boolean
}

export interface StoredCandidateSearchSettings {
  smartExtractCandidateSearchEnabled: boolean
}

export type ResultDisplayMode = 'inline' | 'toast' | 'both'

export type OpenBehavior = 'new-tab' | 'same-tab'

export interface ResultDisplaySettings {
  resultDisplayMode: ResultDisplayMode
  openBehavior: OpenBehavior
  inlineOverlayEnabled: boolean
  grayQrOnResult: boolean
  showHelperStatusInResult: boolean
}

export interface StoredResultDisplaySettings {
  resultDisplayMode: ResultDisplayMode
  openBehavior: OpenBehavior
  inlineOverlayEnabled: boolean
  grayQrOnResult: boolean
  showHelperStatusInResult: boolean
}

export interface StoredHelperSettings {
  smartExtractEndpoint: string
  smartExtractToken: string
  smartExtractEnabled: boolean
  smartExtractManualOnly: boolean
}

export type CandidateExtractionRequest = {
  type: 'boltqr:extract-candidates'
  qrText: string
  anchorImageUrl?: string
  imageMime?: string
}

export type CandidateExtractionResponse = {
  ok: boolean
  bundle?: CandidateBundle
  error?: string
}

export type ShowResultMessage = {
  type: 'boltqr:show-result'
  bundle: CandidateBundle
  ingest: IngestSummary
}

export type DecodeErrorMessage = {
  type: 'boltqr:decode-error'
  message: string
}

export const DEFAULT_HELPER_ENDPOINT = 'http://127.0.0.1:17321'
