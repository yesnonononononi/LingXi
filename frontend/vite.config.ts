import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/auth': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
      '/model': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
      '/a': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      }
    }
  }
})

