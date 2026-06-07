import { describe, expect, it } from 'vitest'
import {
  makeScanCacheKey,
  planAutoScanBatch,
  scoreAutoScanCandidate,
  type ImageScanDescriptor,
} from './auto-scan'

function image(overrides: Partial<ImageScanDescriptor> = {}): ImageScanDescriptor {
  return {
    url: 'https://cdn.example.com/assets/qr.png',
    width: 220,
    height: 220,
    naturalWidth: 220,
    naturalHeight: 220,
    visible: true,
    ...overrides,
  }
}

describe('auto-scan planner/filter', () => {
  it('selects promising QR-ish square images before weaker candidates', () => {
    const planned = planAutoScanBatch([
      image({ url: 'https://cdn.example.com/photo-card.jpg', width: 320, height: 220, naturalWidth: 640, naturalHeight: 440, alt: 'download poster' }),
      image({ url: 'https://cdn.example.com/qr-download.png', width: 180, height: 180, naturalWidth: 360, naturalHeight: 360, alt: '微信扫码下载 QR code' }),
      image({ url: 'https://cdn.example.com/banner.png', width: 480, height: 180, naturalWidth: 960, naturalHeight: 360, alt: 'banner' }),
    ])

    expect(planned.map((scan) => scan.url)).toEqual([
      'https://cdn.example.com/qr-download.png',
      'https://cdn.example.com/photo-card.jpg',
      'https://cdn.example.com/banner.png',
    ])
    expect(planned[0].score).toBeGreaterThan(planned[1].score)
  })

  it('prioritizes QR-ish candidates and caps planning at 6 when mixed with noisy images', () => {
    const planned = planAutoScanBatch([
      ...Array.from({ length: 30 }, (_, index) =>
        image({
          url: `https://cdn.example.com/noise-${index}.png`,
          id: `noise-${index}`,
          width: 120 + (index % 5) * 4,
          height: 120 + (index % 5) * 3,
          naturalWidth: 240,
          naturalHeight: 240,
          alt: 'site logo avatar',
          className: 'avatar social-icon',
        }),
      ),
      ...Array.from({ length: 12 }, (_, index) =>
        image({
          url: `https://cdn.example.com/qr-${index}.png`,
          id: `qr-${index}`,
          width: 160,
          height: 160,
          naturalWidth: 320,
          naturalHeight: 320,
          alt: `微信 扫码 下载 ${index}`,
          className: 'qrcode-image',
        }),
      ),
      image({
        url: 'https://cdn.example.com/button-similar.png',
        id: 'plain-button',
        width: 160,
        height: 160,
        naturalWidth: 320,
        naturalHeight: 320,
        alt: 'plain button icon',
        className: 'cta',
      }),
    ], { maxBatchSize: 6 })

    expect(planned).toHaveLength(6)
    expect(new Set(planned.map((scan) => scan.url)).size).toBe(6)
    expect(planned.every((scan) => /\/qr-\d+\.png$/.test(scan.url))).toBe(true)
  })

  it('rejects tiny icons, logos/avatars/social icons, hidden candidates, unsupported extensions, and huge hero/photo-like images', () => {
    const rejected = [
      image({ url: 'https://cdn.example.com/favicon.png', width: 24, height: 24, naturalWidth: 24, naturalHeight: 24, alt: 'qr?' }),
      image({ url: 'https://cdn.example.com/logo.png', alt: 'Company Logo', className: 'site-logo' }),
      image({ url: 'https://cdn.example.com/avatar.jpg', alt: 'user avatar', className: 'avatar rounded' }),
      image({ url: 'https://cdn.example.com/twitter.svg', width: 96, height: 96, naturalWidth: 96, naturalHeight: 96, alt: 'Twitter social icon' }),
      image({ url: 'https://cdn.example.com/animated-qr.gif', alt: 'qr code' }),
      image({ url: 'https://cdn.example.com/legacy-qr.bmp', alt: 'qr code' }),
      image({ url: 'https://cdn.example.com/hidden-qr.png', visible: false, alt: 'qr code' }),
      image({ url: 'https://cdn.example.com/qr.txt', alt: 'qr code' }),
      image({ url: 'https://cdn.example.com/hero-photo.jpg', width: 1600, height: 900, naturalWidth: 3200, naturalHeight: 1800, alt: 'hero photo' }),
    ]

    for (const descriptor of rejected) {
      expect(scoreAutoScanCandidate(descriptor), descriptor.url).toBeNull()
    }
    expect(planAutoScanBatch(rejected)).toEqual([])
  })

  it('respects the batch cap after sorting eligible candidates', () => {
    const planned = planAutoScanBatch([
      image({ url: 'https://cdn.example.com/weak-wide.png', width: 360, height: 240, naturalWidth: 720, naturalHeight: 480 }),
      image({ url: 'https://cdn.example.com/qr-a.png', alt: 'qr code' }),
      image({ url: 'https://cdn.example.com/qr-b.png', alt: 'scan qr' }),
    ], { maxBatchSize: 2 })

    expect(planned).toHaveLength(2)
    expect(planned.map((scan) => scan.url)).toEqual([
      'https://cdn.example.com/qr-a.png',
      'https://cdn.example.com/qr-b.png',
    ])
  })

  it('dedupes mutation-like reinsertion when cache key is unchanged', () => {
    const base = image({
      url: 'https://cdn.example.com/qr.png',
      currentSrc: 'https://cdn.example.com/rendered-qr.png',
      id: 'qr-slot',
      alt: 'qr code',
    })

    const planned = planAutoScanBatch([
      base,
      {
        ...base,
        alt: '二维码 扫码',
      },
      {
        ...base,
        className: 'refreshed',
      },
      image({
        url: 'https://cdn.example.com/qr-other.png',
        currentSrc: 'https://cdn.example.com/rendered-qr-other.png',
        id: 'qr-slot-2',
        alt: 'qr code',
      }),
    ])

    expect(planned).toHaveLength(2)
    expect(planned.map((scan) => scan.url)).toEqual([
      'https://cdn.example.com/rendered-qr.png',
      'https://cdn.example.com/rendered-qr-other.png',
    ])
    expect(planned[0].cacheKey).toBe(makeScanCacheKey(base))
    expect(planned.every((scan, index) => scan.cacheKey !== planned[0].cacheKey || index === 0)).toBe(true)
  })

  it('changes cache key when element identity or source changes enough to require re-scan', () => {
    const base = image({ url: 'https://cdn.example.com/qr.png', id: 'slot-a', elementKey: 'img-1' })

    expect(makeScanCacheKey(base)).toBe(makeScanCacheKey({ ...base, alt: 'different caption text' }))
    expect(makeScanCacheKey(base)).not.toBe(makeScanCacheKey({ ...base, id: 'slot-b' }))
    expect(makeScanCacheKey(base)).not.toBe(makeScanCacheKey({ ...base, url: 'https://cdn.example.com/qr-v2.png' }))
    expect(makeScanCacheKey(base)).not.toBe(makeScanCacheKey({ ...base, currentSrc: 'https://cdn.example.com/rendered-v2.png' }))
  })
})
