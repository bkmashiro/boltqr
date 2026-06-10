import { decodeQrFromImageData as decodeQrFromPixels } from './qr-decode'
import type {
  CandidateBundle,
  CandidateExtractionResponse,
  HelperSettings,
  IngestSummary,
} from './shared/types'
import { toRuntimeSettings } from './options/settings'

const MENU_ID = 'boltqr-scan-image'
const DEBUG_STORAGE_KEY = 'boltqrLastScanDebug'

interface SenderTabContext {
  id?: number
  url?: string
}

interface ScanDebugInfo {
  srcUrl: string
  mode: 'manual' | 'auto'
  pageUrl?: string
  phase: string
  status?: number
  statusText?: string
  contentType?: string
  ok?: boolean
  error?: string
  createdAt: string
}

interface PixelImagePayload {
  width: number
  height: number
  data: number[]
}

interface ViewportCropPayload {
  left: number
  top: number
  width: number
  height: number
  devicePixelRatio: number
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'BoltQR: 识别此图片中的二维码',
    contexts: ['image'],
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl || !tab?.id) return
  void chrome.tabs.sendMessage(tab.id, { type: 'boltqr:manual-scan-selected-image', srcUrl: info.srcUrl })
    .catch(() => scanImageFromContextMenu(info.srcUrl!, tab.id!, tab.url))
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const msg = message as any
  if (!msg?.srcUrl) return undefined
  const mode = msg.type === 'boltqr:auto-scan-image' ? 'auto' : msg.type === 'boltqr:manual-scan-image' ? 'manual' : null
  if (!mode) return undefined
  void resolveSenderTabContext(sender)
    .then((tab) => {
      if (!tab.id) throw new Error('无法定位当前标签页')
      return mode === 'auto'
        ? scanImageFromAutoScan(msg.srcUrl, tab.id, tab.url, msg.imageData)
        : scanImageFromContextMenu(msg.srcUrl, tab.id, tab.url, msg.imageData, msg.viewportCrop)
    })
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }))
  return true
})

async function resolveSenderTabContext(sender: chrome.runtime.MessageSender): Promise<SenderTabContext> {
  if (sender.tab?.id) return { id: sender.tab.id, url: sender.tab.url }
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    return { id: tabs[0]?.id, url: tabs[0]?.url }
  } catch {
    return {}
  }
}

async function scanImageFromContextMenu(srcUrl: string, tabId: number, pageUrl?: string, imageData?: PixelImagePayload, viewportCrop?: ViewportCropPayload): Promise<{ ok: boolean; error?: string }> {
  return scanImage(srcUrl, tabId, 'manual', pageUrl, imageData, viewportCrop)
}

async function scanImageFromAutoScan(srcUrl: string, tabId: number, pageUrl?: string, imageData?: PixelImagePayload): Promise<{ ok: boolean; error?: string }> {
  return scanImage(srcUrl, tabId, 'auto', pageUrl, imageData)
}

async function scanImage(srcUrl: string, tabId: number, mode: 'manual' | 'auto', pageUrl?: string, imageData?: PixelImagePayload, viewportCrop?: ViewportCropPayload): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!isSupportedImageUrl(srcUrl)) {
      throw new Error('只支持 PNG/JPG/JPEG/WebP 图片')
    }
    const decoded = await decodeImageWithOptionalPixels(srcUrl, imageData, viewportCrop, { mode, pageUrl, tabId })
    const bundle = await extractCandidatesFromTab(tabId, decoded.text, srcUrl, decoded.mime)
    const ingest = await sendToSmartExtract(bundle, mode)
    await chrome.tabs.sendMessage(tabId, { type: 'boltqr:show-result', bundle, ingest })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await recordScanDebug({
      srcUrl,
      mode,
      pageUrl,
      phase: 'scan-error',
      error: message,
      createdAt: new Date().toISOString(),
    })
    if (mode === 'auto') return { ok: false, error: message }
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'boltqr:decode-error', message })
    } catch {
      // Content script may be unavailable on chrome:// pages.
    }
    return { ok: false, error: message }
  }
}

