import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy API routes to the local backend in development only.
    // In production, VITE_API_BASE_URL in .env.production points directly at Cloud Run.
    proxy: {
      '/fetch': 'http://localhost:8000',
      '/results': 'http://localhost:8000',
      '/compare': 'http://localhost:8000',
      '/jobs': 'http://localhost:8000',
      '/import': 'http://localhost:8000',
    },
  },
})
