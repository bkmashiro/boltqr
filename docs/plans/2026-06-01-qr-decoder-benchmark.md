# BoltQR QR Decoder Benchmark Implementation Plan

> **For Claude Code:** Implement this plan exactly. Keep the work under `/Users/yuzhe/projects/boltqr`. This is a benchmark spike only: do not build the browser extension yet.

**Goal:** Build a reproducible browser-side benchmark comparing QR decoding pipelines for PNG/JPG/WebP images, with emphasis on ultra-fast extension use cases.

**Architecture:** Create a small Vite + TypeScript benchmark app that runs in Chromium. It will generate or load deterministic QR image samples in PNG/JPG/WebP, then benchmark native `BarcodeDetector`, `zxing-wasm`, and `jsQR` across cold start, warm decode, batch decode, and image preprocessing costs. Results should be emitted both in the browser UI and as downloadable JSON/CSV so the user can decide the final decoder stack.

**Tech Stack:** TypeScript, Vite, browser APIs, `qrcode`, `zxing-wasm`, `jsqr`, optional Playwright for automated benchmark runs.

---

## Non-goals

- Do not build the final Chrome extension yet.
- Do not implement overlays, popup UI, content scripts, or manifest configuration beyond benchmark needs.
- Do not use paid/commercial QR SDKs.
- Do not send images or QR contents to a server.
- Do not optimize prematurely before measuring.

---

## Benchmark Questions

The benchmark must answer:

1. Is native `BarcodeDetector` available in the target browser?
2. How expensive is each decoder's cold start?
3. How fast is a single warm decode for PNG/JPG/WebP?
4. How fast is batch decode for 10/50/100 images?
5. How much time is spent in image fetch/load, `createImageBitmap`, canvas draw, `getImageData`, and actual QR decode?
6. Does downscaling improve or hurt decode speed/reliability?
7. Which pipeline should BoltQR use by default?

---

## Expected Final Deliverables

At the end, `/Users/yuzhe/projects/boltqr` should contain:

```txt
/Users/yuzhe/projects/boltqr/
  package.json
  pnpm-lock.yaml
  index.html
  src/
    main.ts
    styles.css
    types.ts
    sample-generator.ts
    image-pipeline.ts
    benchmark-runner.ts
    decoders/
      native-barcode-detector.ts
      zxing-wasm.ts
      jsqr.ts
    report.ts
  public/
    samples/
      generated manifest and sample images
  scripts/
    run-bench.ts or run-bench.mjs
  docs/
    benchmark-report.md
    plans/
      2026-06-01-qr-decoder-benchmark.md
```

The final response should include:

- Exact commands run.
- Whether native `BarcodeDetector` was available.
- A summary table of measured results.
- Recommendation for BoltQR's decoder pipeline.
- Any blockers or caveats.

---

## Task 1: Initialize the Project

**Objective:** Create a clean Vite + TypeScript project in `/Users/yuzhe/projects/boltqr`.

**Files:**
- Create: `package.json`
- Create: `index.html`
- Create: `src/main.ts`
- Create: `src/styles.css`
- Create: `tsconfig.json`
- Create: `vite.config.ts`

**Step 1: Check current directory state**

Run:

```bash
cd /Users/yuzhe/projects/boltqr
find . -maxdepth 3 -type f | sort
```

Expected: either only this plan exists, or existing files are clearly unrelated. Do not delete user files without checking.

**Step 2: Initialize package**

Run:

```bash
cd /Users/yuzhe/projects/boltqr
pnpm init
```

If `pnpm init` is interactive or inconvenient, manually create `package.json`.

**Step 3: Install dependencies**

Run:

```bash
cd /Users/yuzhe/projects/boltqr
pnpm add -D vite typescript playwright @types/node
pnpm add qrcode zxing-wasm jsqr
```

**Step 4: Configure scripts**

`package.json` should include:

```json
{
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "build": "tsc --noEmit && vite build",
    "bench": "playwright install chromium >/dev/null 2>&1 || true; node scripts/run-bench.mjs"
  }
}
```

**Step 5: Verify**

Run:

```bash
cd /Users/yuzhe/projects/boltqr
pnpm build
```

Expected: build succeeds, even if app only renders a placeholder.

---

## Task 2: Define Benchmark Types

**Objective:** Create shared types for samples, decoders, timings, and reports.

**Files:**
- Create: `src/types.ts`

**Implementation:**

