import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { HelperStore, type StoreOptions } from './helper-store'
import {
  HELPER_SERVICE_NAME,
  PROTOCOL_VERSION,
  validateCandidateBundle,
  type HelperHealthResponse,
  type IngestResponse,
  type PasswordQuery,
  type QueryResponse,
  type SuccessReport,
} from './helper-protocol'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const MAX_BODY_BYTES = 1 * 1024 * 1024

export interface HelperServerOptions extends StoreOptions {
  token?: string
  host?: '127.0.0.1' | '::1' | 'localhost'
  port?: number
  allowedOrigin?: string
}

export interface RunningHelper {
  url: string
  port: number
  host: string
  store: HelperStore
  close: () => Promise<void>
}

export async function startConformanceHelper(options: HelperServerOptions = {}): Promise<RunningHelper> {
  const host = options.host ?? '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`Conformance helper refuses non-loopback host: ${host}`)
  }
  const token = options.token ?? ''
  const allowedOrigin = options.allowedOrigin ?? '*'
  const store = new HelperStore(options)
  const server = createServer((req, res) => {
    handle(req, res, { store, token, allowedOrigin }).catch((err) => {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => resolve())
  })

  const address = server.address() as AddressInfo
  const port = address.port
  const bindHost = host === '::1' ? `[${host}]` : host
  return {
    url: `http://${bindHost}:${port}`,
    port,
    host,
    store,
    close: () => closeServer(server),
  }
}

interface RequestContext {
  store: HelperStore
  token: string
  allowedOrigin: string
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  applyCors(res, ctx.allowedOrigin)
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  const url = new URL(req.url || '/', 'http://localhost')
  const route = `${req.method} ${url.pathname}`

  if (route === 'GET /healthz') {
    const body: HelperHealthResponse = {
      ok: true,
      service: HELPER_SERVICE_NAME,
      protocol: 'boltqr-password-candidates',
      version: PROTOCOL_VERSION,
    }
    sendJson(res, 200, body)
    return
  }

  if (!isAuthorized(req, ctx.token)) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' })
    return
  }

  if (route === 'POST /v1/candidates') {
    let body: unknown
    try {
      body = await readJson(req)
    } catch (err) {
      const status = err instanceof PayloadError ? err.status : 400
      sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : 'bad request' })
      return
    }
    try {
      validateCandidateBundle(body)
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid bundle' })
      return
    }
    const stored = ctx.store.ingest(body)
    const response: IngestResponse = { ok: true, bundleId: stored.id, stored: body.candidates.length }
    sendJson(res, 200, response)
    return
  }

  if (route === 'GET /v1/passwords') {
    const params: PasswordQuery = {
      file: url.searchParams.get('file') ?? undefined,
      path: url.searchParams.get('path') ?? undefined,
      url: url.searchParams.get('url') ?? undefined,
      pageUrl: url.searchParams.get('pageUrl') ?? undefined,
      sha256: url.searchParams.get('sha256') ?? undefined,
      size: toNumber(url.searchParams.get('size')),
      limit: toNumber(url.searchParams.get('limit')),
    }
    const response: QueryResponse = ctx.store.query(params)
    sendJson(res, 200, response)
    return
  }

  if (route === 'POST /v1/passwords/success') {
    let body: unknown
    try {
      body = await readJson(req)
    } catch (err) {
      const status = err instanceof PayloadError ? err.status : 400
      sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : 'bad request' })
      return
    }
    if (!body || typeof body !== 'object' || typeof (body as SuccessReport).password !== 'string') {
      sendJson(res, 400, { ok: false, error: 'password required' })
      return
    }
    ctx.store.recordSuccess(body as SuccessReport)
    sendJson(res, 200, { ok: true })
    return
  }

  sendJson(res, 404, { ok: false, error: 'not found' })
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  if (!token) return true
  const header = req.headers['authorization']
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return !!match && match[1] === token
}

function applyCors(res: ServerResponse, allowedOrigin: string): void {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

class PayloadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string)
    received += buf.length
    if (received > MAX_BODY_BYTES) throw new PayloadError('payload too large', 413)
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new PayloadError('invalid JSON', 400)
  }
}

function toNumber(value: string | null): number | undefined {
  if (value === null) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}
