import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist-extension',
    emptyOutDir: false,
    sourcemap: false,
    rollupOptions: {
      input: 'extension/options.html',
      output: {
        entryFileNames: 'options.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
