import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3001,
    proxy: {
      '/api': {
        // SAFETY: default is the LOCAL backend. Dev dashboards must never mutate
        // production data by accident (lead status PATCH, booking cancel, API-key
        // regeneration all go through this proxy). To intentionally target prod:
        //   VITE_PROXY_TARGET=https://ai-sales-agent-production-9736.up.railway.app npm run dev
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('error', (err) => console.error('[proxy error]', err.message))
        },
      },
    },
  },
})
