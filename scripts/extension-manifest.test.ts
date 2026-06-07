import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const extensionRoot = join(process.cwd(), 'extension')
const manifestPath = join(extensionRoot, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  icons?: Record<string, string>
  action?: { default_icon?: Record<string, string> }
}

const REQUIRED_SIZES = ['16', '32', '48', '128'] as const

describe('extension manifest icon metadata', () => {
  it('declares top-level icons for all required sizes', () => {
    expect(manifest.icons).toBeDefined()
    for (const size of REQUIRED_SIZES) {
      expect(manifest.icons?.[size], `manifest.icons[${size}] missing`).toBe(`icons/icon-${size}.png`)
    }
  })

  it('declares action.default_icon for all required sizes', () => {
    expect(manifest.action?.default_icon).toBeDefined()
    for (const size of REQUIRED_SIZES) {
      expect(manifest.action?.default_icon?.[size], `action.default_icon[${size}] missing`).toBe(`icons/icon-${size}.png`)
    }
  })

  it('references icon files that exist in extension assets', () => {
    for (const size of REQUIRED_SIZES) {
      expect(existsSync(join(extensionRoot, 'assets', 'icons', `icon-${size}.png`))).toBe(true)
    }
  })
})

