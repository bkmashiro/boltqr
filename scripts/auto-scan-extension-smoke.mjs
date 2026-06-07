import { chromium } from 'playwright'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import QRCode from 'qrcode'

const distExtension = resolve(process.cwd(), 'dist-extension')

const fixtureHtml = `
  <!doctype html>
  <html>
    <head><meta charset="utf-8" /><title>Auto Scan Fixture</title></head>
    <body>
      <h1>Auto Scan Smoke Fixture</h1>
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
    const installedHandlers = []
    const contextMenuCalls = []

    window.__boltqrAutoScanMessages = sentMessages
    window.__boltqrContextMenuCalls = contextMenuCalls
    window.__boltqrInstalledHandlers = installedHandlers

    window.chrome = {
      runtime: {
        onMessage: { addListener: () => undefined },
        onInstalled: {
          addListener: (handler) => {
            installedHandlers.push(handler)
            setTimeout(() => handler({ reason: 'install' }), 0)
          },
        },
        sendMessage: async (message) => {
          sentMessages.push(message)
          return { ok: true }
        },
        getURL: (asset) => `chrome-extension://test/${asset}`,
      },
      contextMenus: {
        create: (opts) => {
          contextMenuCalls.push(opts)
        },
        onClicked: { addListener: () => undefined },
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
        sendMessage: async () => ({ ok: true }),
      },
    }
  })
}

async function makeQrPngBuffer() {
  const dataUrl = await QRCode.toDataURL('https://example.com/downloads/archive.zip', {
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
  await context.route('https://example.com/assets/*.png', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: qrPng,
    })
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

async function waitForAutoScanMessage(page) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const hasMessage = await page.evaluate(() =>
      window.__boltqrAutoScanMessages?.some((msg) => msg?.type === 'boltqr:auto-scan-image') === true,
    )
    if (hasMessage) return
    await page.waitForTimeout(100)
  }

  const debugState = await page.evaluate(() => ({
    started: document.documentElement.dataset.boltqrAutoScanStarted,
    messages: window.__boltqrAutoScanMessages,
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
  throw new Error(`Timed out waiting for auto-scan message: ${JSON.stringify(debugState)}`)
}

async function testAutoScanDispatchesOnlySuspectedQr() {
  const fixture = await launchFixturePage()
  try {
    await waitForAutoScanMessage(fixture.page)

    const messages = await fixture.page.evaluate(() => window.__boltqrAutoScanMessages)
    assert.deepEqual(messages, [
      {
        type: 'boltqr:auto-scan-image',
        srcUrl: 'https://example.com/assets/download-qr.png',
      },
    ])

    const contextMenuCalls = await fixture.page.evaluate(() => window.__boltqrContextMenuCalls)
    assert.ok(
      contextMenuCalls.some((entry) => entry?.id === 'boltqr-scan-image'),
      'background script should still register the manual context-menu entry',
    )
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

await testAutoScanDispatchesOnlySuspectedQr()
await testAutoScanDedupesAfterDomMutation()
console.log('auto-scan extension smoke passed')
