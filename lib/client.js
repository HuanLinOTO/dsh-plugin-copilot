window.__ModuleLoader__.load({ id: "@huanlin/dsh-plugin-copilot", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);
let __deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
__deepseek_ai_dsh_client_store = __toESM(__deepseek_ai_dsh_client_store);

//#region src/client/CopilotAuthCard.tsx
const cardStyle = {
	border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22))",
	background: "var(--dsw-alias-bg-layer-3, transparent)",
	borderRadius: 12,
	listStyle: "none"
};
const headerStyle = {
	width: "100%",
	font: "inherit",
	color: "inherit",
	textAlign: "left",
	cursor: "pointer",
	background: "transparent",
	border: 0,
	borderRadius: 12,
	alignItems: "center",
	gap: 12,
	padding: "14px 16px",
	display: "flex",
	boxSizing: "border-box"
};
const headTextStyle = {
	flexDirection: "column",
	flex: 1,
	gap: 4,
	minWidth: 0,
	display: "flex"
};
const titleStyle = {
	color: "var(--dsw-alias-label-primary, inherit)",
	fontSize: 15,
	fontWeight: 600,
	lineHeight: 1.4
};
const descStyle = {
	color: "var(--dsw-alias-label-tertiary, rgba(128,128,128,0.7))",
	fontSize: 13,
	lineHeight: 1.5
};
const badgeStyle = (tone) => ({
	whiteSpace: "nowrap",
	background: tone === "ok" ? "var(--dsw-alias-state-success-bg, rgba(48,209,88,0.14))" : "var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.12))",
	color: tone === "ok" ? "var(--dsw-alias-state-success-primary, #30d158)" : "var(--dsw-alias-label-secondary, inherit)",
	borderRadius: 999,
	flex: "none",
	padding: "1px 8px",
	fontSize: 11,
	fontWeight: 500,
	lineHeight: "17px"
});
const bodyStyle = {
	borderTop: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22))",
	margin: "0 16px",
	padding: "12px 0 4px",
	display: "flex",
	flexDirection: "column",
	gap: 12
};
const noticeStyle = {
	color: "var(--dsw-alias-label-secondary, inherit)",
	margin: 0,
	fontSize: 12,
	lineHeight: 1.6
};
const errorStyle = {
	color: "var(--dsw-alias-label-error, #ff453a)",
	margin: 0,
	fontSize: 12,
	lineHeight: 1.6
};
const successStyle = {
	color: "var(--dsw-alias-state-success-primary, #30d158)",
	margin: 0,
	fontSize: 12,
	lineHeight: 1.6
};
const codeRowStyle = {
	alignItems: "center",
	gap: 10,
	display: "flex",
	flexWrap: "wrap"
};
const codeStyle = {
	fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)",
	fontSize: 20,
	fontWeight: 700,
	letterSpacing: 2,
	color: "var(--dsw-alias-label-primary, inherit)"
};
const btnBase = {
	appearance: "none",
	font: "inherit",
	cursor: "pointer",
	border: "1px solid transparent",
	borderRadius: 8,
	padding: "5px 14px",
	fontSize: 13,
	fontWeight: 500,
	lineHeight: "20px",
	color: "var(--dsw-alias-label-primary, inherit)",
	background: "var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.12))"
};
const btnPrimary = {
	...btnBase,
	background: "var(--dsw-alias-brand-primary, #0a84ff)",
	color: "var(--dsw-alias-bg-layer-1, #fff)"
};
const actionsStyle = {
	display: "flex",
	gap: 8,
	flexWrap: "wrap",
	paddingBottom: 10
};
const inputStyle = {
	flex: 1,
	padding: "6px 10px",
	fontSize: 13,
	borderRadius: 8,
	border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))",
	background: "var(--dsw-alias-bg-layer-3, transparent)",
	color: "var(--dsw-alias-label-primary, inherit)",
	boxSizing: "border-box",
	fontFamily: "inherit",
	minWidth: 0
};
const modelsStyle = {
	fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)",
	fontSize: 12,
	color: "var(--dsw-alias-label-secondary, inherit)",
	overflowWrap: "anywhere"
};
const CHEVRON_SVG = "<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M6 9l6 6 6-6\"/></svg>";
/**
* Render the Copilot onboarding card.
* @param props - locale + controller inject.
* @returns a `<li>` card element.
*/
function CopilotAuthCard({ t, controller, useCard }) {
	const state = useCard((snapshot) => snapshot);
	const [open, setOpen] = (0, react.useState)(false);
	const [promptAnswer, setPromptAnswer] = (0, react.useState)("");
	if (!state.loaded) controller.load();
	const unsupported = state.loaded && !state.status.flowAvailable;
	const loginRevealed = state.login.kind !== "idle";
	const expanded = open || unsupported || loginRevealed;
	const busy = state.busy;
	const header = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
		type: "button",
		style: headerStyle,
		"aria-expanded": expanded,
		"aria-label": t("card.title"),
		onClick: () => {
			setOpen(!open);
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: headTextStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: titleStyle,
					children: t("card.title")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: descStyle,
					children: t("card.intro")
				})]
			}),
			state.status.loggedIn ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: badgeStyle("ok"),
				children: t("card.signedIn")
			}) : state.loaded && state.status.flowAvailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: badgeStyle("warn"),
				children: t("card.signedOut")
			}) : null,
			state.status.loggedIn ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: badgeStyle(state.status.profileActivated ? "ok" : "warn"),
				children: t(state.status.profileActivated ? "card.routeActive" : "card.routeDormant")
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: {
					color: "var(--dsw-alias-label-tertiary, inherit)",
					flex: "none",
					display: "inline-flex",
					transform: expanded ? "rotate(180deg)" : "none"
				},
				dangerouslySetInnerHTML: { __html: CHEVRON_SVG }
			})
		]
	});
	if (!expanded) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
		style: cardStyle,
		children: header
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
		style: cardStyle,
		children: [header, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: bodyStyle,
			children: [
				unsupported ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: noticeStyle,
					role: "status",
					children: t("card.unsupported")
				}) : null,
				!unsupported && state.login.kind === "idle" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [state.status.loggedIn ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: actionsStyle,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: btnPrimary,
						disabled: busy,
						onClick: () => {
							controller.login();
						},
						children: t("action.signIn")
					})
				}), state.status.loggedIn ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: actionsStyle,
					children: [
						!state.status.profileActivated ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: btnPrimary,
							disabled: busy,
							onClick: () => {
								controller.autofill();
							},
							children: t("action.activate")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: btnBase,
							disabled: busy,
							onClick: () => {
								controller.autofill();
							},
							children: t("action.syncModels")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: btnBase,
							disabled: busy,
							onClick: () => {
								controller.logout();
							},
							children: t("action.signOut")
						})
					]
				}) : null] }) : null,
				state.login.kind === "running" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: noticeStyle,
						role: "status",
						children: t("state.pending")
					}),
					state.deviceCode !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: codeRowStyle,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: noticeStyle,
								children: t("notice.deviceCode")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: codeStyle,
								children: state.deviceCode
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: btnBase,
								onClick: () => {
									navigator.clipboard?.writeText(state.deviceCode ?? "");
									controller.markCopied();
								},
								children: t(state.copied ? "action.copied" : "action.copyCode")
							}),
							state.verificationUrl !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: btnBase,
								onClick: () => {
									window.open(state.verificationUrl, "_blank", "noopener,noreferrer,width=960,height=760");
								},
								children: t("action.openUrl")
							}) : null
						]
					}) : null,
					state.events.filter((event) => event.kind === "notice" && event.code === void 0 && event.message).slice(-2).map((event) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: noticeStyle,
						children: event.message
					}, event.seq)),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: actionsStyle,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: btnBase,
							disabled: busy,
							onClick: () => {
								controller.cancel();
							},
							children: t("action.cancel")
						})
					})
				] }) : null,
				state.openPrompt !== void 0 && state.openPrompt.prompt !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: noticeStyle,
						role: "status",
						children: t("state.pendingPrompt")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: noticeStyle,
						children: state.openPrompt.prompt.message
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: codeRowStyle,
						children: [state.openPrompt.prompt.options === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: state.openPrompt.prompt.kind === "secret" ? "password" : "text",
							style: inputStyle,
							value: promptAnswer,
							placeholder: state.openPrompt.prompt.placeholder ?? t("prompt.placeholder"),
							onChange: (event) => {
								setPromptAnswer(event.target.value);
							}
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: btnPrimary,
							disabled: busy,
							onClick: () => {
								controller.answer(promptAnswer, false);
								setPromptAnswer("");
							},
							children: t("action.submit")
						})] }) : state.openPrompt.prompt.options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: btnBase,
							onClick: () => {
								controller.answer(option.id, false);
							},
							children: option.label
						}, option.id)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: btnBase,
							onClick: () => {
								controller.answer("", true);
							},
							children: t("action.decline")
						})]
					})
				] }) : null,
				state.login.kind === "success" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: successStyle,
					role: "status",
					children: t("state.success")
				}) : null,
				(state.login.kind === "idle" || state.login.kind === "success") && state.status.models !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					style: noticeStyle,
					children: [
						t("card.models"),
						" ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: modelsStyle,
							children: state.status.models.length > 0 ? state.status.models.join(", ") : "—"
						})
					]
				}) : null,
				state.login.kind === "cancelled" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					style: noticeStyle,
					role: "status",
					children: [
						t("state.error"),
						" ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: btnBase,
							disabled: busy,
							onClick: () => {
								controller.login();
							},
							children: t("action.retry")
						})
					]
				}) : null,
				state.login.kind === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					style: errorStyle,
					role: "status",
					children: [
						t("state.error"),
						": ",
						state.login.message,
						" ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: btnBase,
							disabled: busy,
							onClick: () => {
								controller.login();
							},
							children: t("action.retry")
						})
					]
				}) : null
			]
		})]
	});
}

