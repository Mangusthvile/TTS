import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/TTS/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Talevox: Intelligent Reader',
        short_name: 'Talevox',
        description: 'AI-Powered Intelligent TTS Reader with Web Content Extraction',
        theme_color: '#4f46e5',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          {
            src: 'https://cdn-icons-png.flaticon.com/512/3145/3145761.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'https://cdn-icons-png.flaticon.com/512/3145/3145761.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      workbox: {
        // Ensure cache is updated when version bumps
        cacheId: 'talevox-v2.7.6',
        cleanupOutdatedCaches: true
      }
    })
  ],
  define: {
    'process.env': {},
    __APP_VERSION__: JSON.stringify('2.7.6'),
  },
  server: {
    port: 3000
  }
});