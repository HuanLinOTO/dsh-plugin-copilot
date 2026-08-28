/**
 * Locale dictionaries for the `dsh-plugin-copilot` card namespace.
 *
 * @module @huanlin/dsh-plugin-copilot/client/locales
 */

/** The locale keys the Copilot card reads. */
export type CopilotKey =
  | 'card.title'
  | 'card.intro'
  | 'card.unsupported'
  | 'card.signedIn'
  | 'card.signedOut'
  | 'card.routeActive'
  | 'card.routeDormant'
  | 'card.models'
  | 'action.signIn'
  | 'action.signOut'
  | 'action.cancel'
  | 'action.retry'
  | 'action.activate'
  | 'action.syncModels'
  | 'action.openUrl'
  | 'action.copyCode'
  | 'action.copied'
  | 'action.decline'
  | 'action.submit'
  | 'state.pending'
  | 'state.pendingPrompt'
  | 'state.working'
  | 'state.success'
  | 'state.error'
  | 'notice.deviceCode'
  | 'notice.polling'
  | 'prompt.placeholder'
  | 'prompt.answer'

/** The locale namespace name; matches the `locale: NS` passed at slot register. */
export const NS = 'dsh-plugin-copilot'

/** English dictionary. */
export const en: Record<CopilotKey, string> = {
  'card.title': 'GitHub Copilot',
  'card.intro': 'Sign in to GitHub Copilot and activate its model route (served by dsh-llm-pi-ai).',
  'card.unsupported': 'Copilot sign-in needs dsh-llm-pi-ai (0.1.2-alpha.1 or later) with the github-copilot catalog provider.',
  'card.signedIn': 'Signed in',
  'card.signedOut': 'Not signed in',
  'card.routeActive': 'Route active',
  'card.routeDormant': 'Route not activated',
  'card.models': 'Models available to this account:',
  'action.signIn': 'Sign in with GitHub',
  'action.signOut': 'Sign out',
  'action.cancel': 'Cancel',
  'action.retry': 'Retry',
  'action.activate': 'Activate route',
  'action.syncModels': 'Sync model list',
  'action.openUrl': 'Open verification page',
  'action.copyCode': 'Copy code',
  'action.copied': 'Copied',
  'action.decline': 'Decline',
  'action.submit': 'Submit',
  'state.pending': 'Waiting for authorization…',
  'state.pendingPrompt': 'Answer the question below to continue signing in — the device code appears right after.',
  'state.working': 'Working…',
  'state.success': 'Signed in. The Copilot models are ready — pick one on the Models page.',
  'state.error': 'Failed',
  'notice.deviceCode': 'Open the verification page and enter this code:',
  'notice.polling': 'Waiting for you to finish in the browser…',
  'prompt.placeholder': 'Your answer',
  'prompt.answer': 'GitHub asks',
}

/** Chinese dictionary. */
export const zh: Record<CopilotKey, string> = {
  'card.title': 'GitHub Copilot',
  'card.intro': '登录 GitHub Copilot 并激活其模型路由（由 dsh-llm-pi-ai 提供）。',
  'card.unsupported': 'Copilot 登录需要 dsh-llm-pi-ai（0.1.2-alpha.1 或更高）内置的 github-copilot 供应商。',
  'card.signedIn': '已登录',
  'card.signedOut': '未登录',
  'card.routeActive': '路由已激活',
  'card.routeDormant': '路由未激活',
  'card.models': '当前账号可用模型：',
  'action.signIn': '使用 GitHub 登录',
  'action.signOut': '退出登录',
  'action.cancel': '取消',
  'action.retry': '重试',
  'action.activate': '激活路由',
  'action.syncModels': '同步模型列表',
  'action.openUrl': '打开验证页面',
  'action.copyCode': '复制代码',
  'action.copied': '已复制',
  'action.decline': '拒绝',
  'action.submit': '提交',
  'state.pending': '等待授权中…',
  'state.pendingPrompt': '回答下面的问题即可继续登录，随后会显示设备码和验证页面。',
  'state.working': '处理中…',
  'state.success': '已登录，Copilot 模型就绪 — 去 Models 页选择即可。',
  'state.error': '失败',
  'notice.deviceCode': '打开验证页面并输入此代码：',
  'notice.polling': '等待你在浏览器中完成授权…',
  'prompt.placeholder': '输入你的回答',
  'prompt.answer': 'GitHub 需要你回答',
}
