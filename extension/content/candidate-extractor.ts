import type { CandidateBundle, QRCandidate } from '../shared/types'

const KEYWORDS = [
  '解压密码', '压缩包密码', '下载密码', '密码', '提取码', '访问码', '口令', '验证码',
  'password', 'pass', 'pwd', 'archive password', 'zip password', 'rar password', 'extract code', 'access code',
]
const UI_LABELS = new Set(['密码', '解压密码', '压缩包密码', '提取码', '访问码', '复制', '下载', '打开', 'password', 'pass', 'pwd', 'copy', 'download'])
const MAX_CANDIDATE_LEN = 256
const MAX_CANDIDATES = 250

export interface CandidateBundleInput {
  pageUrl: string
  pageTitle?: string
  qrText: string
  anchorImageUrl?: string
  imageMime?: string
}

export function buildCandidateBundleFromDocument(doc: Document, input: CandidateBundleInput): CandidateBundle {
  const qrUrl = looksLikeUrl(input.qrText) ? input.qrText : undefined
  const candidates = collectCandidates(doc, input.qrText, input.anchorImageUrl)
  return {
    schemaVersion: 1,
    producer: 'boltqr',
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle || doc.title || undefined,
    qrText: input.qrText,
    qrUrl,
    downloadUrl: qrUrl,
    fileName: fileNameFromUrl(qrUrl || ''),
    imageUrl: input.anchorImageUrl,
    imageMime: input.imageMime,
    createdAt: new Date().toISOString(),
    candidates,
  }
}

function collectCandidates(doc: Document, qrText: string, anchorImageUrl?: string): QRCandidate[] {
  const out: QRCandidate[] = []
  const add = makeCandidateAdder(out)

  const nearText = anchorImageUrl ? textNearImage(doc, anchorImageUrl) : ''
  harvestText(nearText, 'near-qr', 120, add)
  harvestText(getVisibleText(doc), 'visible-text', 80, add)

  for (const value of collectAttributeTexts(doc)) {
    harvestText(value, 'dom-attribute', 90, add)
    add(value, 70, 'dom-attribute', 'raw attribute value')
  }

  const pageHost = hostnameFromUrl(inputUrl(doc))
  if (pageHost) {
    add(pageHost, 35, 'page-hostname', 'current page hostname')
    add(stripWww(pageHost), 30, 'page-hostname', 'current page hostname without www')
  }

  for (const urlText of [qrText, anchorImageUrl || '']) {
    const host = hostnameFromUrl(urlText)
    if (host) {
      add(host, 45, 'qr-hostname', 'QR/image URL hostname')
      add(stripWww(host), 40, 'qr-hostname', 'QR/image URL hostname without www')
      add(stripServiceSubdomain(host), 38, 'qr-hostname', 'QR/image URL hostname without service subdomain')
    }
  }

  return out.slice(0, MAX_CANDIDATES)
}

function inputUrl(doc: Document): string {
  return doc.location?.href || ''
}

function getVisibleText(doc: Document): string {
  const body = doc.body
  if (!body) return ''
  const innerText = (body as HTMLElement & { innerText?: string }).innerText
  if (innerText) return innerText
  const chunks: string[] = []
  const walker = doc.createTreeWalker(body, doc.defaultView?.NodeFilter.SHOW_TEXT ?? 4)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim()
    if (text) chunks.push(text)
  }
  return chunks.join('\n')
}

function makeCandidateAdder(out: QRCandidate[]) {
  const seen = new Set<string>()
  return (raw: string, scoreHint: number, source: string, reason?: string, context?: string) => {
    for (const value of normalizeCandidates(raw)) {
      const key = value.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ value, scoreHint, source, reason, context })
    }
  }
}

export function normalizeCandidates(raw: string): string[] {
  const cleaned = raw
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .trim()
    .replace(/^["'`“”‘’「」『』【】\[\]（）()<>\s]+|["'`“”‘’「」『』【】\[\]（）()<>\s]+$/g, '')
  if (!cleaned || cleaned.length > MAX_CANDIDATE_LEN) return []
  if (UI_LABELS.has(cleaned.toLowerCase())) return []
  return [cleaned]
}

function harvestText(text: string, source: string, baseScore: number, add: (raw: string, score: number, source: string, reason?: string, context?: string) => void) {
  if (!text) return
  for (const keyword of KEYWORDS) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`${escaped}\\s*[:：=\-—–]?\\s*([^\\n\\r\\t，,。；;|]{1,128})`, 'giu')
    for (const match of text.matchAll(regex)) {
      add(match[1] || '', baseScore + 30, source, `matched ${keyword}`, snippetAround(text, match.index || 0))
    }
  }

  const tokenRegex = /[A-Za-z0-9_@#%+~!.$^&*=-]{3,64}|[\u4e00-\u9fff]{2,24}/gu
  for (const match of text.matchAll(tokenRegex)) {
    add(match[0], baseScore - 40, source, 'broad token', snippetAround(text, match.index || 0))
  }
}

function collectAttributeTexts(doc: Document): string[] {
  const attrs = ['data-clipboard-text', 'data-copy', 'data-code', 'data-password', 'title', 'aria-label', 'value']
  const values: string[] = []
  const nodes = doc.querySelectorAll<HTMLElement>('button,a,input,textarea,[data-clipboard-text],[data-copy],[data-code],[data-password],[title],[aria-label]')
  for (const el of Array.from(nodes).slice(0, 1000)) {
    for (const attr of attrs) {
      const view = el.ownerDocument.defaultView
      const value = attr === 'value' && view && (el instanceof view.HTMLInputElement || el instanceof view.HTMLTextAreaElement) ? el.value : el.getAttribute(attr)
      if (value) values.push(value)
    }
  }
  return values
}

function textNearImage(doc: Document, srcUrl: string): string {
  const imgs = Array.from(doc.images)
  const found = imgs.find((img) => img.currentSrc === srcUrl || img.src === srcUrl || srcUrl.endsWith(img.currentSrc) || srcUrl.endsWith(img.src))
  if (!found) return ''
  let el: Element | null = found
  const chunks: string[] = []
  for (let i = 0; el && i < 4; i += 1, el = el.parentElement) {
    chunks.push((el.textContent || '').slice(0, 4000))
  }
  return chunks.join('\n')
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /\.(zip|rar|7z|tar|gz|xz|bz2)(?:[?#]|$)/i.test(value)
}

function hostnameFromUrl(value: string): string {
  try {
    return new URL(value).hostname
  } catch {
    return ''
  }
}

function fileNameFromUrl(value: string): string | undefined {
  try {
    const path = new URL(value).pathname
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || '') || undefined
  } catch {
    return undefined
  }
}

function stripWww(hostname: string): string {
  return hostname.replace(/^www\./i, '')
}

function stripServiceSubdomain(hostname: string): string {
  return hostname.replace(/^(www|files|file|cdn|dl|download|downloads)\./i, '')
}

function snippetAround(text: string, index: number): string {
  return text.slice(Math.max(0, index - 50), Math.min(text.length, index + 120)).trim()
}
