# dsh-plugin-copilot 0.2.0 设计：WebUI Copilot 授权 + 自动填写入口

- 日期：2026-08-28
- 状态：设计稿（待实现）
- 范围：重构 `@huanlin/dsh-plugin-copilot`，**只做计划，本文档不含实现**

## 1. 背景与动机

### 1.1 冲突事实（boot 失败根因）

dsh 0.1.2-alpha.1 的 `dsh-llm-pi-ai` 携带 pi-ai@0.84.2，其 builtin catalog 已内置
`github-copilot`（40 个 provider 之一）。插件当前调用
`ctx.llm.registerConfigurableProviders([{ provider: 'github-copilot', ... }])`，
llm-pi-ai 挂载时 catalog 全量 declare 同名 provider →
`DUPLICATE_DIRECTORY: configurable provider "github-copilot" is already declared`
→ 整个 profile boot 失败（已运行时取证确认，诊断脚本见 §8.2）。

### 1.2 pi-ai 内置能力已覆盖插件全部核心功能

pi-ai（opencode 同源库）为 github-copilot 提供：

- OAuth device-flow 登录（`providers/all.js` 的 `auth.oauth`，opencode 同款 client id/scope）
- Copilot 请求头/会话管理（`dist/api/github-copilot-headers.js`）
- 模型目录（`models.generated.js`）
- 三协议 API（chat completions / responses / anthropic messages）

且 dsh 侧 `dsh-llm-pi-ai` 已把这些登录桥接到 harness 的 `authorization` seam
（`login.ts` 的 `registerPiAiFlows`），OAuth 成功后 grant 写入 credentials 服务
（`recordKeyFor`，scope=`llm-pi-ai`，key=`llm-pi-ai:github-copilot`）。

**结论**：插件自己的 `adapter.ts` / `wire/*` / `copilot-models.ts` /
`registerAdapter` / `registerConfigurableProviders` 全部冗余，且是冲突源。

### 1.3 WebUI 空缺

`AuthorizationService.begin(request)` 是公开 API（typert catalog 已登记），但
**当前无任何生产调用方** —— WebUI 上没有任何"provider 登录"按钮。用户要用
pi-ai 内置 copilot 只能手工配 settings/credentials。这正是本插件 0.2.0 的价值：
**在 WebUI 提供方便的 Copilot 授权 + 自动填写入口**。

## 2. 目标 / 非目标

### 目标

1. **消除 provider 冲突**：不再注册 `github-copilot` provider / adapter，与
   llm-pi-ai catalog 共存，profile 正常 boot。
2. **WebUI 一键授权**：设置页新增 Copilot 卡片 —— 登录按钮发起 device-flow，
   面板展示 `user_code` + `verification_uri` + 轮询状态 + 取消，成功后即时反馈。
3. **自动填写**：授权成功后自动完成两件事，使 pi-ai 内置路由即刻可用：
   - 凭证落位：由 llm-pi-ai 的 flow 自行写入 `llm-pi-ai:github-copilot` record；
   - settings profile 自动创建：写 `llm-pi-ai.providers.github-copilot = {}`
     （最小 profile，激活 adapter 路由注册；dormant → active）。
4. **状态展示**：卡片显示 已登录/未登录（来自 credential record 是否存在 +
   kind=oauth），以及 profile 是否已激活；未激活而仅缺 profile 时可单独"补填"。

### 非目标

- 不再维护自己的 wire 协议适配、模型目录、请求头逻辑（全部交给 pi-ai）。
- 不改上游 Models 设置页（`ui-settings-models`）；只在插件自己的卡片里操作。
- 不做旧凭证（`github-copilot-auth.json` / `GITHUB_COPILOT_TOKEN`）迁移。
- GitHub Enterprise 支持暂不承诺（见 §7 开放问题 5）。

## 3. 关键机制（已核实的事实）

| 机制 | 位置 | 要点 |
| --- | --- | --- |
| `AuthorizationService.begin(request)` | `packages/credentials/authorization/src/index.ts:275` | 公开；`request = { key, method?, interaction, signal? }`；interaction（notify/prompt）由调用方提供 —— 插件可程序化发起别人注册的 flow |
| flow 注册（pi-ai copilot） | `dsh-llm-pi-ai` `login.ts` `registerPiAiFlows` | key = `credentialKey('llm-pi-ai','github-copilot')`；method `oauth`（device-flow，事件含 `device_code` → notice `{url, code}`） |
| grant 存储 | `dsh-llm-pi-ai` `auth.ts` `credentialStoreFrom` | pi-ai 的 credential store 桥接 harness credentials 服务；record scope=`llm-pi-ai`，id=`github-copilot`，kind=oauth |
| 路由激活条件 | `dsh-llm-pi-ai` `index.ts` `ensureRegistrationFacts` | 零 profile = dormant；settings 出现 `providers.github-copilot` profile 即注册 adapter 路由 |
| client 扩展 | `ui-slots`（`InjectFace` / `PropsRenderSlots`） | 设置插件页（`ui-settings-plugins`）本身基于 slots 组合；morlay `ui-conversation-message-actions` 是 client 插件注入先例（`dsh.client: { platform, inject }` + `lib/client.js`） |
| 每键单 flow | authorization seam | 同 key 二次 `registerFlow` 抛 `DUPLICATE_FLOW` —— 插件**绝不能**再为该 key 注册自己的 flow |

