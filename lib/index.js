import { CONTEXT_WINDOW_EXCEEDED_CODE, CallId, EMPTY_RESPONSE_CODE, HarnessError, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId, RetryPolicySchema, assertUsableApiKey, attributionHeaders, boundContextSummary, contentHasImage, createUserMessage, isContextWindowExceededError, isQuotaExceededError, offloadRequestImages, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import z from "schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/auth-store.ts
/** Auth-store format version; a mismatching value fails loud (no migrations). */
const AUTH_STORE_VERSION = 1;
/** Typed failure of the auth store; `code` is a stable machine-routing string. */
var AuthStoreError = class extends Error {
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
		this.name = "AuthStoreError";
	}
};
/** Structural guard for the on-disk record; unknown extra keys are ignored. */
function parse(raw) {
	let value;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new AuthStoreError("copilot auth store is not valid JSON", "MALFORMED_AUTH_STORE", { cause: error });
	}
	if (typeof value !== "object" || value === null) throw new AuthStoreError("copilot auth store is not an object", "MALFORMED_AUTH_STORE");
	const record = value;
	if (record.version !== AUTH_STORE_VERSION) throw new AuthStoreError(`copilot auth store version ${String(record.version)} is not supported (expected ${AUTH_STORE_VERSION})`, "AUTH_STORE_VERSION");
	if (typeof record.githubToken !== "string" || record.githubToken.length === 0) throw new AuthStoreError("copilot auth store has no githubToken", "MALFORMED_AUTH_STORE");
	if (record.enterpriseDomain !== void 0 && (typeof record.enterpriseDomain !== "string" || record.enterpriseDomain.length === 0)) throw new AuthStoreError("copilot auth store enterpriseDomain must be a non-empty string", "MALFORMED_AUTH_STORE");
	return {
		version: AUTH_STORE_VERSION,
		githubToken: record.githubToken,
		...record.enterpriseDomain !== void 0 ? { enterpriseDomain: record.enterpriseDomain } : {}
	};
}
/**
* Read the stored auth. A missing file resolves `undefined` (not logged in);
* a malformed or foreign-version file throws {@link AuthStoreError}.
*/
async function loadStoredAuth(file) {
	let raw;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw new AuthStoreError(`copilot auth store ${file} is unreadable`, "AUTH_STORE_UNREADABLE", { cause: error });
	}
	return parse(raw);
}
/**
* Atomically persist the auth record: the payload lands in a sibling temp
* file first, then a `rename()` replace publishes it, so concurrent readers
* see either the previous or the new record — never a partial one.
*/
async function saveStoredAuth(file, auth) {
	const payload = `${JSON.stringify(auth, null, 2)}\n`;
	const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	try {
		await mkdir(dirname(file), { recursive: true });
		await writeFile(temp, payload, {
			encoding: "utf8",
			mode: 384
		});
		await rename(temp, file);
	} catch (error) {
		await rm(temp, { force: true }).catch(() => {});
		throw new AuthStoreError(`copilot auth store ${file} is unwritable`, "AUTH_STORE_UNWRITABLE", { cause: error });
	}
}
/** Remove the auth record; a missing file is a successful no-op. */
async function clearStoredAuth(file) {
	try {
		await rm(file, { force: true });
	} catch (error) {
		throw new AuthStoreError(`copilot auth store ${file} could not be removed`, "AUTH_STORE_UNWRITABLE", { cause: error });
	}
}

