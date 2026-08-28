//#region src/invariant.ts
const PACKAGE_NAME = "@huanlin/dsh-plugin-copilot";
/** Cordis companion plugin name. */
const name = "dsh-plugin-copilot-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the gateway route, the settings-namespace
* registration, and the `copilot_status` tool registration are cordis
* effect contributions auto-disposed with the plugin fiber. The gateway's
* in-flight login slot is intentionally non-durable — a dropped page just
* re-polls, and a half-finished device flow holds no authority.
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