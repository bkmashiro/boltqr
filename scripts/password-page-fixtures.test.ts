import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { buildCandidateBundleFromDocument } from '../extension/content/candidate-extractor'

const root = fileURLToPath(new URL('../fixtures/password-pages/', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
  cases: Array<{ id: string; file: string; qrText: string; expectedCandidates: string[] }>
}

describe('password-page fixture corpus', () => {
  it('covers at least 10 realistic QR download/password layouts', () => {
    expect(manifest.cases.length).toBeGreaterThanOrEqual(10)
  })

  for (const fixture of manifest.cases) {
    it(`extracts expected candidates from ${fixture.id}`, () => {
      const html = readFileSync(join(root, fixture.file), 'utf8')
      const dom = new JSDOM(html, { url: `https://fixture.local/${fixture.file}` })
      const image = dom.window.document.querySelector('img') as HTMLImageElement | null
      const bundle = buildCandidateBundleFromDocument(dom.window.document, {
        pageUrl: dom.window.location.href,
        pageTitle: dom.window.document.title,
        qrText: fixture.qrText,
        anchorImageUrl: image?.src,
        imageMime: 'image/png',
      })
      const values = new Set(bundle.candidates.map((candidate) => candidate.value))
      for (const expected of fixture.expectedCandidates) {
        expect(values.has(expected), `${fixture.id} should include ${expected}; got ${Array.from(values).slice(0, 30).join(', ')}`).toBe(true)
      }
    })
  }
})
