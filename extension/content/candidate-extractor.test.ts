// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildCandidateBundleFromDocument } from './candidate-extractor'

describe('candidate extractor', () => {
  it('keeps high-recall password candidates from visible text, copy attributes, hidden inputs, and hostnames', () => {
    document.body.innerHTML = `
      <main>
        <section id="card">
          <img src="https://example.com/assets/qr.png" />
          <p>下载说明：解压密码：www.example.com</p>
          <p>百度网盘提取码：abcd</p>
          <button data-clipboard-text="HiddenPass-7788">复制密码</button>
          <input type="hidden" value="input-secret-42" />
          <span>复制 下载 密码</span>
        </section>
      </main>
    `

    const bundle = buildCandidateBundleFromDocument(document, {
      pageUrl: 'https://www.example.com/post/123',
      pageTitle: '下载页面',
      qrText: 'https://files.example.com/downloads/archive.zip',
      anchorImageUrl: 'https://example.com/assets/qr.png',
    })

    const values = bundle.candidates.map((candidate) => candidate.value)
    expect(bundle.schemaVersion).toBe(1)
    expect(bundle.producer).toBe('boltqr')
    expect(bundle.qrUrl).toBe('https://files.example.com/downloads/archive.zip')
    expect(bundle.fileName).toBe('archive.zip')
    expect(values).toContain('www.example.com')
    expect(values).toContain('abcd')
    expect(values).toContain('HiddenPass-7788')
    expect(values).toContain('input-secret-42')
    expect(values).toContain('example.com')
    expect(values).toContain('files.example.com')
    expect(values).not.toContain('复制')
    expect(values).not.toContain('下载')
    expect(values).not.toContain('密码')
  })
})
