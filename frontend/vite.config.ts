import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    watch: {
      usePolling: true,
    },
  },
  resolve: {
    alias: {
      '@': '/src',
      // MsgReader Node.js uyumluluğu için Buffer polyfill
      buffer: 'buffer',
    },
  },
  define: {
    // Node.js global → browser
    global: 'globalThis',
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
    include: ['buffer'],
  },
  worker: {
    format: 'es',
  },
});

