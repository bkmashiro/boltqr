import QRCode from 'qrcode'
import { describe, expect, it, vi } from 'vitest'
import {
  createWasmInstantiateOverride,
  decodeQrFromImageData,
  resetZXingReaderForTests,
  type PixelImageData,
} from './qr-decode'

const LOGO_QR_TEXT = 'https://example.com/test'

function rasterLogoQr(text: string): PixelImageData {
  const size = 121
  const inset = 2
  const logoScale = 0.26
  const qr = QRCode.create(text, { errorCorrectionLevel: 'H', margin: 0 } as any)
  const modules = qr.modules.size
  const base = new Uint8ClampedArray(size * size * 4)

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const mx = Math.max(0, Math.min(modules - 1, Math.floor((x * modules) / size)))
      const my = Math.max(0, Math.min(modules - 1, Math.floor((y * modules) / size)))
      const value = qr.modules.get(mx, my) ? 0 : 255
      const offset = (y * size + x) * 4
      base[offset] = value
      base[offset + 1] = value
      base[offset + 2] = value
      base[offset + 3] = 255
    }
  }

  const logoSize = Math.floor(size * logoScale)
  const logoStart = Math.floor((size - logoSize) / 2)
  const logoEnd = logoStart + logoSize
  for (let y = logoStart; y < logoEnd; y += 1) {
    for (let x = logoStart; x < logoEnd; x += 1) {
      const offset = (y * size + x) * 4
      base[offset] = 255
      base[offset + 1] = 255
      base[offset + 2] = 255
      base[offset + 3] = 255
    }
  }

  const width = size - inset * 2
  const height = size - inset * 2
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = ((y + inset) * size + (x + inset)) * 4
      const dest = (y * width + x) * 4
      data[dest] = base[source]
      data[dest + 1] = base[source + 1]
      data[dest + 2] = base[source + 2]
      data[dest + 3] = 255
    }
  }

  return { width, height, data }
}

describe('QR decode profiles', () => {
  it('keeps auto fast but lets manual robust decode centered-logo QR with cropped quiet zone', async () => {
    const image = rasterLogoQr(LOGO_QR_TEXT)

    await expect(decodeQrFromImageData(image, 'fast')).rejects.toThrow(/二维码|QR/i)
    await expect(decodeQrFromImageData(image, 'robust')).resolves.toBe(LOGO_QR_TEXT)

    resetZXingReaderForTests()
  }, 20_000)
})

describe('ZXing WASM service-worker loader', () => {
  it('instantiates from fetch without touching XMLHttpRequest fallback', async () => {
    const bytes = new ArrayBuffer(8)
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => bytes,
    }))
    const instantiate = vi.fn(async (_wasmBytes: BufferSource, _imports: WebAssembly.Imports) => ({
      instance: { exports: {} } as WebAssembly.Instance,
      module: {} as WebAssembly.Module,
    }))
    const successCallback = vi.fn()

    const override = createWasmInstantiateOverride({
      wasmUrl: 'chrome-extension://id/zxing_reader.wasm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      instantiate,
    })

    const returnValue = override({ env: {} }, successCallback)
    expect(returnValue).toEqual({})
    await vi.waitFor(() => expect(successCallback).toHaveBeenCalledTimes(1))

    expect(fetchImpl).toHaveBeenCalledWith('chrome-extension://id/zxing_reader.wasm')
    expect(instantiate).toHaveBeenCalledWith(bytes, { env: {} })
    expect(successCallback).toHaveBeenCalledWith({ exports: {} })
  })
})
