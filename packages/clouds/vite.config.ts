/// <reference types='vitest/config' />

import * as path from 'node:path'
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin'
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin'
import replace from '@rollup/plugin-replace'
import react from '@vitejs/plugin-react'
import ts from 'typescript'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

const addJsExtensionsToDeclarationImports = (
  filePath: string,
  content: string
): { content: string } | undefined => {
  if (!filePath.endsWith('.d.ts')) {
    return
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const insertions: number[] = []

  const collectModuleSpecifier = (
    specifier: ts.Expression | undefined
  ): void => {
    if (specifier == null || !ts.isStringLiteralLike(specifier)) {
      return
    }
    const moduleName = specifier.text
    if (
      (moduleName.startsWith('./') || moduleName.startsWith('../')) &&
      path.posix.extname(moduleName) === ''
    ) {
      insertions.push(specifier.getEnd() - 1)
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      collectModuleSpecifier(node.moduleSpecifier)
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      collectModuleSpecifier(node.argument.literal)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  for (const position of insertions.sort((a, b) => b - a)) {
    content = `${content.slice(0, position)}.js${content.slice(position)}`
  }
  return { content }
}

export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/packages/clouds',
  plugins: [
    react(),
    nxViteTsPaths(),
    nxCopyAssetsPlugin([
      'assets/**/*',
      {
        input: '.',
        output: '.',
        glob: 'src/**/*',
        ignore: ['src/**/*.test.*', 'src/**/*.spec.*']
      },
      '*.md',
      'LICENSE'
    ]),
    dts({
      outDir: '../../dist/packages/clouds/types',
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
      pathsToAliases: false,
      beforeWriteFile: addJsExtensionsToDeclarationImports,
      afterDiagnostic: diagnostics => {
        diagnostics.forEach(diagnostic => {
          console.warn(diagnostic)
        })
      }
    })
  ],

  // Uncomment this if you are using workers.
  // worker: {
  //  plugins: [ nxViteTsPaths() ],
  // },

  // Configuration for building your library.
  // See: https://vitejs.dev/guide/build.html#library-mode
  build: {
    outDir: '../../dist/packages/clouds',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true
    },
    lib: {
      // Could also be a dictionary or array of multiple entry points.
      entry: {
        'build/index': 'src/index.ts',
        'build/r3f': 'src/r3f/index.ts',
        'build/webgpu': 'src/webgpu/index.ts'
      },
      name: 'clouds'
    },
    sourcemap: true,
    rollupOptions: {
      output: [
        {
          format: 'es' as const,
          chunkFileNames: 'build/shared.js',
          plugins: [
            replace({
              'process.env.NODE_ENV': JSON.stringify('production')
            })
          ]
        },
        {
          format: 'cjs' as const,
          chunkFileNames: 'build/shared.cjs'
        }
      ].map(config => ({
        ...config,
        sourcemapExcludeSources: true,
        // Note this just append files in ignore list.
        sourcemapIgnoreList: relativeSourcePath =>
          relativeSourcePath.includes('node_modules'),
        sourcemapPathTransform: relativeSourcePath =>
          relativeSourcePath
            .replace('../../../../node_modules', '../node_modules')
            .replace('../../../../packages/clouds/src', '../src')
      })),
      // External packages that should not be bundled into your library.
      external: [
        /^@takram\//,
        'react',
        'react-dom',
        'react/jsx-runtime',
        /^three\/?/,
        'postprocessing',
        '@react-three/fiber',
        '@react-three/drei',
        '@react-three/postprocessing'
      ]
    }
  },
  test: {
    name: 'clouds',
    watch: false,
    globals: true,
    environment: 'jsdom',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const
    }
  }
})
