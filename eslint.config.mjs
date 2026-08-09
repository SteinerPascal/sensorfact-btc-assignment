import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['node_modules/**', '.esbuild/**', '.serverless/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Module boundary: shared/ is the core and must not depend on the modules
    // that consume it. This keeps the dependency graph acyclic so the package
    // could be split into workspaces later without untangling imports.
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/api/**', '**/worker/**', '**/retention/**', '**/backfill/**'],
              message: 'shared/ must not depend on modules',
            },
          ],
        },
      ],
    },
  },
  {
    // Modules must not reach into each other; they talk through shared/ only.
    files: ['src/api/**/*.ts', 'src/worker/**/*.ts', 'src/retention/**/*.ts', 'src/backfill/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/api/**', '**/worker/**', '**/retention/**', '**/backfill/**'],
              message: 'modules must not import each other; use shared/',
            },
          ],
        },
      ],
    },
  },
)
