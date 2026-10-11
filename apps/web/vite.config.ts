import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER_ORIGIN = process.env.SERVER_ORIGIN ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The Organizer talks to origin-relative Protocol paths; the dev server forwards
    // /api to the backend so no CORS handling is needed in development.
    proxy: {
      '/api': {
        target: SERVER_ORIGIN,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
