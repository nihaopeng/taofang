import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER_ORIGIN = process.env.SERVER_ORIGIN ?? 'http://localhost:8787';
// 5273 instead of Vite's 5173 default: 5173 is in use by another project on this
// machine. Override with WEB_PORT.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5273);

export default defineConfig({
  plugins: [react()],
  server: {
    port: WEB_PORT,
    // Fail loudly instead of silently drifting to another port when WEB_PORT is
    // taken (a drifted port is easy to misread as "the app works").
    strictPort: true,
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
