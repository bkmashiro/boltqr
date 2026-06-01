import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  optimizeDeps: {
    exclude: ['zxing-wasm'],
  },
})