//#endregion
//#region src/config.ts
/** Shared device-flow OAuth client id of the opencode GitHub Copilot integration. */
const OAUTH_CLIENT_ID = "Ov23li8tweQw6odWQebz";
/** GitHub API version header value opencode pins for the Copilot API. */
const COPILOT_API_VERSION = "2026-06-01";
/** Default credential-ref environment variable naming the GitHub OAuth token. */
const DEFAULT_TOKEN_ENV = "GITHUB_COPILOT_TOKEN";
/** Default API base for the public GitHub deployment. */
const PUBLIC_COPILOT_BASE_URL = "https://api.githubcopilot.com";
/** Default auth-store file name under the harness home. */
const DEFAULT_AUTH_FILE_NAME = "github-copilot-auth.json";
/** Default TTL of the remote `/models` catalog cache. */
const DEFAULT_MODELS_REFRESH_MS = 3e5;
/** Default per-read idle bound for one provider stream. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Default bound on accumulated base64 image payload per request. */
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
/** Context capacity assumed for models the endpoint metadata does not describe. */
const FALLBACK_CONTEXT_WINDOW = 128e3;
/** Output cap assumed for models the endpoint metadata does not describe. */
const FALLBACK_MAX_OUTPUT_TOKENS = 16384;
/**
* Schemastery schema for the plugin row and the settings section. Strict by
* construction: unknown keys fail validation here.
*/
const Config = z.object({
	enterpriseUrl: z.string(),
	clientId: z.string(),
	apiVersion: z.string(),
	githubTokenEnv: z.string().role("credential-ref"),
	authFile: z.string(),
	baseURL: z.string(),
	modelsRefreshMs: z.number().step(1).min(1e3).max(MAX_TIMER_DELAY_MS),
	defaultReasoningEffort: z.string(),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS),
	maxRequestImageBytes: z.number().step(1).min(1),
	retryPolicy: RetryPolicySchema
});
/** Normalize an enterprise URL or domain to the bare host form opencode uses. */
function normalizeEnterpriseDomain(url) {
	return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
/**
* Derive the Copilot API base for one deployment. An explicit override wins;
* otherwise an enterprise domain routes to `https://copilot-api.{domain}` and
* the public deployment to `https://api.githubcopilot.com` — the same
* derivation as opencode's `base()` helper.
*/
function copilotBaseUrl(baseURL, enterpriseDomain) {
	if (baseURL !== void 0 && baseURL.length > 0) return baseURL.replace(/\/$/, "");
	if (enterpriseDomain !== void 0 && enterpriseDomain.length > 0) return `https://copilot-api.${enterpriseDomain}`;
	return PUBLIC_COPILOT_BASE_URL;
}
/** Default auth-store path under the resolved harness home. */
function defaultAuthFile() {
	return join(resolveDshHome(), DEFAULT_AUTH_FILE_NAME);
}
/**
* The one explicit resolve step from raw config to validated connection
* facts. Programmatic construction may bypass Schemastery normalization, so
* every default and bound is re-judged here — for the composition entry at
* load (fail loud) and for each settings snapshot at its first use.
*/
function resolveConnection(config) {
	const clientId = config.clientId ?? OAUTH_CLIENT_ID;
	if (clientId.length === 0) throw new Error("dsh-plugin-copilot: clientId must be non-empty");
	const apiVersion = config.apiVersion ?? COPILOT_API_VERSION;
	if (apiVersion.length === 0) throw new Error("dsh-plugin-copilot: apiVersion must be non-empty");
	const enterpriseUrl = config.enterpriseUrl ?? "";
	const enterpriseDomain = enterpriseUrl.length > 0 ? normalizeEnterpriseDomain(enterpriseUrl) : void 0;
	if (enterpriseDomain !== void 0 && enterpriseDomain.length === 0) throw new Error("dsh-plugin-copilot: enterpriseUrl must contain a domain");
	if (config.baseURL !== void 0 && /^https?:\/\//.test(config.baseURL) === false) throw new Error("dsh-plugin-copilot: baseURL must be an http(s) URL");
	const modelsRefreshMs = config.modelsRefreshMs ?? DEFAULT_MODELS_REFRESH_MS;
	if (!Number.isSafeInteger(modelsRefreshMs) || modelsRefreshMs < 1e3) throw new Error("dsh-plugin-copilot: modelsRefreshMs must be an integer of at least 1000");
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`dsh-plugin-copilot: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	const maxRequestImageBytes = config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES;
	if (!Number.isSafeInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) throw new Error("dsh-plugin-copilot: maxRequestImageBytes must be a positive safe integer");
	const effort = config.defaultReasoningEffort;
	return {
		clientId,
		apiVersion,
		...enterpriseDomain === void 0 ? {} : { enterpriseDomain },
		...config.baseURL !== void 0 && config.baseURL.length > 0 ? { baseURL: config.baseURL } : {},
		githubTokenEnv: credentialRef(config.githubTokenEnv ?? DEFAULT_TOKEN_ENV),
		authFile: config.authFile !== void 0 && config.authFile.length > 0 ? config.authFile : defaultAuthFile(),
		modelsRefreshMs,
		...effort !== void 0 && effort.length > 0 ? { defaultReasoningEffort: effort } : {},
		streamIdleTimeoutMs,
		maxRequestImageBytes,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "dsh-plugin-copilot: retryPolicy")
	};
}

//#endregion
//#region src/copilot-models.ts
/** Utility models opencode uses for title generation; picker-excluded but requestable. */
const UTILITY_MODELS = [
	"gpt-5.4-nano",
	"gpt-4.1",
	"gpt-4o",
	"gpt-4o-mini"
];
/**
* Static best-effort catalog for requests made before login (or while the
* remote listing is unreachable). Intentionally small: the remote `/models`
* endpoint is the authoritative catalog once a token exists.
*/
const STATIC_FALLBACK_MODELS = [
	{
		id: "gpt-5-mini",
		name: "GPT-5 mini",
		endpoint: "chat",
		pickerEnabled: true,
		contextWindow: 128e3,
		maxOutputTokens: 16384,
		supportsVision: false,
		supportsPdf: false
	},
	{
		id: "gpt-4.1",
		name: "GPT-4.1",
		endpoint: "chat",
		pickerEnabled: true,
		contextWindow: 128e3,
		maxOutputTokens: 32768,
		supportsVision: false,
		supportsPdf: false
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		endpoint: "chat",
		pickerEnabled: true,
		contextWindow: 128e3,
		maxOutputTokens: 16384,
		supportsVision: true,
		supportsPdf: false
	},
	{
		id: "gpt-4o-mini",
		name: "GPT-4o mini",
		endpoint: "chat",
		pickerEnabled: true,
		contextWindow: 128e3,
		maxOutputTokens: 16384,
		supportsVision: true,
		supportsPdf: false
	}
];
/**
* opencode's Responses-API routing rule: GPT-5 class models (except the mini
* variants, which still need chat completions) prefer `/responses`.
*/
function prefersResponsesApi(modelId) {
	const match = /^gpt-(\d+)/.exec(modelId);
	return match !== null && Number(match[1]) >= 5 && !modelId.startsWith("gpt-5-mini");
}
/** Endpoint routing: `/v1/messages` first, then `/responses`, then `/chat/completions`; unknown falls to the GPT-5 heuristic. */
function endpointOf(modelId, supportedEndpoints) {
	if (supportedEndpoints !== void 0) {
		if (supportedEndpoints.includes("/v1/messages")) return "messages";
		if (supportedEndpoints.includes("/responses")) return "responses";
		if (supportedEndpoints.includes("/chat/completions")) return "chat";
	}
	return prefersResponsesApi(modelId) ? "responses" : "chat";
}
/** opencode's usable filter: disabled policy or missing limits/capability drops the model. */
function isUsableRemote(item) {
	return item.id !== void 0 && item.policy?.state !== "disabled" && item.capabilities?.limits?.max_output_tokens !== void 0 && item.capabilities?.limits.max_prompt_tokens !== void 0 && item.capabilities.supports?.tool_calls !== void 0;
}
/** Map one usable remote item to the internal catalog entry. */
function buildModel(item) {
	const id = item.id;
	const supports = item.capabilities?.supports ?? {};
	const limits = item.capabilities?.limits;
	const mediaTypes = limits?.vision?.supported_media_types ?? [];
	const supportsVision = (supports.vision ?? false) || mediaTypes.some((type) => type.startsWith("image/"));
	const supportsPdf = (supports.vision ?? false) && mediaTypes.includes("application/pdf");
	const efforts = supports.reasoning_effort?.filter((effort) => typeof effort === "string" && effort.length > 0);
	const budgets = typeof supports.max_thinking_budget === "number" && supports.max_thinking_budget > 1 ? supports.max_thinking_budget : void 0;
	const isEffortDriven = efforts !== void 0 && efforts.length > 0;
	return {
		id,
		name: item.name ?? id,
		...item.capabilities?.family !== void 0 ? { family: item.capabilities.family } : {},
		endpoint: endpointOf(id, item.supported_endpoints),
		pickerEnabled: item.model_picker_enabled === true,
		...limits?.max_context_window_tokens !== void 0 || limits?.max_prompt_tokens !== void 0 ? { contextWindow: limits.max_context_window_tokens ?? limits.max_prompt_tokens } : {},
		maxOutputTokens: limits?.max_output_tokens,
		supportsVision,
		supportsPdf,
		...isEffortDriven ? { reasoningEfforts: [...efforts] } : {},
		...budgets !== void 0 ? { maxThinkingBudget: budgets } : {},
		...!isEffortDriven && budgets !== void 0 ? { thinkingBudgets: {
			low: Math.floor(budgets / 4),
			high: Math.floor(budgets / 2),
			max: budgets - 1
		} } : {}
	};
}
/** Fetch the remote catalog with the headers one authenticated request carries. */
async function fetchRemoteModels(baseURL, headers, timeoutMs = 5e3, fetchImpl = fetch) {
	const response = await fetchImpl(`${baseURL}/models`, {
		headers: {
			...headers,
			accept: "application/json"
		},
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!response.ok) throw new Error(`Copilot /models request failed with HTTP ${response.status}`);
	const body = await response.json();
	return (Array.isArray(body.data) ? body.data : []).filter(isUsableRemote).map(buildModel);
}
/**
* Catalog selection for harness surfaces: picker-enabled models plus the
* utility models (which stay requestable for session titles even though the
* endpoint hides them from its picker).
*/
function selectableModels(catalog) {
	const utilities = new Set(UTILITY_MODELS);
	return catalog.filter((model) => model.pickerEnabled || utilities.has(model.id));
}
/** Modality declaration for one model: image input only when the model says so. */
function modalities(model) {
	return model.supportsVision ? ["text", "image"] : ["text"];
}
/** Map catalog entries to advisory `LlmModelInfo` values. */
function toModelInfos(provider, catalog) {
	return selectableModels(catalog).map((model) => ({
		provider,
		id: model.id,
		name: model.name,
		...model.family !== void 0 ? { description: `${model.family} family` } : {},
		inputModalities: modalities(model)
	}));
}
/** Effort list for one model: verbatim effort vocabulary, or budget-derived levels. */
function effortsOf(model, connection) {
	if (model.reasoningEfforts !== void 0) return model.reasoningEfforts.map((effort) => ({
		id: ReasoningEffortId(effort),
		name: effort
	}));
	if (model.thinkingBudgets !== void 0) return [
		{
			id: ReasoningEffortId("off"),
			name: "Off"
		},
		{
			id: ReasoningEffortId("low"),
			name: "Low"
		},
		{
			id: ReasoningEffortId("high"),
			name: "High"
		},
		{
			id: ReasoningEffortId("max"),
			name: "Max"
		}
	];
}
/**
* Exact-route metadata for one model. Unknown models resolve with the
* fallback capacities and text-only input (declaring an unverified image
* capability would let the host persist input the endpoint may reject).
*/
function toResolvedModel(provider, model, modelId, connection) {
	const efforts = model === void 0 ? void 0 : effortsOf(model, connection);
	const defaultEffort = efforts !== void 0 && connection.defaultReasoningEffort !== void 0 && efforts.some((entry) => entry.id === connection.defaultReasoningEffort) ? ReasoningEffortId(connection.defaultReasoningEffort) : void 0;
	return {
		provider,
		id: modelId,
		name: model?.name ?? modelId,
		...model === void 0 ? { inputModalities: ["text"] } : { inputModalities: modalities(model) },
		context: { contextWindow: model?.contextWindow ?? FALLBACK_CONTEXT_WINDOW },
		defaultMaxTokens: model?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS,
		...efforts === void 0 ? {} : { reasoning: {
			efforts,
			...defaultEffort === void 0 ? {} : { defaultEffort }
		} }
	};
}

//#endregion
//#region src/headers.ts
/**
* opencode's initiator heuristic, mapped onto the harness request: auxiliary
* purposes (compaction, session titles) are agent-initiated, and so is a turn
* whose last message carries no user-visible content — the harness rides tool
* results inside user messages, so a tool-result-only trailing user message
* is a tool continuation (opencode's Messages-API branch treats it the same
* way). An ordinary prompt is user-initiated.
*/
function initiatorOf(options) {
	if (options.purpose !== void 0) return "agent";
	const last = options.messages.at(-1);
	if (last === void 0 || last.role !== "user") return "agent";
	return last.content.some((block) => block.type !== "tool-result") ? "user" : "agent";
}
/** The exact header set for one Copilot request. */
function requestHeaders(connection, inputs) {
	const headers = {
		"authorization": `Bearer ${inputs.token}`,
		"content-type": "application/json",
		"accept": "text/event-stream",
		"x-github-api-version": connection.apiVersion,
		"openai-intent": "conversation-edits",
		"x-initiator": inputs.initiator,
		...attributionHeaders()
	};
	if (inputs.vision) headers["copilot-vision-request"] = "true";
	if (inputs.purpose === "session-title") headers["x-interaction-type"] = "agent-session-name-generation";
	if (inputs.endpoint === "messages") {
		headers["anthropic-version"] = "2023-06-01";
		headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
	}
	return headers;
}

//#endregion
//#region node_modules/.pnpm/eventsource-parser@3.1.1/node_modules/eventsource-parser/dist/index.js
var ParseError = class extends Error {
	constructor(message, options) {
		super(message), this.name = "ParseError", this.type = options.type, this.field = options.field, this.value = options.value, this.line = options.line;
	}
};
const LF = 10, CR = 13, SPACE = 32;
function noop(_arg) {}
function createParser(config) {
	if (typeof config == "function") throw new TypeError("`config` must be an object, got a function instead. Did you mean `createParser({onEvent: fn})`?");
	const { onEvent = noop, onError = noop, onRetry = noop, onComment, maxBufferSize } = config, pendingFragments = [];
	let pendingFragmentsLength = 0, isFirstChunk = !0, id, data = "", dataLines = 0, eventType, terminated = !1;
	function feed(chunk) {
		if (terminated) throw new Error("Cannot feed parser: it was terminated after exceeding the configured max buffer size. Call `reset()` to resume parsing.");
		if (isFirstChunk && (isFirstChunk = !1, chunk.charCodeAt(0) === 239 && chunk.charCodeAt(1) === 187 && chunk.charCodeAt(2) === 191 && (chunk = chunk.slice(3))), pendingFragments.length === 0) {
			const trailing2 = processLines(chunk);
			trailing2 !== "" && (pendingFragments.push(trailing2), pendingFragmentsLength = trailing2.length), checkBufferSize();
			return;
		}
		if (chunk.indexOf(`
`) === -1 && chunk.indexOf("\r") === -1) {
			pendingFragments.push(chunk), pendingFragmentsLength += chunk.length, checkBufferSize();
			return;
		}
		pendingFragments.push(chunk);
		const input = pendingFragments.join("");
		pendingFragments.length = 0, pendingFragmentsLength = 0;
		const trailing = processLines(input);
		trailing !== "" && (pendingFragments.push(trailing), pendingFragmentsLength = trailing.length), checkBufferSize();
	}
	function checkBufferSize() {
		maxBufferSize !== void 0 && (pendingFragmentsLength + data.length <= maxBufferSize || (terminated = !0, pendingFragments.length = 0, pendingFragmentsLength = 0, id = void 0, data = "", dataLines = 0, eventType = void 0, onError(new ParseError(`Buffered data exceeded max buffer size of ${maxBufferSize} characters`, { type: "max-buffer-size-exceeded" }))));
	}
	function processLines(chunk) {
		let searchIndex = 0;
		if (chunk.indexOf("\r") === -1) {
			let lfIndex = chunk.indexOf(`
`, searchIndex);
			for (; lfIndex !== -1;) {
				if (searchIndex === lfIndex) {
					dataLines > 0 && onEvent({
						id,
						event: eventType,
						data
					}), id = void 0, data = "", dataLines = 0, eventType = void 0, searchIndex = lfIndex + 1, lfIndex = chunk.indexOf(`
`, searchIndex);
					continue;
				}
				const firstCharCode = chunk.charCodeAt(searchIndex);
				if (isDataPrefix(chunk, searchIndex, firstCharCode)) {
					const valueStart = chunk.charCodeAt(searchIndex + 5) === SPACE ? searchIndex + 6 : searchIndex + 5, value = chunk.slice(valueStart, lfIndex);
					if (dataLines === 0 && chunk.charCodeAt(lfIndex + 1) === LF) {
						onEvent({
							id,
							event: eventType,
							data: value
						}), id = void 0, data = "", eventType = void 0, searchIndex = lfIndex + 2, lfIndex = chunk.indexOf(`
`, searchIndex);
						continue;
					}
					data = dataLines === 0 ? value : `${data}
${value}`, dataLines++;
				} else isEventPrefix(chunk, searchIndex, firstCharCode) ? eventType = chunk.slice(chunk.charCodeAt(searchIndex + 6) === SPACE ? searchIndex + 7 : searchIndex + 6, lfIndex) || void 0 : parseLine(chunk, searchIndex, lfIndex);
				searchIndex = lfIndex + 1, lfIndex = chunk.indexOf(`
`, searchIndex);
			}
			return chunk.slice(searchIndex);
		}
		for (; searchIndex < chunk.length;) {
			const crIndex = chunk.indexOf("\r", searchIndex), lfIndex = chunk.indexOf(`
`, searchIndex);
			let lineEnd = -1;
			if (crIndex !== -1 && lfIndex !== -1 ? lineEnd = crIndex < lfIndex ? crIndex : lfIndex : crIndex !== -1 ? crIndex === chunk.length - 1 ? lineEnd = -1 : lineEnd = crIndex : lfIndex !== -1 && (lineEnd = lfIndex), lineEnd === -1) break;
			parseLine(chunk, searchIndex, lineEnd), searchIndex = lineEnd + 1, chunk.charCodeAt(searchIndex - 1) === CR && chunk.charCodeAt(searchIndex) === LF && searchIndex++;
		}
		return chunk.slice(searchIndex);
	}
	function parseLine(chunk, start, end) {
		if (start === end) {
			dispatchEvent();
			return;
		}
		const firstCharCode = chunk.charCodeAt(start);
		if (isDataPrefix(chunk, start, firstCharCode)) {
			const valueStart = chunk.charCodeAt(start + 5) === SPACE ? start + 6 : start + 5, value2 = chunk.slice(valueStart, end);
			data = dataLines === 0 ? value2 : `${data}
${value2}`, dataLines++;
			return;
		}
		if (isEventPrefix(chunk, start, firstCharCode)) {
			eventType = chunk.slice(chunk.charCodeAt(start + 6) === SPACE ? start + 7 : start + 6, end) || void 0;
			return;
		}
		if (firstCharCode === 105 && chunk.charCodeAt(start + 1) === 100 && chunk.charCodeAt(start + 2) === 58) {
			const value2 = chunk.slice(chunk.charCodeAt(start + 3) === SPACE ? start + 4 : start + 3, end);
			value2.includes("\0") || (id = value2);
			return;
		}
		if (firstCharCode === 58) {
			if (onComment) onComment(chunk.slice(start, end).slice(chunk.charCodeAt(start + 1) === SPACE ? 2 : 1));
			return;
		}
		const line = chunk.slice(start, end), fieldSeparatorIndex = line.indexOf(":");
		if (fieldSeparatorIndex === -1) {
			processField(line, "", line);
			return;
		}
		const field = line.slice(0, fieldSeparatorIndex), offset = line.charCodeAt(fieldSeparatorIndex + 1) === SPACE ? 2 : 1;
		processField(field, line.slice(fieldSeparatorIndex + offset), line);
	}
	function processField(field, value, line) {
		switch (field) {
			case "event":
				eventType = value || void 0;
				break;
			case "data":
				data = dataLines === 0 ? value : `${data}
${value}`, dataLines++;
				break;
			case "id":
				value.includes("\0") || (id = value);
				break;
			case "retry":
				/^\d+$/.test(value) ? onRetry(parseInt(value, 10)) : onError(new ParseError(`Invalid \`retry\` value: "${value}"`, {
					type: "invalid-retry",
					value,
					line
				}));
				break;
			default:
				onError(new ParseError(`Unknown field "${field.length > 20 ? `${field.slice(0, 20)}\u2026` : field}"`, {
					type: "unknown-field",
					field,
					value,
					line
				}));
				break;
		}
	}
	function dispatchEvent() {
		dataLines > 0 && onEvent({
			id,
			event: eventType,
			data
		}), id = void 0, data = "", dataLines = 0, eventType = void 0;
	}
	function reset(options = {}) {
		if (options.consume && pendingFragments.length > 0) {
			const incompleteLine = pendingFragments.join("");
			parseLine(incompleteLine, 0, incompleteLine.length);
		}
		isFirstChunk = !0, id = void 0, data = "", dataLines = 0, eventType = void 0, pendingFragments.length = 0, pendingFragmentsLength = 0, terminated = !1;
	}
	return {
		feed,
		reset
	};
}
function isDataPrefix(chunk, i, firstCharCode) {
	return firstCharCode === 100 && chunk.charCodeAt(i + 1) === 97 && chunk.charCodeAt(i + 2) === 116 && chunk.charCodeAt(i + 3) === 97 && chunk.charCodeAt(i + 4) === 58;
}
function isEventPrefix(chunk, i, firstCharCode) {
	return firstCharCode === 101 && chunk.charCodeAt(i + 1) === 118 && chunk.charCodeAt(i + 2) === 101 && chunk.charCodeAt(i + 3) === 110 && chunk.charCodeAt(i + 4) === 116 && chunk.charCodeAt(i + 5) === 58;
}