## 4. 方案比较

### 方案 A（推荐）：授权代理 + 设置卡片

插件退化为"Copilot 引导层"：WebUI 卡片 → host RPC →
`ctx.authorization.begin({ key: 'llm-pi-ai:github-copilot', interaction })` 复用
llm-pi-ai 的 device-flow；成功后插件自动写 settings profile。

- 优点：
  - OAuth 代码全部删除（device-flow.ts / auth-store.ts 移除），零维护；
  - 凭证由 pi-ai 自己写自己的 record，**天然落位正确**，无跨 scope 写越权；
  - 模型目录 / 协议 / 头部随 pi-ai 升级自动对齐。
- 缺点/风险：
  - 依赖 llm-pi-ai flow key（scope 字符串）稳定 —— 缓解：启动时从
    `authorization` flow 注册表探查（`listFlows()`，index.ts:221），找不到
    providerId 含 `github-copilot` 的 flow 则卡片进入"缺少 llm-pi-ai"错误态，
    不盲拼 key；
  - `begin` 并发语义（同 key 已有 attempt → 需从 Outcome/错误映射"进行中"态）。

### 方案 B：自持 device-flow + 跨 scope 写 record

保留现有 `device-flow.ts`，登录成功后把 grant 写入
`llm-pi-ai:github-copilot` record（`modifyRecord` 跨 scope）。

- 优点：不依赖 authorization seam 与 llm-pi-ai flow 细节。
- 缺点：违反 scope 所有权约定（上游 list() 明确"别人 scope 的 record 不是我的
  集合"；写别人 scope 同理越权）；pi-ai grant payload 的 JSON 规范
  （explicit-undefined 剥离等）成为硬耦合；双份 OAuth 代码长期漂移。
- 定位：**不推荐**，仅当实现时发现 seam 不可用时回退。

### 方案 C：最小修补（仅消冲突，无 UI）

disable llm-pi-ai（不可行 —— settings.yaml 的 newapi GLM 路由依赖它）或
插件 provider 改名（不满足用户需求）。列出仅为完整性。

## 5. 方案 A 详设

### 5.1 host 侧（重写 `src/index.ts`，瘦身为引导层）

- `inject`: `['authorization', 'credentials', 'settings']`（移除 `'llm'`）。
- 删除：`adapter.ts`、`wire/*`、`copilot-models.ts`、`device-flow.ts`、
  `auth-store.ts`、`registerConfigurableProviders`、`registerAdapter`、
  `headers.ts`；`tools.ts` 缩减（见 5.4）。
- 启动时探查 flow：从 `ctx.authorization` 的 flow 列表找 key 的 id 段 =
  `github-copilot` 且 scope = `llm-pi-ai` 的 flow，缓存其 `CredentialKey`；
  未找到 → 状态机进入 `unsupported`（卡片提示需要 llm-pi-ai ≥ 0.1.2-alpha.1）。
- RPC 面（供 client 卡片调用；通道实现时定，候选见 §7 开放问题 1）：
  - `copilotStatus()` → `{ flowAvailable, loggedIn, profileActivated }`
    （`loggedIn` = `credentials.readRecord(key)` 存在；`profileActivated` =
    settings 里 `llm-pi-ai.providers.github-copilot` 是否存在）。
  - `copilotLogin(signal)` → `authorization.begin({ key, interaction })`；
    interaction.notify 把 device-flow 事件（url + user code / 轮询中 / 成功）
    转发到 client；interaction.prompt 用于 flow 可能的中间询问（如 api-key
    输入，透传给卡片表单）。
  - `copilotLogout()` → 删除该 record（API 面实现时确认，§7 开放问题 4）。
  - `copilotAutofill()` → 幂等写 `llm-pi-ai.providers.github-copilot = {}`
    （login 成功路径自动调用；也允许单独调用补填）。
- 事件面：登录过程事件推送到 client（notify 桥；订阅模式参考
  ui-settings-plugins 的 card-controller 先例）。

### 5.2 client 侧（新增，`src/client.tsx` + `dsh.client` manifest）

- package.json `dsh` 段新增：
  `"client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings-plugins", ...] }`
  （准确 inject 列表与 slot 表见 §7 开放问题 3）。
- `CopilotAuthCard` 状态机：
  `unsupported`（无 flow）→ `logged-out` → `pending`（code+链接+轮询+取消）
  → `success` / `error`；`logged-in`（record 存在）附"登出"与
  （缺 profile 时的）"补填激活"。
  - device-flow 面板：user code 大字展示 + 打开 `verification_uri` 按钮 +
    复制 code；RFC 8628 轮询节奏由 host flow 负责，client 只消费事件。
  - 成功态提示：路由已激活，可去 Models 页选 Copilot 模型（链接跳转）。
- i18n：走 locale 字典（"Client UI copy is locale-owned" 约定），中英双语。

