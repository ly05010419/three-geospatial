import { defineConfig } from 'eslint/config'

import baseConfig from '../../eslint.config.mjs'

export default defineConfig(
  baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: ['**/eslint.config.mjs', '**/vite.config.ts'],
          // Nx does not count type-only imports or optional peer entry points.
          ignoredDependencies: ['@types/react', 'react', 'type-fest']
        }
      ]
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser')
    }
  },
  {
    files: ['**/*.tsx'],
    rules: {
      'react/display-name': 'error'
    }
  }
)
