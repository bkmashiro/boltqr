import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import QRCode from 'qrcode'

const FIXTURE_QR_TEXT = 'https://example.com/downloads/archive.zip'
const DIST_EXTENSION = path.resolve(process.cwd(), 'dist-extension')
const QR_IMAGE_PATH = '/qr.png'
const NOISE_IMAGE_PATH = '/noise.png'
const FIXTURE_PATH = '/auto-scan-extension-load-fixture.html'

const SERVICE_WORKER_TIMEOUT_MS = 25_000
const TOAST_TIMEOUT_MS = 45_000
const DOM_READY_TIMEOUT_MS = 12_000

const NOISE_PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/7nC9y0AAAAASUVORK5CYII=',
  'base64',
)

function extractExtensionIdFromUrl(url) {
  const match = /^chrome-extension:\/\/([a-z]{32})\//i.exec(url || '')
  return match?.[1] ?? null
}

function targetUrl(target) {
  if (!target) return null
  if (typeof target.url === 'function') return target.url()
  if (typeof target.url === 'string') return target.url
  return null
}

async function resolveTargetList(value) {
  if (!value) return []
  const result = typeof value?.then === 'function' ? await value : value
  return Array.isArray(result) ? result : []
}

async function findExtensionTargets(context) {
  const targets = []
  const serviceWorkers = await resolveTargetList(context.serviceWorkers?.())
  for (const worker of serviceWorkers) {
    const url = targetUrl(worker)
    if (url) targets.push({ type: 'serviceWorker', url })
  }

  const backgroundPages = await resolveTargetList(context.backgroundPages?.())
  for (const page of backgroundPages) {
    const url = targetUrl(page)
    if (url) targets.push({ type: 'backgroundPage', url })
  }

  return targets
}

async function waitForExtensionTarget(context, timeoutMs) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const targets = await findExtensionTargets(context)
    const extensionTarget = targets.find(({ url }) => typeof url === 'string' && url.startsWith('chrome-extension://'))

    if (extensionTarget) {
      return {
        ...extensionTarget,
        extensionId: extractExtensionIdFromUrl(extensionTarget.url),
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  return null
}

function makeHtmlFixture() {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>BoltQR MV3 extension load smoke fixture</title>
        <style>
          body { font-family: ui-sans-serif, system-ui; padding: 20px; }
          .row { display: flex; gap: 16px; align-items: center; }
          img { display: block; }
        </style>
      </head>
      <body>
        <h1>Auto Scan Extension Smoke</h1>
        <p>QR text: ${FIXTURE_QR_TEXT}</p>
        <div class="row">
          <img
            id="qr-image"
            src="${QR_IMAGE_PATH}"
            width="180"
            height="180"
            alt="微信 扫码 下载 二维码"
          />
          <img
            id="noise-image"
            src="${NOISE_IMAGE_PATH}"
            width="36"
            height="36"
            alt="noise icon"
            class="avatar"
          />
        </div>
      </body>
    </html>
  `
}

function createFixtureServer({ qrImageBuffer, noiseImageBuffer }) {
  const html = makeHtmlFixture()
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const headers = { 'cache-control': 'no-store, no-cache, must-revalidate, max-age=0' }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(404)
      res.end('not found')
      return
    }

    if (url.pathname === '/auto-scan-extension-load-fixture.html') {
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    if (url.pathname === '/qr.png') {
      res.writeHead(200, { ...headers, 'content-type': 'image/png', 'content-length': qrImageBuffer.length })
      res.end(qrImageBuffer)
      return
    }

    if (url.pathname === '/noise.png') {
      res.writeHead(200, { ...headers, 'content-type': 'image/png', 'content-length': noiseImageBuffer.length })
      res.end(noiseImageBuffer)
      return
    }

    res.writeHead(404, headers)
    res.end('not found')
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string' || !address.port) {
        reject(new Error('Failed to bind fixture server'))
        return
      }
      resolve({
        server,
        port: address.port,
        close: () => new Promise((done, fail) => {
          server.close((err) => (err ? fail(err) : done()))
        }),
        url: `http://127.0.0.1:${address.port}${FIXTURE_PATH}`,
      })
    })
  })
}