### 5.3 cordis.patch.yml / 设置 section

- patch 行保持 `id: dsh-plugin-copilot` / `name` 不变；config 收敛为空
  （`githubTokenEnv` / auth file / enterprise URL 等旧配置字段删除 ——
  README 注明迁移）。
- `installSettingsSection` 移除（无剩余可配置项；YAGNI）。

### 5.4 工具面（agent 侧）

- 保留单工具 `copilot_status`（读同一状态 join，便于 agent 问答）。
- `copilot_login` / `copilot_login_wait` / `copilot_logout` 移除：登录交互
  归 WebUI 卡片；headless 场景的 authorization 交互面不在本插件范围
  （§7 开放问题 6）。

## 6. 错误处理

| 情形 | 行为 |
| --- | --- |
| llm-pi-ai 未安装/未注册 copilot flow | 卡片 `unsupported` 态，文案指明前置条件 |
| 同 key 已有 attempt in flight | `begin` 结果映射为"已在进行中"，卡片回到 pending 态展示当前事件 |
| device-flow 超时 / 用户拒绝 / `slow_down` | flow 内部语义；卡片 error 态 + 原因文案，可重试 |
| settings 写入被 schema 拒绝 | 凭证已存不算失败：notice 说明原因，卡片提供"重试补填" |
| client 与 host 版本错位（RPC 缺方法） | 卡片整体禁用并提示升级插件 |

## 7. 开放问题（实现前必须确认）

1. **插件 RPC 通道**：client → host 的调用面用 typert `ClientRemote` 注册
   还是 HTTP（morlay sessionEditor 的 `/session-editor` HTTP 先例）？
   实现 checklist 第一项。
2. **settings 跨命名空间写**：插件写 `llm-pi-ai` namespace 的 API 面
   （Models 页 wire 的 settings face 是否可复用 / host 侧 settings 服务写路径）。
3. **ui-settings-plugins 注入点**：确切的 slot 表名与 inject 包列表
   （`PropsRenderSlots` 的键）；若无现成卡片槽，fallback 为插件自带
   独立设置区块入口。
4. **logout 的 record 删除 API**：`unset(ref)` 接受 record key 吗，还是
   `modifyRecord` 返回 `undefined` 才是删除路径。
5. **GitHub Enterprise**：pi-ai copilot flow 是否经 prompt 收集 enterprise
   URL；不支持则文档明示仅 github.com。
6. **headless/ACP 场景**：`begin` 的 interaction 由宿主 surface 提供；
   本插件只在 web 平台注册 client，headless 不受影响（确认无 host 侧
   副作用即可）。

## 8. 验证计划

### 8.1 测试（分层）

- **Unit**：flow 探查逻辑；status join（record × profile）；autofill 写入
  payload 与幂等性；begin 结果 → 卡片状态映射。
- **Composition（REAL，boot 级）**：最小 cordis.yml（本插件 + llm-pi-ai +
  authorization + credentials-local + settings-file）过 Loader boot，断言：
  无 `DUPLICATE_DIRECTORY`；mock authorization flow（假 device-flow）走通
  login → record 出现 → profile 写入。
- **Client spec**：卡片状态机渲染（参考 ui-settings-plugins 测试模式，
  jsdom + store mock）。

### 8.2 诊断工具（已就绪，复跑用）

`C:\Users\Administrator\AppData\Local\Temp\opencode\diag-boot.mjs` —— 复刻
profile boot 并 wrap `registerConfigurableProviders` 打印 directory 冲突现场。
重构后跑一次：期望 directory 只剩 `llm-deepseek` / `llm-pi-ai` 两个 ns，
`dsh-plugin-copilot` ns 不再出现。

### 8.3 手工验收

1. `dsh web` 正常 boot（当前冲突已消）。
2. 设置页卡片：登录 → 浏览器完成 device 授权 → 成功态；Models 页出现
   github-copilot 路由与模型（pi-ai catalog）。
3. 会话里选 Copilot 模型发起一次真实生成。

## 9. 迁移与版本

- 版本 bump **0.2.0**（行为破坏：provider 注册移除、旧配置字段删除、工具集缩减）。
- README 重写：定位从"provider 实现"改为"Copilot 引导层"；注明旧
  `github-copilot-auth.json` / `GITHUB_COPILOT_TOKEN` 不迁移，首次用卡片
  重新登录。
- 发布流程照旧（AGENTS.md SOP：预构建 lib/、双语描述、dshfind card、
  `dsh-plugin-` 命名已合规）。

## 10. 实施步骤（粗粒度 checklist）

1. 确认 §7 开放问题 1-4（RPC 通道 / settings 写 / slot 表 / logout API）。
2. host 重写：删冗余模块 + flow 探查 + status/login/logout/autofill。
3. client：manifest + CopilotAuthCard + locale 字典。
4. 测试三件套（unit / composition / client spec）+ `pnpm typecheck && test && build`。
5. README / cordis.patch.yml / package.json（dsh.client、version 0.2.0）。
6. 本地验证：diag-boot.mjs → 手工验收 §8.3（由人类重启 dsh web）。