```ts
export type ImageFormat = 'png' | 'jpg' | 'webp'

export type SampleSpec = {
  id: string
  format: ImageFormat
  size: number
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

export type Decoder = {
  id: 'native-barcode-detector' | 'zxing-wasm' | 'jsqr'
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
  decoderId: Decoder['id']
  sampleId: string
  format: ImageFormat
  size: number
  payloadBytes: number
  iteration: number
  cold: boolean
  success: boolean
  textMatches: boolean
  timing: StageTiming
  error?: string
}

export type BenchmarkSummary = {
  userAgent: string
  timestamp: string
  barcodeDetectorAvailable: boolean
  results: BenchmarkCaseResult[]
}
```

**Verification:**

Run:

```bash
cd /Users/yuzhe/projects/boltqr
pnpm build
```

Expected: TypeScript passes.

---

## Task 3: Generate Deterministic PNG/JPG/WebP Samples

**Objective:** Generate local QR samples in all required formats without relying on network images.

**Files:**
- Create: `src/sample-generator.ts`
- Create or modify: `src/main.ts`

**Requirements:**

Generate combinations of:

- formats: `png`, `jpg`, `webp`
- sizes: `128`, `256`, `512`, `1024`
- payload sizes: short, medium, long

Suggested payloads:

```ts
const payloads = {
  short: 'https://example.com/a',
  medium: 'https://example.com/orders/1234567890?token=boltqr-medium-payload',
  long: 'BOLTQR:' + 'x'.repeat(700),
}
```

**Implementation notes:**

Use package `qrcode` to render QR to canvas, then export via:

```ts
canvas.toBlob(resolve, mimeType, quality)
```

For JPG, use white background before drawing QR because JPEG has no alpha.

Return object URLs for browser benchmark.

**Expected function:**

```ts
export async function generateSamples(): Promise<SampleSpec[]> {
  // returns generated samples with object URLs
}
```

**Verification:**

The page should show a list of generated sample IDs like:

```txt
png-128-short
jpg-128-short
webp-128-short
...
```

Run:

```bash
cd /Users/yuzhe/projects/boltqr
pnpm dev
```

Open the local URL and visually confirm samples are generated or listed.

---

## Task 4: Implement Image Preprocessing Pipeline

**Objective:** Measure image preparation separately from decode time.

**Files:**
- Create: `src/image-pipeline.ts`

**Implementation:**

Create:

```ts
export async function prepareImage(sample: SampleSpec): Promise<{
  input: DecodeInput
  timing: Omit<StageTiming, 'decodeMs' | 'totalMs'>
}> {
  // fetch object URL -> Blob
  // createImageBitmap(blob)
  // draw to OffscreenCanvas if available, otherwise HTMLCanvasElement
  // get ImageData
}
```

Use `performance.now()` around every stage:

- fetchBlobMs
- createImageBitmapMs
- drawToCanvasMs
- getImageDataMs

**Important:**

- If `OffscreenCanvas` is available, use it.
- Otherwise use regular canvas.
- Keep the original QR size for baseline. Downscaling is a separate later task.

**Verification:**

Log one sample's timing in the UI.

Expected: all timing fields are finite non-negative numbers.

---

## Task 5: Implement Native BarcodeDetector Decoder

**Objective:** Add native browser fast path.

**Files:**
- Create: `src/decoders/native-barcode-detector.ts`

**Implementation:**

```ts
import type { DecodeInput, DecodeResult, Decoder } from '../types'

export const nativeBarcodeDetectorDecoder: Decoder = {
  id: 'native-barcode-detector',
  label: 'Native BarcodeDetector',
  async isAvailable() {
    return 'BarcodeDetector' in globalThis
  },
  async init() {},
  async decode(input: DecodeInput): Promise<DecodeResult> {
    if (!('BarcodeDetector' in globalThis)) {
      return { ok: false, error: 'BarcodeDetector unavailable' }
    }
    const Detector = (globalThis as any).BarcodeDetector
    const detector = new Detector({ formats: ['qr_code'] })
    const results = await detector.detect(input.bitmap)
    const first = results?.[0]
    return first?.rawValue
      ? { ok: true, text: first.rawValue, raw: first }
      : { ok: false, error: 'No QR detected' }
  },
}
```

**Verification:**

Run benchmark for one sample. If unavailable, the UI must say unavailable instead of failing.

---

## Task 6: Implement zxing-wasm Decoder

**Objective:** Add the main WASM candidate decoder.

**Files:**
- Create: `src/decoders/zxing-wasm.ts`

**Implementation guidance:**

Use `zxing-wasm/reader` if possible to avoid writer code.

Look up the actual current API from installed package types if needed:

```bash
cd /Users/yuzhe/projects/boltqr
find node_modules/zxing-wasm -maxdepth 4 -type f | sort | head -80
```

Likely shape is around `readBarcodes` or similar. Use package types/source as truth.

