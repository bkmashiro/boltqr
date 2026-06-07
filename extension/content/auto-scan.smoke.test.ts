import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// @vitest-environment node

describe('auto-scan extension smoke (browser)', () => {
  it('runs the built content/background bundles in Chromium and verifies auto-scan plus manual menu wiring', { timeout: 30_000 }, () => {
    const output = execFileSync('node', [resolve(process.cwd(), 'scripts/auto-scan-extension-smoke.mjs')], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    expect(output).toContain('auto-scan extension smoke passed')
  })
})
