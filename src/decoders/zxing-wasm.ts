import type { DecodeInput, DecodeResult, Decoder } from '../types'

let modulePromise: Promise<typeof import('zxing-wasm/reader')> | null = null

async function loadReader() {
  if (!modulePromise) {
    modulePromise = import('zxing-wasm/reader').then(async (mod) => {
      await mod.prepareZXingModule({ fireImmediately: true })
      return mod
    })
  }
  return modulePromise
}

export const zxingWasmDecoder: Decoder = {
  id: 'zxing-wasm',
  label: 'ZXing WASM',
  async isAvailable() {
    return true
  },
  async init() {
    await loadReader()
  },
  async decode(input: DecodeInput): Promise<DecodeResult> {
    try {
      const mod = await loadReader()
      const results = await mod.readBarcodes(input.imageData, {
        formats: ['QRCode'],
        tryHarder: false,
        tryRotate: false,
        tryInvert: false,
        tryDownscale: false,
        maxNumberOfSymbols: 1,
      })
      const first = results?.[0]
      if (first && first.isValid && first.text) {
        return { ok: true, text: first.text, raw: first }
      }
      return { ok: false, error: first?.error || 'No QR detected' }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}