//#endregion
//#region node_modules/.pnpm/eventsource-parser@3.1.1/node_modules/eventsource-parser/dist/stream.js
var EventSourceParserStream = class extends TransformStream {
	constructor({ onError, onRetry, onComment, maxBufferSize } = {}) {
		let parser;
		super({
			start(controller) {
				parser = createParser({
					onEvent: (event) => {
						controller.enqueue(event);
					},
					onError(error) {
						typeof onError == "function" && onError(error), (onError === "terminate" || error.type === "max-buffer-size-exceeded") && controller.error(error);
					},
					onRetry,
					onComment,
					maxBufferSize
				});
			},
			transform(chunk) {
				parser.feed(chunk);
			}
		});
	}
};

//#endregion
//#region src/wire/shared.ts
/**
* Parse an SSE byte stream into `{event, data}` events. Framing — chunk
* reassembly, UTF-8/CRLF/BOM handling, comment skipping, multi-`data:`
* joining — is `eventsource-parser`'s. Comments and activity pulses go to the
* optional callback. Unlike the DeepSeek adapter's data-only parser, the
* three Copilot protocols have different terminators, so the raw events are
* yielded and each protocol's translate owns its terminal check.
*/
async function* parseSseEvents(stream, onActivity) {
	const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment: onActivity === void 0 ? void 0 : () => onActivity() }));
	for await (const chunk of events) {
		if (chunk.data === void 0) continue;
		onActivity?.();
		yield {
			event: chunk.event ?? "message",
			data: chunk.data
		};
	}
}
/** Parse one event's JSON payload; malformed JSON aborts with `MALFORMED_RESPONSE`. */
function parseJsonPayload(payload) {
	try {
		return JSON.parse(payload);
	} catch {
		throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
	}
}
/** Best-effort parse of a non-2xx body; a malformed gateway body keeps the status message. */
function parseErrorBody(raw) {
	try {
		const value = JSON.parse(raw);
		const error = value.error;
		if (typeof error === "object" && error !== null) {
			const record = error;
			const message = typeof record.message === "string" ? record.message : void 0;
			const type = typeof record.type === "string" ? record.type : void 0;
			return {
				message,
				detail: [
					typeof record.code === "string" ? record.code : void 0,
					type,
					message
				].filter(Boolean).join(" ")
			};
		}
		if (typeof value.message === "string") return {
			message: value.message,
			detail: value.message
		};
	} catch {}
	return { detail: "" };
}
/** Map an HTTP status to a stable `LlmError` code (Copilot flavor of the DeepSeek mapping). */
function httpErrorCode(status, detail) {
	if (status === 401 || status === 403) return "AUTH";
	if (status === 413) return "INVALID_REQUEST";
	if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
	if (status === 429) return "RATE_LIMIT";
	if (status === 400) {
		if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
		return "INVALID_REQUEST";
	}
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}
/** Parse a `retry-after` header (delta-seconds or HTTP date) into milliseconds. */
function providerRetryAfterMs(value) {
	if (value === null) return void 0;
	if (/^\d+$/.test(value)) {
		const delay$1 = Number(value) * 1e3;
		return Number.isFinite(delay$1) && delay$1 > 0 ? delay$1 : void 0;
	}
	const delay = Date.parse(value) - Date.now();
	return Number.isFinite(delay) && delay > 0 ? delay : void 0;
}
/** Extract the provider request id used by the Copilot API (`x-request-id`). */
function requestId(headers) {
	const value = headers.get("x-request-id") ?? headers.get("x-github-request-id");
	return value === null || value.length === 0 ? void 0 : ProviderRequestId(value);
}
/** Build the `LlmError` for one non-2xx provider response, retry metadata attached. */
async function httpError(response) {
	const parsed = parseErrorBody(await response.text().catch(() => ""));
	const message = parsed.message ?? `Copilot API error (HTTP ${response.status})`;
	const delay = providerRetryAfterMs(response.headers.get("retry-after"));
	const id = requestId(response.headers);
	return new LlmError(message, httpErrorCode(response.status, parsed.detail), {
		status: response.status,
		...delay === void 0 ? {} : { providerRetryAfterMs: delay },
		...id === void 0 ? {} : { requestId: id }
	});
}
/** Map OpenAI usage to disjoint harness counts; cache reads leave `inputTokens`. */
function mapOpenAiUsage(usage) {
	const cacheRead = usage.prompt_tokens_details?.cached_tokens;
	const reasoning = usage.completion_tokens_details?.reasoning_tokens;
	return {
		inputTokens: (usage.prompt_tokens ?? 0) - (cacheRead ?? 0),
		outputTokens: usage.completion_tokens ?? 0,
		...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
	};
}
/** Map Anthropic usage (two partial reports merge into one value). */
function mapAnthropicUsage(...parts) {
	const merged = {};
	for (const part of parts) {
		if (part.input_tokens !== void 0) merged.input_tokens = part.input_tokens;
		if (part.output_tokens !== void 0) merged.output_tokens = part.output_tokens;
		if (part.cache_read_input_tokens !== void 0) merged.cache_read_input_tokens = part.cache_read_input_tokens;
		if (part.cache_creation_input_tokens !== void 0) merged.cache_creation_input_tokens = part.cache_creation_input_tokens;
	}
	const cacheRead = merged.cache_read_input_tokens;
	const cacheWrite = merged.cache_creation_input_tokens;
	return {
		inputTokens: (merged.input_tokens ?? 0) - (cacheRead ?? 0),
		outputTokens: merged.output_tokens ?? 0,
		...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
		...cacheWrite !== void 0 ? { cacheWriteTokens: cacheWrite } : {}
	};
}
/** Map Responses-API usage to disjoint harness counts. */
function mapResponsesUsage(usage) {
	const cacheRead = usage.input_tokens_details?.cached_tokens;
	const reasoning = usage.output_tokens_details?.reasoning_tokens;
	return {
		inputTokens: (usage.input_tokens ?? 0) - (cacheRead ?? 0),
		outputTokens: usage.output_tokens ?? 0,
		...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
	};
}

