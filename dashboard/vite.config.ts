import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3001,
    proxy: {
      '/api': {
        // Default: the deployed backend. Point at a local one with:
        //   VITE_PROXY_TARGET=http://localhost:3000 npm run dev
        target: process.env.VITE_PROXY_TARGET || 'https://ai-sales-agent-production-9736.up.railway.app',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('error', (err) => console.error('[proxy error]', err.message))
        },
      },
    },
  },
})
