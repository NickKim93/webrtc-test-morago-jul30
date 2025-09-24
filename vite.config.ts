import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    global: 'window'
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/auth': { target: 'http://localhost:8091', changeOrigin: true },
      '/call': { target: 'http://localhost:8091', changeOrigin: true },
      '/ws-native': { target: 'ws://localhost:8091', ws: true, changeOrigin: true },
      '/ws':        { target: 'http://localhost:8091', ws: true, changeOrigin: true }, // SockJS (optional)
    },
  },
})
