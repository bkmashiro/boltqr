import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const distDir = 'dist-extension'
const requiredSizes = ['16', '32', '48', '128']

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readPngDimensions(pngPath) {
  const data = readFileSync(pngPath)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert(data.length >= 24, `PNG is too small: ${pngPath}`)
  assert(data.subarray(0, 8).equals(signature), `Invalid PNG signature: ${pngPath}`)

  const chunkType = data.subarray(12, 16).toString('ascii')
  assert(chunkType === 'IHDR', `Expected IHDR for ${pngPath}, got ${chunkType}`)

  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  }
}

const manifestPath = join(distDir, 'manifest.json')
assert(existsSync(manifestPath), `Missing built manifest: ${manifestPath}`)

const manifest = readJson(manifestPath)
const packageJson = readJson('package.json')
assert(manifest.version === packageJson.version, `Manifest version ${manifest.version} does not match package.json ${packageJson.version}`)

for (const size of requiredSizes) {
  const iconPath = `icons/icon-${size}.png`
  assert(manifest.icons?.[size] === iconPath, `manifest.icons[${size}] should be ${iconPath}`)
  assert(manifest.action?.default_icon?.[size] === iconPath, `manifest.action.default_icon[${size}] should be ${iconPath}`)

  const builtIconPath = join(distDir, iconPath)
  const stat = statSync(builtIconPath)
  assert(stat.isFile() && stat.size > 0, `Missing or empty built icon file: ${builtIconPath}`)

  const { width, height } = readPngDimensions(builtIconPath)
  assert(width === Number(size) && height === Number(size), `Wrong icon dimensions for ${builtIconPath}: ${width}x${height}`)
}

console.log(`Extension assets validated: manifest ${manifest.version}, icons ${requiredSizes.join('/')}`)
