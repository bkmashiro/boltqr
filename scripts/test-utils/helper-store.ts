import type { CandidateBundle } from '../../extension/shared/types'
import type { PasswordQuery, QueryItem, QueryResponse, SuccessReport } from './helper-protocol'

interface StoredBundle {
  id: string
  bundle: CandidateBundle
  receivedAt: number
}

export interface StoreOptions {
  ttlMs?: number
  maxBundles?: number
  now?: () => number
}

export class HelperStore {
  private readonly bundles: StoredBundle[] = []
  private readonly successes: SuccessReport[] = []
  private readonly ttlMs: number
  private readonly maxBundles: number
  private readonly now: () => number
  private nextId = 1

  constructor(options: StoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000
    this.maxBundles = options.maxBundles ?? 500
    this.now = options.now ?? (() => Date.now())
  }

  ingest(bundle: CandidateBundle): StoredBundle {
    const entry: StoredBundle = {
      id: `b-${this.nextId++}`,
      bundle,
      receivedAt: this.now(),
    }
    this.bundles.push(entry)
    this.pruneExpired()
    while (this.bundles.length > this.maxBundles) this.bundles.shift()
    return entry
  }

  recordSuccess(report: SuccessReport): void {
    this.successes.push(report)
  }

  listSuccesses(): SuccessReport[] {
    return this.successes.slice()
  }

  query(params: PasswordQuery): QueryResponse {
    this.pruneExpired()
    const limit = clampLimit(params.limit)
    const scored = new Map<string, QueryItem>()
    const matchedBy = new Set<string>()

    const wantedFile = basename(params.path) || basename(params.file)
    const wantedUrl = params.url || ''
    const wantedUrlHost = hostnameFromUrl(wantedUrl)
    const wantedPageHost = hostnameFromUrl(params.pageUrl || '')

    for (const stored of [...this.bundles].reverse()) {
      const { bundle } = stored
      let bundleScore = 0
      const bundleHost = hostnameFromUrl(bundle.qrUrl || bundle.downloadUrl || '')
      const pageHost = hostnameFromUrl(bundle.pageUrl)
      const file = bundle.fileName || basename(bundle.qrUrl) || basename(bundle.downloadUrl)

      if (wantedUrl && (bundle.qrUrl === wantedUrl || bundle.downloadUrl === wantedUrl)) {
        bundleScore += 100
        matchedBy.add('url')
      }
      if (wantedUrlHost && bundleHost && wantedUrlHost === bundleHost) {
        bundleScore += 30
        matchedBy.add('url-host')
      }
      if (wantedFile && file && wantedFile === file) {
        bundleScore += 60
        matchedBy.add('file')
      }
      if (wantedPageHost && pageHost && wantedPageHost === pageHost) {
        bundleScore += 20
        matchedBy.add('page-host')
      }

      if (bundleScore <= 0) continue

      const ageSeconds = Math.max(0, Math.floor((this.now() - stored.receivedAt) / 1000))
      if (ageSeconds < 60 * 60) {
        bundleScore += Math.max(0, 30 - Math.floor(ageSeconds / 120))
        matchedBy.add('recent')
      }

      for (const candidate of bundle.candidates) {
        const hint = typeof candidate.scoreHint === 'number' ? candidate.scoreHint : 0
        const score = bundleScore + hint
        const existing = scored.get(candidate.value)
        if (!existing || existing.score < score) {
          scored.set(candidate.value, {
            value: candidate.value,
            score,
            source: candidate.source,
            reason: candidate.reason,
          })
        }
      }
    }

    const items = [...scored.values()].sort((a, b) => b.score - a.score).slice(0, limit)
    const ageSeconds = this.bundles.length
      ? Math.max(0, Math.floor((this.now() - this.bundles[this.bundles.length - 1].receivedAt) / 1000))
      : undefined

    return {
      candidates: items.map((item) => item.value),
      items,
      meta: {
        matchedBy: matchedBy.size ? [...matchedBy].join(',') : 'none',
        bundleAgeSeconds: ageSeconds,
        limit,
      },
    }
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.ttlMs
    while (this.bundles.length && this.bundles[0].receivedAt < cutoff) {
      this.bundles.shift()
    }
  }
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 50
  return Math.min(500, Math.floor(value))
}

function basename(value: string | undefined): string {
  if (!value) return ''
  try {
    const path = new URL(value).pathname
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || '')
  } catch {
    const parts = value.split(/[\\/]/).filter(Boolean)
    return parts.length ? parts[parts.length - 1] : ''
  }
}

function hostnameFromUrl(value: string): string {
  if (!value) return ''
  try {
    return new URL(value).hostname
  } catch {
    return ''
  }
}
