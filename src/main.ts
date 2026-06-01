import { runBenchmark } from './benchmark-runner'
import { toCsv, toMarkdown } from './report'
import type { BenchmarkSummary } from './types'

const log = document.getElementById('log') as HTMLPreElement
const envEl = document.getElementById('env') as HTMLElement
const runBtn = document.getElementById('run') as HTMLButtonElement
const dlJson = document.getElementById('dl-json') as HTMLButtonElement
const dlCsv = document.getElementById('dl-csv') as HTMLButtonElement
const copyMd = document.getElementById('copy-md') as HTMLButtonElement
const results = document.getElementById('results') as HTMLElement

let lastSummary: BenchmarkSummary | null = null

function appendLog(msg: string) {
  log.textContent += msg + '\n'
  log.scrollTop = log.scrollHeight
}

function renderEnv() {
  const hasBD = typeof (globalThis as any).BarcodeDetector !== 'undefined'
  envEl.innerHTML = `
    <p><strong>User agent:</strong> ${navigator.userAgent}</p>
    <p><strong>BarcodeDetector available:</strong> ${hasBD ? 'yes' : 'no'}</p>
    <p><strong>OffscreenCanvas available:</strong> ${typeof OffscreenCanvas !== 'undefined' ? 'yes' : 'no'}</p>
  `
}

function renderResults(summary: BenchmarkSummary) {
  results.innerHTML = `<h2>Markdown summary</h2><pre>${escapeHtml(toMarkdown(summary))}</pre>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

async function run() {
  runBtn.disabled = true
  log.textContent = ''
  appendLog('Starting benchmark...')
  try {
    const summary = await runBenchmark({
      iterations: 10,
      onProgress: appendLog,
    })
    lastSummary = summary
    appendLog('Done.')
    dlJson.disabled = false
    dlCsv.disabled = false
    copyMd.disabled = false
    renderResults(summary)
  } catch (err) {
    appendLog('Benchmark failed: ' + (err as Error).message)
    console.error(err)
  } finally {
    runBtn.disabled = false
  }
}

renderEnv()
runBtn.addEventListener('click', run)
dlJson.addEventListener('click', () => {
  if (!lastSummary) return
  download('benchmark-results.json', JSON.stringify(lastSummary, null, 2), 'application/json')
})
dlCsv.addEventListener('click', () => {
  if (!lastSummary) return
  download('benchmark-results.csv', toCsv(lastSummary), 'text/csv')
})
copyMd.addEventListener('click', async () => {
  if (!lastSummary) return
  await navigator.clipboard.writeText(toMarkdown(lastSummary))
})

declare global {
  interface Window {
    runBoltQrBenchmark?: (opts?: { iterations?: number }) => Promise<BenchmarkSummary>
  }
}

window.runBoltQrBenchmark = async (opts) =>
  runBenchmark({ iterations: opts?.iterations ?? 10, onProgress: appendLog })