Decoder contract:

```ts
export const zxingWasmDecoder: Decoder = {
  id: 'zxing-wasm',
  label: 'ZXing WASM',
  async isAvailable() {
    return true
  },
  async init() {
    // import and warm module here
  },
  async decode(input) {
    // decode QRCode only if API supports format hints
  },
}
```

**Important benchmark detail:**

- `init()` must include dynamic import / WASM initialization cost.
- Decode timing should exclude `init()` for warm runs.
- Cold benchmark should measure first `init() + decode` separately.

**Verification:**

At least PNG 256 short payload decodes correctly.

Run:

```bash
cd /Users/yuzhe/projects/boltqr
pnpm build
```

Expected: TypeScript passes.

---

## Task 7: Implement jsQR Decoder Baseline

**Objective:** Add pure JS baseline decoder.

**Files:**
- Create: `src/decoders/jsqr.ts`

**Implementation:**

```ts
import jsQR from 'jsqr'
import type { Decoder } from '../types'

export const jsQrDecoder: Decoder = {
  id: 'jsqr',
  label: 'jsQR',
  async isAvailable() {
    return true
  },
  async init() {},
  async decode(input) {
    const code = jsQR(input.imageData.data, input.imageData.width, input.imageData.height)
    return code?.data
      ? { ok: true, text: code.data, raw: code }
      : { ok: false, error: 'No QR detected' }
  },
}
```

**Verification:**

Decode one PNG sample successfully.

---

## Task 8: Build Benchmark Runner

**Objective:** Run repeatable benchmark cases with warmup, iterations, and summary collection.

**Files:**
- Create: `src/benchmark-runner.ts`
- Modify: `src/main.ts`

**Benchmark matrix:**

- decoders: native, zxing-wasm, jsQR
- formats: png, jpg, webp
- sizes: 128, 256, 512, 1024
- payloads: short, medium, long
- iterations: 10 warm iterations per case
- cold: 1 cold measurement per decoder

**Implementation requirements:**

- Skip unavailable decoders.
- Run one decoder at a time.
- Run samples sequentially first for stable measurements.
- Use `await new Promise(requestAnimationFrame)` or short idle gap between large groups so UI does not freeze permanently.
- Validate decoded text equals expected payload.
- Capture errors per case; do not crash entire run.

**Expected exported function:**

```ts
export async function runBenchmark(options?: {
  iterations?: number
  onProgress?: (message: string) => void
}): Promise<BenchmarkSummary>
```

**Timing shape:**

For each case:

```ts
const prepStart = performance.now()
const { input, timing: prepTiming } = await prepareImage(sample)
const decodeStart = performance.now()
const result = await decoder.decode(input)
const decodeMs = performance.now() - decodeStart
const totalMs = performance.now() - prepStart
```

**Verification:**

UI button `Run benchmark` should populate a result table.

---

## Task 9: Add Optional Downscale Experiment

**Objective:** Determine whether downscaling large images helps.

**Files:**
- Modify: `src/image-pipeline.ts`
- Modify: `src/benchmark-runner.ts`
- Modify: `src/types.ts`

**Requirement:**

Add preprocessing modes:

```ts
export type PreprocessMode = 'original' | 'max-512' | 'max-1024'
```

For each image, optionally scale down preserving aspect ratio before `getImageData`.

Benchmark at least:

- original
- max-512
- max-1024

Add mode to result rows.

**Important:**

Do not downscale images smaller than the max dimension.

**Verification:**

Results table must show preprocess mode.

---

## Task 10: Report Export

**Objective:** Save benchmark outputs in useful formats.

**Files:**
- Create: `src/report.ts`
- Modify: `src/main.ts`

**Requirements:**

UI should provide:

- Download JSON
- Download CSV
- Copy markdown summary

CSV columns:

```txt
decoderId,sampleId,format,size,payloadBytes,preprocessMode,iteration,cold,success,textMatches,fetchBlobMs,createImageBitmapMs,drawToCanvasMs,getImageDataMs,decodeMs,totalMs,error
```

Markdown summary should group by decoder and show median / p95 decode time and total time.

Implement helper functions:

```ts
export function toCsv(summary: BenchmarkSummary): string
export function toMarkdown(summary: BenchmarkSummary): string
export function percentile(values: number[], p: number): number
export function median(values: number[]): number
```

**Verification:**

Clicking export buttons downloads or copies valid data.

---

## Task 11: Automated Chromium Run with Playwright

**Objective:** Allow Claude Code to run the benchmark and collect real results without manual browser interaction.

**Files:**
- Create: `scripts/run-bench.mjs`
- Modify: `src/main.ts`

