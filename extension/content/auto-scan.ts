export interface ImageScanDescriptor {
  src?: string
  currentSrc?: string
  url?: string
  width?: number
  height?: number
  naturalWidth?: number
  naturalHeight?: number
  alt?: string
  id?: string
  className?: string
  visible?: boolean
  loading?: string
  elementKey?: string
}

export interface AutoScanPlanOptions {
  maxBatchSize?: number
}

export interface PlannedScan {
  descriptor: ImageScanDescriptor
  url: string
  cacheKey: string
  score: number
}

const DEFAULT_MAX_BATCH_SIZE = 8
const MIN_DIMENSION = 48
const MIN_AREA = 48 * 48
const HUGE_AREA = 2_000_000
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp'])
const QR_HINT_RE = /\b(qr|qrcode|qr-code|scan|wechat|weixin|code)\b|二维码|扫码|扫一扫|微信/i
const NEGATIVE_HINT_RE = /\b(logo|avatar|icon|favicon|sprite|social|share|twitter|facebook|instagram|youtube|wechat-icon|profile|portrait)\b|头像|图标|徽标|社交/i
const PHOTO_HERO_RE = /\b(hero|photo|banner|cover|poster|gallery|carousel|background|wallpaper)\b|横幅|封面|照片|相册/i

export function planAutoScanBatch(
  descriptors: readonly ImageScanDescriptor[],
  options: AutoScanPlanOptions = {},
): PlannedScan[] {
  const maxBatchSize = Math.max(0, Math.floor(options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE))
  if (maxBatchSize === 0) return []

  const seen = new Set<string>()
  return descriptors
    .map((descriptor, index) => {
      const score = scoreAutoScanCandidate(descriptor)
      if (score === null) return null
      const url = effectiveUrl(descriptor)
      if (!url) return null
      const cacheKey = makeScanCacheKey(descriptor)
      return { descriptor, url, cacheKey, score, index }
    })
    .filter((scan): scan is PlannedScan & { index: number } => scan !== null)
    .filter((scan) => {
      if (seen.has(scan.cacheKey)) return false
      seen.add(scan.cacheKey)
      return true
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxBatchSize)
    .map(({ index: _index, ...scan }) => scan)
}

export function makeScanCacheKey(descriptor: ImageScanDescriptor): string {
  const url = normalizeUrl(effectiveUrl(descriptor))
  const id = normalizeToken(descriptor.id)
  const elementKey = normalizeToken(descriptor.elementKey)
  const width = positiveNumber(descriptor.naturalWidth) || positiveNumber(descriptor.width) || 0
  const height = positiveNumber(descriptor.naturalHeight) || positiveNumber(descriptor.height) || 0
  return [url, id, elementKey, width, height].join('|')
}

export function scoreAutoScanCandidate(descriptor: ImageScanDescriptor): number | null {
  const url = effectiveUrl(descriptor)
  if (!url || descriptor.visible === false) return null
  if (!hasSupportedImageUrl(url)) return null

  const width = positiveNumber(descriptor.width) || positiveNumber(descriptor.naturalWidth) || 0
  const height = positiveNumber(descriptor.height) || positiveNumber(descriptor.naturalHeight) || 0
  const naturalWidth = positiveNumber(descriptor.naturalWidth) || width
  const naturalHeight = positiveNumber(descriptor.naturalHeight) || height
  if (!width || !height || !naturalWidth || !naturalHeight) return null

  const minSide = Math.min(width, height, naturalWidth, naturalHeight)
  const displayedArea = width * height
  const naturalArea = naturalWidth * naturalHeight
  if (minSide < MIN_DIMENSION || displayedArea < MIN_AREA || naturalArea < MIN_AREA) return null

  const text = `${descriptor.alt || ''} ${descriptor.id || ''} ${descriptor.className || ''} ${url}`
  if (NEGATIVE_HINT_RE.test(text)) return null

  const aspect = aspectRatio(width, height)
  const naturalAspect = aspectRatio(naturalWidth, naturalHeight)
  const maxSide = Math.max(width, height, naturalWidth, naturalHeight)
  const looksSquare = aspect <= 1.18 && naturalAspect <= 1.18
  const stronglyWide = aspect >= 2.2 || naturalAspect >= 2.2
  const stronglyTall = aspect <= 1 / 2.2 || naturalAspect <= 1 / 2.2
  const photoLikeHuge = naturalArea >= HUGE_AREA && (PHOTO_HERO_RE.test(text) || !looksSquare || maxSide >= 2400)
  if (photoLikeHuge) return null

  let score = 15
  if (looksSquare) score += 70
  else if (aspect <= 1.55 && naturalAspect <= 1.55) score += 28
  else if (stronglyWide || stronglyTall) score -= 22

  if (QR_HINT_RE.test(text)) score += 55
  if (PHOTO_HERO_RE.test(text)) score -= 18
  if (/\.(png|webp|bmp)(?:[?#]|$)/i.test(url)) score += 8
  if (/\.(jpe?g)(?:[?#]|$)/i.test(url)) score -= 4
  if (minSide >= 96 && minSide <= 768) score += 18
  if (maxSide > 1400) score -= 16
  if (descriptor.loading === 'lazy') score -= 2

  return score > 0 ? score : null
}

function effectiveUrl(descriptor: ImageScanDescriptor): string {
  return (descriptor.currentSrc || descriptor.src || descriptor.url || '').trim()
}

function positiveNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function aspectRatio(width: number, height: number): number {
  return width >= height ? width / height : height / width
}

function hasSupportedImageUrl(value: string): boolean {
  if (/^(data:image\/(png|jpeg|jpg|webp)|blob:)/i.test(value)) return true
  const extension = extensionFromUrl(value)
  if (!extension) return true
  return SUPPORTED_IMAGE_EXTENSIONS.has(extension)
}

function extensionFromUrl(value: string): string {
  try {
    const path = new URL(value, 'https://boltqr.invalid').pathname
    const match = /\.([a-z0-9]+)$/i.exec(path)
    return match?.[1]?.toLowerCase() || ''
  } catch {
    const clean = value.split(/[?#]/, 1)[0]
    const match = /\.([a-z0-9]+)$/i.exec(clean)
    return match?.[1]?.toLowerCase() || ''
  }
}

function normalizeUrl(value: string): string {
  try {
    const parsed = new URL(value, 'https://boltqr.invalid')
    parsed.hash = ''
    return parsed.href
  } catch {
    return value.trim()
  }
}

function normalizeToken(value: string | undefined): string {
  return (value || '').trim()
}
