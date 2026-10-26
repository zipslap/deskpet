import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } }
  },
  preload: {
    build: {
      // Sandboxed preload scripts cannot require() sibling chunks, so each entry must be fully self-contained.
      isolatedEntries: true,
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts'), chat: resolve('src/preload/chat.ts') },
        // sandboxed preload scripts must be CommonJS
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html'), chat: resolve('src/renderer/chat.html') } }
    }
  }
})
