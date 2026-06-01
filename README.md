# BoltQR

Fast, local-first QR decoding browser extension for QR download flows.

BoltQR focuses on a low-friction flow:

1. Right-click an image in Chrome/Edge.
2. Decode QR locally with `zxing-wasm`.
3. Extract high-recall password candidates from the current page.
4. Send candidates to a localhost helper protocol for archive extraction tools.

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

## Helper protocol

See:

```txt
docs/smart-extract-helper-protocol.md
```

A protocol conformance harness lives in `scripts/test-utils/` and runs as part of `pnpm test`. Third-party local helpers can reuse `scripts/test-utils/helper-conformance.test.ts` as a checklist for compatibility — see the "Conformance harness" section in the protocol doc.

## CI

GitHub Actions runs install, `pnpm build`, `pnpm build:extension`, and `pnpm test` on Node 22 + pnpm via `.github/workflows/ci.yml`.

## Fixture corpus

Generate realistic password-page fixtures:

```bash
pnpm fixtures
```

Fixture docs:

```txt
docs/p0-settings-and-fixtures.md
```
