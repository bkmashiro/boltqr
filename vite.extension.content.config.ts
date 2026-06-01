import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist-extension',
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: 'extension/content.ts',
      name: 'BoltQRContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
})
