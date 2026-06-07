import type {
  CandidateExtractionResponse,
  DecodeErrorMessage,
  IngestSummary,
  ShowResultMessage,
} from './shared/types'
import { buildCandidateBundleFromDocument } from './content/candidate-extractor'
import { planAutoScanBatch, type ImageScanDescriptor } from './content/auto-scan'

const AUTO_SCAN_MAX_BATCH = 6
const AUTO_SCAN_CONCURRENCY = 2
const AUTO_SCAN_MUTATION_DELAY_MS = 250
const AUTO_SCAN_INITIAL_DELAY_MS = 150

const autoScanState = {
  scheduled: false,
  inFlight: 0,
  queue: [] as string[],
  queuedUrls: new Set<string>(),
  attemptedKeys: new Set<string>(),
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message).then(sendResponse)
  return true
})

startAutoScan()

async function handleMessage(message: unknown): Promise<CandidateExtractionResponse | undefined> {
  const msg = message as any
  if (msg.type === 'boltqr:extract-candidates') {
    try {
      return {
        ok: true,
        bundle: buildCandidateBundleFromDocument(document, {
          pageUrl: location.href,
          pageTitle: document.title,
          qrText: msg.qrText || '',
          anchorImageUrl: msg.anchorImageUrl,
          imageMime: msg.imageMime,
        }),
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  if (msg.type === 'boltqr:show-result' && msg.bundle && msg.ingest) {
    showToast(renderResult(msg))
  }
  if (msg.type === 'boltqr:decode-error') {
    showToast(renderDecodeError(msg))
  }
  return undefined
}

function startAutoScan(): void {
  if (document.documentElement.dataset.boltqrAutoScanStarted === '1') return
  document.documentElement.dataset.boltqrAutoScanStarted = '1'

  scheduleAutoScan(AUTO_SCAN_INITIAL_DELAY_MS)

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue
      if ([...mutation.addedNodes].some(nodeMayContainImage)) {
        scheduleAutoScan(AUTO_SCAN_MUTATION_DELAY_MS)
        return
      }
    }
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })

  document.addEventListener('load', (event) => {
    if (event.target instanceof HTMLImageElement) {
      scheduleAutoScan(AUTO_SCAN_MUTATION_DELAY_MS)
    }
  }, true)
}

function scheduleAutoScan(delayMs = 0): void {
  if (autoScanState.scheduled) return
  autoScanState.scheduled = true
  const run = () => {
    autoScanState.scheduled = false
    collectAndEnqueueAutoScans()
  }
  const requestIdle = (globalThis as any).requestIdleCallback as ((cb: () => void, opts?: { timeout: number }) => number) | undefined
  if (requestIdle) {
    const fallback = setTimeout(run, Math.max(750, delayMs + 250))
    requestIdle(() => {
      clearTimeout(fallback)
      run()
    }, { timeout: Math.max(500, delayMs) })
    return
  }
  setTimeout(run, delayMs)
}

function collectAndEnqueueAutoScans(): void {
  const images = Array.from(document.images)
  const descriptors = images.map(imageDescriptor).filter((descriptor): descriptor is ImageScanDescriptor => descriptor !== null)
  const planned = planAutoScanBatch(descriptors, { maxBatchSize: AUTO_SCAN_MAX_BATCH })

  for (const scan of planned) {
    if (autoScanState.attemptedKeys.has(scan.cacheKey)) continue
    autoScanState.attemptedKeys.add(scan.cacheKey)
    enqueueUrlWhenNearViewport(scan.url, scan.cacheKey)
  }
}

function enqueueUrlWhenNearViewport(url: string, cacheKey: string): void {
  const img = findImageByCacheKey(cacheKey)
  if (!img || isNearViewport(img)) {
    enqueueAutoScan(url)
    return
  }

  const Intersection = (globalThis as any).IntersectionObserver as typeof IntersectionObserver | undefined
  if (!Intersection) return

  const observer = new Intersection((entries) => {
    if (entries.some(entry => entry.isIntersecting)) {
      observer.disconnect()
      enqueueAutoScan(url)
    }
  }, { rootMargin: '600px 0px' })
  observer.observe(img)
}

