//#region src/invariant.ts
const PACKAGE_NAME = "@huanlin/dsh-plugin-copilot";
/** Cordis companion plugin name. */
const name = "dsh-plugin-copilot-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the adapter route and the four tools are cordis
* effect registrations auto-disposed with the plugin fiber (the llm registry
* unwinds routes on dispose — proven by `LlmRuntime`'s own tests), and the
* settings namespace registration rides the scoped settings child that
* `installSettingsSection` creates. The pending device-flow login slot is
* intentionally non-durable: a half-finished login holds no authority, so
* dropping it on unload is the correct cleanup, not lost state.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));

//#endregion
export { apply, inject, name };