**Browser app requirement:**

Expose a global function for automation:

```ts
declare global {
  interface Window {
    runBoltQrBenchmark?: () => Promise<BenchmarkSummary>
  }
}

window.runBoltQrBenchmark = () => runBenchmark({ iterations: 10 })
```

**Playwright script behavior:**

1. Start Vite preview or dev server.
2. Open Chromium.
3. Navigate to local app.
4. Evaluate `window.runBoltQrBenchmark()`.
5. Save outputs:
   - `docs/benchmark-results.json`
   - `docs/benchmark-results.csv`
   - `docs/benchmark-report.md`
6. Print concise summary to stdout.

Suggested implementation approach:

- Use Node `child_process.spawn` to start `pnpm dev -- --port 5173`.
- Wait until server responds.
- Use `playwright.chromium.launch({ headless: true })`.
- Use `page.evaluate(() => window.runBoltQrBenchmark!())`.
- Close browser and server in `finally`.

**Verification:**

Run:

```bash
cd /Users/yuzhe/projects/boltqr
pnpm bench
```

Expected:

- Exit code 0.
- JSON, CSV, and MD report files are created under `docs/`.
- Console prints a summary table.

---

## Task 12: Write Final Benchmark Report

**Objective:** Produce a human-readable recommendation for BoltQR.

**Files:**
- Create or overwrite: `docs/benchmark-report.md`

**Report structure:**

```md
# BoltQR QR Decoder Benchmark Report

## Environment

- Date:
- Browser user agent:
- OS:
- Native BarcodeDetector available: yes/no

## Methodology

- Sample formats:
- Sample sizes:
- Payload sizes:
- Iterations:
- Preprocess modes:

## Results Summary

| Decoder | Availability | Median decode | P95 decode | Median total | Success rate |
|---|---:|---:|---:|---:|---:|

## Format Breakdown

| Decoder | Format | Median decode | P95 decode | Success rate |
|---|---|---:|---:|---:|

## Preprocessing Breakdown

| Decoder | Preprocess mode | Median total | Success rate |
|---|---|---:|---:|

## Recommendation

State the recommended BoltQR pipeline, likely:

1. Native BarcodeDetector if available.
2. zxing-wasm reader fallback.
3. Only use jsQR if measurements show it is faster for small clean QR images.

## Caveats

- Headless Chromium may differ from normal Chrome.
- Object URLs avoid network/cache effects.
- Real extension host permissions and cross-origin image fetches need separate testing.
```

**Verification:**

Open `docs/benchmark-report.md` and confirm it contains real measured values, not placeholders.

---

## Task 13: Final Verification Commands

**Objective:** Prove the benchmark works end to end.

Run all:

```bash
cd /Users/yuzhe/projects/boltqr
pnpm build
pnpm bench
ls -lah docs/benchmark-results.json docs/benchmark-results.csv docs/benchmark-report.md
```

Expected:

- `pnpm build` succeeds.
- `pnpm bench` succeeds.
- Result files exist and are non-empty.

---

## Implementation Notes for Claude Code

### zxing-wasm API discovery

Do not guess the API. Inspect installed package files:

```bash
cd /Users/yuzhe/projects/boltqr
find node_modules/zxing-wasm -maxdepth 4 -type f | sort
sed -n '1,200p' node_modules/zxing-wasm/dist/es/reader/index.d.ts
```

Use the type definitions as source of truth.

### Native BarcodeDetector typing

TypeScript may not know `BarcodeDetector`. Use a small local type or `(globalThis as any).BarcodeDetector`.

### JPEG generation

Before exporting JPEG, draw a white background:

```ts
ctx.fillStyle = '#fff'
ctx.fillRect(0, 0, size, size)
```

### Benchmark fairness

- Separate image preparation time from decode time.
- Reuse generated sample object URLs.
- Run at least one warmup before recording warm iterations if needed.
- Report failures honestly.

### Performance API

Use `performance.now()`, not `Date.now()`.

### Commit suggestion

Use small signed commits if committing:

```bash
git add package.json pnpm-lock.yaml index.html src scripts docs
 git commit -S -m "bench: add QR decoder benchmark spike"
```

Only commit if this directory is a git repo and the working tree is clean enough.

---

## Acceptance Criteria

This task is complete when:

- `/Users/yuzhe/projects/boltqr` has a working Vite benchmark app.
- `pnpm build` passes.
- `pnpm bench` runs a real Chromium benchmark.
- `docs/benchmark-results.json` exists.
- `docs/benchmark-results.csv` exists.
- `docs/benchmark-report.md` contains real measured results and a recommendation.
- The final answer reports the actual measured winner and caveats.
