<p align="center">
  <a href="https://dshfind.com/zh/plugins/huanlinoto/dsh-plugin-copilot"><img src="https://dshfind.com/api/card/huanlinoto/dsh-plugin-copilot?lang=zh" alt="dsh-plugin-copilot card"></a>
</p>

# @huanlin/dsh-plugin-copilot

GitHub Copilot 引导层插件（DSH bundle）。0.2.0 起不再实现 provider —— dsh 0.1.2-alpha.1 的 `dsh-llm-pi-ai` 内置 pi-ai catalog 已完整提供 `github-copilot` 供应商（OAuth 设备流登录、请求头、模型目录、三协议接入），本插件转而解决「如何从 WebUI 用上它」：

- **WebUI 一键授权**：设置 → 插件配置 → GitHub Copilot 卡片，点「使用 GitHub 登录」发起 device-flow（复用 `dsh-llm-pi-ai` 注册的 authorization flow），卡片展示 `user_code` + 验证链接 + 轮询状态 + 取消，成功即时反馈；flow 开头的「GitHub Enterprise URL/domain」提问由网关按插件配置直接作答（默认留空 = github.com），常见登录零输入直达设备码；「打开验证页面」以独立弹窗打开，不受 better-sidebar 等侧边栏插件拦截；
- **自动填写**：授权成功自动写 `llm-pi-ai.providers.github-copilot = {}`（最小 profile），pi-ai 的 github-copilot 路由从 dormant 转 active；也可在卡片上单独「激活路由」补填；
- **模型列表收窄**：harness 的模型选择页读取的是 profile 解析出的 `models` 列表（pi-ai 自身的请求时过滤在这里不生效），因此插件会把凭证 record 里的 `availableModelIds` 与已装模型目录求交集后写进 profile 的 `models`（通过 `ctx.llm.discoverModels` 读目录，零网络）。登录成功、点「激活路由」或卡片上「同步模型列表」时触发；已装目录不认识的模型 id 会被剔除（否则整条路由会在写入时被拒）。
- **可用模型展示**：pi-ai 登录/刷新令牌时会把当前账号可调用的模型 id 写进凭证 record（`availableModelIds`），本插件读取并在卡片与 `copilot_status` 工具中展示；pi-ai 自身已按该列表过滤模型目录，展示仅为反馈。

English: a Copilot onboarding plugin. Since dsh 0.1.2-alpha.1's builtin `dsh-llm-pi-ai` catalog fully serves the `github-copilot` provider, this plugin no longer registers one (doing so failed profile boot with `DUPLICATE_DIRECTORY`); it now provides the WebUI sign-in card + automatic provider-profile autofill on top of the builtin flow.

## 0.1.x → 0.2.0 迁移（破坏性）

| 0.1.x | 0.2.0 |
|-------|-------|
| 自带 `CopilotAdapter` + 三协议 wire + 模型目录 | 删除；由 pi-ai catalog 提供 |
| `copilot_login` / `copilot_login_wait` / `copilot_logout` 工具 | 删除；登录归 WebUI 卡片 |
| `copilot_status` 工具 | 保留（读同一状态 join） |
| 配置字段（`githubTokenEnv` / `authFile` / `enterpriseUrl` 等） | 全部删除；仅保留一个 `enterpriseDomain`（GHE 域名，留空 = github.com） |
| 旧凭证 `github-copilot-auth.json` / `GITHUB_COPILOT_TOKEN` | **不迁移**；首次用卡片重新登录 |

## 前置条件

- `dsh-llm-pi-ai` ≥ 0.1.2-alpha.1（内置 github-copilot catalog provider 并注册其 authorization flow）。缺失时卡片进入「不支持」态并提示。
- `dsh-authorization`：`dsh-llm-pi-ai` 仅在 `ctx.inject(['authorization'])` 下注册登录流，而该服务是可选挂载、所有官方 bundle 均未包含——本插件的 `cordis.patch.yml` 已自动 insert 它，无需手工配置。
- 凭证服务（如 `dsh-credentials-local`）+ settings 服务：`dsh web` 默认 base bundle 已挂载。

