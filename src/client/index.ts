/**
 * The MSYS2 executor's settings page, browser half: backend, subsystem,
 * install root, bash path, and the command budgets over the `shell-host`
 * namespace the host executor row serves. The page registers into the Plugins
 * page's `plugins.item` slot while the Host serves that namespace, so a
 * deployment without this bundle shows no trace of it.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ShellCard } from './shell-card.tsx'
import { SHELL_NS, ShellCardController } from './shell-card-controller.ts'
import { en, zh, type ShellSettingsLocaleKey } from './locales.ts'

export type { ShellCardProps } from './shell-card.tsx'
export type { ShellCardFace, ShellCardState, ShellSettings } from './shell-card-controller.ts'
export type { ShellSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MSYS2 settings page copy. */
    'settings.shell-host': ShellSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.shell-host'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the MSYS2 settings page while the Host serves the executor's namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'shell-host: dictionaries')
  // The base platform composes exactly one shell executor; with this bundle it
  // is ours (id `shell-host`), so the card edits the live executor's config.
  const controller = new ShellCardController(ctx.configForms.get(SHELL_NS))
  ctx.effect(() => () => { controller.dispose() }, 'shell-host: form subscription')
  ctx.effect(() => ctx.configForms.whileServed([SHELL_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'shell-host', order: 11, label: () => t('title'), locale: NS, inject: () => controller.inject(),
  }, ShellCard))), 'shell-host: page')
}
