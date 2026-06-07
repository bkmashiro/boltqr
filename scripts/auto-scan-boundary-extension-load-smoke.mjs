import { createServer } from 'node:http'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import QRCode from 'qrcode'

const FIXTURE_QR_TEXT = 'https://example.com/dynamic-boundary.zip'
const DIST_EXTENSION = path.resolve(process.cwd(), 'dist-extension')
const NOISE_IMAGE_PATH = '/noise.png'
const DYNAMIC_QR_PATH = '/dynamic-qr.png'
const FIXTURE_PATH = '/auto-scan-boundary-extension-load-fixture.html'

const SERVICE_WORKER_TIMEOUT_MS = 25_000
const TOAST_TIMEOUT_MS = 45_000
const DOM_READY_TIMEOUT_MS = 12_000
const NO_TOAST_TIMEOUT_MS = 5_000

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
    if (url) targets.push({ type: 'serviceWorker', url, ref: worker })
  }

  const backgroundPages = await resolveTargetList(context.backgroundPages?.())
  for (const page of backgroundPages) {
    const url = targetUrl(page)
    if (url) targets.push({ type: 'backgroundPage', url, ref: page })
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
        <title>BoltQR MV3 boundary extension load smoke fixture</title>
        <style>
          body { font-family: ui-sans-serif, system-ui; padding: 20px; }
          .row { display: flex; gap: 16px; align-items: center; margin-top: 12px; }
          img { display: block; }
        </style>
      </head>
      <body>
        <h1>Auto Scan Boundary Extension Smoke</h1>
        <p>Noisy image prelude. Dynamic QR should be injected later.</p>
        <div class="row">
          <img
            src="${NOISE_IMAGE_PATH}"
            width="24"
            height="24"
            alt="site logo"
            class="avatar logo"
          />
          <img
            src="${NOISE_IMAGE_PATH}"
            width="32"
            height="32"
            alt="social icon"
            class="social"
          />
          <img
            src="${NOISE_IMAGE_PATH}"
            width="40"
            height="40"
            alt="user avatar"
            class="profile-avatar"
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

    if (url.pathname === FIXTURE_PATH) {
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    if (url.pathname === NOISE_IMAGE_PATH) {
      res.writeHead(200, { ...headers, 'content-type': 'image/png', 'content-length': noiseImageBuffer.length })
      res.end(noiseImageBuffer)
      return
    }

    if (url.pathname === DYNAMIC_QR_PATH) {
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
        dynamicQrUrl: `http://127.0.0.1:${address.port}${DYNAMIC_QR_PATH}`,
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

async function assertNoToastContains(page, forbiddenText, timeoutMs) {
  const endAt = Date.now() + timeoutMs
  while (Date.now() < endAt) {
    const hasForbidden = await page.evaluate((value) => {
      const toast = document.getElementById('boltqr-toast')
      return !!toast && (toast.textContent || '').includes(value)
    }, forbiddenText)
    if (hasForbidden) {
      const current = await page.$eval('#boltqr-toast', (el) => el?.textContent || '')
      throw new Error(`Unexpected toast already contained dynamic QR text: ${current}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
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

  const userDataDir = await mkdtemp(path.join(tmpdir(), 'boltqr-boundary-auto-scan-smoke-'))
  const dynamicQrImageBuffer = await QRCode.toBuffer(FIXTURE_QR_TEXT, {
    width: 180,
    margin: 1,
    errorCorrectionLevel: 'M',
  })
  const fixture = await createFixtureServer({
    qrImageBuffer: dynamicQrImageBuffer,
    noiseImageBuffer: NOISE_PNG_1X1,
  })

  const context = await chromium.launchPersistentContext(userDataDir, {
    // Playwright's default headless mode does not expose extension support.
    // The `chromium` channel uses Chromium's new headless mode, which supports MV3 extension loading.
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST_EXTENSION}`, `--load-extension=${DIST_EXTENSION}`],
  })

  const page = await context.newPage()

  try {
    const extensionTarget = await waitForExtensionTarget(context, SERVICE_WORKER_TIMEOUT_MS)
    if (!extensionTarget) {
      const workers = await resolveTargetList(context.serviceWorkers?.())
      const bgs = await resolveTargetList(context.backgroundPages?.())
      throw new Error(
        JSON.stringify({
          message: 'Extension target did not appear after loading fixture',
          serviceWorkers: workers.map((worker) => targetUrl(worker)).filter(Boolean),
          backgroundPages: bgs.map((bg) => targetUrl(bg)).filter(Boolean),
        }),
      )
    }
    if (!extensionTarget.extensionId) {
      console.error(`Extension loaded but could not parse extension id from URL: ${extensionTarget.url}`)
    }

    await extensionTarget.ref.evaluate(() => chrome.storage.local.set({
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

    await assertNoToastContains(page, FIXTURE_QR_TEXT, NO_TOAST_TIMEOUT_MS)

    await page.evaluate((url) => {
      const img = document.createElement('img')
      img.id = 'dynamic-boundary-qr'
      img.src = url
      img.width = 180
      img.height = 180
      img.alt = '二维码 扫码 下载'
      img.loading = 'eager'
      document.body.appendChild(img)
    }, fixture.dynamicQrUrl)

    await pollUntil(
      page,
      `local marker did not show dynamic QR text (${FIXTURE_QR_TEXT})`,
      TOAST_TIMEOUT_MS,
      () =>
        page.evaluate((expected) => {
          const marker = document.getElementById('boltqr-inline-marker')
          return !!marker && marker.parentElement !== document.documentElement && ((marker.getAttribute('title') || '').includes(expected) || (document.getElementById('boltqr-toast')?.textContent || '').includes(expected))
        }, FIXTURE_QR_TEXT),
    )

    const inlineText = await page.evaluate(() => document.getElementById('boltqr-inline-marker')?.title || '')
    if (!inlineText.includes(FIXTURE_QR_TEXT)) {
      throw new Error(`Expected local marker text to include ${FIXTURE_QR_TEXT}, got: ${inlineText}`)
    }

    console.log('auto-scan boundary mv3 smoke passed')
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
