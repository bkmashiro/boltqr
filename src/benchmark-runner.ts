import { jsQrDecoder } from './decoders/jsqr'
import { nativeBarcodeDetectorDecoder } from './decoders/native-barcode-detector'
import { zxingWasmDecoder } from './decoders/zxing-wasm'
import { prepareImage, releaseInput } from './image-pipeline'
import { generateSamples } from './sample-generator'
import type {
  BenchmarkCaseResult,
  BenchmarkSummary,
  ColdInitMeasurement,
  Decoder,
  PreprocessMode,
  SampleSpec,
} from './types'

const ALL_DECODERS: Decoder[] = [
  nativeBarcodeDetectorDecoder,
  zxingWasmDecoder,
  jsQrDecoder,
]

const PREPROCESS_MODES: PreprocessMode[] = ['original', 'max-512', 'max-1024']

export type RunOptions = {
  iterations?: number
  onProgress?: (msg: string) => void
}

async function nextFrame() {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 0)
  })
}

async function measureColdInit(decoder: Decoder, sample: SampleSpec): Promise<ColdInitMeasurement> {
  try {
    const t0 = performance.now()
    await decoder.init()
    const t1 = performance.now()
    const { input } = await prepareImage(sample, 'original')
    const t2 = performance.now()
    const result = await decoder.decode(input)
    const t3 = performance.now()
    releaseInput(input)
    return {
      decoderId: decoder.id,
      initMs: t1 - t0,
      firstDecodeMs: t3 - t2,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
    }
  } catch (err) {
    return {
      decoderId: decoder.id,
      initMs: 0,
      firstDecodeMs: 0,
      ok: false,
      error: (err as Error).message,
    }
  }
}

async function runCase(
  decoder: Decoder,
  sample: SampleSpec,
  mode: PreprocessMode,
  iteration: number,
  cold: boolean,
): Promise<BenchmarkCaseResult> {
  const prepStart = performance.now()
  const { input, timing: prep } = await prepareImage(sample, mode)
  const decodeStart = performance.now()
  const result = await decoder.decode(input)
  const decodeEnd = performance.now()
  releaseInput(input)
  const totalMs = decodeEnd - prepStart
  return {
    decoderId: decoder.id,
    sampleId: sample.id,
    format: sample.format,
    size: sample.size,
    payloadBytes: sample.payloadBytes,
    payloadSize: sample.payloadSize,
    preprocessMode: mode,
    iteration,
    cold,
    success: result.ok,
    textMatches: result.ok && result.text === sample.payload,
    timing: {
      ...prep,
      decodeMs: decodeEnd - decodeStart,
      totalMs,
    },
    error: result.error,
  }
}

export async function runBenchmark(options: RunOptions = {}): Promise<BenchmarkSummary> {
  const iterations = options.iterations ?? 10
  const progress = options.onProgress ?? (() => {})
  progress('Generating samples...')
  const samples = await generateSamples()
  progress(`Generated ${samples.length} samples`)

  const nativeAvailable = await nativeBarcodeDetectorDecoder.isAvailable()
  progress(`BarcodeDetector available: ${nativeAvailable}`)

  const activeDecoders: Decoder[] = []
  for (const d of ALL_DECODERS) {
    if (await d.isAvailable()) activeDecoders.push(d)
  }

  // Cold init using a deterministic moderate sample
  const coldSample = samples.find((s) => s.id === 'png-256-short') ?? samples[0]
  const coldInit: ColdInitMeasurement[] = []
  for (const d of activeDecoders) {
    progress(`Cold init: ${d.label}`)
    coldInit.push(await measureColdInit(d, coldSample))
    await nextFrame()
  }

  const results: BenchmarkCaseResult[] = []
  const totalCases = activeDecoders.length * samples.length * PREPROCESS_MODES.length * iterations
  let done = 0

  for (const decoder of activeDecoders) {
    // ensure warm
    try {
      await decoder.init()
    } catch (err) {
      progress(`Init failed for ${decoder.label}: ${(err as Error).message}`)
      continue
    }
    // warmup pass: one decode per sample/mode without recording
    for (const sample of samples) {
      try {
        const { input } = await prepareImage(sample, 'original')
        await decoder.decode(input)
        releaseInput(input)
      } catch {}
    }

    for (const sample of samples) {
      for (const mode of PREPROCESS_MODES) {
        for (let i = 0; i < iterations; i++) {
          const r = await runCase(decoder, sample, mode, i, false)
          results.push(r)
          done++
        }
        if (done % 30 === 0) {
          progress(`${decoder.label}: ${done}/${totalCases}`)
          await nextFrame()
        }
      }
    }
    progress(`Finished ${decoder.label}`)
    await nextFrame()
  }

  // Release sample object URLs
  for (const s of samples) URL.revokeObjectURL(s.url)

  return {
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
    barcodeDetectorAvailable: nativeAvailable,
    coldInit,
    results,
  }
}
