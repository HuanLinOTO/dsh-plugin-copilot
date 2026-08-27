# dsh-plugin-copilot 设计文档

> 日期：2026-08-27
> 参考实现：opencode（anomalyco/opencode，dev 分支）的 GitHub Copilot 供应商
> —— `packages/opencode/src/plugin/github-copilot/copilot.ts`（OAuth 设备流 + 请求头）、
> `packages/opencode/src/plugin/github-copilot/models.ts`（远程模型目录）、
> `packages/llm/src/providers/github-copilot.ts`（chat/responses 路由规则）。

## 目标

在 DSH 上以「缝上插件」的方式复刻 opencode 的 GitHub Copilot 供应商：GitHub Copilot
订阅者通过 OAuth 设备流登录后，Copilot 托管的全部模型（GPT-5.x / GPT-4.x / Claude /
Gemini 等）成为 DSH 可选模型，支持流式、工具调用、视觉输入、推理努力档位、会话标题等
辅助请求，零源码 patch。

## 对齐 opencode 的行为清单

| 行为 | opencode 实现 | 本插件实现 |
|------|--------------|-----------|
| OAuth 设备流 | `POST {domain}/login/device/code`（client_id `Ov23li8tweQw6odWQebz`，scope `read:user`）→ 轮询 `access_token`（`authorization_pending`/`slow_down` +3s 安全边距，RFC 8628 +5s） | 完全一致（`src/device-flow.ts`，fetch 注入可测） |
| GitHub Enterprise | 域名归一化；设备流走 `{domain}`，API 走 `https://copilot-api.{domain}` | 完全一致（config `enterpriseUrl`） |
| 认证方式 | GitHub OAuth token 直连 `Authorization: Bearer`（`X-GitHub-Api-Version: 2026-06-01`） | 完全一致（不做 copilot_internal token 交换） |
| 请求头 | `x-initiator: agent\|user`（末条消息 role ≠ user → agent）、`Openai-Intent: conversation-edits`、`Copilot-Vision-Request`（含图）、`X-Interaction-Type: agent-session-name-generation`（标题请求）、`anthropic-beta: interleaved-thinking-2025-05-14`（messages 端点） | 一致；DSH 映射：`purpose`（compaction/session-title）→ agent；session-title → 交互类型头 |
| 模型目录 | `GET {base}/models`（5s 超时）：`model_picker_enabled` 过滤选择器；`policy.state=disabled`、缺 limits/tool_calls 的剔除；utility models（gpt-5.4-nano/gpt-4.1/gpt-4o/gpt-4o-mini）不进选择器但可请求（标题） | 一致（TTL 缓存 5min；未认证/失败回退静态小目录）；DSH 侧 `listModels` 返回 picker + utility |
| 协议路由 | `supported_endpoints`：`/v1/messages` 优先 → `/responses`（gpt-N≥5 且非 gpt-5-mini，或显式声明）→ `/chat/completions` 兜底 | 一致，三协议均为完整流式实现 |
| max_tokens | gpt* 模型一律省略（对齐 GitHub Copilot CLI） | 一致；messages 端点例外（Anthropic 协议必填） |
| 推理 | `reasoning_effort` 数组 → Responses `reasoning.effort`；`adaptive_thinking`/`max_thinking_budget` → Anthropic `thinking.budget_tokens`（max-1 / ½ 档） | DSH effort id 逐字透传 wire；budget 档位 low=¼/high=½/max=-1 |
| 视觉 | `Copilot-Vision-Request: true` + 图像 content part | 一致；image block 经附件服务解析为 data URL / base64 |
| 登录入口 | `opencode auth login`（CLI 交互） | DSH 无 CLI 注入缝 → 模型工具：`copilot_login` / `copilot_login_wait` / `copilot_status` / `copilot_logout`（设备流拆两段，避免长阻塞工具） |

## DSH 侧设计

- **形态**：Cordis 函数式插件，`name`/`inject = ['llm','tools']`/`Config`（Schemastery）/`apply`。
- **注册**：`ctx.llm.registerAdapter(['github-copilot'], adapter)` +
  `registerConfigurableProviders([{provider:'github-copilot', displayName:'GitHub Copilot', settingsNs, settingsPath:[]}])` +
  `installSettingsSection`（设置页热更，每请求重读快照，llm-deepseek 同款）。
- **adapter**：`CopilotAdapter extends LlmAdapter`，`stream()` 骨架与 llm-deepseek 一致
  （每操作一次配置/凭证快照冻结、`AbortSignal.any` + idle watchdog、错误规范为 `LlmError` 稳定码）。
- **凭证解析**（每请求）：① auth 文件（设备流产物，默认 `{dshHome}/github-copilot-auth.json`，
  可配 `authFile`；原子写）→ ② credential-ref（`ctx.credentials` → 启动 env，默认
  `GITHUB_COPILOT_TOKEN`）。两者皆缺 → `MISSING_CREDENTIAL`。
- **wire 层**（`src/wire/`）：三协议各自的 serialize + SSE translate，输出统一
  `StreamChunk`（block-start/delta/block-end 缓冲到流尾、usage 先于 finish、finish 后无 chunk、
  空 stop → `EMPTY_RESPONSE`）。SSE 用 `eventsource-parser`（bundle 进 lib/，零运行时依赖）。
- **工具**：`defineTool` + 规范 JSON 输出 + `exec.deferContext` 把验证码作为 plugin notice 持久化进会话。
- **合规**：零源码 patch；预构建 `lib/` 入库（含 `@deepseek-ai/*` private peer，无 `prepare`）；
  `attributionHeaders()` 全部出站请求携带；测试零网络（fetch 注入 + fake timers）。

## 测试分层

Unit（vitest，全部离线）：设备流状态机、auth 存储原子性、模型目录映射/过滤/路由、
三协议 serialize/translate、请求头启发式、HTTP 错误码映射。Real-API e2e 需要真实订阅，
keyless 自跳过，不在本仓库强制。
