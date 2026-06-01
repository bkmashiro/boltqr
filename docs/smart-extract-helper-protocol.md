# BoltQR Local Password Candidate Helper Protocol

Status: draft MVP  
Default endpoint: `http://127.0.0.1:17321`  
Transport: localhost HTTP + JSON  
Producer: BoltQR browser extension  
Consumer/helper: any local archive/password service, including Smart Extract-compatible tools

## Goals

BoltQR recognizes a QR code on a web page, extracts broad password candidates from that page, and hands them to a local helper. Later, an archive extractor can query the helper for likely passwords for a downloaded archive.

BoltQR does **not** try to decide the final password. It sends high-recall candidates with light metadata. The local helper is expected to score, remember, deduplicate, and learn.

## Security requirements

1. Bind only to loopback:
   - `127.0.0.1`
   - `[::1]`
   - optionally `localhost`
2. Do **not** bind to `0.0.0.0`.
3. Require a local bearer token unless explicitly running in insecure/dev mode.
4. Recommended header:

```http
Authorization: Bearer <local-token>
```

5. Browser-facing CORS should be restricted if possible:

```http
Access-Control-Allow-Origin: chrome-extension://<extension-id>
Access-Control-Allow-Headers: authorization, content-type
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

For development, `Access-Control-Allow-Origin: *` is acceptable only if bearer token is still required.

## Common data model

### CandidateBundle

Sent by BoltQR to the helper.

```ts
type CandidateBundle = {
  schemaVersion: 1
  producer: 'boltqr'
  pageUrl: string
  pageTitle?: string
  qrText: string
  qrUrl?: string
  downloadUrl?: string
  fileName?: string
  imageUrl?: string
  imageMime?: 'image/png' | 'image/jpeg' | 'image/webp' | string
  candidates: PasswordCandidate[]
  createdAt: string // ISO 8601
}
```

### PasswordCandidate

```ts
type PasswordCandidate = {
  value: string
  source:
    | 'keyword-nearby'
    | 'visible-text'
    | 'dom-attribute'
    | 'input-value'
    | 'near-qr'
    | 'page-hostname'
    | 'qr-hostname'
    | 'download-hostname'
    | 'manual'
    | 'other'
  reason?: string
  scoreHint?: number
  context?: string
}
```

Field meaning:

| Field | Meaning |
|---|---|
| `value` | Raw password candidate after trim. High recall; may contain junk. |
| `source` | Where BoltQR found it. |
| `reason` | Human/debug explanation, e.g. `matched 解压密码：xxx`. |
| `scoreHint` | Weak hint from BoltQR. Helper may ignore it. |
| `context` | Short nearby text snippet. Do not send full page text. |

BoltQR-side filtering should be minimal:

- trim whitespace / quotes / brackets
- remove empty values
- dedupe exact values within the bundle
- drop extremely long values, recommended `>256` chars
- drop obvious UI-label-only junk such as `复制`, `下载`, `密码`, `提取码`, `password`, `copy`

Do not aggressively filter. The helper should handle scoring.

## Endpoint: health check

```http
GET /healthz
```

Response:

```json
{
  "ok": true,
  "service": "smart-extract-helper",
  "protocol": "boltqr-password-candidates",
  "version": 1
}
```

This endpoint may be unauthenticated, but authenticated is also acceptable.

## Endpoint: ingest candidates

```http
POST /v1/candidates
Authorization: Bearer <local-token>
Content-Type: application/json
```

Request body:

```json
{
  "schemaVersion": 1,
  "producer": "boltqr",
  "pageUrl": "https://example.com/post/123",
  "pageTitle": "Example download page",
  "qrText": "https://files.example.com/a.zip",
  "qrUrl": "https://files.example.com/a.zip",
  "downloadUrl": "https://files.example.com/a.zip",
  "fileName": "a.zip",
  "imageUrl": "https://example.com/qr.png",
  "imageMime": "image/png",
  "candidates": [
    {
      "value": "www.example.com",
      "source": "keyword-nearby",
      "reason": "matched 解压密码：",
      "scoreHint": 100,
      "context": "解压密码：www.example.com"
    },
    {
      "value": "abcd",
      "source": "keyword-nearby",
      "reason": "matched 提取码：",
      "scoreHint": 70,
      "context": "提取码：abcd"
    },
    {
      "value": "example.com",
      "source": "page-hostname",
      "scoreHint": 20
    }
  ],
  "createdAt": "2026-06-01T09:40:00.000Z"
}
```

Successful response:

```json
{
  "ok": true,
  "bundleId": "optional-local-id",
  "stored": 3
}
```

Error response:

```json
{
  "ok": false,
  "error": "unauthorized"
}
```

Recommended HTTP status codes:

| Status | Meaning |
|---:|---|
| 200 | Accepted/stored. |
| 400 | Bad JSON or invalid payload. |
| 401 | Missing/invalid token. |
| 413 | Payload too large. |
| 429 | Too many requests. |
| 500 | Helper internal error. |

## Endpoint: query passwords

Used by an archive extractor or another local tool.

```http
GET /v1/passwords?file=<archive-file-name>&url=<download-url>&pageUrl=<source-page-url>
Authorization: Bearer <local-token>
```

All query parameters are optional, but at least one is recommended.

Supported query params:

| Param | Example | Meaning |
|---|---|---|
| `file` | `a.zip` | Local archive filename or basename. |
| `path` | `/Downloads/a.zip` | Full local archive path. Helper should use basename too. |
| `url` | `https://files.example.com/a.zip` | Download/final URL if known. |
| `pageUrl` | `https://example.com/post/123` | Page where QR was scanned. |
| `sha256` | `...` | Optional archive hash if known. |
| `size` | `12345678` | Optional archive byte size. |
| `limit` | `50` | Optional max candidates. |

