import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist-extension',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: 'extension/background.ts',
      output: {
        entryFileNames: 'background.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  optimizeDeps: { exclude: ['zxing-wasm'] },
})
