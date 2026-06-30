import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit(),
    VitePWA({
      registerType: 'autoUpdate',
      srcDir: 'src',
      filename: 'service-worker.ts',
      strategies: 'injectManifest',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff,woff2}']
      },
      manifest: {
        name: 'Timing Hub',
        short_name: 'TimingHub',
        description: 'Professional motorsport live-timing',
        theme_color: '#e63012',
        background_color: '#0f0f0f',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/login',
        scope: '/',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ],
        shortcuts: [
          {
            name: 'Meine Veranstaltungen',
            url: '/dashboard',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }]
          }
        ],
        categories: ['sports', 'utilities']
      },
      devOptions: {
        enabled: true,
        type: 'module'
      }
    })
  ],
  resolve: {
    alias: {
      $lib: resolve('./src/lib'),
      $i18n: resolve('./src/i18n')
    }
  },
  server: {
    port: 5173
  },
  build: {
    target: 'esnext'
  }
});
