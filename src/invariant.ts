/**
 * Package-owned invariant companion for `@huanlin/dsh-plugin-copilot`.
 *
 * @module @huanlin/dsh-plugin-copilot/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@huanlin/dsh-plugin-copilot'

/** Cordis companion plugin name. */
export const name = 'dsh-plugin-copilot-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the adapter route and the four tools are cordis
 * effect registrations auto-disposed with the plugin fiber (the llm registry
 * unwinds routes on dispose — proven by `LlmRuntime`'s own tests), and the
 * settings namespace registration rides the scoped settings child that
 * `installSettingsSection` creates. The pending device-flow login slot is
 * intentionally non-durable: a half-finished login holds no authority, so
 * dropping it on unload is the correct cleanup, not lost state.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
