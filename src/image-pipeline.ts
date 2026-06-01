import type { DecodeInput, PreprocessMode, SampleSpec, StageTiming } from './types'

export type PrepTiming = Omit<StageTiming, 'decodeMs' | 'totalMs'>

function targetDim(mode: PreprocessMode): number | null {
  if (mode === 'original') return null
  if (mode === 'max-512') return 512
  if (mode === 'max-1024') return 1024
  return null
}

function computeScaled(width: number, height: number, max: number): { w: number; h: number } {
  const longest = Math.max(width, height)
  if (longest <= max) return { w: width, h: height }
  const scale = max / longest
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) }
}

function makeCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement | OffscreenCanvas
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
} {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null
    if (ctx) return { canvas, ctx }
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  return { canvas, ctx }
}

export async function prepareImage(
  sample: SampleSpec,
  mode: PreprocessMode = 'original',
): Promise<{ input: DecodeInput; timing: PrepTiming }> {
  const t0 = performance.now()
  const res = await fetch(sample.url)
  const blob = await res.blob()
  const t1 = performance.now()

  const sourceBitmap = await createImageBitmap(blob)
  const t2 = performance.now()

  const max = targetDim(mode)
  let bitmap = sourceBitmap
  let width = sourceBitmap.width
  let height = sourceBitmap.height
  if (max !== null && Math.max(width, height) > max) {
    const { w, h } = computeScaled(width, height, max)
    width = w
    height = h
    bitmap = await createImageBitmap(sourceBitmap, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'high',
    })
    sourceBitmap.close()
  }

  const { ctx } = makeCanvas(width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  const t3 = performance.now()

  const imageData = ctx.getImageData(0, 0, width, height)
  const t4 = performance.now()

  return {
    input: { sample, blob, bitmap, imageData },
    timing: {
      fetchBlobMs: t1 - t0,
      createImageBitmapMs: t2 - t1,
      drawToCanvasMs: t3 - t2,
      getImageDataMs: t4 - t3,
    },
  }
}

export function releaseInput(input: DecodeInput) {
  try {
    input.bitmap.close()
  } catch {}
}
