import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// @vitest-environment node

describe('auto-scan boundary MV3 extension load smoke (Playwright)', () => {
  it('ignores noisy non-QR images then detects dynamically inserted QR image', { timeout: 90_000 }, () => {
    const output = execFileSync('node', [resolve(process.cwd(), 'scripts/auto-scan-boundary-extension-load-smoke.mjs')], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })

    expect(output).toContain('auto-scan boundary mv3 smoke passed')
  })
})