async function pollUntil(page, label, timeoutMs, evaluator) {
  const endAt = Date.now() + timeoutMs

  while (Date.now() < endAt) {
    const ok = await evaluator()
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  const state = await page.evaluate(() => ({
    started: document.documentElement.dataset.boltqrAutoScanStarted,
    toastText: document.getElementById('boltqr-toast')?.textContent || null,
    inlineText: document.getElementById('boltqr-inline-result')?.shadowRoot?.textContent || null,
    imageCount: document.images.length,
    images: Array.from(document.images).map((img) => ({
      id: img.id,
      src: img.getAttribute('src'),
      width: img.width,
      height: img.height,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    })),
    title: document.title,
    url: location.href,
  }))
  throw new Error(`${label} timed out. state=${JSON.stringify({ label, state })}`)
}

async function main() {
  if (!existsSync(DIST_EXTENSION)) {
    throw new Error(`dist-extension not found at ${DIST_EXTENSION}. Please run: pnpm build:extension`)
  }

  try {
    await access(path.resolve(DIST_EXTENSION, 'manifest.json'))
  } catch {
    throw new Error('dist-extension/manifest.json is missing. Please run: pnpm build:extension')
  }

  const userDataDir = await mkdtemp(path.join(tmpdir(), 'boltqr-extension-load-smoke-'))
  const qrImageBuffer = await QRCode.toBuffer(FIXTURE_QR_TEXT, {
    width: 180,
    margin: 1,
    errorCorrectionLevel: 'M',
  })
  const fixture = await createFixtureServer({
    qrImageBuffer,
    noiseImageBuffer: NOISE_PNG_1X1,
  })

  const context = await chromium.launchPersistentContext(userDataDir, {
    // Playwright's default headless shell does not expose Chrome extensions.
    // The `chromium` channel uses Chromium's new headless mode, which supports MV3 extension loading.
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST_EXTENSION}`, `--load-extension=${DIST_EXTENSION}`],
  })

  const page = await context.newPage()

  try {
    const extensionTarget = await waitForExtensionTarget(context, SERVICE_WORKER_TIMEOUT_MS)
    if (!extensionTarget) {
      const sws = await resolveTargetList(context.serviceWorkers?.())
      const bgs = await resolveTargetList(context.backgroundPages?.())
      throw new Error(
        JSON.stringify({
          message: 'Extension target did not appear after loading fixture',
          serviceWorkers: sws.map((worker) => targetUrl(worker)).filter(Boolean),
          backgroundPages: bgs.map((pageRef) => targetUrl(pageRef)).filter(Boolean),
        }),
      )
    }
    if (!extensionTarget.extensionId) {
      console.error(`Extension loaded but could not parse extension id from URL: ${extensionTarget.url}`)
    }

    const serviceWorker = (await resolveTargetList(context.serviceWorkers?.()))
      .find((worker) => targetUrl(worker) === extensionTarget.url)
    await serviceWorker?.evaluate(() => chrome.storage.local.set({
      smartExtractEnabled: false,
      smartExtractManualOnly: true,
    }))

    await page.goto(fixture.url, { waitUntil: 'networkidle' })

    await pollUntil(
      page,
      'content script did not set dataset flag',
      DOM_READY_TIMEOUT_MS,
      () => page.evaluate(() => document.documentElement.dataset.boltqrAutoScanStarted === '1'),
    )

    await page.evaluate(() => {
      for (const img of Array.from(document.images)) {
        img.dispatchEvent(new Event('load'))
      }
    })

    await pollUntil(
      page,
      `inline result did not show fixture QR text (${FIXTURE_QR_TEXT})`,
      TOAST_TIMEOUT_MS,
      () =>
        page.evaluate((expected) => {
          const inline = document.getElementById('boltqr-inline-result')
          return !!inline?.shadowRoot && (inline.shadowRoot.textContent || '').includes(expected)
        }, FIXTURE_QR_TEXT),
    )

    const inlineState = await page.evaluate((expected) => {
      const inline = document.getElementById('boltqr-inline-result')
      const text = inline?.shadowRoot?.textContent || ''
      const close = inline?.shadowRoot?.querySelector('[data-boltqr-result-action="close"]')
      close?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
      return { text, removed: !document.getElementById('boltqr-inline-result'), includesExpected: text.includes(expected) }
    }, FIXTURE_QR_TEXT)
    assert.equal(inlineState.includesExpected, true, `Expected inline result to include ${FIXTURE_QR_TEXT}, got: ${inlineState.text}`)
    assert.equal(inlineState.removed, true, 'Expected inline result close button to remove overlay')

    console.log('auto-scan mv3 extension load smoke passed')
  } finally {
    await page?.close().catch(() => {})
    await context.close().catch(() => {})
    await fixture.close().catch(() => {})
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
