import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "schemastery";
import { AuthorizationDeclinedError } from "@deepseek-ai/dsh-authorization";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/status.ts
/** The provider route and record id this plugin bootstraps. */
const COPILOT_PROVIDER = "github-copilot";
/** Scope owning the Copilot credential record (dsh-llm-pi-ai's plugin name). */
const COPILOT_SCOPE = "llm-pi-ai";
/** Settings namespace whose `providers` dict carries the Copilot profile. */
const COPILOT_SETTINGS_NS = "llm-pi-ai";
/**
* The credential record a pi-ai Copilot login writes.
*
* Spelled from the two public constants rather than imported from
* `@deepseek-ai/dsh-llm-pi-ai`: a third-party plugin must not take a
* runtime dependency on an internal plugin package, and the record address
* is exactly `credentialKey('llm-pi-ai', 'github-copilot')`.
*/
const COPILOT_RECORD_KEY = credentialKey(COPILOT_SCOPE, COPILOT_PROVIDER);
/** The joined record address, as the authorization flow registry reports it. */
function recordAddress(key) {
	return `${key.slice(0, key.indexOf("/"))}/${key.slice(key.indexOf("/") + 1)}`;
}
/**
* Find the pi-ai Copilot authorization flow without hand-composing its key:
* the flow registry is the authority on which keys exist, so the join is by
* scope + id segments of each registered flow's key.
* @param entries - every registered authorization flow.
* @returns the entry whose record is the Copilot one, or undefined.
*/
function findCopilotFlow(entries) {
	return entries.find((entry) => {
		return recordAddress(entry.key) === `${COPILOT_SCOPE}/${COPILOT_PROVIDER}`;
	});
}
/**
* Pull the model ids a stored pi-ai OAuth grant reports as usable by this
* account. pi-ai writes `availableModelIds` at login and rewrites it on every
* token refresh; anything else — an api-key record, an absent store, an
* unexpected payload — reads as unknown rather than empty, so a surface can
* stay silent instead of claiming the account has no models.
* @param record - the credential record as stored, or undefined.
* @returns the usable model ids, or undefined when unknown.
*/
function grantModelIds(record) {
	if (record?.kind !== "grant") return void 0;
	const models = record.payload?.availableModelIds;
	if (!Array.isArray(models) || !models.every((id) => typeof id === "string")) return void 0;
	return models;
}
/**
* Join the facts the card shows.
* @param sources - the live host reads.
* @returns the card status; `loggedIn` is false when no credential store is mounted.
*/
async function joinStatus(sources) {
	const flow = findCopilotFlow(sources.listFlows());
	let loggedIn = false;
	if (flow !== void 0) {
		const record = await sources.describeRecord(flow.key);
		loggedIn = record?.configured === true && record.kind === "grant";
	}
	const providers = sources.settingsSection()?.providers;
	return {
		flowAvailable: flow !== void 0,
		loggedIn,
		profileActivated: typeof providers === "object" && providers !== null && Object.hasOwn(providers, COPILOT_PROVIDER),
		inFlight: flow?.inFlight ?? false,
		models: loggedIn ? await sources.models() : void 0
	};
}

