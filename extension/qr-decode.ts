import { prepareZXingModule, purgeZXingModule, readBarcodes } from 'zxing-wasm/reader'

export type DecodeProfile = 'fast' | 'robust'

export interface PixelImageData {
  width: number
  height: number
  data: Uint8ClampedArray | number[]
}

type InstantiateSuccessCallback = (instance: WebAssembly.Instance) => void

type InstantiateFunction = (
  bytes: BufferSource,
  imports: WebAssembly.Imports,
) => Promise<WebAssembly.WebAssemblyInstantiatedSource>

export interface WasmInstantiateOverrideOptions {
  wasmUrl: string
  fetchImpl?: typeof fetch
  instantiate?: InstantiateFunction
}

let zxingReady: Promise<void> | null = null

export function createWasmInstantiateOverride(options: WasmInstantiateOverrideOptions) {
  const fetchImpl = options.fetchImpl ?? fetch
  const instantiate = options.instantiate ?? WebAssembly.instantiate

  return (imports: WebAssembly.Imports, successCallback: InstantiateSuccessCallback) => {
    void fetchImpl(options.wasmUrl)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`WASM load failed: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`)
        }
        const bytes = await response.arrayBuffer()
        return instantiate(bytes, imports)
      })
      .then((source) => successCallback(source.instance))
    return {}
  }
}

export async function prepareZXingReader(): Promise<void> {
  if (!zxingReady) {
    zxingReady = prepareZXingReaderOnce().catch((err) => {
      zxingReady = null
      throw err
    })
  }
  await zxingReady
}

async function prepareZXingReaderOnce(): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    await prepareZXingModule({
      fireImmediately: true,
      overrides: {
        locateFile: (fileName: string) => chrome.runtime.getURL(fileName),
        instantiateWasm: createWasmInstantiateOverride({
          wasmUrl: chrome.runtime.getURL('zxing_reader.wasm'),
        }),
      },
    })
    return
  }

  await prepareZXingModule({ fireImmediately: true })
}

export function resetZXingReaderForTests(): void {
  zxingReady = null
  purgeZXingModule()
}

export async function decodeQrFromImageData(input: PixelImageData, profile: DecodeProfile): Promise<string> {
  await prepareZXingReader()
  const attempts = profile === 'fast' ? [input] : robustImageVariants(input)
  const errors: string[] = []

  for (const candidate of attempts) {
    const result = await tryDecode(candidate, profile)
    if (result.ok) return result.text
    errors.push(result.error)
  }

  throw new Error(errors.find(Boolean) || '未识别到二维码')
}

async function tryDecode(input: PixelImageData, profile: DecodeProfile): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const results = await readBarcodes(toImageDataLike(input) as ImageData, readerOptions(profile) as any)
    const first = results[0]
    if (first?.isValid && first.text) return { ok: true, text: first.text }
    return { ok: false, error: first?.error || '未识别到二维码' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function readerOptions(profile: DecodeProfile) {
  const base = {
    formats: ['QRCode'],
    maxNumberOfSymbols: 1,
  }
  if (profile === 'fast') {
    return {
      ...base,
      tryHarder: false,
      tryRotate: false,
      tryInvert: false,
      tryDownscale: false,
      tryDenoise: false,
    }
  }
  return {
    ...base,
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    tryDenoise: true,
    binarizer: 'LocalAverage',
  }
}

function robustImageVariants(input: PixelImageData): PixelImageData[] {
  const variants: PixelImageData[] = [input]
  const padded = padImage(input, Math.max(12, Math.round(Math.min(input.width, input.height) * 0.1)))
  variants.push(padded)
  variants.push(adjustContrast(padded, 1.35))

  const minSide = Math.min(input.width, input.height)
  if (minSide < 220) variants.push(scaleNearest(padded, 2))
  if (minSide > 320) variants.push(scaleNearest(padded, 0.75))

  return variants
}

function toImageDataLike(input: PixelImageData): PixelImageData {
  return {
    width: input.width,
    height: input.height,
    data: input.data instanceof Uint8ClampedArray ? input.data : new Uint8ClampedArray(input.data),
  }
}

function padImage(input: PixelImageData, padding: number): PixelImageData {
  const source = toImageDataLike(input)
  const width = source.width + padding * 2
  const height = source.height + padding * 2
  const data = new Uint8ClampedArray(width * height * 4)
  data.fill(255)
  for (let offset = 3; offset < data.length; offset += 4) data[offset] = 255

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const src = (y * source.width + x) * 4
      const dest = ((y + padding) * width + x + padding) * 4
      data[dest] = source.data[src]
      data[dest + 1] = source.data[src + 1]
      data[dest + 2] = source.data[src + 2]
      data[dest + 3] = source.data[src + 3] || 255
    }
  }

  return { width, height, data }
}

function adjustContrast(input: PixelImageData, factor: number): PixelImageData {
  const source = toImageDataLike(input)
  const data = new Uint8ClampedArray(source.data.length)
  for (let offset = 0; offset < source.data.length; offset += 4) {
    data[offset] = contrastChannel(source.data[offset], factor)
    data[offset + 1] = contrastChannel(source.data[offset + 1], factor)
    data[offset + 2] = contrastChannel(source.data[offset + 2], factor)
    data[offset + 3] = source.data[offset + 3] || 255
  }
  return { width: source.width, height: source.height, data }
}

function contrastChannel(value: number, factor: number): number {
  return Math.max(0, Math.min(255, Math.round((value - 128) * factor + 128)))
}

function scaleNearest(input: PixelImageData, factor: number): PixelImageData {
  const source = toImageDataLike(input)
  const width = Math.max(1, Math.round(source.width * factor))
  const height = Math.max(1, Math.round(source.height * factor))
  const data = new Uint8ClampedArray(width * height * 4)

  for (let y = 0; y < height; y += 1) {
    const srcY = Math.min(source.height - 1, Math.floor(y / factor))
    for (let x = 0; x < width; x += 1) {
      const srcX = Math.min(source.width - 1, Math.floor(x / factor))
      const src = (srcY * source.width + srcX) * 4
      const dest = (y * width + x) * 4
      data[dest] = source.data[src]
      data[dest + 1] = source.data[src + 1]
      data[dest + 2] = source.data[src + 2]
      data[dest + 3] = source.data[src + 3] || 255
    }
  }

  return { width, height, data }
}
