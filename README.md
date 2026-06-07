# BoltQR

Fast, local-first QR decoding browser extension for QR download flows.

BoltQR focuses on fast, local-first QR recognition in Chrome/Edge:

1. Quietly auto-scan likely QR images on the current page.
2. Fall back to right-clicking an image and choosing `BoltQR: 识别此图片中的二维码`.
3. Decode locally with `zxing-wasm` and show a small in-page result toast.
4. Keep page/image data local by default; optional helper integrations are separate from the core QR path.

## Development

```bash
pnpm install
pnpm build
pnpm build:extension
pnpm test
pnpm bench
```

Load the unpacked extension from:

```txt
dist-extension/
```

Manual install from a release artifact:

1. Download `boltqr-<version>.zip` from the GitHub Actions artifact or GitHub Release.
2. Unzip it; the extracted folder should contain `manifest.json` at its root.
3. Open `chrome://extensions` or `edge://extensions`.
4. Enable Developer mode.
5. Click "Load unpacked" / "加载已解压的扩展程序" and select the extracted folder.

## Helper protocol

See:

```txt
docs/smart-extract-helper-protocol.md
```

A protocol conformance harness lives in `scripts/test-utils/` and runs as part of `pnpm test`. Third-party local helpers can reuse `scripts/test-utils/helper-conformance.test.ts` as a checklist for compatibility — see the "Conformance harness" section in the protocol doc.

## CI

GitHub Actions runs install, `pnpm build`, `pnpm build:extension`, and `pnpm test` on Node 22 + pnpm via `.github/workflows/ci.yml`.

## Fast auto-scan

The auto-scan path filters and queues likely QR images with strict performance guardrails before local decoding. See:

```txt
docs/fast-auto-scan.md
```

## Fixture corpus

Generate realistic password-page fixtures:

```bash
pnpm fixtures
```

Fixture docs:

```txt
docs/p0-settings-and-fixtures.md
```