## 安装

```powershell
# 本地开发（link:）
dsh plugin --profile web add link:D:/Projects/deepseek-harness/dsh-plugin-copilot

# 远端（预构建 lib/，开箱即用）
dsh plugin --profile web add "github:huanlinoto/dsh-plugin-copilot"
```

安装后重启 `dsh web` 并硬刷新浏览器。首次使用：设置 → 插件配置 → GitHub Copilot → 「使用 GitHub 登录」→ 浏览器完成 device 授权 → 卡片显示成功 → Models 页选 Copilot 模型。

## 架构

```
WebUI 卡片 (settings.plugin.item, key=dsh-plugin-copilot)
   │  fetch /copilot/api/*（同源 JSON envelope）
   ▼
Host gateway (src/gateway.ts, ctx.webServer)
   ├─ status    → flow 探查（authorization.list）× record（credentials.describeRecord）× profile（settings.get）
   ├─ login     → authorization.begin(llm-pi-ai:github-copilot)   ← dsh-llm-pi-ai 注册的 device-flow
   │   notices/prompts → 序列化事件环 → events 轮询；login 请求即起即返
   │   flow 开头的 enterprise 提问按插件配置自动作答（默认 github.com，不进卡片）
   ├─ answer    → 卡片回答 flow 的其余提问（未被识别的 prompt 走此手动路径）
   ├─ cancel    → authorization.cancel
   ├─ logout    → credentials.deleteRecord
   └─ autofill  → settings.update('llm-pi-ai', { providers: { 'github-copilot': { models: 交集 } } })（幂等；模型目录不可用时退回 `{}`）
```

- 凭证由 pi-ai flow 自己写入 `llm-pi-ai:github-copilot` record（scope 所有权不越权），插件只读 `describeRecord`。
- device-flow 轮询节奏（RFC 8628）由 pi-ai flow 负责，卡片只消费事件流。
- GitHub Enterprise 部署：在插件配置里填 `enterpriseDomain`（如 `company.ghe.com`）；默认留空即 github.com 公有部署。

## 开发

```powershell
pnpm install
pnpm run typecheck   # tsc --noEmit（类型经 ~/.dsh/source/current 解析）
pnpm test            # vitest run（48 个用例：status join / gateway / 控制器 / 卡片渲染）
pnpm run build       # tsdown（lib/index.js + lib/invariant.js + lib/client.js）+ tsc 声明
```

目录：`src/index.ts`（host 入口：命名空间注册 + gateway + 工具）· `src/status.ts`（状态 join 与 flow 探查）· `src/gateway.ts`（/copilot/api 路由与登录状态机）· `src/tools.ts`（copilot_status 工具）· `src/invariant.ts`（不变量伴生）· `src/client/`（浏览器半：卡片 + 控制器 + 词典）。

设计依据见 `docs/plans/2026-08-28-webui-copilot-auth-design.md`。

## 运行（挂载验证）

```powershell
dsh plugin --profile web add link:<本目录>
# 由人类执行 dsh web 启动后：
#   设置 → 插件配置 → GitHub Copilot 卡片可见
#   登录 → 浏览器完成授权 → 成功态；Models 页出现 github-copilot 路由与模型
```

## 检查

- `pnpm run typecheck` 零错误；`pnpm test` 48/48 通过（keyless，无真实 API 依赖）。
- `lib/` 产物自包含（仅 peer 外部依赖 + node 内置），`node -e "import('./lib/index.js')"` 可直接加载；client bundle 以 `window.__ModuleLoader__.load` 包裹。
- 合规：零源码 patch；预构建 `lib/` 入库（含 `@deepseek-ai/*` private peer，无 `prepare`）；同源 fence + JSON envelope。

## 许可

MIT
