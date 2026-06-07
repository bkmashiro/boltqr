import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import QRCode from 'qrcode'

const distExtension = resolve(process.cwd(), 'dist-extension')
const zxingReaderWasm = readFileSync(resolve(distExtension, 'zxing_reader.wasm'))
const qrTextValue = 'https://example.com/downloads/archive.zip'

const AUTO_SCAN_MAX_BATCH = 6
const AUTO_SCAN_MAX_CONCURRENCY = 2

const fixtureHtml = `
  <!doctype html>
  <html>
    <head><meta charset="utf-8" /><title>Auto Scan Fixture</title></head>
    <body>
      <h1>Auto Scan Fixture</h1>
      <img
        id="likely-qr"
        src="https://example.com/assets/download-qr.png"
        width="160"
        height="160"
        alt="微信 扫码 下载 二维码"
      />
      <img
        id="avatar"
        src="https://example.com/assets/user-avatar.png"
        width="64"
        height="64"
        class="avatar"
        alt="user avatar"
      />
      <img
        id="social"
        src="https://example.com/assets/twitter-social-icon.png"
        width="128"
        height="128"
        class="social-icon"
        alt="social icon"
      />
    </body>
  </html>
`

function makeNoisyAutoScanFixtureHtml({ qrCount = 12, noiseCount = 30 } = {}) {
  const images = []
  for (let index = 0; index < noiseCount; index += 1) {
    images.push(`
      <img
        id="noise-${index}"
        src="https://example.com/assets/noise-${index}.png"
        width="160"
        height="160"
        class="avatar logo"
        alt="site logo"
      />
    `)
  }

  for (let index = 0; index < qrCount; index += 1) {
    images.push(`
      <img
        id="candidate-qr-${index}"
        src="https://example.com/assets/qr-${index}.png"
        width="170"
        height="170"
        class="qr-card"
        alt="微信 扫码 下载 二维码"
      />
    `)
  }

  return `
    <!doctype html>
    <html>
      <head><meta charset="utf-8" /><title>Auto Scan Guardrail Fixture</title></head>
      <body>
        <h1>Auto Scan Guardrail Fixture</h1>
        ${images.join('\n')}
      </body>
    </html>
  `
}

function makeAutoScanFailureFixtureHtml() {
  return `
    <!doctype html>
    <html>
      <head><meta charset="utf-8" /><title>Auto Scan Failure Fixture</title></head>
      <body>
        <h1>Auto Scan Failure Fixture</h1>
        <img
          id="missing-qr"
          src="https://example.com/assets/missing-qr.png"
          width="170"
          height="170"
          style="display:block;width:170px;height:170px"
          class="qr-card"
          alt="微信 扫码 下载 二维码"
        />
      </body>
    </html>
  `
}

