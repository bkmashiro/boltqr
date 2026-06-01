import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { buildCandidateBundleFromDocument } from '../../extension/content/candidate-extractor'
import type { CandidateBundle } from '../../extension/shared/types'
import { startConformanceHelper, type RunningHelper } from './helper-server'
import type { HelperHealthResponse, IngestResponse, QueryResponse } from './helper-protocol'

const TOKEN = 'test-token-do-not-use-in-prod'

function buildBundle(): CandidateBundle {
  const dom = new JSDOM(
    `
    <main>
      <img src="https://example.com/assets/qr.png" />
      <p>下载说明：解压密码：www.example.com</p>
      <p>提取码：abcd</p>
      <button data-clipboard-text="HiddenPass-7788">复制</button>
    </main>
  `,
    { url: 'https://www.example.com/post/123' },
  )
  return buildCandidateBundleFromDocument(dom.window.document, {
    pageUrl: dom.window.location.href,
    pageTitle: dom.window.document.title,
    qrText: 'https://files.example.com/downloads/archive.zip',
    anchorImageUrl: 'https://example.com/assets/qr.png',
    imageMime: 'image/png',
  })
}

describe('helper conformance harness', () => {
  let helper: RunningHelper

  beforeAll(async () => {
    helper = await startConformanceHelper({ token: TOKEN })
  })

  afterAll(async () => {
    await helper.close()
  })

  it('binds only to loopback', () => {
    expect(helper.host).toBe('127.0.0.1')
    expect(helper.url.startsWith('http://127.0.0.1:')).toBe(true)
  })

  it('refuses non-loopback bindings', async () => {
    await expect(
      startConformanceHelper({ host: '0.0.0.0' as unknown as '127.0.0.1' }),
    ).rejects.toThrow(/loopback/i)
  })

  it('responds to GET /healthz without auth', async () => {
    const res = await fetch(`${helper.url}/healthz`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as HelperHealthResponse
    expect(body.ok).toBe(true)
    expect(body.protocol).toBe('boltqr-password-candidates')
    expect(body.version).toBe(1)
  })

  it('rejects POST /v1/candidates without a token', async () => {
    const res = await fetch(`${helper.url}/v1/candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildBundle()),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { ok: boolean; error?: string }
    expect(body.ok).toBe(false)
    expect(body.error).toBe('unauthorized')
  })

  it('rejects POST /v1/candidates with wrong token', async () => {
    const res = await fetch(`${helper.url}/v1/candidates`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify(buildBundle()),
    })
    expect(res.status).toBe(401)
  })

  it('rejects invalid bundles (400)', async () => {
    const res = await fetch(`${helper.url}/v1/candidates`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ schemaVersion: 99, producer: 'someone-else' }),
    })
    expect(res.status).toBe(400)
  })

  it('accepts a BoltQR-built bundle and returns ok+stored count', async () => {
    const bundle = buildBundle()
    const res = await fetch(`${helper.url}/v1/candidates`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(bundle),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as IngestResponse
    expect(body.ok).toBe(true)
    expect(typeof body.bundleId === 'string' || typeof body.bundleId === 'number').toBe(true)
    expect(body.stored).toBe(bundle.candidates.length)
  })

  it('returns matching candidates by file and url', async () => {
    const res = await fetch(
      `${helper.url}/v1/passwords?file=archive.zip&url=${encodeURIComponent('https://files.example.com/downloads/archive.zip')}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as QueryResponse
    expect(Array.isArray(body.candidates)).toBe(true)
    expect(body.candidates).toContain('www.example.com')
    expect(body.candidates).toContain('abcd')
    expect(body.candidates).toContain('HiddenPass-7788')
    expect(body.meta?.matchedBy).toMatch(/file|url/)
    expect(body.items?.length).toBeGreaterThan(0)
    expect(body.items?.[0].score).toBeGreaterThanOrEqual(body.items?.[1]?.score ?? 0)
  })

  it('returns empty candidates when nothing matches', async () => {
    const res = await fetch(
      `${helper.url}/v1/passwords?file=unrelated.rar&url=${encodeURIComponent('https://other.invalid/x.rar')}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as QueryResponse
    expect(body.candidates).toEqual([])
  })

  it('rejects GET /v1/passwords with wrong token', async () => {
    const res = await fetch(`${helper.url}/v1/passwords?file=archive.zip`, {
      headers: { authorization: 'Bearer nope' },
    })
    expect(res.status).toBe(401)
  })

  it('records POST /v1/passwords/success', async () => {
    const res = await fetch(`${helper.url}/v1/passwords/success`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        file: 'archive.zip',
        url: 'https://files.example.com/downloads/archive.zip',
        password: 'www.example.com',
        source: 'archive-extractor',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
    expect(helper.store.listSuccesses()).toHaveLength(1)
    expect(helper.store.listSuccesses()[0]?.password).toBe('www.example.com')
  })

  it('rejects success report without password', async () => {
    const res = await fetch(`${helper.url}/v1/passwords/success`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ file: 'archive.zip' }),
    })
    expect(res.status).toBe(400)
  })

  it('responds 404 on unknown route', async () => {
    const res = await fetch(`${helper.url}/v1/unknown`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(404)
  })

  it('handles CORS preflight for the extension', async () => {
    const res = await fetch(`${helper.url}/v1/candidates`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/)
    expect(res.headers.get('access-control-allow-headers')).toMatch(/authorization/i)
  })
})

describe('helper conformance harness — token-free mode', () => {
  let helper: RunningHelper

  beforeAll(async () => {
    helper = await startConformanceHelper({})
  })

  afterAll(async () => {
    await helper.close()
  })

  it('accepts ingest without a token when configured token is empty (dev mode)', async () => {
    const res = await fetch(`${helper.url}/v1/candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildBundle()),
    })
    expect(res.status).toBe(200)
  })
})
