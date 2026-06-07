import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import QRCode from 'qrcode'

const FIXTURE_QR_TEXT = 'https://example.com/manual-download.zip'
const DIST_EXTENSION = path.resolve(process.cwd(), 'dist-extension')
const QR_IMAGE_PATH = '/manual-qr.png'
const FIXTURE_PATH = '/manual-scan-extension-load-fixture.html'

const SERVICE_WORKER_TIMEOUT_MS = 25_000
const TOAST_TIMEOUT_MS = 45_000
const DOM_READY_TIMEOUT_MS = 12_000

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

async function waitForExtensionTarget(context, timeoutMs) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const serviceWorkers = await resolveTargetList(context.serviceWorkers?.())
    for (const worker of serviceWorkers) {
      const url = targetUrl(worker)
      if (url?.startsWith('chrome-extension://')) {
        return { target: worker, url, extensionId: extractExtensionIdFromUrl(url) }
      }
    }

    const backgroundPages = await resolveTargetList(context.backgroundPages?.())
    for (const page of backgroundPages) {
      const url = targetUrl(page)
      if (url?.startsWith('chrome-extension://')) {
        return { target: page, url, extensionId: extractExtensionIdFromUrl(url) }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  return null
}

function makeHtmlFixture(imageUrl) {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>BoltQR manual scan smoke fixture</title>
        <style>
          body { font-family: ui-sans-serif, system-ui; padding: 20px; }
          img { display: block; width: 180px; height: 180px; }
        </style>
      </head>
      <body>
        <h1>Manual Scan Extension Smoke</h1>
        <p>QR text: ${FIXTURE_QR_TEXT}</p>
        <img
          id="manual-target"
          src="${imageUrl}"
          width="180"
          height="180"
          alt="profile avatar icon"
          class="avatar icon"
        />
      </body>
    </html>
  `
}

function createFixtureServer({ imageUrl }) {
  const html = makeHtmlFixture(imageUrl)
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const headers = { 'cache-control': 'no-store, no-cache, must-revalidate, max-age=0' }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(404)
      res.end('not found')
      return
    }

    if (url.pathname === FIXTURE_PATH) {
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
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
        qrUrl: imageUrl,
      })
    })
  })
}

function createImageFixtureServer({ qrImageBuffer }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const headers = { 'cache-control': 'no-store, no-cache, must-revalidate, max-age=0' }
    if (url.pathname === QR_IMAGE_PATH) {
      res.writeHead(200, { ...headers, 'content-type': 'image/png', 'content-length': qrImageBuffer.length })
      res.end(qrImageBuffer)
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
        reject(new Error('Failed to bind image fixture server'))
        return
      }
      resolve({
        server,
        port: address.port,
        close: () => new Promise((done, fail) => {
          server.close((err) => (err ? fail(err) : done()))
        }),
        qrUrl: `http://127.0.0.1:${address.port}${QR_IMAGE_PATH}`,
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
    inlineText: document.getElementById('boltqr-inline-marker')?.title || null,
    imageCount: document.images.length,
    images: Array.from(document.images).map((img) => ({
      id: img.id,
      src: img.getAttribute('src'),
      currentSrc: img.currentSrc,
      width: img.width,
      height: img.height,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      alt: img.alt,
      className: img.className,
    })),
    title: document.title,
    url: location.href,
  }))
  throw new Error(`${label} timed out. state=${JSON.stringify({ label, state })}`)
}

async function sendManualScanFromExtension(extensionTarget, srcUrl, pageUrl) {
  return extensionTarget.target.evaluate(async ({ imageUrl, pageUrl }) => {
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find((candidate) => candidate.url === pageUrl) || tabs.find((candidate) => candidate.active)
    const tabId = tab?.id
    if (!tabId) throw new Error(`No tab for manual scan smoke; tabs=${JSON.stringify(tabs.map(({ id, url, active }) => ({ id, url, active })))}`)
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'boltqr:manual-scan-selected-image',
      srcUrl: imageUrl,
    })
    return { response, tabs: tabs.map(({ id, url, active }) => ({ id, url, active })), selectedTabId: tabId }
  }, { imageUrl: srcUrl, pageUrl })
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

  const userDataDir = await mkdtemp(path.join(tmpdir(), 'boltqr-manual-scan-smoke-'))
  const qrImageBuffer = await QRCode.toBuffer(FIXTURE_QR_TEXT, {
    width: 180,
    margin: 1,
    errorCorrectionLevel: 'M',
  })
  const imageFixture = await createImageFixtureServer({ qrImageBuffer })
  const fixture = await createFixtureServer({ imageUrl: imageFixture.qrUrl })

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST_EXTENSION}`, `--load-extension=${DIST_EXTENSION}`],
  })

  const page = await context.newPage()

  try {
    const extensionTarget = await waitForExtensionTarget(context, SERVICE_WORKER_TIMEOUT_MS)
    if (!extensionTarget) throw new Error('Extension target did not appear for manual scan smoke')
    if (!extensionTarget.extensionId) {
      console.error(`Extension loaded but could not parse extension id from URL: ${extensionTarget.url}`)
    }

    await extensionTarget.target.evaluate(() => chrome.storage.local.set({
      smartExtractEnabled: false,
      smartExtractManualOnly: true,
    }))

    await page.goto(fixture.url, { waitUntil: 'networkidle' })
    await page.bringToFront()

    await pollUntil(
      page,
      'content script did not set dataset flag',
      DOM_READY_TIMEOUT_MS,
      () => page.evaluate(() => document.documentElement.dataset.boltqrAutoScanStarted === '1'),
    )

    await page.evaluate(() => {
      for (const img of Array.from(document.images)) img.dispatchEvent(new Event('load'))
    })
    await page.waitForTimeout(1_200)
    const autoToastText = await page.evaluate(() => document.getElementById('boltqr-toast')?.textContent || '')
    if (autoToastText.includes(FIXTURE_QR_TEXT)) {
      throw new Error(`Manual-only fixture was decoded by auto-scan before manual trigger: ${autoToastText}`)
    }

    const manualResult = await sendManualScanFromExtension(extensionTarget, fixture.qrUrl, fixture.url)
    if (manualResult?.response && manualResult.response.ok === false) {
      throw new Error(`Manual scan message failed: ${JSON.stringify(manualResult)}`)
    }

    await pollUntil(
      page,
      `manual scan local marker did not show fixture QR text (${FIXTURE_QR_TEXT})`,
      TOAST_TIMEOUT_MS,
      () =>
        page.evaluate((expected) => {
          const marker = document.getElementById('boltqr-inline-marker')
          return !!marker && marker.parentElement !== document.documentElement && ((marker.getAttribute('title') || '').includes(expected) || (document.getElementById('boltqr-toast')?.textContent || '').includes(expected))
        }, FIXTURE_QR_TEXT),
    )

    const scanDebug = await extensionTarget.target.evaluate(() => chrome.storage.local.get('boltqrLastScanDebug'))
    if (scanDebug?.boltqrLastScanDebug?.phase !== 'visible-tab-screenshot') {
      throw new Error(`Manual scan did not use screenshot fallback for cross-origin image: ${JSON.stringify(scanDebug)}`)
    }

    console.log('manual-scan mv3 extension load smoke passed')
  } finally {
    await page?.close().catch(() => {})
    await context.close().catch(() => {})
    await fixture.close().catch(() => {})
    await imageFixture.close().catch(() => {})
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