async function installChromeStub(page, options = {}) {
  const mockAutoScan = Boolean(options.mockAutoScan)
  const autoScanDelayMs = Math.max(0, Number(options.autoScanDelayMs ?? 40))
  const autoScanErrorText = options.autoScanErrorText || 'mock auto-scan failed'
  const storageValues = options.storageValues || {}

  await page.evaluate(({ mockAutoScan, autoScanDelayMs, autoScanErrorText, storageValues }) => {
    const sentMessages = []
    const showResultMessages = []
    const installedHandlers = []
    const contextMenuCalls = []
    const contextMenuClickHandlers = []
    const runtimeMessageListeners = []

    const autoScanStats = {
      autoScanMessages: 0,
      autoScanResponses: 0,
      autoScanInFlight: 0,
      autoScanMaxInFlight: 0,
      autoScanDelayMs,
      autoScanErrorText,
      mockAutoScan,
    }

    function makeSendResponsePromise() {
      let resolved = false
      let value
      let resolveFn = () => {}
      const promise = new Promise((resolve) => {
        resolveFn = (next) => {
          resolved = true
          value = next
          resolve(next)
        }
      })
      return {
        get: () => (resolved ? value : undefined),
        promise,
        fn: resolveFn,
        isDone: () => resolved,
      }
    }

    async function dispatchRuntimeMessage(message, sender) {
      for (const listener of runtimeMessageListeners) {
        const responseHolder = makeSendResponsePromise()
        let directResult

        try {
          directResult = listener(message, sender, responseHolder.fn)
          if (directResult && typeof directResult.then === 'function') {
            directResult = await directResult
          }
        } catch {
          directResult = undefined
        }

        if (directResult === true) {
          const timeout = new Promise((resolve) => {
            setTimeout(() => {
              resolve(responseHolder.get())
            }, 3000)
          })
          return Promise.race([responseHolder.promise, timeout])
        }

        if (responseHolder.isDone()) {
          return responseHolder.get()
        }

        if (directResult !== undefined) {
          return directResult
        }
      }
      return undefined
    }

    async function mockAutoScanResponse(message, callback) {
      autoScanStats.autoScanMessages += 1
      autoScanStats.autoScanInFlight += 1
      autoScanStats.autoScanMaxInFlight = Math.max(autoScanStats.autoScanMaxInFlight, autoScanStats.autoScanInFlight)
      const response = await new Promise((resolve) => {
        setTimeout(() => {
          resolve({ ok: false, error: autoScanErrorText })
        }, autoScanDelayMs)
      })
      autoScanStats.autoScanInFlight -= 1
      autoScanStats.autoScanResponses += 1
      if (typeof callback === 'function') callback(response)
      return response
    }

    function installGlobals() {
      window.__boltqrAutoScanMessages = sentMessages
      window.__boltqrShowResultMessages = showResultMessages
      window.__boltqrContextMenuCalls = contextMenuCalls
      window.__boltqrContextMenuClickHandlers = contextMenuClickHandlers
      window.__boltqrInstalledHandlers = installedHandlers
      window.__boltqrAutoScanStats = autoScanStats

      window.chrome = {
        runtime: {
          onMessage: {
            addListener: (handler) => {
              runtimeMessageListeners.push(handler)
            },
          },
          onInstalled: {
            addListener: (handler) => {
              installedHandlers.push(handler)
              setTimeout(() => handler({ reason: 'install' }), 0)
            },
          },
          sendMessage: async (message, callback) => {
            sentMessages.push(message)

            if (message?.type === 'boltqr:auto-scan-image' && mockAutoScan) {
              const response = await mockAutoScanResponse(message, callback)
              return response
            }

            const response = await dispatchRuntimeMessage(message, {
              tab: {
                id: 1,
                url: window.location.href,
              },
            })
            if (typeof callback === 'function') callback(response)
            return response
          },
          getURL: (asset) => `https://example.com/assets/${asset}`,
        },
        contextMenus: {
          create: (opts) => {
            contextMenuCalls.push(opts)
          },
          onClicked: {
            addListener: (handler) => {
              contextMenuClickHandlers.push(handler)
            },
          },
        },
        storage: {
          local: {
            get: async () => ({
              smartExtractEnabled: true,
              smartExtractManualOnly: false,
              ...storageValues,
            }),
          },
        },
        tabs: {
          sendMessage: async (_tabId, message) => {
            const response = await dispatchRuntimeMessage(message, {
              tab: {
                id: _tabId,
              },
            })
            if (message?.type === 'boltqr:show-result' || message?.type === 'boltqr:decode-error') {
              showResultMessages.push(message)
            }
            return response
          },
        },
      }
    }

    installGlobals()
  }, { mockAutoScan, autoScanDelayMs, autoScanErrorText, storageValues })
}

async function makeQrPngBuffer() {
  const dataUrl = await QRCode.toDataURL(qrTextValue, {
    width: 160,
    margin: 1,
    errorCorrectionLevel: 'M',
  })
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

async function launchFixturePage({ fixtureContent = fixtureHtml, chromeStubOptions = {}, failedImagePathPattern = null } = {}) {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const qrPng = await makeQrPngBuffer()
  await context.route('https://example.com/assets/*', async (route) => {
    const url = new URL(route.request().url())
    const pathname = url.pathname

    if (failedImagePathPattern && failedImagePathPattern.test(pathname)) {
      await route.fulfill({
        status: 404,
        contentType: 'text/plain',
        body: 'not found',
      })
      return
    }

    if (pathname.endsWith('.png')) {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: qrPng,
      })
      return
    }

    if (pathname.endsWith('zxing_reader.wasm')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/wasm',
        body: zxingReaderWasm,
      })
      return
    }

    await route.abort()
  })
  const page = await context.newPage()

  await page.setContent(fixtureContent, { waitUntil: 'load' })
  await installChromeStub(page, chromeStubOptions)
  await page.addScriptTag({ path: `${distExtension}/background.js` })
  await page.addScriptTag({ path: `${distExtension}/content.js` })

  return { browser, context, page }
}

async function closeFixture(fixture) {
  await fixture.context.close()
  await fixture.browser.close()
}

