import { readBarcodes, prepareZXingModule } from 'zxing-wasm/reader'
import type {
  CandidateBundle,
  CandidateExtractionResponse,
  HelperSettings,
  IngestSummary,
} from './shared/types'
import { toRuntimeSettings } from './options/settings'

const MENU_ID = 'boltqr-scan-image'
let zxingReady: Promise<void> | null = null

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'BoltQR: 识别此图片中的二维码',
    contexts: ['image'],
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl || !tab?.id) return
  void scanImageFromContextMenu(info.srcUrl, tab.id)
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const msg = message as any
  if (msg?.type !== 'boltqr:auto-scan-image' || !msg.srcUrl) return undefined
  void resolveSenderTabId(sender)
    .then((tabId) => {
      if (!tabId) throw new Error('无法定位当前标签页')
      return scanImageFromAutoScan(msg.srcUrl, tabId)
    })
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }))
  return true
})

async function resolveSenderTabId(sender: chrome.runtime.MessageSender): Promise<number | undefined> {
  if (sender.tab?.id) return sender.tab.id
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    return tabs[0]?.id
  } catch {
    return undefined
  }
}

async function ensureZXing() {
  if (!zxingReady) {
    zxingReady = prepareZXingModule({
      fireImmediately: true,
      overrides: {
        locateFile: (fileName: string) => chrome.runtime.getURL(fileName),
      },
    }).then(() => undefined)
  }
  await zxingReady
}

async function scanImageFromContextMenu(srcUrl: string, tabId: number) {
  await scanImage(srcUrl, tabId, 'manual')
}

async function scanImageFromAutoScan(srcUrl: string, tabId: number): Promise<{ ok: boolean; error?: string }> {
  return scanImage(srcUrl, tabId, 'auto')
}

async function scanImage(srcUrl: string, tabId: number, mode: 'manual' | 'auto'): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!isSupportedImageUrl(srcUrl)) {
      throw new Error('只支持 PNG/JPG/JPEG/WebP 图片')
    }
    const decoded = await decodeImageUrl(srcUrl)
    const bundle = await extractCandidatesFromTab(tabId, decoded.text, srcUrl, decoded.mime)
    const ingest = await sendToSmartExtract(bundle, mode)
    await chrome.tabs.sendMessage(tabId, { type: 'boltqr:show-result', bundle, ingest })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
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

async function decodeImageUrl(srcUrl: string): Promise<{ text: string; mime: string }> {
  await ensureZXing()
  const response = await fetch(srcUrl, { credentials: 'include', cache: 'force-cache' })
  if (!response.ok) throw new Error(`图片读取失败: HTTP ${response.status}`)
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
  const results = await readBarcodes(imageData, {
    formats: ['QRCode'],
    tryHarder: false,
    tryRotate: false,
    tryInvert: false,
    tryDownscale: false,
    maxNumberOfSymbols: 1,
  })
  const first = results[0]
  if (!first?.isValid || !first.text) throw new Error('未识别到二维码')
  return { text: first.text, mime: blob.type || '' }
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