function isSupportedImageUrl(url: string): boolean {
  if (url.startsWith('data:image/png') || url.startsWith('data:image/jpeg') || url.startsWith('data:image/webp')) return true
  if (url.startsWith('blob:')) return true
  return /\.(png|jpe?g|webp)(?:[?#].*)?$/i.test(url)
}

async function decodeImageWithOptionalPixels(srcUrl: string, payload: PixelImagePayload | undefined, viewportCrop: ViewportCropPayload | undefined, context: { mode: 'manual' | 'auto'; pageUrl?: string; tabId: number }): Promise<{ text: string; mime: string }> {
  if (payload) {
    try {
      return await decodePixelImageData(srcUrl, payload, context)
    } catch (err) {
      await recordScanDebug({
        srcUrl,
        mode: context.mode,
        pageUrl: context.pageUrl,
        phase: 'loaded-image-pixels-error',
        error: err instanceof Error ? err.message : String(err),
        createdAt: new Date().toISOString(),
      })
    }
  }
  if (context.mode === 'manual' && viewportCrop) {
    try {
      return await decodeVisibleTabCrop(srcUrl, viewportCrop, context)
    } catch (err) {
      await recordScanDebug({
        srcUrl,
        mode: context.mode,
        pageUrl: context.pageUrl,
        phase: 'visible-tab-screenshot-error',
        error: err instanceof Error ? err.message : String(err),
        createdAt: new Date().toISOString(),
      })
    }
  }
  return decodeImageUrl(srcUrl, context)
}

async function decodeVisibleTabCrop(srcUrl: string, crop: ViewportCropPayload, context: { mode: 'manual' | 'auto'; pageUrl?: string; tabId: number }): Promise<{ text: string; mime: string }> {
  if (!isValidViewportCrop(crop)) throw new Error('页面截图裁剪区域无效')
  const dataUrl = await captureCurrentVisibleTabPng()
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  const dpr = Math.max(1, crop.devicePixelRatio || 1)
  const sx = clamp(Math.round(crop.left * dpr), 0, bitmap.width - 1)
  const sy = clamp(Math.round(crop.top * dpr), 0, bitmap.height - 1)
  const sw = clamp(Math.round(crop.width * dpr), 1, bitmap.width - sx)
  const sh = clamp(Math.round(crop.height * dpr), 1, bitmap.height - sy)
  const canvas = new OffscreenCanvas(sw, sh)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建页面截图裁剪 canvas')
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
  bitmap.close()
  const imageData = ctx.getImageData(0, 0, sw, sh)
  await recordScanDebug({
    srcUrl,
    mode: context.mode,
    pageUrl: context.pageUrl,
    phase: 'visible-tab-screenshot',
    ok: true,
    createdAt: new Date().toISOString(),
  })
  const text = await decodeQrFromPixels(imageData, 'robust')
  return { text, mime: 'image/png' }
}

function isValidViewportCrop(crop: ViewportCropPayload): boolean {
  return Number.isFinite(crop.left)
    && Number.isFinite(crop.top)
    && Number.isFinite(crop.width)
    && Number.isFinite(crop.height)
    && Number.isFinite(crop.devicePixelRatio)
    && crop.width > 0
    && crop.height > 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function captureCurrentVisibleTabPng(): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab({ format: 'png' }, (dataUrl) => {
      const err = chrome.runtime.lastError
      if (err) {
        reject(new Error(err.message || 'captureVisibleTab failed'))
        return
      }
      resolve(dataUrl)
    })
  })
}

async function decodePixelImageData(srcUrl: string, payload: PixelImagePayload, context: { mode: 'manual' | 'auto'; pageUrl?: string }): Promise<{ text: string; mime: string }> {
  if (!isValidPixelPayload(payload)) throw new Error('页面图片像素数据无效')
  await recordScanDebug({
    srcUrl,
    mode: context.mode,
    pageUrl: context.pageUrl,
    phase: 'loaded-image-pixels',
    ok: true,
    createdAt: new Date().toISOString(),
  })
  const imageData = new ImageData(new Uint8ClampedArray(payload.data), payload.width, payload.height)
  const text = await decodeQrFromPixels(imageData, context.mode === 'manual' ? 'robust' : 'fast')
  return { text, mime: '' }
}

