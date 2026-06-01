# BoltQR extension + Smart Extract helper

## Build

```bash
cd /Users/yuzhe/projects/boltqr
pnpm build:extension
```

Load `dist-extension/` as an unpacked Chrome/Edge extension.

## Configure Smart Extract token

Start Smart Extract helper:

```bash
cd /Users/yuzhe/projects/smart-extract
go run . --serve
```

The helper prints a Bearer token and token file path. Configure the extension from the extension service worker console:

```js
chrome.storage.local.set({
  smartExtractEndpoint: 'http://127.0.0.1:17321',
  smartExtractToken: '<token printed by smart-extract --serve>'
})
```

## Use

Right-click a PNG/JPG/JPEG/WebP image and choose:

```txt
BoltQR: 识别此图片中的二维码
```

BoltQR decodes the QR with `zxing-wasm`, extracts broad password candidates from the page, and POSTs them to Smart Extract.