//#endregion
//#region src/wire/chat.ts
/** Join the text blocks of a message. */
function flattenText$2(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Reject core image content before a text-flattening path can silently erase it. */
function assertTextOnly(message) {
	if (message.role !== "user" && contentHasImage(message.content)) throw new LlmError(`The Copilot chat-completions protocol cannot represent image content in a ${message.role} message.`, "UNSUPPORTED_CONTENT");
}
/** Resolve one durable image into its transient data-URL part. */
async function imagePart(block, attachments, signal) {
	const stored = await attachments.readImage(block.attachment, signal);
	return {
		type: "image_url",
		image_url: { url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}` }
	};
}
/** Convert user or nested tool-result blocks into ordered wire parts. */
async function contentParts(blocks, attachments, signal) {
	const parts = [];
	for (const block of blocks) switch (block.type) {
		case "text":
			if (block.text.length > 0) parts.push({
				type: "text",
				text: block.text
			});
			break;
		case "image":
			if (attachments === void 0) throw new LlmError("Copilot image input requires the durable attachment service.", "UNSUPPORTED_CONTENT");
			parts.push(await imagePart(block, attachments, signal));
			break;
		case "tool-result":
			parts.push(...await contentParts(block.content, attachments, signal));
			break;
		default: break;
	}
	return parts;
}
/** Serialize one assistant message (text + tool calls; reasoning is not replayed). */
function serializeAssistant(message) {
	const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
		id: block.id,
		type: "function",
		function: {
			name: block.name,
			arguments: block.arguments
		}
	}));
	return {
		role: "assistant",
		content: flattenText$2(message.content),
		...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
	};
}
/**
* Serialize the conversation. `tool-result` blocks become standalone
* `{role: 'tool'}` messages; tool-result images follow as one user message.
*/
async function serializeMessages(messages, images) {
	const attachments = images?.attachments;
	const signal = images?.signal ?? new AbortController().signal;
	const wire = [];
	let pendingToolImages = [];
	const flushToolImages = () => {
		if (pendingToolImages.length === 0) return;
		wire.push({
			role: "user",
			content: [{
				type: "text",
				text: "Attached image(s) from tool result:"
			}, ...pendingToolImages]
		});
		pendingToolImages = [];
	};
	for (const message of messages) {
		assertTextOnly(message);
		if (message.role === "system") {
			flushToolImages();
			wire.push({
				role: "system",
				content: flattenText$2(message.content)
			});
			continue;
		}
		if (message.role === "assistant") {
			flushToolImages();
			wire.push(serializeAssistant(message));
			continue;
		}
		const regular = message.content.filter((block) => block.type !== "tool-result");
		const toolResults = message.content.filter((block) => block.type === "tool-result");
		const parts = await contentParts(regular, attachments, signal);
		const textOnly = parts.every((part) => part.type === "text");
		const text = parts.map((part) => part.type === "text" ? part.text : "").join("");
		if (text.length > 0 || toolResults.length === 0) {
			flushToolImages();
			wire.push({
				role: "user",
				content: textOnly ? text : parts
			});
		}
		for (const result of toolResults) {
			const resultParts = await contentParts(result.content, attachments, signal);
			const resultImages = resultParts.filter((part) => part.type === "image_url");
			const resultText = resultParts.filter((part) => part.type === "text").map((part) => part.text).join("");
			wire.push({
				role: "tool",
				tool_call_id: result.toolCallId,
				content: resultText || (resultImages.length > 0 ? "(see attached image)" : "(no output)")
			});
			pendingToolImages.push(...resultImages);
		}
	}
	flushToolImages();
	return wire;
}
/** Whether the gpt-family output-token omission applies (opencode parity: substring match). */
function omitsMaxTokens(modelId) {
	return modelId.includes("gpt");
}
/**
* Build the full chat-completions request. Always streaming with usage
* reporting; optional fields are omitted rather than sent as null.
* gpt-family models never carry `max_tokens` (GitHub Copilot CLI parity).
*/
async function serializeChatRequest(options, model, images) {
	const requestMessages = images === void 0 ? options.messages : offloadRequestImages(options.messages, images.maxImageBytes);
	const messages = [];
	if (options.system !== void 0) messages.push({
		role: "system",
		content: options.system
	});
	messages.push(...await serializeMessages(requestMessages, images));
	const tools = options.tools?.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
	const effort = options.reasoningEffort;
	const supportsEffort = effort !== void 0 && model?.reasoningEfforts !== void 0 && model.reasoningEfforts.includes(effort);
	return {
		model: options.model,
		messages,
		stream: true,
		stream_options: { include_usage: true },
		...tools !== void 0 && tools.length > 0 ? { tools } : {},
		...options.temperature !== void 0 ? { temperature: options.temperature } : {},
		...omitsMaxTokens(options.model) || options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens },
		...options.stop !== void 0 ? { stop: options.stop } : {},
		...supportsEffort && effort !== "off" ? { reasoning_effort: effort } : {}
	};
}
/** Map the wire finish_reason vocabulary to the harness FinishReason. */
function mapFinishReason(reason) {
	switch (reason) {
		case "stop": return { kind: "stop" };
		case "tool_calls": return { kind: "tool-calls" };
		case "length": return { kind: "max-tokens" };
		default: return {
			kind: "error",
			failure: {
				message: `model stopped: ${reason}`,
				code: reason.toUpperCase()
			}
		};
	}
}
/** Assemble the final ContentBlock for one open block. */
function closeBlock$2(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: CallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Consume SSE events (terminated by the `data: [DONE]` sentinel) and yield
* StreamChunks. Deltas stream through as they arrive; `block-end`s, usage,
* and finish are deferred to the sentinel, so no chunk follows `finish`. A
* `stop` (or absent) finish with no opened blocks is a degenerate completion
* and maps to an `EMPTY_RESPONSE` error finish.
*/
async function* translateChat(events) {
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	const toolBlocks = /* @__PURE__ */ new Map();
	const order = [];
	let pendingFinish;
	let pendingUsage;
	function open(kind) {
		const block = {
			index: nextIndex++,
			kind,
			text: ""
		};
		order.push(block);
		return block;
	}
	for await (const { data } of events) {
		if (data === "[DONE]") {
			for (const block of order) yield {
				type: "block-end",
				index: block.index,
				block: closeBlock$2(block)
			};
			if (pendingUsage) yield {
				type: "usage",
				usage: pendingUsage
			};
			const reason = pendingFinish ?? { kind: "stop" };
			yield {
				type: "finish",
				reason: reason.kind === "stop" && order.length === 0 ? {
					kind: "error",
					failure: {
						message: "model returned a completed response with no content",
						code: EMPTY_RESPONSE_CODE
					}
				} : reason
			};
			return;
		}
		const chunk = parseJsonPayload(data);
		for (const choice of chunk.choices ?? []) {
			const delta = choice.delta;
			const reasoning = delta?.reasoning_content;
			if (typeof reasoning === "string" && reasoning.length > 0) {
				if (!reasoningBlock) {
					reasoningBlock = open("reasoning");
					yield {
						type: "block-start",
						index: reasoningBlock.index,
						blockType: "reasoning"
					};
				}
				reasoningBlock.text += reasoning;
				yield {
					type: "reasoning-delta",
					index: reasoningBlock.index,
					text: reasoning
				};
			}
			const content = delta?.content;
			if (typeof content === "string" && content.length > 0) {
				if (!textBlock) {
					textBlock = open("text");
					yield {
						type: "block-start",
						index: textBlock.index,
						blockType: "text"
					};
				}
				textBlock.text += content;
				yield {
					type: "text-delta",
					index: textBlock.index,
					text: content
				};
			}
			for (const call of delta?.tool_calls ?? []) {
				const key = call.index ?? 0;
				let block = toolBlocks.get(key);
				if (!block) {
					block = open("tool-call");
					toolBlocks.set(key, block);
					yield {
						type: "block-start",
						index: block.index,
						blockType: "tool-call"
					};
				}
				if (call.id !== void 0) block.callId = call.id;
				if (call.function?.name !== void 0) block.name = call.function.name;
				const fragment = call.function?.arguments ?? "";
				block.text += fragment;
				yield {
					type: "tool-call-delta",
					index: block.index,
					id: CallId(block.callId ?? ""),
					...block.name !== void 0 ? { name: block.name } : {},
					argumentsDelta: fragment
				};
			}
			if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
		}
		if (chunk.usage !== void 0) pendingUsage = mapOpenAiUsage(chunk.usage);
	}
	throw new LlmError("Copilot chat stream ended without [DONE]", "STREAM_CLOSED");
}

//#endregion
//#region src/wire/responses.ts
/** Join the text blocks of a message. */
function flattenText$1(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Reject image content in roles whose Responses item cannot carry it. */
function assertSupportedImageRoles$1(messages) {
	for (const message of messages) if (message.role !== "user" && contentHasImage(message.content)) throw new LlmError(`The Copilot responses protocol cannot represent image content in a ${message.role} message.`, "UNSUPPORTED_CONTENT");
}
/** Convert user text/image blocks into ordered input parts. */
async function userParts$1(blocks, attachments, signal) {
	const parts = [];
	for (const block of blocks) switch (block.type) {
		case "text":
			if (block.text.length > 0) parts.push({
				type: "input_text",
				text: block.text
			});
			break;
		case "image": {
			if (attachments === void 0) throw new LlmError("Copilot image input requires the durable attachment service.", "UNSUPPORTED_CONTENT");
			const stored = await attachments.readImage(block.attachment, signal);
			parts.push({
				type: "input_image",
				image_url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}`
			});
			break;
		}
		default: break;
	}
	return parts;
}
/** Serialize the conversation into Responses input items. */
async function serializeInput(messages, images) {
	assertSupportedImageRoles$1(messages);
	const attachments = images?.attachments;
	const signal = images?.signal ?? new AbortController().signal;
	const items = [];
	for (const message of messages) {
		if (message.role === "system") {
			const text = flattenText$1(message.content);
			if (text.length > 0) items.push({
				role: "system",
				content: text
			});
			continue;
		}
		if (message.role === "assistant") {
			const text = flattenText$1(message.content);
			if (text.length > 0) items.push({
				role: "assistant",
				content: text
			});
			for (const block of message.content) if (block.type === "tool-call") items.push({
				type: "function_call",
				call_id: block.id,
				name: block.name,
				arguments: block.arguments
			});
			continue;
		}
		const parts = await userParts$1(message.content.filter((block) => block.type !== "tool-result"), attachments, signal);
		if (parts.length > 0) items.push({
			role: "user",
			content: parts.every((part) => part.type === "input_text") && parts.length === 1 ? parts[0].text : parts
		});
		for (const block of message.content) {
			if (block.type !== "tool-result") continue;
			const nested = await userParts$1(block.content, attachments, signal);
			const text = nested.filter((part) => part.type === "input_text").map((part) => part.text).join("");
			const hasImage = nested.some((part) => part.type === "input_image");
			items.push({
				type: "function_call_output",
				call_id: block.toolCallId,
				output: text || (hasImage ? "(image output not supported here)" : "(no output)")
			});
		}
	}
	return items;
}
/** Build the full `/responses` request. gpt-family models omit the output cap (opencode parity). */
async function serializeResponsesRequest(options, model, images) {
	const items = await serializeInput(images === void 0 ? options.messages : offloadRequestImages(options.messages, images.maxImageBytes), images);
	const tools = options.tools?.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		strict: false
	}));
	const effort = options.reasoningEffort;
	const supportsEffort = effort !== void 0 && model?.reasoningEfforts !== void 0 && model.reasoningEfforts.includes(effort);
	return {
		model: options.model,
		input: items,
		stream: true,
		...options.system !== void 0 ? { instructions: options.system } : {},
		...tools !== void 0 && tools.length > 0 ? { tools } : {},
		...options.temperature !== void 0 ? { temperature: options.temperature } : {},
		...options.model.includes("gpt") || options.maxTokens === void 0 ? {} : { max_output_tokens: options.maxTokens },
		...supportsEffort && effort !== "off" ? { reasoning: { effort } } : {}
	};
}
function closeBlock$1(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: CallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Consume SSE events (terminated by `response.completed` / `response.incomplete`)
* and yield StreamChunks with the same buffering discipline as the chat
* protocol. `response.failed` and top-level `error` events abort with
* `LlmError`; EOF before a terminal event is `STREAM_CLOSED`.
*/
async function* translateResponses(events) {
	let nextIndex = 0;
	const blocks = /* @__PURE__ */ new Map();
	const order = [];
	let sawToolCall = false;
	function* openFor(key, kind) {
		let block = blocks.get(key);
		if (block === void 0) {
			block = {
				index: nextIndex++,
				kind,
				text: ""
			};
			blocks.set(key, block);
			order.push(block);
			yield {
				type: "block-start",
				index: block.index,
				blockType: kind
			};
		}
		return block;
	}
	for await (const event of events) {
		const parsed = parseJsonPayload(event.data);
		const type = parsed.type ?? event.event;
		if (type === "response.output_item.added") {
			const item = parsed.item;
			const key = String(parsed.output_index ?? item?.id ?? "");
			if (item?.type === "function_call") {
				sawToolCall = true;
				const block = yield* openFor(key, "tool-call");
				block.callId = item.call_id;
				block.name = item.name;
			}
			continue;
		}
		if (type === "response.output_text.delta") {
			const delta = parsed.delta;
			if (typeof delta === "string" && delta.length > 0) {
				const block = yield* openFor(`${parsed.output_index ?? ""}:${parsed.content_index ?? ""}`, "text");
				block.text += delta;
				yield {
					type: "text-delta",
					index: block.index,
					text: delta
				};
			}
			continue;
		}
		if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
			const delta = parsed.delta;
			if (typeof delta === "string" && delta.length > 0) {
				const block = yield* openFor(String(parsed.output_index ?? parsed.item?.id ?? ""), "reasoning");
				block.text += delta;
				yield {
					type: "reasoning-delta",
					index: block.index,
					text: delta
				};
			}
			continue;
		}
		if (type === "response.function_call_arguments.delta") {
			const delta = parsed.delta;
			if (typeof delta === "string" && delta.length > 0) {
				sawToolCall = true;
				const block = yield* openFor(String(parsed.output_index ?? ""), "tool-call");
				block.text += delta;
				yield {
					type: "tool-call-delta",
					index: block.index,
					id: CallId(block.callId ?? ""),
					...block.name !== void 0 ? { name: block.name } : {},
					argumentsDelta: delta
				};
			}
			continue;
		}
		if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
			const response = parsed.response;
			if (type === "response.failed") throw new LlmError(response?.error?.message ?? "Copilot responses request failed", "SERVER");
			for (const block of order) yield {
				type: "block-end",
				index: block.index,
				block: closeBlock$1(block)
			};
			if (response?.usage !== void 0) yield {
				type: "usage",
				usage: mapResponsesUsage(response.usage)
			};
			let reason;
			if (type === "response.incomplete") reason = response?.incomplete_details?.reason === "max_output_tokens" ? { kind: "max-tokens" } : {
				kind: "error",
				failure: {
					message: `response incomplete: ${response?.incomplete_details?.reason ?? "unknown reason"}`,
					code: "RESPONSE_INCOMPLETE"
				}
			};
			else if (sawToolCall) reason = { kind: "tool-calls" };
			else reason = { kind: "stop" };
			yield {
				type: "finish",
				reason: reason.kind === "stop" && order.length === 0 ? {
					kind: "error",
					failure: {
						message: "model returned a completed response with no content",
						code: EMPTY_RESPONSE_CODE
					}
				} : reason
			};
			return;
		}
		if (type === "error") throw new LlmError(parsed.message ?? "Copilot responses stream reported an error", "SERVER");
	}
	throw new LlmError("Copilot responses stream ended without a terminal event", "STREAM_CLOSED");
}

