# BoltQR ↔ Smart Extract Integration Notes

**Context:** Smart Extract already has its own password database and scoring system. Once it has seen a true password pattern, it can surface the real password from noisy candidate sets.

## Product implication

BoltQR should **not aggressively filter password candidates**. Its job is to extract and forward a broad, high-recall candidate set from the page around a decoded QR/download link.

## Candidate extraction policy

Prefer recall over precision:

- Extract visible page text around the QR/image first.
- Also scan whole-page visible text.
- Also scan selected DOM attributes likely used by copy buttons:
  - `data-clipboard-text`
  - `data-copy`
  - `data-code`
  - `title`
  - `aria-label`
  - `value` for `input` / `textarea`
- Include current page hostname variants:
  - `example.com`
  - `www.example.com`
- Include QR/download URL hostname variants.
- Include regex keyword hits for:
  - `密码`
  - `解压密码`
  - `压缩包密码`
  - `提取码`
  - `访问码`
  - `口令`
  - `password`
  - `pass`
  - `pwd`
  - `archive password`
  - `zip password`
  - `rar password`

## Filtering policy

Only apply cheap safety/quality filters:

- Deduplicate exact values.
- Trim whitespace and quotes.
- Drop empty strings.
- Drop extremely long values, e.g. `>256` chars.
- Drop obvious UI labels with no value, e.g. bare `密码`, `复制`, `下载`.

Do **not** heavily filter by entropy, length, language, or character class. Smart Extract will do the real scoring.

## Payload to Smart Extract / local helper

Send candidates with metadata so Smart Extract can learn better associations:

```json
{
  "pageUrl": "https://example.com/post/123",
  "qrUrl": "https://files.example.com/a.zip",
  "fileName": "a.zip",
  "createdAt": 1770000000000,
  "candidates": [
    {
      "value": "www.example.com",
      "scoreHint": 120,
      "source": "near-qr-text",
      "reason": "matched 解压密码"
    },
    {
      "value": "abcd",
      "scoreHint": 80,
      "source": "visible-text",
      "reason": "matched 提取码"
    }
  ]
}
```

`scoreHint` is only advisory. Smart Extract remains the source of truth for final ranking.

## Recommended MVP flow

```txt
Right-click image → Decode QR via zxing-wasm → If QR is URL/download-ish → Extract broad candidates from page → POST to local helper / Smart Extract → Smart Extract ranks and answers archive extraction password queries.
```

## UX implication

BoltQR should show only the top few candidates to humans, but send the broader set to Smart Extract.
