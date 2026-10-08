/** The MSYS2 executor's settings page: the environment the bash tool runs in. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsValueField, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type { ShellCardFace } from './shell-card-controller.ts'
import type { SettingsFieldState } from '@deepseek-ai/dsh-client-ui-primitives'

/** Props the renderer binds for the MSYS2 page. */
export type ShellCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.shell-host'>
  & InjectFace<ShellCardFace>

/** The routable backend ids (AC6/AC8: five options, one dropdown). */
const BACKEND_OPTIONS = ['msys2', 'plain', 'pwsh', 'wsl', 'ssh'] as const

type SelectFieldProps = {
  id: string
  label: string
  hint: string
  /** Locale copy for the empty-draft placeholder option (inherit = the composition default). */
  placeholderLabel: string
  options: readonly string[]
  disabled: boolean
  overriddenLabel: string
  resetLabel: string
  field: SettingsFieldState
  onEdit: (text: string) => void
  onReset: () => void
}

/**
 * A choice field in the shared settings form's layout: the same head row
 * (label, overridden badge, reset) and hint paragraph as the primitives'
 * `SettingsValueField` (lib/settings-form/fields.tsx — no select variant is
 * exported, so this mirrors its DOM; re-diff on upstream bumps), with a
 * native `<select>` as the control — the backend ids are a closed set, so
 * free text is the wrong control (AC8). An empty draft renders a
 * default-marked placeholder option (inherit the composition value).
 */
function SettingsSelectField(props: SelectFieldProps) {
  const { field } = props
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <label htmlFor={props.id} style={{ fontWeight: 500 }}>{props.label}</label>
        {field.overridden ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Tag tone="neutral">{props.overriddenLabel}</Tag>
            <button type="button" disabled={props.disabled} onClick={props.onReset}>{props.resetLabel}</button>
          </span>
        ) : null}
      </div>
      <select
        id={props.id}
        value={field.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
        style={{ maxWidth: 280 }}
      >
        {field.text === '' ? <option value="">{props.placeholderLabel}</option> : null}
        {props.options.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
      <p style={{ margin: 0, opacity: 0.7, fontSize: '0.9em' }}>{props.hint}</p>
    </div>
  )
}

/**
 * Render the MSYS2 executor's one-liner or its settings form, as the Plugins page asks.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the form.
 */
export function ShellCard(props: ShellCardProps) {
  const { t } = props
  const state = props.useShellCard(snapshot => snapshot)
  if (props.view === 'summary') return t('description')
  const disabled = !state.writable
  const overriddenLabel = t('overridden')
  const resetLabel = t('reset')
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <SettingsSelectField
        id="plugin-config-shell-host-backend"
        label={t('backend')}
        hint={t('backendHint')}
        placeholderLabel={t('backendDefault')}
        options={BACKEND_OPTIONS}
        disabled={disabled}
        overriddenLabel={overriddenLabel}
        resetLabel={resetLabel}
        field={state.backend}
        onEdit={(text) => { props.edit('backend', text) }}
        onReset={() => { props.resetField('backend') }}
      />
      <SettingsValueField
        id="plugin-config-shell-host-subsystem"
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
        id="plugin-config-shell-host-root"
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
        id="plugin-config-shell-host-bash-path"
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
        id="plugin-config-shell-host-ssh-host"
        label={t('sshHost')}
        hint={t('sshHostHint')}
        overriddenLabel={overriddenLabel}
        resetLabel={resetLabel}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.sshHost}
        onEdit={(text) => { props.edit('sshHost', text) }}
        onReset={() => { props.resetField('sshHost') }}
      />
      <SettingsValueField
        id="plugin-config-shell-host-timeout"
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
        id="plugin-config-shell-host-output"
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
