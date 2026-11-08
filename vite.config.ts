import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Relative paths work both locally and on GitHub Pages.
export default defineConfig({
  base: './',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Конвертер координат Севастополя',
        short_name: 'Конвертер СК',
        description: 'Офлайн-перевод МСК-42, СК-63 зона 4 и WGS-84',
        lang: 'ru',
        start_url: './',
        scope: './',
        display: 'standalone',
        theme_color: '#0e4e5a',
        background_color: '#f4f8f7',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      },
      workbox: {
        navigateFallback: 'index.html',
        globPatterns: ['**/*.{js,css,html,svg,ico,png}']
      }
    })
  ]
})
