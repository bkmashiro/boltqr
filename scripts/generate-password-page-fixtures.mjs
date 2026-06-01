import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'

const outDir = new URL('../fixtures/password-pages/', import.meta.url)
mkdirSync(outDir, { recursive: true })

const cases = [
  {
    id: '01-visible-extract-password',
    title: '正文解压密码',
    qr: 'https://files.example.com/releases/archive-visible.zip',
    expected: ['www.example.com'],
    body: '<p>下载完成后请解压，解压密码：www.example.com</p><p>复制 下载 密码 广告 备用链接</p>',
  },
  {
    id: '02-pan-code-and-archive-password',
    title: '提取码与压缩包密码共存',
    qr: 'https://pan.example.net/s/abc?file=pan-code.rar',
    expected: ['abcd', 'ZipPass-2026'],
    body: '<p>网盘提取码：abcd</p><p>压缩包密码：ZipPass-2026</p>',
  },
  {
    id: '03-copy-button-attribute',
    title: '复制按钮属性',
    qr: 'https://cdn.example.org/packs/copy-button.7z',
    expected: ['CopyButtonSecret88'],
    body: '<button data-clipboard-text="CopyButtonSecret88">复制解压密码</button><p>页面文本里没有直接写密码。</p>',
  },
  {
    id: '04-hidden-input-value',
    title: '隐藏 input 值',
    qr: 'https://dl.example.org/files/hidden-input.zip',
    expected: ['HiddenInput-42'],
    body: '<input type="hidden" value="HiddenInput-42"><p>密码请点击复制按钮获取。</p>',
  },
  {
    id: '05-near-qr-priority',
    title: '二维码附近文本',
    qr: 'https://near.example.com/a/near-qr.zip',
    expected: ['near-pass-001'],
    body: '<div class="qr-card"><p>二维码附近：解压密码：near-pass-001</p>{{QR}}</div><aside>远处垃圾 token garbage-999</aside>',
    inlineQr: true,
  },
  {
    id: '06-english-password',
    title: '英文 password',
    qr: 'https://english.example.com/archive/english.rar',
    expected: ['EnglishPass99'],
    body: '<p>Archive password: EnglishPass99</p><p>download mirror password protected.</p>',
  },
  {
    id: '07-domain-password',
    title: '域名作为密码',
    qr: 'https://files.domainpass.test/pkg/domainpass.zip',
    expected: ['domainpass.test'],
    body: '<p>本站资源默认密码就是本站域名。</p>',
  },
  {
    id: '08-title-attribute',
    title: 'title 属性',
    qr: 'https://attr.example.com/pkg/title-attr.zip',
    expected: ['TitleAttr-PASS'],
    body: '<a href="#" title="解压密码：TitleAttr-PASS">密码说明</a>',
  },
  {
    id: '09-aria-label',
    title: 'aria-label 属性',
    qr: 'https://aria.example.com/pkg/aria-label.zip',
    expected: ['AriaLabelSecret'],
    body: '<button aria-label="password: AriaLabelSecret">copy</button>',
  },
  {
    id: '10-noisy-page',
    title: '大量垃圾文本',
    qr: 'https://noise.example.com/pkg/noisy.zip',
    expected: ['TruePass-Noise'],
    body: '<p>下载 下载 复制 广告 token111 token222 token333</p><p>解压密码：TruePass-Noise</p><p>foo bar baz abc def ghi jkl mno pqr</p>',
  },
  {
    id: '11-quark-style',
    title: '夸克风格访问码',
    qr: 'https://quark.example.com/s/pkg-quark.zip',
    expected: ['QK88'],
    body: '<p>夸克网盘访问码：QK88</p><p>文件很大，建议保存后下载。</p>',
  },
  {
    id: '12-non-url-qr-with-password',
    title: '非 URL 二维码但页面有密码',
    qr: 'MAGNET-LIKE-CONTENT-WITHOUT-URL',
    expected: ['NonUrlPass'],
    body: '<p>口令：NonUrlPass</p><p>即使 QR 不是 URL，也应该能捞候选。</p>',
  },
]

const manifest = []
for (const c of cases) {
  const qrData = await QRCode.toDataURL(c.qr, { margin: 1, width: 220 })
  const qrImg = `<img alt="qr" src="${qrData}" data-qr-text="${escapeHtml(c.qr)}">`
  const body = (c.inlineQr ? c.body.replace('{{QR}}', qrImg) : `${qrImg}\n${c.body}`)
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${escapeHtml(c.title)}</title></head>
<body>
  <h1>${escapeHtml(c.title)}</h1>
  ${body}
</body>
</html>
`
  const filename = `${c.id}.html`
  writeFileSync(join(outDir.pathname, filename), html)
  manifest.push({ id: c.id, title: c.title, file: filename, qrText: c.qr, expectedCandidates: c.expected })
}
writeFileSync(join(outDir.pathname, 'manifest.json'), JSON.stringify({ cases: manifest }, null, 2) + '\n')
console.log(`Wrote ${manifest.length} password-page fixtures to ${outDir.pathname}`)

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}
