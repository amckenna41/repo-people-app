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
        // Vite 8 / Rolldown only accepts the function form of manualChunks.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/[/\\]node_modules[/\\](react|react-dom|scheduler)[/\\]/.test(id)) return 'vendor-react'
          if (id.includes('recharts')) return 'vendor-recharts'
          if (id.includes('react-simple-maps')) return 'vendor-maps'
          if (id.includes('@tanstack/react-table')) return 'vendor-table'
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
      '/clear_cache': 'http://localhost:8000',
      '/auth': 'http://localhost:8000',
      '/share': 'http://localhost:8000',
    },
  },
})
