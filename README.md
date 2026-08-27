# @huanlin/dsh-plugin-copilot

GitHub Copilot 模型供应商插件（DSH bundle）。行为对齐 [opencode](https://github.com/anomalyco/opencode) 的 GitHub Copilot 供应商：OAuth 设备流登录后，Copilot 托管的全部模型（GPT-5.x / GPT-4.x / Claude / o 系列等）即成为 DSH 可选模型，支持流式输出、工具调用、视觉输入、推理档位与会话标题等辅助请求。

English: A DSH plugin bundle that adds GitHub Copilot as a model provider (OAuth device-flow login, remote model catalog, and chat completions / responses / messages wire protocols), behaviorally aligned with opencode's GitHub Copilot provider.

## 功能

- **OAuth 设备流登录**（github.com 与 GitHub Enterprise）：`POST /login/device/code` + 轮询 `/login/oauth/access_token`，处理 `authorization_pending` / `slow_down`（RFC 8628 +5s，3s 时钟安全边距），与 opencode 同款 client id 与 scope（`read:user`）。
- **三协议路由**（按 `/models` 元数据 `supported_endpoints`，opencode 同规则）：
  - `/v1/messages`（Anthropic shim，Claude 系）— thinking 块、`tool_use`/`tool_result`、`anthropic-beta: interleaved-thinking-2025-05-14`
  - `/responses`（GPT-5 系，非 mini）— reasoning summary、`function_call` 流式参数
  - `/chat/completions`（兜底）— 标准 OpenAI 兼容流
- **请求头对齐**：`x-initiator`（agent/user 启发式，工具续跑与 compaction/标题请求 → agent）、`Openai-Intent: conversation-edits`、`Copilot-Vision-Request`、`X-GitHub-Api-Version: 2026-06-01`、标题请求带 `X-Interaction-Type`。
- **gpt* 模型省略 `max_tokens`**（对齐 GitHub Copilot CLI / opencode `chat.params`）。
- **模型目录**：远程 `GET /models`（5s 超时、TTL 缓存、picker 过滤、utility models 供标题/压缩使用），未登录或失败时回退静态小目录；`listModels`/`resolveModel` 提供上下文窗口、输出上限与推理档位。
- **凭证解析（每请求）**：设备流产物 `github-copilot-auth.json`（默认 `{dshHome}/` 下，原子写）优先 → credential-ref 环境变量（默认 `GITHUB_COPILOT_TOKEN`）回退；两者皆缺报 `MISSING_CREDENTIAL`。
- **模型可调工具**：`copilot_login` / `copilot_login_wait` / `copilot_status` / `copilot_logout`（对 DSH 无 CLI auth 缝的替代，登录码同时以 plugin notice 落入会话）。
- **设置页热更**：`dsh-plugin-copilot` 设置 section（即插件 Config），改动即时生效于下一请求；企业域名、API 版本、缓存 TTL、重试策略等均可配。

## 安装

```powershell
# 本地开发（link:）
dsh plugin --profile web add link:D:/Projects/deepseek-harness/dsh-plugin-copilot

# 远端（预构建 lib/，开箱即用）
dsh plugin --profile web add "github:huanlinoto/dsh-plugin-copilot"
```

安装后重启 `dsh web` 并硬刷新浏览器。在 agent 配置（`agent-loop` 的 `agents[].provider/model` 或默认模型设置）中选用：

```yaml
provider: github-copilot
model: gpt-5.1        # 登录后可用完整远程目录；未登录仅静态回退目录
```

## 登录流程（对话内）

1. 对模型说「登录 GitHub Copilot」→ 模型调用 `copilot_login`，返回 `verification_uri` 与 `user_code`；
2. 浏览器打开该 URL、输入代码并授权；
3. 模型调用 `copilot_login_wait` 完成轮询并落盘 token；`copilot_status` 可随时查看状态（含远程模型数探针）。

无头部署可直接 `export GITHUB_COPILOT_TOKEN=<GitHub OAuth token>`。

## 配置（cordis.patch.yml 行 config / 设置页同名 section）

| 字段 | 默认 | 说明 |
|------|------|------|
| `enterpriseUrl` | — | GitHub Enterprise 域名/URL；API 走 `https://copilot-api.{domain}` |
| `clientId` | opencode 同款 | 设备流 OAuth client id |
| `apiVersion` | `2026-06-01` | `X-GitHub-Api-Version` |
| `githubTokenEnv` | `GITHUB_COPILOT_TOKEN` | credential-ref 环境变量名 |
| `authFile` | `{dshHome}/github-copilot-auth.json` | 设备流 token 存储路径（`~` 可展开） |
| `baseURL` | 按部署推导 | 高级：显式覆盖 API base |
| `modelsRefreshMs` | `300000` | `/models` 缓存 TTL（≥1000） |
| `defaultReasoningEffort` | — | 模型档位列表内的预选档位 |
| `streamIdleTimeoutMs` | `300000` | 单次流读取空闲上限 |
| `maxRequestImageBytes` | `20971520` | 单请求累计 base64 图像上限 |
| `retryPolicy` | 宿主默认 | provider 侧重试策略 |

## 开发

```powershell
pnpm install
pnpm run typecheck   # tsc --noEmit（类型经 sibling checkout 解析）
pnpm test            # vitest run（78 个离线用例：注入 fetch/sleep，零网络）
pnpm run build       # tsdown（lib/index.js + lib/invariant.js，eventsource-parser 已 bundle）+ tsc 声明到 lib/types
```

目录：`src/config.ts`（配置与解析）· `src/device-flow.ts`（RFC 8628 状态机）· `src/auth-store.ts`（原子 JSON 存储）· `src/copilot-models.ts`（目录映射/路由）· `src/headers.ts`（请求头）· `src/wire/{chat,responses,messages,shared}.ts`（三协议）· `src/adapter.ts`（LlmAdapter）· `src/tools.ts`（登录工具）· `src/invariant.ts`（不变量伴生）。

设计依据见 `docs/plans/2026-08-27-copilot-provider-design.md`。

## 运行（挂载验证）

```powershell
dsh plugin --profile web add link:<本目录>
# 由人类执行 dsh web 启动后：
#   设置 → 插件配置 → dsh-plugin-copilot 可见 section
#   会话内让模型调用 copilot_status → authenticated/model_count 反映真实状态
```

## 检查

- `pnpm run typecheck` 零错误；`pnpm test` 78/78 通过（keyless，无真实 API 依赖）。
- `lib/` 产物自包含（仅 peer 外部依赖 + node 内置），`node -e "import('./lib/index.js')"` 可直接加载，导出 `name/inject/Config/apply`。
- 合规：零源码 patch；预构建 `lib/` 入库（含 `@deepseek-ai/*` private peer，无 `prepare`）；所有出站请求携带 `attributionHeaders()` 并尊重 `options.signal`；错误一律 `LlmError` 稳定码。

## 许可

MIT
