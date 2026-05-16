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

    // Test file patterns
    include: ['src/test/**/*.test.ts'],

    // Coverage (optional — run with --coverage flag)
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/test/**', 'src/telemetry.ts', 'src/server.ts'],
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