async function waitFor(page, condition, failureLabel) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const hasMessage = await page.evaluate(condition)
    if (hasMessage) return
    await page.waitForTimeout(100)
  }

  const debugState = await page.evaluate(() => ({
    started: document.documentElement.dataset.boltqrAutoScanStarted,
    autoScanMessages: window.__boltqrAutoScanMessages,
    showResultMessages: window.__boltqrShowResultMessages,
    contextMenus: window.__boltqrContextMenuCalls,
    images: Array.from(document.images).map((img) => ({
      id: img.id,
      src: img.currentSrc || img.src,
      width: img.getBoundingClientRect().width,
      height: img.getBoundingClientRect().height,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    })),
  }))
  throw new Error(`Timed out waiting for ${failureLabel}: ${JSON.stringify(debugState)}`)
}

async function waitForAutoScanMessage(page) {
  await waitFor(
    page,
    () => window.__boltqrAutoScanMessages?.some((msg) => msg?.type === 'boltqr:auto-scan-image') === true,
    'auto-scan message',
  )
}

async function waitForAutoScanResult(page) {
  await waitFor(
    page,
    () => window.__boltqrShowResultMessages?.some((msg) => msg?.type === 'boltqr:show-result') === true,
    'show-result message',
  )
}

async function waitForAutoScanMessageBatchSettled(page) {
  const deadline = Date.now() + 12_000
  let stableCount = -1
  let stableSince = 0

  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      autoScanMessages: window.__boltqrAutoScanMessages || [],
      autoScanStats: window.__boltqrAutoScanStats || {},
    }))

    const totalMessages = state.autoScanMessages.length
    if (totalMessages > 0 && state.autoScanStats.autoScanInFlight === 0) {
      if (totalMessages === stableCount) {
        if (!stableSince) stableSince = Date.now()
        if (Date.now() - stableSince >= 400) {
          return state
        }
      } else {
        stableCount = totalMessages
        stableSince = Date.now()
      }
    }

    await page.waitForTimeout(100)
  }

  const state = await page.evaluate(() => ({
    autoScanMessages: window.__boltqrAutoScanMessages || [],
    autoScanStats: window.__boltqrAutoScanStats || {},
    toastText: document.getElementById('boltqr-toast')?.textContent || '',
  }))
  throw new Error(`Timed out waiting for auto-scan batch settle: ${JSON.stringify(state)}`)
}

async function testAutoScanDispatchesAndShowResult() {
  const fixture = await launchFixturePage()
  try {
    await waitForAutoScanMessage(fixture.page)
    await waitForAutoScanResult(fixture.page)

    const messages = await fixture.page.evaluate(() => window.__boltqrAutoScanMessages)
    assert.deepEqual(messages, [
      {
        type: 'boltqr:auto-scan-image',
        srcUrl: 'https://example.com/assets/download-qr.png',
      },
    ])

    const showResultMessages = await fixture.page.evaluate(() => window.__boltqrShowResultMessages)
    assert.equal(showResultMessages.length, 1)

    const showResult = showResultMessages[0]
    assert.equal(showResult.type, 'boltqr:show-result')
    assert.equal(showResult.bundle?.qrText, qrTextValue)
    assert.equal(showResult.bundle?.qrUrl, qrTextValue)
    assert.ok(showResult.ingest && typeof showResult.ingest === 'object', 'background should include ingest summary')
    assert.equal(showResult.ingest?.helperEndpoint, 'http://127.0.0.1:17321')
    assert.ok('ok' in showResult.ingest)

    const contextMenuCalls = await fixture.page.evaluate(() => window.__boltqrContextMenuCalls)
    assert.ok(
      contextMenuCalls.some((entry) => entry?.id === 'boltqr-scan-image'),
      'background script should still register the manual context-menu entry',
    )
  } finally {
    await closeFixture(fixture)
  }
}

async function testContextMenuClickScansImage() {
  const fixture = await launchFixturePage()
  try {
    await fixture.page.evaluate(() => {
      window.__boltqrAutoScanMessages.length = 0
      window.__boltqrShowResultMessages.length = 0
      for (const handler of window.__boltqrContextMenuClickHandlers) {
        handler(
          {
            menuItemId: 'boltqr-scan-image',
            srcUrl: 'https://example.com/assets/download-qr.png',
          },
          { id: 1, url: window.location.href },
        )
      }
    })

    await waitForAutoScanResult(fixture.page)
    const showResultMessages = await fixture.page.evaluate(() => window.__boltqrShowResultMessages)
    assert.ok(showResultMessages.length >= 1)
    const showResult = showResultMessages[showResultMessages.length - 1]
    assert.equal(showResult?.type, 'boltqr:show-result')
    assert.equal(showResult?.bundle?.qrText, qrTextValue)
    assert.equal(showResult?.bundle?.qrUrl, qrTextValue)
  } finally {
    await closeFixture(fixture)
  }
}

