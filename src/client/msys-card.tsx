/** The MSYS2 executor's settings page: the environment the bash tool runs in. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type { MsysCardFace } from './msys-card-controller.ts'

/** Props the renderer binds for the MSYS2 page. */
export type MsysCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.bash-msys'>
  & InjectFace<MsysCardFace>

/**
 * Render the MSYS2 executor's one-liner or its settings form, as the Plugins page asks.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the form.
 */
export function MsysCard(props: MsysCardProps) {
  const { t } = props
  const state = props.useMsysCard(snapshot => snapshot)
  if (props.view === 'summary') return t('description')
  const disabled = !state.writable
  const overriddenLabel = t('overridden')
  const resetLabel = t('reset')
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <SettingsValueField
        id="plugin-config-bash-msys-backend"
        label={t('backend')}
        hint={t('backendHint')}
        overriddenLabel={overriddenLabel}
        resetLabel={resetLabel}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.backend}
        onEdit={(text) => { props.edit('backend', text) }}
        onReset={() => { props.resetField('backend') }}
      />
      <SettingsValueField
        id="plugin-config-bash-msys-subsystem"
        label={t('subsystem')}
        hint={t('subsystemHint')}
        overriddenLabel={overriddenLabel}
        resetLabel={resetLabel}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.subsystem}
        onEdit={(text) => { props.edit('subsystem', text) }}
        onReset={() => { props.resetField('subsystem') }}
      />
      <SettingsValueField
        id="plugin-config-bash-msys-root"
        label={t('msysRoot')}
        hint={t('msysRootHint')}
        overriddenLabel={overriddenLabel}
        resetLabel={resetLabel}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.msysRoot}
        onEdit={(text) => { props.edit('msysRoot', text) }}
        onReset={() => { props.resetField('msysRoot') }}
      />
      <SettingsValueField
        id="plugin-config-bash-msys-bash-path"
        label={t('bashPath')}
        hint={t('bashPathHint')}
        overriddenLabel={overriddenLabel}
        resetLabel={resetLabel}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.bashPath}
        onEdit={(text) => { props.edit('bashPath', text) }}
        onReset={() => { props.resetField('bashPath') }}
      />
      <SettingsValueField
        id="plugin-config-bash-msys-timeout"
        label={t('timeoutMs')}
        hint={t('timeoutMsHint')}
        overriddenLabel={overriddenLabel}
        resetLabel={resetLabel}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.timeoutMs}
        onEdit={(text) => { props.edit('timeoutMs', text) }}
        onReset={() => { props.resetField('timeoutMs') }}
      />
      <SettingsValueField
        id="plugin-config-bash-msys-output"
        label={t('maxOutputBytes')}
        hint={t('maxOutputBytesHint')}
        overriddenLabel={overriddenLabel}
        resetLabel={resetLabel}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.maxOutputBytes}
        onEdit={(text) => { props.edit('maxOutputBytes', text) }}
        onReset={() => { props.resetField('maxOutputBytes') }}
      />
    </SettingsForm>
  )
}
