import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const distDir = 'dist-extension'
mkdirSync(distDir, { recursive: true })
copyFileSync('extension/manifest.json', join(distDir, 'manifest.json'))
console.log('Copied extension/manifest.json -> dist-extension/manifest.json')

const icons = ['icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png']
mkdirSync(join(distDir, 'icons'), { recursive: true })
for (const fileName of icons) {
  const source = join('extension', 'assets', 'icons', fileName)
  const target = join(distDir, 'icons', fileName)
  copyFileSync(source, target)
  console.log(`Copied ${source} -> ${target}`)
}
