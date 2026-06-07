# BoltQR Fast Auto-Scan Strategy

BoltQR's auto-scan path is designed to feel instant without sweeping every asset on the page.

## What it scans

The content script builds lightweight descriptors for page images and sends only the best candidates to the background decoder.

Signals that increase priority:

- square-ish rendered and natural dimensions
- QR-related filename/alt/id/class hints (`qr`, `qrcode`, `scan`, `二维码`, `扫码`, `微信`)
- supported local-decodable formats: PNG, JPEG, WebP
- moderate QR-like size, roughly 96–768 px on the shortest side

Signals that reject or lower priority:

- hidden images or zero-size layout boxes
- tiny icons / favicons
- logos, avatars, social icons, profile portraits
- unsupported file extensions
- huge hero/banner/photo-like images
- extremely wide/tall assets

## Guardrails

- The planner is pure and cheap: no network, no decoding, no DOM traversal inside scoring.
- Initial scan runs after `document_idle` via `requestIdleCallback` when available.
- Late images are handled through a batched `MutationObserver`, not a tight loop.
- Only near-viewport images are decoded immediately; `IntersectionObserver` queues offscreen candidates when they approach the viewport.
- Each image cache key is attempted once unless URL/currentSrc/id/size changes.
- Background decode concurrency is limited by the content-side queue.
- Decode remains local via `zxing-wasm`; no page content or image data is uploaded.

## Manual mode

Right-click image recognition remains the explicit fallback and bypasses auto-scan filtering. Manual recognition still posts candidates to the helper when helper reporting is enabled, even if settings are configured as "manual only".

## Helper reporting

Auto-scan can decode and show results locally. If settings enable "manual only" reporting, auto-scan skips POSTing candidates to the local helper while preserving manual reporting.
