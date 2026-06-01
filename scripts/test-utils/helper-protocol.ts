import type { CandidateBundle, QRCandidate } from '../../extension/shared/types'

export type { CandidateBundle, QRCandidate }

export interface HelperHealthResponse {
  ok: true
  service: string
  protocol: 'boltqr-password-candidates'
  version: 1
}

export interface IngestResponse {
  ok: boolean
  bundleId?: string | number
  stored?: number
  error?: string
}

export interface QueryItem {
  value: string
  score: number
  source: string
  reason?: string
}

export interface QueryResponse {
  candidates: string[]
  items?: QueryItem[]
  meta?: {
    matchedBy?: string
    bundleAgeSeconds?: number
    limit?: number
  }
}

export interface SuccessReport {
  file?: string
  path?: string
  url?: string
  pageUrl?: string
  sha256?: string
  size?: number
  password: string
  source?: string
}

export interface PasswordQuery {
  file?: string
  path?: string
  url?: string
  pageUrl?: string
  sha256?: string
  size?: number
  limit?: number
}

export const PROTOCOL_VERSION = 1 as const
export const HELPER_SERVICE_NAME = 'boltqr-conformance-helper'

const ALLOWED_SOURCES = new Set<QRCandidate['source'] | string>([
  'keyword-nearby',
  'visible-text',
  'dom-attribute',
  'input-value',
  'near-qr',
  'page-hostname',
  'qr-hostname',
  'download-hostname',
  'manual',
  'other',
])

export function validateCandidateBundle(value: unknown): asserts value is CandidateBundle {
  if (!value || typeof value !== 'object') throw new Error('bundle is not an object')
  const bundle = value as Record<string, unknown>
  if (bundle.schemaVersion !== 1) throw new Error('schemaVersion must be 1')
  if (bundle.producer !== 'boltqr') throw new Error("producer must be 'boltqr'")
  if (typeof bundle.pageUrl !== 'string' || !bundle.pageUrl) throw new Error('pageUrl required')
  if (typeof bundle.qrText !== 'string') throw new Error('qrText required')
  if (typeof bundle.createdAt !== 'string') throw new Error('createdAt required')
  if (Number.isNaN(Date.parse(bundle.createdAt))) throw new Error('createdAt must be ISO 8601')
  if (!Array.isArray(bundle.candidates)) throw new Error('candidates must be array')
  for (const candidate of bundle.candidates as unknown[]) {
    if (!candidate || typeof candidate !== 'object') throw new Error('candidate is not an object')
    const c = candidate as Record<string, unknown>
    if (typeof c.value !== 'string' || !c.value) throw new Error('candidate.value required')
    if (typeof c.source !== 'string' || !ALLOWED_SOURCES.has(c.source)) {
      throw new Error(`candidate.source invalid: ${String(c.source)}`)
    }
  }
}
