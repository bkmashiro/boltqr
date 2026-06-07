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

const INLINE_RESULT_OVERLAY_ID = 'boltqr-inline-result'

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
      return await chrome.runtime.sendMessage({ type: 'boltqr:manual-scan-image', srcUrl: msg.srcUrl })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  if (msg.type === 'boltqr:show-result' && msg.bundle && msg.ingest) {
    const resultMessage = msg as ShowResultMessage
    const displaySettings = await loadDisplaySettings()
    const inlineShown = shouldShowInline(displaySettings) ? showInlineResult(resultMessage, displaySettings) : false
    if (shouldShowToast(displaySettings) || (!inlineShown && displaySettings.resultDisplayMode === 'inline')) {
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

function showInlineResult(message: ShowResultMessage, settings: ResultDisplaySettings): boolean {
  const image = findImageElement(message.bundle.imageUrl)
  if (!image) return false

  const rect = image.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false

  removeInlineResultOverlay()

  const bundle = message.bundle
  const overlayHost = document.createElement('div')
  overlayHost.id = INLINE_RESULT_OVERLAY_ID
  overlayHost.dataset.boltqrInlineResult = '1'

  const shadow = overlayHost.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `
    :host {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .scrim {
      position: fixed;
      border-radius: 10px;
      background: rgba(15, 23, 42, 0.52);
      backdrop-filter: grayscale(1) contrast(.85);
      pointer-events: none;
      box-sizing: border-box;
    }
    .pin {
      position: fixed;
      display: grid;
      gap: 4px;
      min-width: 128px;
      max-width: min(260px, calc(100vw - 24px));
      padding: 8px 34px 8px 10px;
      border: 1px solid rgba(148, 163, 184, .45);
      border-radius: 10px;
      color: #f8fafc;
      background: rgba(15, 23, 42, .92);
      box-shadow: 0 10px 28px rgba(0, 0, 0, .36);
      backdrop-filter: blur(8px);
      box-sizing: border-box;
      pointer-events: auto;
      cursor: pointer;
      transition: transform .12s ease, background .12s ease;
    }
    .pin:hover {
      transform: translateY(-1px);
      background: rgba(17, 24, 39, .98);
    }
    .domain {
      font-weight: 800;
      color: #facc15;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .value {
      color: #e5e7eb;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 220px;
    }
    .hint {
      color: #bfdbfe;
      font-size: 11px;
    }
    .close {
      position: absolute;
      top: 5px;
      right: 5px;
      width: 22px;
      height: 22px;
      border: 0;
      border-radius: 999px;
      color: #cbd5e1;
      background: rgba(51, 65, 85, .9);
      cursor: pointer;
      pointer-events: auto;
      font-weight: 800;
      line-height: 22px;
      padding: 0;
    }
    .close:hover { color: white; background: #ef4444; }
  `

  const scrim = document.createElement('div')
  scrim.className = 'scrim'
  scrim.setAttribute('part', 'scrim')
  if (!settings.grayQrOnResult) scrim.style.display = 'none'

  const pin = document.createElement('button')
  pin.type = 'button'
  pin.className = 'pin'
  pin.setAttribute('part', 'pin')
  pin.setAttribute('data-boltqr-result-action', 'open-or-copy')

  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'close'
  closeButton.setAttribute('aria-label', '关闭 BoltQR 结果')
  closeButton.setAttribute('data-boltqr-result-action', 'close')
  closeButton.textContent = '×'

  const domain = document.createElement('div')
  domain.className = 'domain'
  const value = document.createElement('div')
  value.className = 'value'
  const hint = document.createElement('div')
  hint.className = 'hint'

  const safeUrl = isOpenableUrl(bundle.qrUrl) ? bundle.qrUrl : undefined
  domain.textContent = safeUrl ? hostnameFromUrl(safeUrl) : '文本二维码'
  value.textContent = compactResultText(bundle.qrText)
  hint.textContent = safeUrl
    ? (settings.openBehavior === 'same-tab' ? '点击在当前页打开 ↗' : '点击新标签打开 ↗')
    : '点击复制文本'

  pin.append(domain, value, hint, closeButton)
  shadow.append(style, scrim, pin)
  document.documentElement.appendChild(overlayHost)

  const updatePosition = () => {
    if (!document.documentElement.contains(image)) {
      removeInlineResultOverlay()
      return
    }
    const next = image.getBoundingClientRect()
    if (next.width <= 0 || next.height <= 0) {
      removeInlineResultOverlay()
      return
    }
    scrim.style.left = `${Math.max(0, next.left)}px`
    scrim.style.top = `${Math.max(0, next.top)}px`
    scrim.style.width = `${next.width}px`
    scrim.style.height = `${next.height}px`

    const pinWidth = Math.min(260, Math.max(128, next.width))
    const pinLeft = Math.min(Math.max(8, next.left), Math.max(8, window.innerWidth - pinWidth - 8))
    const pinTop = Math.min(Math.max(8, next.top - 10), Math.max(8, window.innerHeight - 72))
    pin.style.width = `${pinWidth}px`
    pin.style.left = `${pinLeft}px`
    pin.style.top = `${pinTop}px`
  }

  const onMove = () => requestAnimationFrame(updatePosition)
  updatePosition()
  window.addEventListener('scroll', onMove, true)
  window.addEventListener('resize', onMove)

  const cleanup = () => {
    window.removeEventListener('scroll', onMove, true)
    window.removeEventListener('resize', onMove)
  }
  ;(overlayHost as any).__boltqrCleanup = cleanup

  pin.addEventListener('click', () => {
    if (safeUrl) {
      if (settings.openBehavior === 'same-tab') {
        window.location.href = safeUrl
      } else {
        window.open(safeUrl, '_blank', 'noopener')
      }
      return
    }
    void copyToClipboard(bundle.qrText)
  })
  closeButton.addEventListener('click', (event) => {
    event.stopPropagation()
    removeInlineResultOverlay()
  })

  return true
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