function isValidPixelPayload(payload: PixelImagePayload): boolean {
  return Number.isInteger(payload.width)
    && Number.isInteger(payload.height)
    && payload.width > 0
    && payload.height > 0
    && Array.isArray(payload.data)
    && payload.data.length === payload.width * payload.height * 4
}

async function decodeImageUrl(srcUrl: string, context: { mode: 'manual' | 'auto'; pageUrl?: string }): Promise<{ text: string; mime: string }> {
  const fetchInit: RequestInit = { credentials: 'include', cache: 'force-cache' }
  if (context.pageUrl && /^https?:\/\//i.test(context.pageUrl)) {
    fetchInit.referrer = context.pageUrl
    fetchInit.referrerPolicy = 'strict-origin-when-cross-origin'
  }

  const response = await fetch(srcUrl, fetchInit)
  const contentType = response.headers.get('content-type') || ''
  await recordScanDebug({
    srcUrl,
    mode: context.mode,
    pageUrl: context.pageUrl,
    phase: 'fetch-image',
    status: response.status,
    statusText: response.statusText,
    contentType,
    ok: response.ok,
    createdAt: new Date().toISOString(),
  })
  if (!response.ok) {
    throw new Error(`图片读取失败: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}; type=${contentType || 'unknown'}; url=${shortenForDebug(srcUrl)}`)
  }
  const blob = await response.blob()
  if (!/^image\/(png|jpeg|webp)$/i.test(blob.type) && !isSupportedImageUrl(srcUrl)) {
    throw new Error(`不支持的图片类型: ${blob.type || 'unknown'}`)
  }
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建图片解码 canvas')
  ctx.drawImage(bitmap, 0, 0)
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  bitmap.close()
  const text = await decodeQrFromPixels(imageData, context.mode === 'manual' ? 'robust' : 'fast')
  return { text, mime: blob.type || '' }
}

async function recordScanDebug(info: ScanDebugInfo): Promise<void> {
  try {
    await chrome.storage.local.set({ [DEBUG_STORAGE_KEY]: info })
    console.debug?.('[BoltQR] scan debug', info)
  } catch {
    // Diagnostics must never break scanning.
  }
}

function shortenForDebug(value: string): string {
  return value.length > 180 ? `${value.slice(0, 177)}...` : value
}

async function extractCandidatesFromTab(tabId: number, qrText: string, srcUrl: string, imageMime?: string): Promise<CandidateBundle> {
  const response = (await chrome.tabs.sendMessage(tabId, {
    type: 'boltqr:extract-candidates',
    qrText,
    anchorImageUrl: srcUrl,
    imageMime,
  })) as CandidateExtractionResponse
  if (!response?.ok || !response.bundle) throw new Error(response?.error || '页面候选提取失败')
  return response.bundle
}

async function loadHelperSettings(): Promise<HelperSettings> {
  const stored = (await chrome.storage.local.get([
    'smartExtractEndpoint',
    'smartExtractToken',
    'smartExtractEnabled',
    'smartExtractManualOnly',
  ]))
  return toRuntimeSettings(stored)
}


async function sendToSmartExtract(bundle: CandidateBundle, mode: 'manual' | 'auto'): Promise<IngestSummary> {
  const settings = await loadHelperSettings()
  if (!settings.enabled) {
    return { ok: false, helperEndpoint: settings.endpoint, error: '候选上报已在设置中关闭' }
  }
  if (mode === 'auto' && settings.manualOnly) {
    return { ok: false, helperEndpoint: settings.endpoint, error: '设置为仅手动识别时上报候选' }
  }
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (settings.token) headers.authorization = `Bearer ${settings.token}`
    const response = await fetch(`${settings.endpoint}/v1/candidates`, {
      method: 'POST',
      headers,
      body: JSON.stringify(bundle),
    })
    if (!response.ok) {
      return { ok: false, helperEndpoint: settings.endpoint, error: `Smart Extract HTTP ${response.status}` }
    }
    const json = (await response.json()) as Partial<IngestSummary>
    return {
      ok: json.ok !== false,
      bundleId: json.bundleId,
      stored: json.stored,
      helperEndpoint: settings.endpoint,
    }
  } catch (err) {
    return {
      ok: false,
      helperEndpoint: settings.endpoint,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
