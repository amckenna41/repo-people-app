/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f5f3ff',
          100: '#ede9fe',
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
        },
      },
      backgroundImage: {
        'gradient-brand': 'linear-gradient(135deg, #7c3aed 0%, #2563eb 60%, #0ea5e9 100%)',
        'gradient-text': 'linear-gradient(90deg, #a78bfa 0%, #60a5fa 50%, #34d399 100%)',
      },
      boxShadow: {
        glow: '0 0 20px rgba(124,58,237,0.4)',
        'glow-sm': '0 0 10px rgba(124,58,237,0.25)',
      },
    },
  },
  plugins: [],
}
