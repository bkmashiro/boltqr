import type {
  CandidateExtractionResponse,
  DecodeErrorMessage,
  IngestSummary,
  ShowResultMessage,
} from './shared/types'
import { buildCandidateBundleFromDocument } from './content/candidate-extractor'

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message).then(sendResponse)
  return true
})

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