Response:

```json
{
  "candidates": [
    "www.example.com",
    "abcd",
    "example.com"
  ],
  "items": [
    {
      "value": "www.example.com",
      "score": 150,
      "source": "keyword-nearby",
      "reason": "matched filename/url recent bundle"
    },
    {
      "value": "abcd",
      "score": 90,
      "source": "keyword-nearby"
    }
  ],
  "meta": {
    "matchedBy": "url,file,recent",
    "bundleAgeSeconds": 42,
    "limit": 50
  }
}
```

Compatibility rule:

- Consumers may only read `candidates`.
- Helpers may additionally return `items` for richer debugging/scoring.
- `candidates` should be ordered best-first according to the helper's own scoring.

## Endpoint: report successful password

Optional but recommended. Lets the helper learn.

```http
POST /v1/passwords/success
Authorization: Bearer <local-token>
Content-Type: application/json
```

Request body:

```json
{
  "file": "a.zip",
  "path": "/Users/example/Downloads/a.zip",
  "url": "https://files.example.com/a.zip",
  "pageUrl": "https://example.com/post/123",
  "sha256": "optional",
  "size": 12345678,
  "password": "www.example.com",
  "source": "archive-extractor"
}
```

Response:

```json
{
  "ok": true
}
```

## Matching recommendations for helper

The helper should associate bundles with archives using multiple weak keys:

1. Exact `downloadUrl` / `qrUrl` match.
2. Same URL hostname.
3. Exact `fileName` / basename match.
4. Recent ingest time, e.g. within 1 hour.
5. Same source `pageUrl` hostname.
6. Optional file size / hash if available.

Recommended default TTL for raw bundles:

- short-term memory: 1–6 hours
- persistent learning: only after `/v1/passwords/success` or user opt-in

## Minimal implementation checklist

A compatible local helper only needs:

1. `POST /v1/candidates`
2. `GET /v1/passwords`
3. Bearer token check
4. Loopback-only listener
5. In-memory or SQLite recent bundle store

`/healthz` and `/v1/passwords/success` are optional but recommended.

## Example curl

```bash
HELPER_BEARER='replace-me'

curl -sS http://127.0.0.1:17321/v1/candidates \
  -H "Authorization: Bearer ${HELPER_BEARER}" \
  -H 'Content-Type: application/json' \
  -d '{
    "schemaVersion": 1,
    "producer": "boltqr",
    "pageUrl": "https://example.com/post/123",
    "qrText": "https://files.example.com/a.zip",
    "qrUrl": "https://files.example.com/a.zip",
    "fileName": "a.zip",
    "candidates": [
      {"value":"www.example.com","source":"keyword-nearby","scoreHint":100},
      {"value":"abcd","source":"keyword-nearby","scoreHint":70}
    ],
    "createdAt": "2026-06-01T09:40:00.000Z"
  }'

curl -sS 'http://127.0.0.1:17321/v1/passwords?file=a.zip&url=https%3A%2F%2Ffiles.example.com%2Fa.zip' \
  -H "Authorization: Bearer ${HELPER_BEARER}"
```

## Conformance harness

This repo ships a reference implementation of the protocol used as an integration test target:

```txt
scripts/test-utils/helper-protocol.ts   # types + CandidateBundle validation
scripts/test-utils/helper-store.ts      # in-memory bundle store + scoring
scripts/test-utils/helper-server.ts     # loopback-bound HTTP server (startConformanceHelper)
scripts/test-utils/helper-conformance.test.ts  # protocol-level integration tests
```

Another local helper project can reuse the same tests to check protocol compatibility:

1. Start your helper on a loopback port with a known bearer token.
2. Point a test runner at `${YOUR_HELPER_URL}` and replay the requests/assertions in `helper-conformance.test.ts`:
   - `GET /healthz` returns `{ ok, protocol: "boltqr-password-candidates", version: 1 }`.
   - `POST /v1/candidates` with a valid `CandidateBundle` returns `{ ok: true, stored: <number> }`.
   - `GET /v1/passwords?file=...&url=...` returns `{ candidates: string[] }`, optionally `items` and `meta`.
   - Wrong/missing bearer token returns 401.
   - `POST /v1/passwords/success` is optional but should return `{ ok: true }` when accepted.
3. Bind only to `127.0.0.1` or `[::1]`. Refuse `0.0.0.0`.

Run BoltQR's harness locally:

```bash
pnpm test
```

The harness uses an ephemeral port on `127.0.0.1`. No secrets are stored; the bearer value used in tests is a hard-coded non-secret literal scoped to the test process.

## Versioning

Current protocol version: `1`.

BoltQR should include:

```json
{
  "schemaVersion": 1,
  "producer": "boltqr"
}
```

Helpers should ignore unknown fields for forward compatibility.