//#endregion
//#region src/gateway.ts
/** HTTP route prefix owning every copilot API request. */
const API_PREFIX = "/copilot/api";
/**
* The pi-ai Copilot flow opens by asking for the enterprise deployment, where
* blank is the normal answer ("blank for github.com"). Matched by the concept
* its message names rather than the exact copy, so a wording tweak upstream
* degrades into the manual prompt path instead of a wrong auto-answer.
* @param prompt - the prompt the flow raised.
* @returns whether this is the enterprise-domain question.
*/
function isEnterpriseDomainPrompt(prompt) {
	return prompt.kind === "text" && /enterprise/i.test(prompt.message);
}
/** Upper bound on the buffered notice ring the client replays from. */
const MAX_BUFFERED_NOTICES = 64;
/**
* Register the `/copilot/api` route.
*
* @param ctx - host context carrying `webServer`.
* @param deps - the host capabilities the route drives.
* @returns disposer removing the route.
*/
function registerCopilotGateway(ctx, deps) {
	const webServer = ctx.webServer;
	if (webServer === void 0 || typeof webServer.register !== "function") return () => {};
	let seq = 0;
	let ring = [];
	let runningLogin;
	/** Last settlement, as a terminal event the client polls for. */
	let settlement;
	const pushEvent = (event) => {
		ring.push(event);
		if (ring.length > MAX_BUFFERED_NOTICES) ring = ring.slice(-MAX_BUFFERED_NOTICES);
		return event.seq;
	};
	const pushNotice = (notice) => {
		seq += 1;
		return pushEvent({
			kind: "notice",
			seq,
			notice
		});
	};
	const pushPrompt = (prompt) => {
		seq += 1;
		return pushEvent({
			kind: "prompt",
			seq,
			prompt
		});
	};
	const settle = (outcome) => {
		runningLogin = void 0;
		settlement = outcome;
		pushNotice({ message: outcome.status === "authorized" ? "Authorized. The Copilot route is being activated…" : outcome.status === "cancelled" ? "Sign-in was cancelled." : `Sign-in failed: ${outcome.message}` });
	};
	const copilotKey = () => {
		return findCopilotFlow(deps.listFlows())?.key;
	};
	const status = () => joinStatus(deps);
	const runLogin = () => {
		const key = copilotKey();
		if (key === void 0) {
			settle({
				status: "error",
				message: "no authorization flow is registered for llm-pi-ai/github-copilot (requires dsh-llm-pi-ai)"
			});
			return;
		}
		if (runningLogin !== void 0) return;
		const controller = new AbortController();
		runningLogin = {
			key,
			controller
		};
		settlement = void 0;
		pushNotice({ message: "Starting GitHub sign-in…" });
		deps.begin({
			key,
			signal: controller.signal,
			interaction: {
				notify: (notice) => {
					pushNotice(notice);
				},
				prompt: (prompt) => {
					if (isEnterpriseDomainPrompt(prompt)) {
						const domain = (deps.enterpriseDomain ?? "").trim();
						if (domain !== "") pushNotice({ message: `Using GitHub Enterprise domain ${domain}.` });
						return Promise.resolve(domain);
					}
					return new Promise((resolve, reject) => {
						const at = pushPrompt(prompt);
						prompt.signal?.addEventListener("abort", () => {
							pendingAnswers.delete(at);
							reject(/* @__PURE__ */ new Error("prompt withdrawn"));
						}, { once: true });
						pendingAnswers.set(at, {
							resolve,
							reject
						});
					});
				}
			}
		}).then(async (outcome) => {
			if (outcome.status === "authorized") try {
				await autofill();
			} catch (error) {
				pushNotice({ message: `Credential stored, but activating the provider profile failed: ${error instanceof Error ? error.message : String(error)} — retry from the card.` });
			}
			settle(outcome);
		}, (error) => {
			settle(error instanceof AuthorizationDeclinedError ? { status: "cancelled" } : {
				status: "error",
				message: error instanceof Error ? error.message : String(error)
			});
		});
	};
	/** Start the attempt and answer with the event cursor the card polls from. */
	const startLoginImmediate = () => {
		runLogin();
		return seq;
	};
	const pendingAnswers = /* @__PURE__ */ new Map();
	const answerPrompt = (answerSeq, answer, declined) => {
		const waiter = pendingAnswers.get(answerSeq);
		if (waiter === void 0) return false;
		pendingAnswers.delete(answerSeq);
		if (declined) waiter.reject(new AuthorizationDeclinedError());
		else waiter.resolve(answer);
		return true;
	};
	/** The `github-copilot` profile of the resolved `llm-pi-ai` section, or undefined. */
	const copilotProfile = () => {
		const profile = (deps.settingsSection()?.providers)?.[COPILOT_PROVIDER];
		return typeof profile === "object" && profile !== null ? profile : void 0;
	};
	/**
	* The grant's available model ids narrowed to the installed catalog, in
	grant order. `undefined` when either side is unknown or the intersection
	is empty — narrowing to nothing would refuse the route at write time, so
	an unknown list leaves the installed catalog serving untouched.
	*/
	const narrowedModels = async () => {
		const [available, catalog] = await Promise.all([deps.models(), deps.catalogModels()]);
		if (available === void 0 || catalog === void 0) return void 0;
		if (available.length === 0 || catalog.length === 0) return void 0;
		const known = new Set(catalog.map((model) => model.id));
		const ids = available.filter((id) => known.has(id));
		return ids.length > 0 ? ids : void 0;
	};
	/** The `models` list ids a profile already carries, or undefined when it has none. */
	const profileModelIds = (profile) => {
		const models = profile?.models;
		if (!Array.isArray(models) || !models.every((entry) => typeof entry?.id === "string")) return;
		return models.map((entry) => entry.id);
	};
	const sameStrings = (left, right) => left !== void 0 && right !== void 0 && left.length === right.length && left.every((id, at) => id === right[at]);
	/**
	* Ensure the provider profile exists and its `models` list matches what the
	* stored grant reports. The harness model picker serves the profile's
	* resolved list, so this — not pi-ai's request-time `filterModels`, which
	* the harness never consults — is what keeps unavailable models out of the
	* picker. One merged write carries profile creation and model narrowing
	* together; a profile already carrying the derived list costs no revision.
	* A list a user hand-wrote is treated as derived data and re-narrowed on
	* the next sync.
	* @returns what the call did, for the response envelope.
	*/
	const autofill = async () => {
		const profile = copilotProfile();
		const available = await narrowedModels();
		const narrowed = available?.map((id) => ({ id }));
		const changed = narrowed !== void 0 && !sameStrings(profileModelIds(profile), available);
		if (profile !== void 0 && !changed) return "unchanged";
		await deps.updateSettings({ providers: { [COPILOT_PROVIDER]: changed && narrowed !== void 0 ? { models: narrowed } : {} } });
		return profile === void 0 ? "created" : "updated";
	};
	return webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (req, res) => {
			if ((req.method ?? "") !== "POST") {
				writeJson(res, 405, errorEnvelope("method-not-allowed", "POST only"));
				return;
			}
			const originCheck = sameOrigin(req);
			if (originCheck !== void 0) {
				writeJson(res, originCheck.status, errorEnvelope(originCheck.code, originCheck.message));
				return;
			}
			if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
				writeJson(res, 415, errorEnvelope("content-type-not-supported", "application/json required"));
				return;
			}
			const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
			const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(`${API_PREFIX}/`.length) : void 0;
			if (method === void 0 || method.includes("/")) {
				writeJson(res, 404, errorEnvelope("not-found", "unknown copilot API method"));
				return;
			}
			try {
				const body = await readJsonBody(req);
				switch (method) {
					case "status":
						writeJson(res, 200, okEnvelope(await status()));
						return;
					case "login":
						if (runningLogin !== void 0) {
							writeJson(res, 200, okEnvelope({
								status: "in-progress",
								cursor: seq
							}));
							return;
						}
						writeJson(res, 200, okEnvelope({
							status: "started",
							cursor: startLoginImmediate()
						}));
						return;
					case "cancel":
						if (runningLogin === void 0) {
							writeJson(res, 200, okEnvelope({ status: "not-running" }));
							return;
						}
						runningLogin.controller.abort();
						writeJson(res, 200, okEnvelope({ status: "cancelling" }));
						return;
					case "events": {
						const since = typeof body?.since === "number" ? body.since : 0;
						writeJson(res, 200, okEnvelope({
							events: ring.filter((event) => event.seq > since).map((event) => event.kind === "notice" ? {
								seq: event.seq,
								kind: "notice",
								message: event.notice.message,
								...event.notice.url === void 0 ? {} : { url: event.notice.url },
								...event.notice.code === void 0 ? {} : { code: event.notice.code }
							} : {
								seq: event.seq,
								kind: "prompt",
								prompt: event.prompt
							}),
							cursor: seq,
							inFlight: runningLogin !== void 0,
							...settlement === void 0 ? {} : { settlement }
						}));
						return;
					}
					case "answer": {
						const payload = body;
						if (typeof payload.seq !== "number") {
							writeJson(res, 400, errorEnvelope("bad-request", "answer needs a numeric seq"));
							return;
						}
						const declined = payload.declined === true;
						const answer = typeof payload.answer === "string" ? payload.answer : "";
						writeJson(res, 200, okEnvelope({ accepted: answerPrompt(payload.seq, answer, declined) }));
						return;
					}
					case "logout": {
						const key = copilotKey();
						if (key === void 0) {
							writeJson(res, 200, okEnvelope({ status: "not-running" }));
							return;
						}
						if ((await deps.describeRecord(key))?.configured !== true) {
							writeJson(res, 200, okEnvelope({ status: "not-logged-in" }));
							return;
						}
						await deps.deleteRecord(key);
						writeJson(res, 200, okEnvelope({ status: "cleared" }));
						return;
					}
					case "autofill": {
						const before = copilotProfile() !== void 0;
						await autofill();
						writeJson(res, 200, okEnvelope({ status: before ? "already-active" : "activated" }));
						return;
					}
					default: writeJson(res, 404, errorEnvelope("not-found", `unknown copilot API method "${method}"`));
				}
			} catch (error) {
				writeJson(res, 500, errorEnvelope("internal", error instanceof Error ? error.message : String(error)));
			}
		}
	});
}
/** Reject cross-site browser requests: same-origin only, like every plugin route. */
function sameOrigin(req) {
	const origin = req.headers.origin;
	if (typeof origin === "string" && origin !== "") {
		let originHost;
		try {
			originHost = new URL(origin).host;
		} catch {
			return {
				status: 400,
				code: "invalid-origin",
				message: "invalid Origin header"
			};
		}
		const reqHost = req.headers.host;
		if (typeof reqHost === "string" && originHost !== reqHost) return {
			status: 403,
			code: "origin-not-allowed",
			message: "same-origin requests only"
		};
	}
}
/** Read and parse a JSON body from a node:http request. */
async function readJsonBody(req, maxBytes = 8192) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > maxBytes) throw new Error("request body too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return {};
	return JSON.parse(text);
}
/** Write a JSON response envelope. */
function writeJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
/** Build a success envelope. */
function okEnvelope(value) {
	return {
		ok: true,
		value
	};
}
/** Build an error envelope. */
function errorEnvelope(code, message) {
	return {
		ok: false,
		error: {
			code,
			message
		}
	};
}

