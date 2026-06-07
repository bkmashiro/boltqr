import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// @vitest-environment node

describe('auto-scan MV3 extension load smoke (Playwright)', () => {
  it('loads real dist-extension and verifies auto-scan toast path', { timeout: 90_000 }, () => {
    const output = execFileSync('node', [resolve(process.cwd(), 'scripts/auto-scan-extension-load-smoke.mjs')], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })

    expect(output).toContain('auto-scan mv3 extension load smoke passed')
  })
})
