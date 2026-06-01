import QRCode from 'qrcode'
import type { ImageFormat, PayloadSize, SampleSpec } from './types'

const PAYLOADS: Record<PayloadSize, string> = {
  short: 'https://example.com/a',
  medium: 'https://example.com/orders/1234567890?token=boltqr-medium-payload',
  long: 'BOLTQR:' + 'x'.repeat(700),
}

const FORMATS: ImageFormat[] = ['png', 'jpg', 'webp']
const SIZES = [128, 256, 512, 1024]
const PAYLOAD_SIZES: PayloadSize[] = ['short', 'medium', 'long']

function mimeFor(format: ImageFormat): string {
  switch (format) {
    case 'png':
      return 'image/png'
    case 'jpg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
  }
}

async function renderQrCanvas(payload: string, size: number): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  await QRCode.toCanvas(canvas, payload, {
    width: size,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  })
  return canvas
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error(`toBlob failed for ${mime}`))
      },
      mime,
      quality,
    )
  })
}

async function generateOne(format: ImageFormat, size: number, payloadSize: PayloadSize): Promise<SampleSpec> {
  const payload = PAYLOADS[payloadSize]
  const qrCanvas = await renderQrCanvas(payload, size)

  // For JPEG we need an opaque background.
  let finalCanvas = qrCanvas
  if (format === 'jpg') {
    const c = document.createElement('canvas')
    c.width = size
    c.height = size
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
    ctx.drawImage(qrCanvas, 0, 0)
    finalCanvas = c
  }

  const mime = mimeFor(format)
  const quality = format === 'jpg' ? 0.92 : format === 'webp' ? 0.92 : 1.0
  const blob = await canvasToBlob(finalCanvas, mime, quality)
  const url = URL.createObjectURL(blob)
  const id = `${format}-${size}-${payloadSize}`
  return {
    id,
    format,
    size,
    payloadSize,
    payloadBytes: new TextEncoder().encode(payload).length,
    payload,
    url,
  }
}

export async function generateSamples(): Promise<SampleSpec[]> {
  const samples: SampleSpec[] = []
  for (const format of FORMATS) {
    for (const size of SIZES) {
      for (const payloadSize of PAYLOAD_SIZES) {
        try {
          const sample = await generateOne(format, size, payloadSize)
          samples.push(sample)
        } catch (err) {
          console.warn(`failed to generate ${format}-${size}-${payloadSize}`, err)
        }
      }
    }
  }
  return samples
}

export const SAMPLE_CONFIG = { FORMATS, SIZES, PAYLOAD_SIZES }
