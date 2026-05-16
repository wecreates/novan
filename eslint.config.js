// @ts-check
import js         from '@eslint/js'
import tsPlugin   from '@typescript-eslint/eslint-plugin'
import tsParser   from '@typescript-eslint/parser'
import globals    from 'globals'

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  // Global ignores
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.js.map',
      'infra/**',
    ],
  },

  // Base JS rules
  js.configs.recommended,

  // TypeScript files
  {
    files:           ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser:        tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType:  'module',
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // TypeScript
      '@typescript-eslint/no-explicit-any':          'warn',
      '@typescript-eslint/no-unused-vars':           ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion':    'off',
      '@typescript-eslint/consistent-type-imports':  ['error', { prefer: 'type-imports' }],

      // JS quality
      'no-console':          'off',
      'no-debugger':         'error',
      'eqeqeq':              ['error', 'always'],
      'no-var':              'error',
      'prefer-const':        'error',
      'no-unused-vars':      'off',  // handled by TS plugin
      'no-undef':            'off',  // TypeScript handles undefined references
    },
  },

  // Test files — relaxed rules
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
]