//#endregion
//#region src/client/controller.ts
/** Initial state before the first load. */
function initialState() {
	return {
		loaded: false,
		status: {
			flowAvailable: false,
			loggedIn: false,
			profileActivated: false,
			inFlight: false,
			models: void 0
		},
		login: { kind: "idle" },
		events: [],
		deviceCode: void 0,
		verificationUrl: void 0,
		openPrompt: void 0,
		copied: false,
		busy: false
	};
}
/** Call one `/copilot/api/<method>` endpoint. */
async function call(method, payload = {}) {
	const response = await fetch(`/copilot/api/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload)
	});
	const parsed = await response.json().catch(() => null);
	if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === void 0) throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
	return parsed.value;
}
/**
* Controller managing the Copilot card lifecycle. Constructed once in the
* client `apply()`; polls only while a login attempt is running or the card
* holds an unanswered prompt.
*/
var CopilotAuthController = class {
	store;
	cursor = 0;
	pollTimer;
	disposed = false;
	constructor() {
		this.store = (0, __deepseek_ai_dsh_client_store.createSnapshotStore)(initialState());
	}
	/** Load the joined status from the host. */
	async load() {
		try {
			const status = await call("status");
			this.store.update((s) => {
				s.loaded = true;
				s.status = status;
				if (status.inFlight && s.login.kind === "idle") {
					s.login = { kind: "running" };
					this.schedulePoll(0);
				}
			});
		} catch {
			this.store.update((s) => {
				s.loaded = true;
			});
		}
	}
	/** Start a login attempt, then poll events until settlement. */
	async login() {
		if (this.disposed) return;
		this.store.update((s) => {
			s.busy = true;
			s.login = { kind: "running" };
			s.events = [];
			s.deviceCode = void 0;
			s.verificationUrl = void 0;
			s.openPrompt = void 0;
		});
		try {
			this.cursor = (await call("login")).cursor ?? this.cursor;
		} catch (error) {
			this.finishLogin("error", error instanceof Error ? error.message : String(error));
			return;
		}
		this.store.update((s) => {
			s.busy = false;
		});
		this.schedulePoll(0);
	}
	/** Withdraw the running attempt. */
	async cancel() {
		this.store.update((s) => {
			s.busy = true;
		});
		try {
			await call("cancel");
		} catch {}
		this.store.update((s) => {
			s.busy = false;
		});
	}
	/** Answer the open prompt. */
	async answer(answer, declined) {
		const prompt = this.store.getSnapshot().openPrompt;
		if (prompt === void 0) return;
		this.store.update((s) => {
			s.busy = true;
			s.openPrompt = void 0;
		});
		try {
			await call("answer", {
				seq: prompt.seq,
				answer,
				declined
			});
		} catch {}
		this.store.update((s) => {
			s.busy = false;
		});
		this.schedulePoll(0);
	}
	/** Delete the stored credential record. */
	async logout() {
		this.store.update((s) => {
			s.busy = true;
		});
		try {
			await call("logout");
			await this.load();
		} catch {}
		this.store.update((s) => {
			s.busy = false;
		});
	}
	/** Write the provider profile (idempotent on the host side). */
	async autofill() {
		this.store.update((s) => {
			s.busy = true;
		});
		try {
			await call("autofill");
			await this.load();
		} catch {
			await this.load();
		}
		this.store.update((s) => {
			s.busy = false;
		});
	}
	/** Copy-button feedback. */
	markCopied() {
		this.store.update((s) => {
			s.copied = true;
		});
		setTimeout(() => {
			if (!this.disposed) this.store.update((s) => {
				s.copied = false;
			});
		}, 1500);
	}
	/** Stop polling and further actions; called on fiber disposal. */
	dispose() {
		this.disposed = true;
		if (this.pollTimer !== void 0) clearTimeout(this.pollTimer);
		this.pollTimer = void 0;
	}
	/** Fold one settlement into the card state and refresh the join. */
	finishLogin(status, message) {
		this.store.update((s) => {
			s.busy = false;
			if (status === "authorized") {
				s.login = { kind: "success" };
				s.status = {
					...s.status,
					loggedIn: true,
					profileActivated: true
				};
			} else if (status === "cancelled") s.login = { kind: "cancelled" };
			else s.login = {
				kind: "error",
				message: message ?? "Sign-in failed"
			};
		});
		this.load();
	}
	/** Poll the event stream once; reschedules while the attempt runs. */
	async pollOnce() {
		if (this.disposed) return;
		let delay = 1e3;
		try {
			const answer = await call("events", { since: this.cursor });
			this.cursor = answer.cursor;
			for (const event of answer.events) this.applyEvent(event);
			if (answer.settlement !== void 0 && this.store.getSnapshot().login.kind === "running") {
				this.finishLogin(answer.settlement.status, answer.settlement.message);
				return;
			}
			if (answer.inFlight) delay = 1e3;
			else {
				this.load();
				return;
			}
		} catch {
			delay = 2e3;
		}
		this.schedulePoll(delay);
	}
	/** Fold one sequenced event into the card state. */
	applyEvent(event) {
		this.store.update((s) => {
			s.events = [...s.events, event].slice(-24);
			if (event.kind === "prompt") {
				s.openPrompt = event;
				return;
			}
			if (event.code !== void 0) {
				s.deviceCode = event.code;
				s.verificationUrl = event.url;
			}
		});
	}
	/** Schedule the next poll, collapsing overlapping timers. */
	schedulePoll(delayMs) {
		if (this.disposed) return;
		if (this.pollTimer !== void 0) clearTimeout(this.pollTimer);
		this.pollTimer = setTimeout(() => {
			this.pollTimer = void 0;
			this.pollOnce();
		}, delayMs);
	}
};

//#endregion
//#region src/client/bindSnapshotSelector.ts
/**
* Bind a React selector hook to a {@link HostObservable} snapshot source.
* @param source - the observable snapshot store.
* @returns a `useSelector(sel, eq?)` hook.
*/
function bindSnapshotSelector(source) {
	const subscribe = (fn) => source.subscribe(fn);
	const getSnapshot = () => source.getSnapshot();
	return function useSelector(sel) {
		const snapshot = (0, react.useSyncExternalStore)(subscribe, getSnapshot);
		const prevSnapshotRef = (0, react.useRef)(void 0);
		const prevSelectedRef = (0, react.useRef)(void 0);
		if (prevSnapshotRef.current !== snapshot) {
			prevSnapshotRef.current = snapshot;
			prevSelectedRef.current = sel(snapshot);
		}
		return prevSelectedRef.current;
	};
}

//#endregion
//#region src/client/locales.ts
/** The locale namespace name; matches the `locale: NS` passed at slot register. */
const NS = "dsh-plugin-copilot";
/** English dictionary. */
const en = {
	"card.title": "GitHub Copilot",
	"card.intro": "Sign in to GitHub Copilot and activate its model route (served by dsh-llm-pi-ai).",
	"card.unsupported": "Copilot sign-in needs dsh-llm-pi-ai (0.1.2-alpha.1 or later) with the github-copilot catalog provider.",
	"card.signedIn": "Signed in",
	"card.signedOut": "Not signed in",
	"card.routeActive": "Route active",
	"card.routeDormant": "Route not activated",
	"card.models": "Models available to this account:",
	"action.signIn": "Sign in with GitHub",
	"action.signOut": "Sign out",
	"action.cancel": "Cancel",
	"action.retry": "Retry",
	"action.activate": "Activate route",
	"action.syncModels": "Sync model list",
	"action.openUrl": "Open verification page",
	"action.copyCode": "Copy code",
	"action.copied": "Copied",
	"action.decline": "Decline",
	"action.submit": "Submit",
	"state.pending": "Waiting for authorization…",
	"state.pendingPrompt": "Answer the question below to continue signing in — the device code appears right after.",
	"state.working": "Working…",
	"state.success": "Signed in. The Copilot models are ready — pick one on the Models page.",
	"state.error": "Failed",
	"notice.deviceCode": "Open the verification page and enter this code:",
	"notice.polling": "Waiting for you to finish in the browser…",
	"prompt.placeholder": "Your answer",
	"prompt.answer": "GitHub asks"
};
/** Chinese dictionary. */
const zh = {
	"card.title": "GitHub Copilot",
	"card.intro": "登录 GitHub Copilot 并激活其模型路由（由 dsh-llm-pi-ai 提供）。",
	"card.unsupported": "Copilot 登录需要 dsh-llm-pi-ai（0.1.2-alpha.1 或更高）内置的 github-copilot 供应商。",
	"card.signedIn": "已登录",
	"card.signedOut": "未登录",
	"card.routeActive": "路由已激活",
	"card.routeDormant": "路由未激活",
	"card.models": "当前账号可用模型：",
	"action.signIn": "使用 GitHub 登录",
	"action.signOut": "退出登录",
	"action.cancel": "取消",
	"action.retry": "重试",
	"action.activate": "激活路由",
	"action.syncModels": "同步模型列表",
	"action.openUrl": "打开验证页面",
	"action.copyCode": "复制代码",
	"action.copied": "已复制",
	"action.decline": "拒绝",
	"action.submit": "提交",
	"state.pending": "等待授权中…",
	"state.pendingPrompt": "回答下面的问题即可继续登录，随后会显示设备码和验证页面。",
	"state.working": "处理中…",
	"state.success": "已登录，Copilot 模型就绪 — 去 Models 页选择即可。",
	"state.error": "失败",
	"notice.deviceCode": "打开验证页面并输入此代码：",
	"notice.polling": "等待你在浏览器中完成授权…",
	"prompt.placeholder": "输入你的回答",
	"prompt.answer": "GitHub 需要你回答"
};

//#endregion
//#region src/client/index.ts
/** Required services: the slot ledger and the locale dictionaries. */
const inject = ["slots", "locale"];
/**
* Client plugin body: register the locale dictionaries and the settings card.
* @param ctx - client root context.
*/
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "dsh-plugin-copilot: dictionaries");
	const controller = new CopilotAuthController();
	ctx.effect(() => () => {
		controller.dispose();
	}, "dsh-plugin-copilot: card controller");
	const useCard = bindSnapshotSelector(controller.store);
	const injected = () => ({
		controller,
		useCard
	});
	ctx.slots.inject("settings.plugin.item", function* () {
		yield ctx.slots.register({
			name: "settings.plugin.item",
			key: "dsh-plugin-copilot",
			locale: NS,
			inject: injected
		}, CopilotAuthCard);
	});
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=client.js.map