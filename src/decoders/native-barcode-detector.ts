import type { DecodeInput, DecodeResult, Decoder } from '../types'

declare global {
  // eslint-disable-next-line no-var
  var BarcodeDetector: undefined | (new (options?: { formats?: string[] }) => {
    detect(image: ImageBitmapSource): Promise<Array<{ rawValue: string; format: string }>>
  })
}

export const nativeBarcodeDetectorDecoder: Decoder = {
  id: 'native-barcode-detector',
  label: 'Native BarcodeDetector',
  async isAvailable() {
    return typeof (globalThis as any).BarcodeDetector !== 'undefined'
  },
  async init() {
    // no-op; construction happens per decode for fairness with cross-origin worker reuse
  },
  async decode(input: DecodeInput): Promise<DecodeResult> {
    const Detector = (globalThis as any).BarcodeDetector
    if (!Detector) return { ok: false, error: 'BarcodeDetector unavailable' }
    try {
      const detector = new Detector({ formats: ['qr_code'] })
      const results = await detector.detect(input.bitmap)
      const first = results?.[0]
      return first?.rawValue
        ? { ok: true, text: first.rawValue, raw: first }
        : { ok: false, error: 'No QR detected' }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}
