import type {
  CandidateBundle,
  CandidateExtractionResponse,
  CandidateSearchSettings,
  DecodeErrorMessage,
  IngestSummary,
  ResultDisplaySettings,
  ShowResultMessage,
  StoredCandidateSearchSettings,
  StoredResultDisplaySettings,
} from './shared/types'
import {
  toRuntimeCandidateSearchSettings,
  toRuntimeDisplaySettings,
} from './options/settings'
import { buildCandidateBundleFromDocument } from './content/candidate-extractor'
import { planAutoScanBatch, type ImageScanDescriptor } from './content/auto-scan'

const AUTO_SCAN_MAX_BATCH = 6
const AUTO_SCAN_CONCURRENCY = 2
const AUTO_SCAN_MUTATION_DELAY_MS = 250
const AUTO_SCAN_INITIAL_DELAY_MS = 150

const INLINE_RESULT_OVERLAY_ID = 'boltqr-inline-marker'

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

interface CandidateBundleInput {
  pageUrl: string
  pageTitle?: string
  qrText: string
  anchorImageUrl?: string
  imageMime?: string
}

async function handleMessage(message: unknown): Promise<CandidateExtractionResponse | undefined> {
  const msg = message as any
  if (msg.type === 'boltqr:extract-candidates') {
    try {
      const candidateSearchSettings = await loadCandidateSearchSettings()
      const input: CandidateBundleInput = {
        pageUrl: location.href,
        pageTitle: document.title,
        qrText: msg.qrText || '',
        anchorImageUrl: msg.anchorImageUrl,
        imageMime: msg.imageMime,
      }
      const bundle = candidateSearchSettings.candidateSearchEnabled
        ? buildCandidateBundleFromDocument(document, input)
        : buildCandidateBundleWithoutText(input)

      return {
        ok: true,
        bundle,
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  if (msg.type === 'boltqr:manual-scan-selected-image' && msg.srcUrl) {
    try {
      const imageData = captureLoadedImageData(msg.srcUrl)
      return await chrome.runtime.sendMessage({
        type: 'boltqr:manual-scan-image',
        srcUrl: msg.srcUrl,
        ...(imageData ? { imageData } : {}),
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  if (msg.type === 'boltqr:show-result' && msg.bundle && msg.ingest) {
    const resultMessage = msg as ShowResultMessage
    const displaySettings = await loadDisplaySettings()
    const inlineShown = shouldShowInline(displaySettings) ? showInlineResult(resultMessage, displaySettings) : false
    if (shouldShowToast(displaySettings) || inlineShown || (!inlineShown && displaySettings.resultDisplayMode === 'inline')) {
      showToast(renderResult(resultMessage, displaySettings))
    }
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

  const observer = new IntersectionObserver((entries) => {
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

function buildCandidateBundleWithoutText(input: CandidateBundleInput): CandidateBundle {
  const qrUrl = looksLikeUrl(input.qrText) ? input.qrText : undefined
  return {
    schemaVersion: 1,
    producer: 'boltqr',
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle || document.title || undefined,
    qrText: input.qrText,
    qrUrl,
    downloadUrl: qrUrl,
    fileName: fileNameFromUrl(qrUrl || ''),
    imageUrl: input.anchorImageUrl,
    imageMime: input.imageMime,
    createdAt: new Date().toISOString(),
    candidates: [],
  }
}

function shouldShowInline(displaySettings: ResultDisplaySettings): boolean {
  return (displaySettings.resultDisplayMode === 'inline' || displaySettings.resultDisplayMode === 'both') && displaySettings.inlineOverlayEnabled
}

function shouldShowToast(displaySettings: ResultDisplaySettings): boolean {
  return displaySettings.resultDisplayMode === 'toast'
    || displaySettings.resultDisplayMode === 'both'
    || (displaySettings.resultDisplayMode === 'inline' && !displaySettings.inlineOverlayEnabled)
}

function renderResult(message: ShowResultMessage, settings: ResultDisplaySettings): string {
  const { bundle, ingest } = message
  const target = bundle.qrUrl || bundle.qrText || '非 URL 二维码'
  const topCandidates = bundle.candidates.slice(0, 5).map((candidate) => candidate.value)
  const helperLine = settings.showHelperStatusInResult
    ? (ingest.ok
      ? `已发送到本地助手: ${ingest.helperEndpoint}`
      : `本地助手未接收${ingest.error ? `: ${ingest.error}` : ''}`)
    : ''
  const lines: string[] = [
    `BoltQR 识别成功`,
    target,
    `候选 ${bundle.candidates.length} 个${topCandidates.length ? `: ${topCandidates.join(', ')}` : ''}`,
  ]
  if (helperLine) lines.push(helperLine)
  return lines.join('\n')
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

async function loadDisplaySettings(): Promise<ResultDisplaySettings> {
  const stored = (await chrome.storage.local.get([
    'resultDisplayMode',
    'openBehavior',
    'inlineOverlayEnabled',
    'grayQrOnResult',
    'showHelperStatusInResult',
  ])) as Partial<Record<string, unknown>> as Partial<StoredResultDisplaySettings>
  return toRuntimeDisplaySettings(stored)
}

async function loadCandidateSearchSettings(): Promise<CandidateSearchSettings> {
  const stored = (await chrome.storage.local.get(['smartExtractCandidateSearchEnabled'])) as Partial<Record<string, unknown>> as Partial<StoredCandidateSearchSettings>
  return toRuntimeCandidateSearchSettings(stored)
}

function findImageElement(imageUrl?: string): HTMLImageElement | undefined {
  if (!imageUrl) return undefined
  for (const img of Array.from(document.images)) {
    const candidate = [img.getAttribute('src') || '', img.currentSrc || '']
    if (candidate.includes(imageUrl) || candidate.some((value) => value && imageUrl.includes(value))) {
      return img
    }
  }
  return undefined
}

function captureLoadedImageData(imageUrl: string): { width: number; height: number; data: number[] } | undefined {
  const image = findImageElement(imageUrl)
  if (!image || !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return undefined

  const maxSide = 768
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return undefined

  try {
    ctx.drawImage(image, 0, 0, width, height)
    const imageData = ctx.getImageData(0, 0, width, height)
    return { width, height, data: Array.from(imageData.data) }
  } catch {
    return undefined
  }
}

function showInlineResult(message: ShowResultMessage, settings: ResultDisplaySettings): boolean {
  const image = findImageElement(message.bundle.imageUrl)
  if (!image || !image.parentElement) return false

  const rect = image.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false

  removeInlineResultOverlay()

  const bundle = message.bundle
  const parent = image.parentElement
  const marker = document.createElement('span')
  marker.id = INLINE_RESULT_OVERLAY_ID
  marker.dataset.boltqrInlineResult = '1'
  marker.dataset.boltqrLocalMarker = '1'
  marker.textContent = 'QR✓'
  marker.title = bundle.qrUrl || bundle.qrText || 'BoltQR 识别成功'
  marker.style.cssText = [
    'position:absolute',
    'z-index:1',
    'pointer-events:none',
    'display:inline-flex',
    'align-items:center',
    'justify-content:center',
    'height:20px',
    'min-width:34px',
    'padding:0 6px',
    'border-radius:999px',
    'border:1px solid rgba(250,204,21,.7)',
    'background:rgba(15,23,42,.82)',
    'color:#facc15',
    'font:700 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'box-shadow:0 2px 8px rgba(0,0,0,.18)',
    'box-sizing:border-box',
  ].join(';')

  const parentComputed = getComputedStyle(parent)
  const previousParentPosition = parent.style.position
  const changedParentPosition = parentComputed.position === 'static'
  if (changedParentPosition) parent.style.position = 'relative'

  const previousImageFilter = image.style.filter
  const previousImageOutline = image.style.outline
  const previousImageOutlineOffset = image.style.outlineOffset
  if (settings.grayQrOnResult) {
    image.style.filter = mergeCssFilter(previousImageFilter, 'grayscale(1) brightness(.72)')
  }
  image.style.outline = '2px solid rgba(250, 204, 21, .78)'
  image.style.outlineOffset = '2px'
  image.dataset.boltqrInlineResult = '1'

  parent.appendChild(marker)

  const updatePosition = () => {
    if (!document.documentElement.contains(image) || !document.documentElement.contains(marker)) {
      removeInlineResultOverlay()
      return
    }
    const markerWidth = marker.offsetWidth || 34
    const left = Math.max(0, image.offsetLeft + image.offsetWidth - markerWidth - 4)
    const top = Math.max(0, image.offsetTop + 4)
    marker.style.left = `${left}px`
    marker.style.top = `${top}px`
  }

  const onMove = () => requestAnimationFrame(updatePosition)
  updatePosition()
  window.addEventListener('resize', onMove)
  image.addEventListener('load', onMove)

  const cleanup = () => {
    window.removeEventListener('resize', onMove)
    image.removeEventListener('load', onMove)
    image.style.filter = previousImageFilter
    image.style.outline = previousImageOutline
    image.style.outlineOffset = previousImageOutlineOffset
    delete image.dataset.boltqrInlineResult
    if (changedParentPosition) parent.style.position = previousParentPosition
  }
  ;(marker as any).__boltqrCleanup = cleanup

  return true
}

function mergeCssFilter(existing: string, addition: string): string {
  return existing.trim() ? `${existing} ${addition}` : addition
}

function sectionFromText(labelText: string, valueText: string): HTMLDivElement {
  const block = document.createElement('div')
  const label = document.createElement('div')
  label.className = 'field-label'
  label.textContent = labelText
  const value = document.createElement('div')
  value.className = 'value'
  value.textContent = valueText
  block.append(label, value)
  return block
}

function removeInlineResultOverlay(): void {
  const overlay = document.getElementById(INLINE_RESULT_OVERLAY_ID)
  ;(overlay as any)?.__boltqrCleanup?.()
  overlay?.remove()
}

function hostnameFromUrl(value: string): string {
  try {
    return new URL(value).hostname || value
  } catch {
    return value
  }
}

function compactResultText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 72 ? `${normalized.slice(0, 69)}…` : normalized
}

function isOpenableUrl(value?: string): boolean {
  return !!value && /^https?:\/\//i.test(value)
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /\.(zip|rar|7z|tar|gz|xz|bz2)(?:[?#]|$)/i.test(value)
}

function fileNameFromUrl(value: string): string | undefined {
  try {
    const path = new URL(value).pathname
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || '') || undefined
  } catch {
    return undefined
  }
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // fall back
  }

  const temp = document.createElement('textarea')
  temp.value = text
  temp.setAttribute('readonly', '')
  temp.style.position = 'fixed'
  temp.style.left = '-9999px'
  temp.style.top = '-9999px'
  document.body.appendChild(temp)
  temp.focus()
  temp.select()
  try {
    document.execCommand('copy')
  } catch {
    // ignore
  }
  temp.remove()
}
