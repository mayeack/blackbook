import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The dev server proxies the API on loopback only; no CORS anywhere.
const api = `http://127.0.0.1:${process.env.PORT ?? 4320}`;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // src/pwa.ts registers the worker: the CSP allows no inline scripts.
      injectRegister: false,
      manifestFilename: 'manifest.webmanifest',
      manifest: {
        id: '/',
        name: 'yeackbot',
        short_name: 'yeackbot',
        description: 'Your agentic personal CRM.',
        start_url: '/today',
        scope: '/',
        display: 'standalone',
        background_color: '#11110f',
        theme_color: '#d9a62a',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      injectManifest: {
        // Hashed build assets only. index.html is never precached: pages are network-first (src/sw/navigation.ts).
        globPatterns: ['assets/**/*.{js,css,woff2}'],
        globIgnores: ['**/index.html'],
        rollupFormat: 'iife',
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 5320,
    strictPort: true,
    cors: false,
    proxy: {
      '/api': { target: api },
      '/healthz': { target: api },
      // Event-pick ticket links: the server counts the tap and redirects (outside the SPA).
      '/go/': { target: api },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
