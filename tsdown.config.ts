/**
 * Dev/CI tsdown config: emits two node-half artifacts (plain ESM):
 *
 *   - `lib/index.js`      — bundles src/index.ts (plugin entry)
 *   - `lib/invariant.js`  — bundles src/invariant.ts (package invariant)
 *
 * Peer-provided platform modules stay external (the host Loader resolves them
 * from the profile node_modules); `eventsource-parser` is bundled in so the
 * committed `lib/` is self-contained and a `github:` install needs no
 * registry fetch at all.
 */
import { defineConfig, type UserConfig } from 'tsdown'

const ID = '@huanlin/dsh-plugin-copilot'

/** Host-provided modules that stay external (peer deps). */
const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  'schemastery',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/dsh-tools',
]

const libConfig: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  external: HOST_EXTERNALS,
  noExternal: [/^eventsource-parser/],
}

export default defineConfig([libConfig])