async function testAutoScanDedupesAfterDomMutation() {
  const fixture = await launchFixturePage()
  try {
    await waitForAutoScanMessage(fixture.page)

    await fixture.page.evaluate(() => {
      const img = document.createElement('img')
      img.id = 'likely-qr'
      img.src = 'https://example.com/assets/download-qr.png'
      img.width = 160
      img.height = 160
      img.alt = '微信 扫码 下载 二维码'
      document.body.appendChild(img)
    })

    await fixture.page.waitForTimeout(1_200)

    const messages = await fixture.page.evaluate(() => window.__boltqrAutoScanMessages)
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.type, 'boltqr:auto-scan-image')
    assert.equal(messages[0]?.srcUrl, 'https://example.com/assets/download-qr.png')
  } finally {
    await closeFixture(fixture)
  }
}

async function testAutoScanBatchAndRuntimeGuardrails() {
  const fixture = await launchFixturePage({
    fixtureContent: makeNoisyAutoScanFixtureHtml({ qrCount: 12, noiseCount: 30 }),
    chromeStubOptions: {
      mockAutoScan: true,
      autoScanDelayMs: 120,
      autoScanErrorText: 'mock decode failure',
    },
  })

  try {
    await waitForAutoScanMessage(fixture.page)
    const settled = await waitForAutoScanMessageBatchSettled(fixture.page)

    const autoScanMessages = settled.autoScanMessages.filter((entry) => entry?.type === 'boltqr:auto-scan-image')
    const seenUrls = new Set(autoScanMessages.map((entry) => entry.srcUrl))

    assert.equal(autoScanMessages.length, AUTO_SCAN_MAX_BATCH)
    assert.equal(seenUrls.size, AUTO_SCAN_MAX_BATCH)
    assert.ok(
      autoScanMessages.every((entry) => /\/qr-\d+\.png$/.test(entry.srcUrl || '')),
      'all dispatched auto-scan images should be QR-ish candidates',
    )
    assert.equal(settled.autoScanStats.autoScanMaxInFlight <= AUTO_SCAN_MAX_CONCURRENCY, true)
    assert.equal(settled.autoScanStats.autoScanResponses, AUTO_SCAN_MAX_BATCH)

    const toastState = await fixture.page.evaluate(() => ({
      showResultMessages: window.__boltqrShowResultMessages,
      toastText: document.getElementById('boltqr-toast')?.textContent || '',
    }))

    assert.equal(
      toastState.showResultMessages.some((msg) => msg?.type === 'boltqr:decode-error' || msg?.type === 'boltqr:show-result'),
      false,
      'auto-scan failures should not trigger UI decode toast/result messages',
    )
    assert.ok(
      !/未识别到二维码|识别失败|decode|decode-error/i.test(toastState.toastText || ''),
      'auto-scan failure should keep the page unobtrusive',
    )
  } finally {
    await closeFixture(fixture)
  }
}

async function testAutoScanFailureStaysSilentThroughBackgroundPath() {
  const fixture = await launchFixturePage({
    fixtureContent: makeAutoScanFailureFixtureHtml(),
    failedImagePathPattern: /\/missing-qr\.png$/,
  })

  try {
    await waitForAutoScanMessage(fixture.page)
    await fixture.page.waitForTimeout(1_200)

    const state = await fixture.page.evaluate(() => ({
      autoScanMessages: window.__boltqrAutoScanMessages,
      showResultMessages: window.__boltqrShowResultMessages,
      toastText: document.getElementById('boltqr-toast')?.textContent || '',
    }))
    const autoMessages = state.autoScanMessages.filter((entry) => entry?.type === 'boltqr:auto-scan-image')
    assert.equal(autoMessages.length, 1)
    assert.equal(autoMessages[0]?.srcUrl, 'https://example.com/assets/missing-qr.png')
    assert.equal(
      state.showResultMessages.some((msg) => msg?.type === 'boltqr:decode-error' || msg?.type === 'boltqr:show-result'),
      false,
      'real background auto-scan failures should not send UI decode/result messages',
    )
    assert.equal(state.toastText, '')
  } finally {
    await closeFixture(fixture)
  }
}

