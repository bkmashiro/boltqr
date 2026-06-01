import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const readerEntry = require.resolve('zxing-wasm/reader')
// .../zxing-wasm/dist/es/reader/index.js -> .../zxing-wasm/dist/reader/zxing_reader.wasm
const wasmPath = join(dirname(fileURLToPath(new URL(`file://${readerEntry}`))), '../../reader/zxing_reader.wasm')
mkdirSync('dist-extension', { recursive: true })
copyFileSync(wasmPath, 'dist-extension/zxing_reader.wasm')
console.log('Copied zxing_reader.wasm -> dist-extension/zxing_reader.wasm')
