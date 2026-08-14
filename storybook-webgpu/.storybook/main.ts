import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin'
import type { StorybookConfig } from '@storybook/react-vite'
import react from '@vitejs/plugin-react'
import { mergeConfig, type Plugin, type UserConfig } from 'vite'

const require = createRequire(import.meta.url)

const config: StorybookConfig = {
  stories: ['../src/**/*.@(mdx|stories.@(js|jsx|ts|tsx))'],
  addons: [getAbsolutePath('@storybook/addon-docs')],
  framework: {
    name: getAbsolutePath('@storybook/react-vite'),
    options: {}
  },
  features: {
    actions: false,
    interactions: false
  },

  staticDirs: [{ from: '../assets', to: '/public' }],

  viteFinal: config =>
    mergeConfig(config, {
      plugins: [storybookMockerRuntimeFallback(), react(), nxViteTsPaths()],
      worker: {
        plugins: () => [nxViteTsPaths()]
      },
      build: {
        commonjsOptions: {
          // Ignore built-in modules used by workerpool.
          ignore: ['os', 'child_process', 'worker_threads']
        },
        sourcemap: process.env.NODE_ENV !== 'production'
      }
    } satisfies UserConfig)
}

export default config

// To customize your Vite configuration you can use the viteFinal field.
// Check https://storybook.js.org/docs/react/builders/vite#configuration
// and https://nx.dev/recipes/storybook/custom-builder-configs

function getAbsolutePath(value: string): any {
  return dirname(require.resolve(join(value, 'package.json')))
}

// Storybook 10 injects this runtime even when interactions are disabled, but
// its filtered resolve hook is skipped by the current Vite combination and
// leaves a 404. Serve Storybook's bundled runtime directly so preview startup
// retains the expected globals without exposing the pnpm path through /@fs.
function storybookMockerRuntimeFallback(): Plugin {
  const mockerRuntimePath = require.resolve(
    'storybook/internal/mocking-utils/mocker-runtime'
  )
  const mockerRuntimeSource = readFileSync(mockerRuntimePath, 'utf8')
  return {
    name: 'storybook-mocker-runtime-fallback',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/vite-inject-mocker-entry.js') {
          next()
          return
        }
        response.statusCode = 200
        response.setHeader('Content-Type', 'application/javascript')
        response.end(mockerRuntimeSource)
      })
    }
  }
}
