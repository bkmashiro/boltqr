#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const docsDir = resolve(projectRoot, 'docs')

const PORT = process.env.BOLTQR_PORT ? Number(process.env.BOLTQR_PORT) : 5173
const URL_BASE = `http://127.0.0.1:${PORT}/`

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await delay(250)
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`)
}

async function ensurePlaywright() {
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch (err) {
    console.error('Playwright not installed.')
    throw err
  }
  // Best-effort install
  await new Promise((resolveP) => {
    const p = spawn('npx', ['--yes', 'playwright', 'install', 'chromium'], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    })
    p.on('exit', () => resolveP(null))
    p.on('error', () => resolveP(null))
  })
  return chromium
}

function startVite() {
  const proc = spawn(
    'node',
    [resolve(projectRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'development' } },
  )
  proc.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`))
  proc.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))
  return proc
}

async function main() {
  await mkdir(docsDir, { recursive: true })

  const chromium = await ensurePlaywright()
  const vite = startVite()
  let exitCode = 0
  let browser
  try {
    await waitForServer(URL_BASE)
    console.log('Vite dev server is ready, launching Chromium...')
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext()
    const page = await context.newPage()
    page.on('console', (msg) => {
      const t = msg.type()
      if (t === 'error' || t === 'warning') {
        console.log(`[page:${t}] ${msg.text()}`)
      }
    })
    page.on('pageerror', (err) => console.log(`[page:error] ${err.message}`))

    await page.goto(URL_BASE, { waitUntil: 'load' })
    // Wait until the bench function is exposed
    await page.waitForFunction(() => typeof window.runBoltQrBenchmark === 'function', null, { timeout: 30000 })
    console.log('Running benchmark in the browser...')
    const summary = await page.evaluate(
      async (iterations) => {
        const s = await window.runBoltQrBenchmark({ iterations })
        return s
      },
      Number(process.env.BOLTQR_ITER || 10),
    )

    // Save outputs from Node side using the toCsv/toMarkdown via the page
    const csv = await page.evaluate(async (s) => {
      const mod = await import('/src/report.ts')
      return mod.toCsv(s)
    }, summary)
    const md = await page.evaluate(async (s) => {
      const mod = await import('/src/report.ts')
      return mod.toMarkdown(s)
    }, summary)

    await writeFile(resolve(docsDir, 'benchmark-results.json'), JSON.stringify(summary, null, 2))
    await writeFile(resolve(docsDir, 'benchmark-results.csv'), csv)
    await writeFile(resolve(docsDir, 'benchmark-report.md'), md)

    console.log('\n=== Summary ===')
    console.log(`Cases: ${summary.results.length}`)
    console.log(`BarcodeDetector available: ${summary.barcodeDetectorAvailable}`)
    console.log('Cold init:')
    for (const c of summary.coldInit) {
      console.log(`  ${c.decoderId}: init=${c.initMs.toFixed(2)}ms firstDecode=${c.firstDecodeMs.toFixed(2)}ms ok=${c.ok}`)
    }
    const groups = new Map()
    for (const r of summary.results) {
      const arr = groups.get(r.decoderId) || []
      arr.push(r)
      groups.set(r.decoderId, arr)
    }
    for (const [id, rows] of groups) {
      const decode = rows.map((r) => r.timing.decodeMs).sort((a, b) => a - b)
      const mid = decode[Math.floor(decode.length / 2)] || 0
      const p95 = decode[Math.min(decode.length - 1, Math.floor(decode.length * 0.95))] || 0
      const succ = rows.filter((r) => r.success).length / rows.length
      console.log(`  ${id}: n=${rows.length} medianDecode=${mid.toFixed(2)}ms p95Decode=${p95.toFixed(2)}ms success=${(succ * 100).toFixed(1)}%`)
    }
  } catch (err) {
    console.error('Benchmark run failed:', err)
    exitCode = 1
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (vite && !vite.killed) {
      vite.kill('SIGTERM')
      await delay(500)
      if (!vite.killed) vite.kill('SIGKILL')
    }
  }
  process.exit(exitCode)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
