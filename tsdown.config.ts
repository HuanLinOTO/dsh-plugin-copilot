/**
 * Build the host, invariant, and DSH module-loader client artifacts.
 *
 *   - `lib/index.js`      — node half (plain ESM, bundles src/index.ts)
 *   - `lib/invariant.js`  — node half (plain ESM, bundles src/invariant.ts)
 *   - `lib/client.js`     — browser half (CJS wrapped in DSH's
 *                            `window.__ModuleLoader__.load({id, factory})`
 *                            so the client module loader can compose it)
 *
 * The browser bundle externals React and the DSH platform modules
 * (@deepseek-ai/cordis, @deepseek-ai/dsh-client-*): the loader's module
 * table provides them at runtime. The plugin ships a pre-built `lib/`
 * (no `prepare` script) so `github:` install works without fetching the
 * private `@deepseek-ai/*` peer deps in pnpm's temporary git-install
 * directory.
 */
import { defineConfig, type UserConfig } from 'tsdown'

const ID = '@huanlin/dsh-plugin-copilot'

/** DSH platform modules that stay external in the host bundles (peer deps). */
const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  'schemastery',
  '@deepseek-ai/dsh-authorization',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-tools',
]

/** DSH platform modules that stay external in the browser bundle (loader module table = PLATFORM_MODULES seed). */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
]

const host: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  external: HOST_EXTERNALS,
}

const client: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  external: CLIENT_EXTERNALS,
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([host, client])
