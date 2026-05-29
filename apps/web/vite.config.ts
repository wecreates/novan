import { defineConfig } from 'vite'
import react            from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // Fail fast if 3000 is taken instead of silently bumping to 3001
    // (which collides with the API and silently swallows traffic on
    // IPv6 localhost). Go-Public.ps1 kills any stale Vite first.
    strictPort: true,
    // Allow access from Cloudflare quick-tunnel hostnames + fly.dev
    // when developing remotely. Vite blocks unknown Host headers by
    // default (CSRF protection); explicit allow-list is safer than
    // `host: true` everywhere.
    allowedHosts: ['.trycloudflare.com', '.fly.dev', 'localhost'],
    // Surface HMR errors as a full-screen overlay instead of failing
    // silently. The error + stack land directly on top of the app the
    // moment a hot-update can't apply.
    hmr: { overlay: true },
    // Skip log + build dirs to avoid restart loops.
    watch: {
      ignored: ['**/.launch-logs/**', '**/dist/**', '**/node_modules/**'],
    },
    proxy: {
      // ws:true keeps WebSocket / SSE connections alive through Vite's
      // dev proxy when the API restarts.
      '/api':     { target: 'http://localhost:3001', changeOrigin: true, ws: true },
      '/metrics': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: {
    outDir:     'dist',
    // R146.26 — source maps in production leak the full unminified
    // source + comments + private logic of every page. They're useful
    // in dev (hot-reload, browser-devtools step-through) but at prod
    // deploy time they double bundle size AND expose the implementation
    // to anyone who fetches `/assets/<chunk>.js.map`. Build inherits
    // mode from vite: `vite build` defaults to mode='production', so
    // we get source maps in `vite build --mode development` (rare) and
    // none in the standard prod build.
    sourcemap:  process.env['NODE_ENV'] !== 'production' && process.env['VITE_BUILD_MODE'] !== 'production',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor:   ['react', 'react-dom', 'react-router-dom'],
          query:    ['@tanstack/react-query'],
          charts:   ['recharts'],
        },
      },
    },
  },
})