//#endregion
//#region src/wire/messages.ts
/** Join the text blocks of a message. */
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Reject image content in roles the Anthropic shim cannot carry it. */
function assertSupportedImageRoles(messages) {
	for (const message of messages) if (message.role !== "user" && contentHasImage(message.content)) throw new LlmError(`The Copilot messages protocol cannot represent image content in a ${message.role} message.`, "UNSUPPORTED_CONTENT");
}
/** Parse a stored tool-call argument string into the object Anthropic expects. */
function parseToolInput(argumentsRaw) {
	if (argumentsRaw.length === 0) return {};
	try {
		const value = JSON.parse(argumentsRaw);
		return typeof value === "object" && value !== null ? value : { value };
	} catch {
		return { raw: argumentsRaw };
	}
}
/** Convert user text/image blocks into ordered wire content. */
async function userParts(blocks, attachments, signal) {
	const parts = [];
	for (const block of blocks) switch (block.type) {
		case "text":
			if (block.text.length > 0) parts.push({
				type: "text",
				text: block.text
			});
			break;
		case "image": {
			if (attachments === void 0) throw new LlmError("Copilot image input requires the durable attachment service.", "UNSUPPORTED_CONTENT");
			const stored = await attachments.readImage(block.attachment, signal);
			parts.push({
				type: "image",
				source: {
					type: "base64",
					media_type: stored.ref.mediaType,
					data: Buffer.from(stored.data).toString("base64")
				}
			});
			break;
		}
		default: break;
	}
	return parts;
}
/**
* Serialize the conversation. In-history system text merges into the
* top-level `system` (Anthropic reserves the role); tool results ride inside
* user messages as `tool_result` blocks, images nested under them included.
*/
async function serializeConversation(messages, images) {
	assertSupportedImageRoles(messages);
	const attachments = images?.attachments;
	const signal = images?.signal ?? new AbortController().signal;
	const wire = [];
	const systemParts = [];
	for (const message of messages) {
		if (message.role === "system") {
			const text = flattenText(message.content);
			if (text.length > 0) systemParts.push(text);
			continue;
		}
		if (message.role === "assistant") {
			const content = [];
			const text = flattenText(message.content);
			if (text.length > 0) content.push({
				type: "text",
				text
			});
			for (const block of message.content) if (block.type === "tool-call") content.push({
				type: "tool_use",
				id: block.id,
				name: block.name,
				input: parseToolInput(block.arguments)
			});
			if (content.length > 0) wire.push({
				role: "assistant",
				content
			});
			continue;
		}
		const parts = await userParts(message.content.filter((block) => block.type !== "tool-result"), attachments, signal);
		for (const block of message.content) {
			if (block.type !== "tool-result") continue;
			const nested = await userParts(block.content, attachments, signal);
			const resultContent = nested.length > 0 ? nested : [{
				type: "text",
				text: "(no output)"
			}];
			parts.push({
				type: "tool_result",
				tool_use_id: block.toolCallId,
				content: resultContent,
				...block.isError === true ? { is_error: true } : {}
			});
		}
		if (parts.length > 0) wire.push({
			role: "user",
			content: parts
		});
	}
	return {
		...systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {},
		messages: wire
	};
}
/** Thinking budget for one effort id, or `undefined` when thinking stays off. */
function thinkingBudgetOf(model, effort) {
	if (model?.thinkingBudgets === void 0) return void 0;
	if (effort === void 0 || effort === "off") return void 0;
	const budget = model.thinkingBudgets[effort];
	return typeof budget === "number" && budget >= 1024 ? budget : void 0;
}
/** Build the full `/v1/messages` request. `max_tokens` is mandatory here (even for gpt ids). */
async function serializeMessagesRequest(options, model, images) {
	const conversation = await serializeConversation(images === void 0 ? options.messages : offloadRequestImages(options.messages, images.maxImageBytes), images);
	const tools = options.tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters
	}));
	const baseMaxTokens = options.maxTokens ?? model?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS;
	const budget = thinkingBudgetOf(model, options.reasoningEffort);
	const maxTokens = budget !== void 0 ? Math.max(baseMaxTokens, budget + 1) : baseMaxTokens;
	const system = [options.system, conversation.system].filter((part) => part !== void 0 && part.length > 0).join("\n\n");
	return {
		model: options.model,
		max_tokens: maxTokens,
		messages: conversation.messages,
		stream: true,
		...system.length > 0 ? { system } : {},
		...tools !== void 0 && tools.length > 0 ? { tools } : {},
		...options.temperature !== void 0 ? { temperature: options.temperature } : {},
		...options.stop !== void 0 ? { stop_sequences: options.stop } : {},
		...budget !== void 0 ? { thinking: {
			type: "enabled",
			budget_tokens: budget
		} } : {}
	};
}
function closeBlock(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: CallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/** Map the Anthropic stop_reason vocabulary to the harness FinishReason. */
function mapStopReason(reason) {
	switch (reason) {
		case "end_turn":
		case "stop_sequence": return { kind: "stop" };
		case "tool_use": return { kind: "tool-calls" };
		case "max_tokens": return { kind: "max-tokens" };
		default: return {
			kind: "error",
			failure: {
				message: `model stopped: ${reason}`,
				code: reason.toUpperCase()
			}
		};
	}
}
/**
* Consume SSE events (terminated by `message_stop`) and yield StreamChunks
* with the shared buffering discipline. `error` events abort with
* `LlmError`; EOF before `message_stop` is `STREAM_CLOSED`.
*/
async function* translateMessages(events) {
	let nextIndex = 0;
	const blocks = /* @__PURE__ */ new Map();
	const order = [];
	const startUsage = {};
	let pendingStopReason;
	function* openFor(key, kind) {
		let block = blocks.get(key);
		if (block === void 0) {
			block = {
				index: nextIndex++,
				kind,
				text: ""
			};
			blocks.set(key, block);
			order.push(block);
			yield {
				type: "block-start",
				index: block.index,
				blockType: kind
			};
		}
		return block;
	}
	for await (const event of events) {
		const parsed = parseJsonPayload(event.data);
		const type = parsed.type ?? event.event;
		if (type === "message_start") {
			if (parsed.message?.usage !== void 0) Object.assign(startUsage, parsed.message.usage);
			continue;
		}
		if (type === "content_block_start") {
			const block = parsed.content_block;
			const key = parsed.index ?? 0;
			if (block?.type === "text") yield* openFor(key, "text");
			else if (block?.type === "thinking") yield* openFor(key, "reasoning");
			else if (block?.type === "tool_use") {
				const wire = yield* openFor(key, "tool-call");
				wire.callId = block.id;
				wire.name = block.name;
			}
			continue;
		}
		if (type === "content_block_delta") {
			const key = parsed.index ?? 0;
			const delta = parsed.delta;
			if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
				const block = yield* openFor(key, "text");
				block.text += delta.text;
				yield {
					type: "text-delta",
					index: block.index,
					text: delta.text
				};
			} else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
				const block = yield* openFor(key, "reasoning");
				block.text += delta.thinking;
				yield {
					type: "reasoning-delta",
					index: block.index,
					text: delta.thinking
				};
			} else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
				const block = yield* openFor(key, "tool-call");
				if (delta.partial_json.length > 0) {
					block.text += delta.partial_json;
					yield {
						type: "tool-call-delta",
						index: block.index,
						id: CallId(block.callId ?? ""),
						...block.name !== void 0 ? { name: block.name } : {},
						argumentsDelta: delta.partial_json
					};
				}
			}
			continue;
		}
		if (type === "message_delta") {
			if (typeof parsed.delta?.stop_reason === "string") pendingStopReason = parsed.delta.stop_reason;
			if (parsed.usage !== void 0) Object.assign(startUsage, parsed.usage);
			continue;
		}
		if (type === "message_stop") {
			for (const block of order) yield {
				type: "block-end",
				index: block.index,
				block: closeBlock(block)
			};
			const usage = mapAnthropicUsage(startUsage);
			if (usage.inputTokens !== 0 || usage.outputTokens !== 0 || usage.cacheReadTokens !== void 0 || usage.cacheWriteTokens !== void 0) yield {
				type: "usage",
				usage
			};
			const reason = pendingStopReason === void 0 ? { kind: "stop" } : mapStopReason(pendingStopReason);
			yield {
				type: "finish",
				reason: reason.kind === "stop" && order.length === 0 ? {
					kind: "error",
					failure: {
						message: "model returned a completed response with no content",
						code: EMPTY_RESPONSE_CODE
					}
				} : reason
			};
			return;
		}
		if (type === "error") throw new LlmError(parsed.error?.message ?? "Copilot messages stream reported an error", "SERVER");
	}
	throw new LlmError("Copilot messages stream ended without message_stop", "STREAM_CLOSED");
}

