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

  it('dedupes duplicate URLs/cache keys stably', () => {
    const planned = planAutoScanBatch([
      image({ url: 'https://cdn.example.com/qr.png', currentSrc: 'https://cdn.example.com/rendered-qr.png', id: 'first', alt: 'qr code' }),
      image({ url: 'https://cdn.example.com/qr.png', currentSrc: 'https://cdn.example.com/rendered-qr.png', id: 'first', alt: 'same duplicate with higher text boost QR' }),
      image({ url: 'https://cdn.example.com/qr.png', currentSrc: 'https://cdn.example.com/rendered-qr-v2.png', id: 'second', alt: 'qr code' }),
    ])

    expect(planned.map((scan) => scan.url)).toEqual([
      'https://cdn.example.com/rendered-qr.png',
      'https://cdn.example.com/rendered-qr-v2.png',
    ])
    expect(planned[0].descriptor.id).toBe('first')
  })

  it('changes cache key when element id/url changes enough to rescan a changed image', () => {
    const base = image({ url: 'https://cdn.example.com/qr.png', id: 'slot-a', elementKey: 'img-1' })

    expect(makeScanCacheKey(base)).toBe(makeScanCacheKey({ ...base, alt: 'different caption text' }))
    expect(makeScanCacheKey(base)).not.toBe(makeScanCacheKey({ ...base, id: 'slot-b' }))
    expect(makeScanCacheKey(base)).not.toBe(makeScanCacheKey({ ...base, url: 'https://cdn.example.com/qr-v2.png' }))
    expect(makeScanCacheKey(base)).not.toBe(makeScanCacheKey({ ...base, currentSrc: 'https://cdn.example.com/rendered-v2.png' }))
  })
})
