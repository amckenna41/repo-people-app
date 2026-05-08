import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // recharts minifies to ~526 kB — raise the threshold to avoid a false-positive warning.
    // xlsx/jspdf/html2canvas are already lazy-loaded via dynamic import().
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-recharts': ['recharts'],
          'vendor-maps': ['react-simple-maps'],
          'vendor-table': ['@tanstack/react-table'],
        },
      },
    },
  },
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