//#endregion
//#region \0@oxc-project+runtime@0.95.0/helpers/usingCtx.js
function _usingCtx() {
	var r = "function" == typeof SuppressedError ? SuppressedError : function(r$1, e$1) {
		var n$1 = Error();
		return n$1.name = "SuppressedError", n$1.error = r$1, n$1.suppressed = e$1, n$1;
	}, e = {}, n = [];
	function using(r$1, e$1) {
		if (null != e$1) {
			if (Object(e$1) !== e$1) throw new TypeError("using declarations can only be used with objects, functions, null, or undefined.");
			if (r$1) var o = e$1[Symbol.asyncDispose || Symbol["for"]("Symbol.asyncDispose")];
			if (void 0 === o && (o = e$1[Symbol.dispose || Symbol["for"]("Symbol.dispose")], r$1)) var t = o;
			if ("function" != typeof o) throw new TypeError("Object is not disposable.");
			t && (o = function o$1() {
				try {
					t.call(e$1);
				} catch (r$2) {
					return Promise.reject(r$2);
				}
			}), n.push({
				v: e$1,
				d: o,
				a: r$1
			});
		} else r$1 && n.push({
			d: e$1,
			a: r$1
		});
		return e$1;
	}
	return {
		e,
		u: using.bind(null, !1),
		a: using.bind(null, !0),
		d: function d() {
			var o, t = this.e, s = 0;
			function next() {
				for (; o = n.pop();) try {
					if (!o.a && 1 === s) return s = 0, n.push(o), Promise.resolve().then(next);
					if (o.d) {
						var r$1 = o.d.call(o.v);
						if (o.a) return s |= 2, Promise.resolve(r$1).then(next, err);
					} else s |= 1;
				} catch (r$2) {
					return err(r$2);
				}
				if (1 === s) return t !== e ? Promise.reject(t) : Promise.resolve();
				if (t !== e) throw t;
			}
			function err(n$1) {
				return t = t !== e ? new r(n$1, t) : n$1, next();
			}
			return next();
		}
	};
}

