import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // ESM project — use node environment
    environment: 'node',

    // Global test APIs (describe, it, expect, vi) — no imports needed
    globals: true,

    // Resolve .js extensions to actual .ts source files (TSX/ESM interop)
    alias: {
      // vitest handles TypeScript via esbuild transforms by default
    },

    // Test file patterns. R146.200 — also pick up colocated
    // src/services/__tests__/ files; the R192 smoke tests + R200
    // regression tests live there and were silently never running
    // because the glob excluded them.
    include: ['src/test/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],

    // Coverage (optional — run with --coverage flag)
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/test/**', 'src/telemetry.ts', 'src/server.ts'],
    },

    // R146.240 — give tests a no-op DATABASE_URL so module imports that
    // initialize a postgres client don't throw before tests run. The
    // connection is never used unless a test explicitly hits the DB.
    env: {
      DATABASE_URL: process.env['DATABASE_URL'] || 'postgresql://test:test@127.0.0.1:5432/test',
      NODE_ENV: process.env['NODE_ENV'] || 'test',
    },

    // Timeout — allow app build + plugin registration
    testTimeout: 30_000,
    hookTimeout: 30_000,

    // Mock resolution — ensure vi.mock() paths resolve correctly
    // (Vitest hoists vi.mock() automatically in ESM mode)
    pool: 'forks',
    poolOptions: {
      forks: {
        // Each test file gets an isolated process — prevents module singleton bleed
        isolate: true,
      },
    },
  },

  // ESM resolution: map .js imports to .ts source (Vitest / esbuild handles this)
  resolve: {
    extensions: ['.ts', '.js'],
  },
})