//#endregion
//#region src/tools.ts
/** Loose canonical-JSON output declaration. */
const JSON_OUTPUT = {
	schema: { type: "json" },
	render: (_args, value) => [{
		type: "text",
		text: JSON.stringify(value)
	}]
};
/**
* Register the status tool.
* @param ctx - host plugin context carrying `ctx.tools`.
* @param sources - the live host reads the status join uses.
*/
function registerCopilotTools(ctx, sources) {
	ctx.tools.register(defineTool({
		name: "copilot_status",
		description: "Report the GitHub Copilot onboarding state: whether the pi-ai authorization flow is registered, whether a credential record is stored (signed in), whether the llm-pi-ai settings section activates the github-copilot provider route, and which model ids the signed-in account can use. Read-only. Signing in is a WebUI action: Settings → Plugins → GitHub Copilot.",
		parameters: {},
		output: JSON_OUTPUT,
		async execute() {
			const status = await joinStatus(sources);
			const result = {
				flow_available: status.flowAvailable,
				signed_in: status.loggedIn,
				profile_activated: status.profileActivated,
				login_in_flight: status.inFlight
			};
			if (!status.flowAvailable) result.hint = "dsh-llm-pi-ai with the github-copilot catalog provider is required for Copilot sign-in.";
			else if (!status.loggedIn) result.hint = "Sign in from the WebUI: Settings → Plugins → GitHub Copilot → Sign in.";
			else if (!status.profileActivated) result.hint = `Signed in but the route is dormant; the settings card can activate it (writes ${COPILOT_SETTINGS_NS}.providers.github-copilot).`;
			if (status.models !== void 0) result.available_models = [...status.models];
			return result;
		},
		presentCall: () => ({
			card: "generic",
			title: "Copilot auth status",
			kind: "read"
		})
	}));
}