//#endregion
//#region src/adapter.ts
/** Watchdog code distinguishing a stalled provider stream from other failures. */
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
/** Effective API base: an explicit override wins, then the token's domain, then config. */
function effectiveBase(connection, auth) {
	return copilotBaseUrl(connection.baseURL, auth.enterpriseDomain ?? connection.enterpriseDomain);
}
/** The lightweight header set the catalog fetch carries (no stream accept header). */
function catalogHeaders(connection, auth) {
	return {
		"authorization": `Bearer ${auth.token}`,
		"accept": "application/json",
		"x-github-api-version": connection.apiVersion,
		...attributionHeaders()
	};
}
/**
* The Copilot provider adapter. One stable signal reaches both initial fetch
* and body reads; caller aborts map to `ABORTED`, the configured per-read
* idle watchdog maps to `TIMEOUT`.
*/
var CopilotAdapter = class extends LlmAdapter {
	cache;
	ongoingRefresh;
	constructor(config) {
		super();
		this.config = config;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "GitHub Copilot"
		};
	}
	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}
	/**
	* Advisory model catalog: picker-enabled plus utility models from the
	* remote listing, or the static fallback when no token exists yet or the
	* endpoint is unreachable. Never throws — an advisory catalog must not
	* break a lookup.
	*/
	async listModels(provider) {
		return toModelInfos(provider, await this.catalogOrFallback());
	}
	/** Exact-route metadata from the latest catalog snapshot (fallback capacities for unknown ids). */
	async resolveModel(provider, model, _signal) {
		const connection = this.config.options();
		return toResolvedModel(provider, (await this.catalogOrFallback()).find((entry) => entry.id === model), model, connection);
	}
	/** Fresh-or-stale catalog snapshot; refreshes in the background when stale. */
	async catalogOrFallback() {
		const connection = this.config.options();
		const cached = this.cache;
		if (cached !== void 0 && cached.models.length > 0 && Date.now() - cached.fetchedAt < connection.modelsRefreshMs) return cached.models;
		try {
			return await this.refreshCatalog(connection);
		} catch {
			if (cached !== void 0 && cached.models.length > 0) return cached.models;
			return STATIC_FALLBACK_MODELS;
		}
	}
	async refreshCatalog(connection) {
		const existing = this.ongoingRefresh;
		if (existing !== void 0) return existing;
		const promise = this.doRefreshCatalog(connection).finally(() => {
			if (this.ongoingRefresh === promise) this.ongoingRefresh = void 0;
		});
		this.ongoingRefresh = promise;
		return promise;
	}
	async doRefreshCatalog(connection) {
		const auth = await this.config.resolveAuth(connection);
		const models = await fetchRemoteModels(effectiveBase(connection, auth), catalogHeaders(connection, auth), 5e3, this.config.fetchImpl);
		if (models.length > 0) this.cache = {
			models,
			fetchedAt: Date.now()
		};
		return models.length > 0 ? models : this.cache?.models ?? STATIC_FALLBACK_MODELS;
	}
	async *stream(options) {
		try {
			var _usingCtx$1 = _usingCtx();
			const connection = this.config.options();
			const auth = await this.config.resolveAuth(connection);
			const vision = options.messages.some((message) => contentHasImage(message.content));
			let images;
			if (vision) {
				const attachments = this.config.resolveAttachments();
				if (attachments === void 0) throw new LlmError("Copilot image conversion requires the durable attachment service.", "UNSUPPORTED_CONTENT");
				images = {
					attachments,
					signal: options.signal ?? new AbortController().signal,
					maxImageBytes: connection.maxRequestImageBytes
				};
			}
			const model = this.cache?.models.find((entry) => entry.id === options.model);
			const baseURL = effectiveBase(connection, auth);
			const consumer = new AbortController();
			const upstream = options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
			const watchdog = _usingCtx$1.u(idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE));
			const iterator = this.request(options, watchdog.signal, connection, auth, model, baseURL, images, vision, () => {
				watchdog.pulse();
			})[Symbol.asyncIterator]();
			let exhausted = false;
			try {
				while (true) {
					const result = await watchdog.next(iterator);
					if (result.done) {
						exhausted = true;
						return;
					}
					yield result.value;
				}
			} catch (error) {
				if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) throw new LlmError(`Copilot stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
				if (options.signal?.aborted) throw new LlmError("Copilot request aborted by caller", "ABORTED", { cause: error });
				if (error instanceof LlmError) throw error;
				throw new LlmError(`Copilot API stream from ${baseURL} failed`, "TRANSPORT", { cause: error });
			} finally {
				consumer.abort("Copilot stream consumer stopped");
				if (!exhausted && iterator.return !== void 0) try {
					await iterator.return();
				} catch (_abortedTransportTeardown) {}
			}
		} catch (_) {
			_usingCtx$1.e = _;
		} finally {
			_usingCtx$1.d();
		}
	}
	async *request(options, signal, connection, auth, model, baseURL, images, vision, onActivity) {
		const endpoint = model?.endpoint ?? endpointOf(options.model, void 0);
		const [body, url] = await serializeFor(endpoint, options, model, images, baseURL);
		const headers = requestHeaders(connection, {
			token: auth.token,
			endpoint,
			vision,
			initiator: initiatorOf(options),
			...options.purpose !== void 0 ? { purpose: options.purpose } : {}
		});
		let response;
		try {
			response = await (this.config.fetchImpl ?? fetch)(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal
			});
		} catch (error) {
			if (signal.aborted) throw error;
			throw new LlmError(`Copilot API request to ${baseURL} failed`, "TRANSPORT", { cause: error });
		}
		if (!response.ok) throw await httpError(response);
		if (!response.body) throw new LlmError("Copilot API returned no response body", "EMPTY_RESPONSE");
		if (endpoint === "chat") yield* translateChat(parseSseEvents(response.body, onActivity));
		else if (endpoint === "responses") yield* translateResponses(parseSseEvents(response.body, onActivity));
		else yield* translateMessages(parseSseEvents(response.body, onActivity));
	}
};
/** Serialize one request body and its URL for the routed endpoint. */
async function serializeFor(endpoint, options, model, images, baseURL) {
	if (endpoint === "chat") return [await serializeChatRequest(options, model, images), `${baseURL}/chat/completions`];
	if (endpoint === "responses") return [await serializeResponsesRequest(options, model, images), `${baseURL}/responses`];
	return [await serializeMessagesRequest(options, model, images), `${baseURL}/v1/messages`];
}

//#endregion
//#region src/device-flow.ts
/**
* GitHub OAuth device flow (RFC 8628) for GitHub Copilot, behaviorally
* identical to opencode's `auth.login.github-copilot` method: request a
* device code from `{domain}/login/device/code`, show the verification URL
* and user code, then poll `{domain}/login/oauth/access_token` until the
* user approves, denies, or the code expires. `slow_down` honors the RFC's
* +5s and a server-provided interval, always padded with the same 3s clock
* skew margin opencode adds.
*
* `fetch` and `sleep` are injectable so the whole state machine unit-tests
* offline.
*
* @module @huanlin/dsh-plugin-copilot/device-flow
*/
/** Extra polling delay so we never poll slightly before the server expects (opencode parity). */
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3e3;
/** Default polling interval when the device response omits one (RFC suggests 5s). */
const DEFAULT_DEVICE_INTERVAL_S = 5;
/** Thrown when the caller cancels a polling session; tools map it to a cancel value. */
var DeviceFlowCancelled = class extends Error {
	constructor() {
		super("copilot device-flow login cancelled");
		this.name = "DeviceFlowCancelled";
	}
};
function deviceCodeUrl(domain) {
	return `https://${domain}/login/device/code`;
}
function accessTokenUrl(domain) {
	return `https://${domain}/login/oauth/access_token`;
}
/** Default sleep: a timer that rejects with {@link DeviceFlowCancelled} when the signal aborts first. */
function sleepWithSignal(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new DeviceFlowCancelled());
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DeviceFlowCancelled());
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
/** JSON POST helper shared by both endpoints; non-2xx fails loud. */
async function postJson(url, body, fetchImpl) {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			"accept": "application/json",
			"content-type": "application/json"
		},
		body: JSON.stringify(body)
	});
	if (!response.ok) throw new Error(`GitHub OAuth request to ${url} failed with HTTP ${response.status}`);
	return await response.json();
}
/**
* Begin a device-flow session on `domain` (github.com or an enterprise
* host). The caller shows {@link DeviceFlowStart.verificationUri} and
* {@link DeviceFlowStart.userCode} to the user, then hands the value to
* {@link pollDeviceFlow}.
*/
async function startDeviceFlow(domain, clientId, deps = {}) {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const data = await postJson(deviceCodeUrl(domain), {
		client_id: clientId,
		scope: "read:user"
	}, fetchImpl);
	if (typeof data.verification_uri !== "string" || typeof data.user_code !== "string" || typeof data.device_code !== "string") throw new Error("GitHub device authorization response is missing required fields");
	const intervalS = typeof data.interval === "number" && data.interval > 0 ? data.interval : DEFAULT_DEVICE_INTERVAL_S;
	return {
		verificationUri: data.verification_uri,
		userCode: data.user_code,
		deviceCode: data.device_code,
		intervalMs: intervalS * 1e3,
		...typeof data.expires_in === "number" ? { expiresInSeconds: data.expires_in } : {}
	};
}
/**
* Poll until the flow settles. Every wait honors `signal`; aborting throws
* {@link DeviceFlowCancelled}. Terminal outcomes per RFC 8628 plus GitHub's
* vocabulary: `access_denied` → denied, `expired_token` → expired, anything
* else → failed with the server-provided description.
*/
async function pollDeviceFlow(start, domain, clientId, signal, deps = {}) {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const sleep = deps.sleep ?? sleepWithSignal;
	let intervalMs = start.intervalMs;
	while (true) {
		const data = await postJson(accessTokenUrl(domain), {
			client_id: clientId,
			device_code: start.deviceCode,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code"
		}, fetchImpl);
		if (typeof data.access_token === "string" && data.access_token.length > 0) return {
			kind: "authorized",
			githubToken: data.access_token
		};
		if (data.error === "authorization_pending") {
			await sleep(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, signal);
			continue;
		}
		if (data.error === "slow_down") {
			intervalMs = typeof data.interval === "number" && data.interval > 0 ? data.interval * 1e3 : intervalMs + 5e3;
			await sleep(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, signal);
			continue;
		}
		if (data.error === "access_denied") return { kind: "denied" };
		if (data.error === "expired_token") return { kind: "expired" };
		return {
			kind: "failed",
			message: data.error_description ?? data.error ?? "GitHub device flow failed without an error code"
		};
	}
}

