import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import QRCode from 'qrcode'

const distExtension = resolve(process.cwd(), 'dist-extension')
const zxingReaderWasm = readFileSync(resolve(distExtension, 'zxing_reader.wasm'))
const qrTextValue = 'https://example.com/downloads/archive.zip'

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

async function installChromeStub(page) {
  await page.evaluate(() => {
    const sentMessages = []
    const showResultMessages = []
    const installedHandlers = []
    const contextMenuCalls = []
    const contextMenuClickHandlers = []
    const runtimeMessageListeners = []

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

    window.__boltqrAutoScanMessages = sentMessages
    window.__boltqrShowResultMessages = showResultMessages
    window.__boltqrContextMenuCalls = contextMenuCalls
    window.__boltqrContextMenuClickHandlers = contextMenuClickHandlers
    window.__boltqrInstalledHandlers = installedHandlers

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
  })
}

async function makeQrPngBuffer() {
  const dataUrl = await QRCode.toDataURL(qrTextValue, {
    width: 160,
    margin: 1,
    errorCorrectionLevel: 'M',
  })
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

async function launchFixturePage() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const qrPng = await makeQrPngBuffer()
  await context.route('https://example.com/assets/*', async (route) => {
    const url = new URL(route.request().url())
    const pathname = url.pathname

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

  await page.setContent(fixtureHtml, { waitUntil: 'load' })
  await installChromeStub(page)
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

await testAutoScanDispatchesAndShowResult()
await testContextMenuClickScansImage()
await testAutoScanDedupesAfterDomMutation()
console.log('auto-scan extension smoke passed')
