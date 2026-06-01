# BoltQR QR Decoder Benchmark Report

## Environment

- Date: 2026-06-01T09:08:07.948Z
- User agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/148.0.7778.96 Safari/537.36
- Native BarcodeDetector available: yes

## Methodology

- Formats: png, jpg, webp
- Sizes: 128, 256, 512, 1024
- Payload sizes: short (~20B), medium (~70B), long (~707B)
- Preprocess modes: original, max-512, max-1024
- Iterations per case: see results (warm decodes only)
- Samples generated locally as object URLs and reused across iterations

## Cold Init

| Decoder | Init ms | First decode ms | Success |
|---|---:|---:|---|
| native-barcode-detector | 0.00 | 525.30 | yes |
| zxing-wasm | 97.10 | 6.20 | yes |
| jsqr | 0.00 | 8.10 | yes |

## Results Summary

| Decoder | N | Median decode ms | P95 decode ms | Median total ms | Success rate | Text match rate |
|---|---:|---:|---:|---:|---:|---:|
| native-barcode-detector | 1080 | 6.50 | 11.70 | 7.50 | 91.7% | 91.7% |
| zxing-wasm | 1080 | 0.70 | 2.80 | 1.50 | 100.0% | 100.0% |
| jsqr | 1080 | 3.70 | 22.60 | 4.60 | 91.7% | 91.7% |

## Format Breakdown (original preprocess mode)

| Decoder | Format | Median decode ms | P95 decode ms | Success rate |
|---|---|---:|---:|---:|
| native-barcode-detector | png | 6.60 | 11.90 | 91.7% |
| native-barcode-detector | jpg | 6.50 | 12.00 | 91.7% |
| native-barcode-detector | webp | 6.60 | 12.20 | 91.7% |
| zxing-wasm | png | 0.70 | 2.70 | 100.0% |
| zxing-wasm | jpg | 0.70 | 3.00 | 100.0% |
| zxing-wasm | webp | 0.70 | 2.90 | 100.0% |
| jsqr | png | 3.80 | 23.00 | 91.7% |
| jsqr | jpg | 4.10 | 23.00 | 91.7% |
| jsqr | webp | 4.10 | 23.90 | 91.7% |

## Size Breakdown (original preprocess mode)

| Decoder | Size | Median decode ms | P95 decode ms | Success rate |
|---|---:|---:|---:|---:|
| native-barcode-detector | 128 | 5.60 | 6.60 | 66.7% |
| native-barcode-detector | 256 | 5.45 | 8.70 | 100.0% |
| native-barcode-detector | 512 | 6.65 | 10.70 | 100.0% |
| native-barcode-detector | 1024 | 9.60 | 12.40 | 100.0% |
| zxing-wasm | 128 | 0.20 | 0.80 | 100.0% |
| zxing-wasm | 256 | 0.30 | 0.80 | 100.0% |
| zxing-wasm | 512 | 0.80 | 1.20 | 100.0% |
| zxing-wasm | 1024 | 2.40 | 3.00 | 100.0% |
| jsqr | 128 | 0.75 | 4.20 | 66.7% |
| jsqr | 256 | 1.50 | 7.30 | 100.0% |
| jsqr | 512 | 4.00 | 13.20 | 100.0% |
| jsqr | 1024 | 12.90 | 25.30 | 100.0% |

## Preprocessing Breakdown

| Decoder | Preprocess mode | Median total ms | Median decode ms | Success rate |
|---|---|---:|---:|---:|
| native-barcode-detector | original | 7.60 | 6.60 | 91.7% |
| native-barcode-detector | max-512 | 7.40 | 6.40 | 91.7% |
| native-barcode-detector | max-1024 | 7.50 | 6.50 | 91.7% |
| zxing-wasm | original | 1.50 | 0.70 | 100.0% |
| zxing-wasm | max-512 | 1.50 | 0.70 | 100.0% |
| zxing-wasm | max-1024 | 1.50 | 0.70 | 100.0% |
| jsqr | original | 4.80 | 4.00 | 91.7% |
| jsqr | max-512 | 4.60 | 3.60 | 91.7% |
| jsqr | max-1024 | 4.60 | 3.70 | 91.7% |

## Recommendation

1. **Use zxing-wasm (reader build) as the primary decoder.** In this run it was both the fastest decoder *and* the most robust, including on high-density QR payloads where native and jsQR returned no detection. Pay its one-time ~90ms WASM init at extension startup, then enjoy sub-millisecond warm decodes.
2. Keep **native `BarcodeDetector`** wired as a zero-bundle option for environments where shipping WASM is undesirable (constrained MV3 contexts, off-main-thread service workers without WASM loaders). It is reliable for standard QR sizes but in this run it failed entirely on the size-128 / long-payload sample.
3. Skip **jsQR**. Its median decode is slower than zxing-wasm on every size class measured, its P95 is ~10x worse at size 1024, and it loses the same edge cases native does.

Fastest decoder in this run: **zxing-wasm** (median 0.70ms). Most robust: **zxing-wasm** (100.0%).

## Caveats

- Run was inside headless Chromium via Playwright; real Chrome may differ slightly.
- Samples are pristine machine-generated QR codes, not photos, so success rates do not reflect real-world camera input.
- The ~91.7% / 66.7% success-rate floors are explained by one failing sample family: the 707-byte payload renders into a high-version QR whose modules are sub-pixel at size 128, so both native `BarcodeDetector` and jsQR refuse to decode it. zxing-wasm still recovers it. This is an honest worst-case, not a bug.
- Object URLs eliminate network and cache effects; extension fetches from web pages may be slower.
- `tryHarder`/`tryRotate`/`tryInvert` are off for zxing-wasm to optimize for clean known input; relaxing them costs decode time but improves recall on bad inputs.
- Native `BarcodeDetector` first-call latency was 525.30ms in this run (likely lazy backend init in headless Chromium). Subsequent decodes are much faster, but treat first-decode latency as a real cost on a fresh extension service worker.