//#endregion
//#region src/tools.ts
const PLUGIN_NAME = "dsh-plugin-copilot";
/** Loose canonical-JSON output declaration shared by all four tools. */
const JSON_OUTPUT = {
	schema: { type: "json" },
	render: (_args, value) => [{
		type: "text",
		text: JSON.stringify(value)
	}]
};
/** Resolve the deployment domain one login attempt targets. */
function loginDomain(connection, enterpriseUrl) {
	const configured = enterpriseUrl !== void 0 && enterpriseUrl.trim().length > 0 ? normalizeEnterpriseDomain(enterpriseUrl.trim()) : connection.enterpriseDomain ?? "github.com";
	return configured.length > 0 ? configured : "github.com";
}
/**
* Register the four tools. One pending login slot lives in this closure:
* a fresh `copilot_login` overwrites it, and a restart drops it (the user
* simply starts the flow again — no durable half-logged-in state exists).
*/
function registerCopilotTools(ctx, deps) {
	let pending;
	ctx.tools.register(defineTool({
		name: "copilot_login",
		description: "Start GitHub Copilot login via the OAuth device flow. Returns a verification URL and a user code: show both to the user and ask them to open the URL, enter the code, and approve the \"GitHub Copilot Request\" authorization, then call copilot_login_wait to finish. Safe to call again at any time; a new call invalidates any previous pending login.",
		parameters: { enterprise_url: {
			type: "string",
			description: "GitHub Enterprise domain or URL (e.g. company.ghe.com). Omit for the public github.com deployment; omission follows the plugin configuration."
		} },
		output: JSON_OUTPUT,
		async execute(args, exec) {
			const connection = deps.options();
			const domain = loginDomain(connection, args.enterprise_url);
			const start = await startDeviceFlow(domain, connection.clientId);
			pending = {
				start,
				domain
			};
			exec.deferContext(createUserMessage({
				content: [{
					type: "text",
					text: `GitHub Copilot login pending: open ${start.verificationUri} and enter code ${start.userCode}.`
				}],
				source: {
					kind: "plugin",
					plugin: PLUGIN_NAME,
					form: "notice",
					summary: boundContextSummary(`copilot_login: code ${start.userCode} at ${start.verificationUri}`)
				}
			}));
			return {
				status: "awaiting_authorization",
				verification_uri: start.verificationUri,
				user_code: start.userCode,
				...start.expiresInSeconds !== void 0 ? { expires_in_seconds: start.expiresInSeconds } : {},
				domain,
				next_step: "Show the URL and code to the user; when they have approved, call copilot_login_wait."
			};
		},
		presentCall: () => ({
			card: "generic",
			title: "GitHub Copilot login",
			kind: "other"
		})
	}));
	ctx.tools.register(defineTool({
		name: "copilot_login_wait",
		description: "Wait for the pending GitHub Copilot device-flow login to finish (the user approving in their browser). Call only after copilot_login returned a user code the user has seen. Returns the final login status; an authorized result stores the token and the GitHub Copilot provider is ready on the next request. Cancelling this tool stops waiting without logging out.",
		parameters: {},
		output: JSON_OUTPUT,
		async execute(_args, exec) {
			const connection = deps.options();
			if (pending === void 0) return {
				status: "no_pending_login",
				hint: "No device-flow login is in progress; call copilot_login first."
			};
			const { start, domain } = pending;
			let outcome;
			try {
				outcome = await pollDeviceFlow(start, domain, connection.clientId, exec.signal);
			} catch (error) {
				if (error instanceof DeviceFlowCancelled) return {
					status: "cancelled",
					hint: "Waiting was cancelled; the pending code may still be valid — call copilot_login_wait again."
				};
				throw error;
			}
			const result = { status: outcome.kind };
			if (outcome.kind === "authorized") {
				await saveStoredAuth(connection.authFile, {
					version: 1,
					githubToken: outcome.githubToken,
					...domain === "github.com" ? {} : { enterpriseDomain: domain }
				});
				pending = void 0;
				result.domain = domain;
				result.stored_at = connection.authFile;
				result.note = "GitHub Copilot is ready; the next model request will use the new token.";
			} else {
				pending = void 0;
				if (outcome.kind === "denied") result.note = "The user denied the authorization request.";
				else if (outcome.kind === "expired") result.note = "The user code expired; call copilot_login to start over.";
				else result.message = outcome.message;
			}
			return result;
		},
		presentCall: () => ({
			card: "generic",
			title: "Waiting for Copilot approval",
			kind: "other"
		})
	}));
	ctx.tools.register(defineTool({
		name: "copilot_status",
		description: "Report the GitHub Copilot provider auth state: whether a token is stored from a device-flow login, where it lives, the deployment domain in use, and — when a token exists — how many models the Copilot API currently lists for the account. Read-only.",
		parameters: {},
		output: JSON_OUTPUT,
		async execute() {
			const connection = deps.options();
			let stored;
			try {
				stored = await loadStoredAuth(connection.authFile);
			} catch (error) {
				return {
					authenticated: false,
					auth_file: connection.authFile,
					store_error: error instanceof Error ? error.message : String(error)
				};
			}
			if (stored === void 0) {
				let source = "none";
				try {
					await deps.resolveAuth(connection);
					source = "credential";
				} catch {}
				const result$1 = {
					authenticated: source === "credential",
					source,
					auth_file: connection.authFile
				};
				if (connection.enterpriseDomain !== void 0) result$1.enterprise_domain = connection.enterpriseDomain;
				if (source === "none") result$1.hint = `Run copilot_login, or export the ${connection.githubTokenEnv} environment variable.`;
				return result$1;
			}
			const domain = stored.enterpriseDomain ?? connection.enterpriseDomain;
			const baseURL = copilotBaseUrl(connection.baseURL, domain);
			const result = {
				authenticated: true,
				source: "device-flow",
				auth_file: connection.authFile,
				api_base: baseURL
			};
			if (domain !== void 0) result.enterprise_domain = domain;
			try {
				result.model_count = (await fetchRemoteModels(baseURL, {
					authorization: `Bearer ${stored.githubToken}`,
					"accept": "application/json",
					"x-github-api-version": connection.apiVersion
				})).length;
			} catch (error) {
				result.probe_error = error instanceof Error ? error.message : String(error);
			}
			return result;
		},
		presentCall: () => ({
			card: "generic",
			title: "Copilot auth status",
			kind: "read"
		})
	}));
	ctx.tools.register(defineTool({
		name: "copilot_logout",
		description: "Remove the stored GitHub Copilot token (device-flow login). The provider stops working on the next request unless a credential-ref environment variable (e.g. GITHUB_COPILOT_TOKEN) is configured. Does not revoke the authorization on github.com.",
		parameters: {},
		output: JSON_OUTPUT,
		async execute() {
			const connection = deps.options();
			let stored;
			try {
				stored = await loadStoredAuth(connection.authFile);
			} catch (error) {
				throw new HarnessError(`copilot_logout: stored auth is unreadable (${error instanceof Error ? error.message : String(error)}); remove the auth file manually to proceed.`, "COPILOT_LOGOUT_UNREADABLE_STORE");
			}
			if (stored === void 0) return { status: "not_logged_in" };
			await clearStoredAuth(connection.authFile);
			const result = { status: "cleared" };
			result.auth_file = connection.authFile;
			return result;
		},
		presentCall: () => ({
			card: "generic",
			title: "Copilot logout",
			kind: "other"
		})
	}));
}

//#endregion
//#region src/index.ts
const name = "dsh-plugin-copilot";
const inject = ["llm", "tools"];
const NS = settingsNamespace("dsh-plugin-copilot");
/** The single provider route this plugin owns. */
const PROVIDER = "github-copilot";
function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = resolveConnection(raw);
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error("dsh-plugin-copilot: keeping the last good configuration after an invalid settings section");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();
	const resolveAuth = async (connection) => {
		let stored;
		try {
			stored = await loadStoredAuth(connection.authFile);
		} catch (error) {
			throw new LlmError(`dsh-plugin-copilot: ${error instanceof AuthStoreError ? error.message : "auth store is unreadable"} (${connection.authFile})`, "INVALID_CREDENTIAL", { cause: error });
		}
		if (stored !== void 0) return {
			token: assertUsableApiKey(stored.githubToken, name, "device-flow"),
			...stored.enterpriseDomain === void 0 ? {} : { enterpriseDomain: stored.enterpriseDomain },
			source: "device-flow"
		};
		const ref = connection.githubTokenEnv;
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const hit = await credentials.resolve(ref);
			if (hit !== void 0) return {
				token: assertUsableApiKey(hit.value, name, ref),
				source: "credential"
			};
		} else {
			const ambient = launchEnvironmentOf(ctx).get(ref);
			if (ambient !== void 0 && ambient.value.length > 0) return {
				token: assertUsableApiKey(ambient.value, name, ref),
				source: "credential"
			};
		}
		throw new LlmError(`dsh-plugin-copilot: no GitHub token for provider route "${PROVIDER}"; ask the model to run the copilot_login tool, or export ${ref} in the launching environment`, "MISSING_CREDENTIAL");
	};
	const adapter = new CopilotAdapter({
		options,
		resolveAuth,
		resolveAttachments: () => ctx.get("attachments")
	});
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "GitHub Copilot",
		settingsNs: NS,
		settingsPath: []
	}]);
	const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
	let registeredPolicy = options().retryPolicy;
	const ensureRegistrationFacts = () => {
		const policy = options().retryPolicy;
		if (deepEqualJson(policy, registeredPolicy)) return;
		registration.replace([PROVIDER]);
		registeredPolicy = policy;
	};
	installSettingsSection(ctx, NS, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: ensureRegistrationFacts
	});
	registerCopilotTools(ctx, {
		options,
		resolveAuth
	});
}

//#endregion
export { AuthStoreError, Config, CopilotAdapter, STATIC_FALLBACK_MODELS, UTILITY_MODELS, apply, clearStoredAuth, copilotBaseUrl, endpointOf, inject, loadStoredAuth, name, normalizeEnterpriseDomain, pollDeviceFlow, prefersResponsesApi, registerCopilotTools, resolveConnection, saveStoredAuth, startDeviceFlow };