export type ImageFormat = 'png' | 'jpg' | 'webp'

export type PayloadSize = 'short' | 'medium' | 'long'

export type PreprocessMode = 'original' | 'max-512' | 'max-1024'

export type SampleSpec = {
  id: string
  format: ImageFormat
  size: number
  payloadSize: PayloadSize
  payloadBytes: number
  payload: string
  url: string
}

export type DecodeInput = {
  sample: SampleSpec
  blob: Blob
  bitmap: ImageBitmap
  imageData: ImageData
}

export type DecodeResult = {
  ok: boolean
  text?: string
  error?: string
  raw?: unknown
}

export type DecoderId = 'native-barcode-detector' | 'zxing-wasm' | 'jsqr'

export type Decoder = {
  id: DecoderId
  label: string
  isAvailable(): Promise<boolean>
  init(): Promise<void>
  decode(input: DecodeInput): Promise<DecodeResult>
}

export type StageTiming = {
  fetchBlobMs: number
  createImageBitmapMs: number
  drawToCanvasMs: number
  getImageDataMs: number
  decodeMs: number
  totalMs: number
}

export type BenchmarkCaseResult = {
  decoderId: DecoderId
  sampleId: string
  format: ImageFormat
  size: number
  payloadBytes: number
  payloadSize: PayloadSize
  preprocessMode: PreprocessMode
  iteration: number
  cold: boolean
  success: boolean
  textMatches: boolean
  timing: StageTiming
  error?: string
}

export type ColdInitMeasurement = {
  decoderId: DecoderId
  initMs: number
  firstDecodeMs: number
  ok: boolean
  error?: string
}

export type BenchmarkSummary = {
  userAgent: string
  timestamp: string
  barcodeDetectorAvailable: boolean
  coldInit: ColdInitMeasurement[]
  results: BenchmarkCaseResult[]
}