async function testCandidateSearchCanDisablePageTextExtraction() {
  const fixture = await launchFixturePage({
    chromeStubOptions: {
      storageValues: {
        smartExtractCandidateSearchEnabled: false,
      },
    },
  })
  try {
    await waitForAutoScanMessage(fixture.page)
    await waitForAutoScanResult(fixture.page)

    const showResultMessages = await fixture.page.evaluate(() => window.__boltqrShowResultMessages)
    const showResult = showResultMessages[showResultMessages.length - 1]
    assert.equal(showResult?.type, 'boltqr:show-result')
    assert.equal(showResult?.bundle?.qrText, qrTextValue)
    assert.equal(showResult?.bundle?.qrUrl, qrTextValue)
    assert.deepEqual(showResult?.bundle?.candidates, [])
  } finally {
    await closeFixture(fixture)
  }
}

async function testInlineOverlayStaysAttachedToImageWhenScrolledOffscreen() {
  const fixture = await launchFixturePage({
    fixtureContent: `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Inline Overlay Scroll Fixture</title>
          <style>
            body { margin: 0; min-height: 2400px; }
            .spacer { height: 1200px; }
            #likely-qr { display: block; width: 160px; height: 160px; margin: 0 0 0 40px; }
          </style>
        </head>
        <body>
          <div class="spacer"></div>
          <img
            id="likely-qr"
            src="https://example.com/assets/download-qr.png"
            width="160"
            height="160"
            alt="微信 扫码 下载 二维码"
          />
        </body>
      </html>
    `,
  })
  try {
    await fixture.page.setViewportSize({ width: 800, height: 600 })
    await fixture.page.evaluate(() => window.scrollTo(0, 1050))
    await waitForAutoScanMessage(fixture.page)
    await waitForAutoScanResult(fixture.page)

    await fixture.page.evaluate(() => window.scrollTo(0, 1410))
    await fixture.page.waitForTimeout(100)

    const state = await fixture.page.evaluate(() => {
      const image = document.getElementById('likely-qr')
      const host = document.getElementById('boltqr-inline-result')
      const pin = host?.shadowRoot?.querySelector('[part="pin"]')
      const scrim = host?.shadowRoot?.querySelector('[part="scrim"]')
      const imageRect = image?.getBoundingClientRect()
      const hostRect = host?.getBoundingClientRect()
      const pinRect = pin?.getBoundingClientRect()
      const scrimRect = scrim?.getBoundingClientRect()
      return {
        image: imageRect && { left: imageRect.left, top: imageRect.top, width: imageRect.width, height: imageRect.height },
        host: hostRect && { left: hostRect.left, top: hostRect.top, width: hostRect.width, height: hostRect.height },
        pin: pinRect && { left: pinRect.left, top: pinRect.top, width: pinRect.width, height: pinRect.height },
        scrim: scrimRect && { left: scrimRect.left, top: scrimRect.top, width: scrimRect.width, height: scrimRect.height },
      }
    })

    assert.ok(state.image, 'fixture image should exist')
    assert.ok(state.host, 'inline overlay host should exist')
    assert.ok(state.pin, 'inline overlay pin should exist')
    assert.ok(state.scrim, 'inline overlay scrim should exist')
    assert.ok(state.image.top < 0, `image should be scrolled partly offscreen: ${JSON.stringify(state.image)}`)
    assert.ok(state.pin.top < 0, `pin should scroll with the image instead of clamping to viewport: ${JSON.stringify(state)}`)
    assert.equal(Math.round(state.host.top), Math.round(state.image.top))
    assert.equal(Math.round(state.host.left), Math.round(state.image.left))
    assert.equal(Math.round(state.scrim.top), Math.round(state.image.top))
    assert.equal(Math.round(state.scrim.left), Math.round(state.image.left))
  } finally {
    await closeFixture(fixture)
  }
}

await testAutoScanDispatchesAndShowResult()
await testContextMenuClickScansImage()
await testAutoScanDedupesAfterDomMutation()
await testCandidateSearchCanDisablePageTextExtraction()
await testInlineOverlayStaysAttachedToImageWhenScrolledOffscreen()
await testAutoScanBatchAndRuntimeGuardrails()
await testAutoScanFailureStaysSilentThroughBackgroundPath()
console.log('auto-scan extension smoke passed')
