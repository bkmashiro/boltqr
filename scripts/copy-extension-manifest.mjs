import { copyFileSync, mkdirSync } from 'node:fs'

mkdirSync('dist-extension', { recursive: true })
copyFileSync('extension/manifest.json', 'dist-extension/manifest.json')
console.log('Copied extension/manifest.json -> dist-extension/manifest.json')
