import jsQR from 'jsqr'
import type { DecodeInput, DecodeResult, Decoder } from '../types'

export const jsQrDecoder: Decoder = {
  id: 'jsqr',
  label: 'jsQR',
  async isAvailable() {
    return true
  },
  async init() {},
  async decode(input: DecodeInput): Promise<DecodeResult> {
    try {
      const code = jsQR(
        input.imageData.data as unknown as Uint8ClampedArray,
        input.imageData.width,
        input.imageData.height,
        { inversionAttempts: 'dontInvert' },
      )
      return code?.data
        ? { ok: true, text: code.data, raw: code }
        : { ok: false, error: 'No QR detected' }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}
