import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Keep the browser's Host header, so the API works out addresses (like
      // the HMRC redirect URI) as the browser sees them.
      '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: false },
    },
  },
});
