import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', 'action/*.mjs', 'evals/work', 'evals/results'] },
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['tests/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // td-DSL test files run with `test`/`td` patched in as globals by the runner.
    files: ['evals/suite/**', 'e2e/**', 'examples/**/*.test.ts'],
    languageOptions: {
      globals: { test: 'readonly', td: 'readonly' },
    },
  },
  {
    // Electron renderer runs in a browser context.
    files: ['electron/renderer.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // e2e scripts are node entrypoints that inject browser-context
    // functions into Playwright pages — they need both global sets.
    files: ['tests/e2e/**'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // Brand template scripts (assets/brand/templates/) run inside a browser page.
    files: ['assets/**/*.{js,mjs}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // ANSI escape handling is the point of these files.
    files: ['scripts/**'],
    rules: {
      'no-control-regex': 'off',
    },
  },
)