//#endregion
//#region src/index.ts
const name = "dsh-plugin-copilot";
const inject = ["tools", "webServer"];
/**
* The plugin's own settings namespace: the card owns no configurable fields,
* but the flow's enterprise question is answered from here.
*/
const CARD_NAMESPACE = settingsNamespace("dsh-plugin-copilot");
const Config = z.object({ enterpriseDomain: z.string().default("").description("GitHub Enterprise domain (e.g. company.ghe.com); blank serves github.com") });
/** The pi-ai settings namespace as a branded settings-namespace value. */
const PI_AI_NS = COPILOT_SETTINGS_NS;
/**
* Plugin body: register the card namespace, the HTTP gateway, and the
* status tool. Every host read goes through optional services (`ctx.get`)
* so a composition without the authorization or credentials seam still
* boots — the card then reports the missing pieces instead of failing load.
* @param ctx - host plugin context.
*/
function apply(ctx, config = { enterpriseDomain: "" }) {
	ctx.inject(["settings"], (sctx) => {
		try {
			sctx.settings.register(CARD_NAMESPACE, Config);
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("already registered")) throw error;
		}
	});
	const authorization = () => ctx.get("authorization");
	const credentials = () => ctx.get("credentials");
	const piAiSection = () => {
		const settings = ctx.get("settings");
		if (settings === void 0) return void 0;
		const raw = settings.get(PI_AI_NS);
		return typeof raw === "object" && raw !== null ? raw : void 0;
	};
	const sources = {
		listFlows: () => authorization()?.list() ?? [],
		describeRecord: async (key) => credentials()?.describeRecord(key),
		settingsSection: piAiSection,
		models: async () => grantModelIds(await credentials()?.readRecord(COPILOT_RECORD_KEY))
	};
	/**
	* The installed pi-ai catalog for the Copilot route, through the llm
	* service's public discovery — a catalog route answers from the registry
	* with no network call. `undefined` (and a swallowed failure, which would
	* only degrade the models narrowing to the untouched catalog) keeps a
	* composition without the llm seam booting.
	*/
	const catalogModels = async () => {
		const llm = ctx.get("llm");
		if (llm === void 0) return void 0;
		try {
			return await llm.discoverModels(COPILOT_SETTINGS_NS, { provider: COPILOT_PROVIDER });
		} catch {
			return;
		}
	};
	ctx.effect(() => registerCopilotGateway(ctx, {
		enterpriseDomain: config.enterpriseDomain,
		listFlows: sources.listFlows,
		models: sources.models,
		catalogModels,
		begin: (request) => {
			const seam = authorization();
			if (seam === void 0) throw new Error("the authorization service is not mounted in this composition");
			return seam.begin(request);
		},
		cancel: (key) => {
			authorization()?.cancel(key);
		},
		describeRecord: sources.describeRecord,
		deleteRecord: (key) => {
			const seam = credentials();
			if (seam === void 0) throw new Error("the credentials service is not mounted in this composition");
			return seam.deleteRecord(key);
		},
		settingsSection: piAiSection,
		updateSettings: async (patch) => {
			const settings = ctx.get("settings");
			if (settings === void 0) throw new Error("the settings service is not mounted; the provider profile cannot be activated");
			await settings.update(PI_AI_NS, patch);
		}
	}), "dsh-plugin-copilot: /copilot/api gateway");
	registerCopilotTools(ctx, sources);
}

//#endregion
export { CARD_NAMESPACE, COPILOT_PROVIDER, COPILOT_RECORD_KEY, COPILOT_SCOPE, COPILOT_SETTINGS_NS, Config, apply, findCopilotFlow, grantModelIds, inject, joinStatus, name, recordAddress, registerCopilotGateway, registerCopilotTools };