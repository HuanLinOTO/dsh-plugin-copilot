/**
 * dsh-plugin-copilot — browser half.
 *
 * One registration: a `settings.plugin.item` card (key `dsh-plugin-copilot`)
 * in the Plugins settings page, rendering the Copilot onboarding state
 * machine (sign-in device-flow panel, route activation, sign-out) through
 * the host's `/copilot/api` gateway.
 *
 * @module @huanlin/dsh-plugin-copilot/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the client Context merges (ctx.slots, ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { CopilotAuthCard } from './CopilotAuthCard.tsx'
import type { CopilotCardInjected } from './CopilotAuthCard.tsx'
import { CopilotAuthController } from './controller.ts'
import { bindSnapshotSelector } from './bindSnapshotSelector.ts'
import { en, zh, NS } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Copilot onboarding card labels. */
    'dsh-plugin-copilot': import('./locales.ts').CopilotKey
  }
}

/** Required services: the slot ledger and the locale dictionaries. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the locale dictionaries and the settings card.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-copilot: dictionaries')

  const controller = new CopilotAuthController()
  ctx.effect(() => () => { controller.dispose() }, 'dsh-plugin-copilot: card controller')
  const useCard = bindSnapshotSelector(controller.store)

  const injected = (): CopilotCardInjected => ({ controller, useCard })
  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: 'dsh-plugin-copilot',
        locale: NS,
        inject: injected,
      },
      CopilotAuthCard,
    )
  })
}