function enqueueAutoScan(url: string): void {
  if (autoScanState.queuedUrls.has(url)) return
  autoScanState.queuedUrls.add(url)
  autoScanState.queue.push(url)
  void drainAutoScanQueue()
}

async function drainAutoScanQueue(): Promise<void> {
  while (autoScanState.inFlight < AUTO_SCAN_CONCURRENCY && autoScanState.queue.length) {
    const url = autoScanState.queue.shift()
    if (!url) return
    autoScanState.inFlight += 1
    void requestAutoDecode(url).finally(() => {
      autoScanState.inFlight -= 1
      autoScanState.queuedUrls.delete(url)
      void drainAutoScanQueue()
    })
  }
}

async function requestAutoDecode(srcUrl: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'boltqr:auto-scan-image', srcUrl })
  } catch {
    // Content scripts can run on pages where the extension context is torn down; keep auto-scan silent.
  }
}

function imageDescriptor(img: HTMLImageElement): ImageScanDescriptor | null {
  const rect = img.getBoundingClientRect()
  const style = getComputedStyle(img)
  const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  const src = img.getAttribute('src') || undefined
  const currentSrc = img.currentSrc || undefined
  const className = typeof img.className === 'string' ? img.className : String(img.className || '')
  const url = currentSrc || src
  if (!url) return null
  return {
    src,
    currentSrc,
    url,
    width: Math.round(rect.width || img.width || 0),
    height: Math.round(rect.height || img.height || 0),
    naturalWidth: img.naturalWidth || undefined,
    naturalHeight: img.naturalHeight || undefined,
    alt: img.alt || undefined,
    id: img.id || undefined,
    className,
    visible,
    loading: img.loading || undefined,
    elementKey: imageElementKey(img),
  }
}

function imageElementKey(img: HTMLImageElement): string {
  if (img.id) return `id:${img.id}`
  const parent = img.parentElement
  const index = parent ? Array.prototype.indexOf.call(parent.children, img) : 0
  return `${img.tagName.toLowerCase()}:${index}:${img.getAttribute('src') || ''}`
}

function findImageByCacheKey(cacheKey: string): HTMLImageElement | null {
  for (const img of Array.from(document.images)) {
    const descriptor = imageDescriptor(img)
    if (!descriptor) continue
    const planned = planAutoScanBatch([descriptor], { maxBatchSize: 1 })[0]
    if (planned?.cacheKey === cacheKey) return img
  }
  return null
}

function isNearViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  const margin = 600
  return rect.bottom >= -margin && rect.top <= window.innerHeight + margin && rect.right >= -margin && rect.left <= window.innerWidth + margin
}

function nodeMayContainImage(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const el = node as Element
  return el.tagName === 'IMG' || !!el.querySelector?.('img')
}

function renderResult(message: ShowResultMessage): string {
  const { bundle, ingest } = message
  const target = bundle.qrUrl || bundle.qrText || '非 URL 二维码'
  const candidates = bundle.candidates.slice(0, 5).map((c) => c.value).join(', ')
  const helper = ingest.ok ? '已发送到本地助手' : `本地助手未接收${ingest.error ? `: ${ingest.error}` : ''}`
  return `BoltQR 识别成功\n${target}\n候选 ${bundle.candidates.length} 个${candidates ? `: ${candidates}` : ''}\n${helper}`
}

function renderDecodeError(message: DecodeErrorMessage): string {
  return `BoltQR: ${message.message || '识别失败'}`
}

function showToast(text: string) {
  const old = document.getElementById('boltqr-toast')
  old?.remove()
  const box = document.createElement('div')
  box.id = 'boltqr-toast'
  box.textContent = text
  box.style.cssText = [
    'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
    'max-width:420px', 'white-space:pre-wrap', 'background:#111827', 'color:white',
    'font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
    'padding:12px 14px', 'border-radius:10px', 'box-shadow:0 12px 30px rgba(0,0,0,.35)',
  ].join(';')
  document.documentElement.appendChild(box)
  setTimeout(() => box.remove(), 8000)
}
