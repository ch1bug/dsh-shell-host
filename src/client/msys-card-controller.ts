/** The MSYS2 page's staged form over the composed host shell executor entry. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Profile entry id of this bundle's executor row (cordis.patch.yml `- insert`).
 * The settings-controller serves one namespace per Loader entry id, so this
 * string is both the configForms key and the card's identity on the Plugins page.
 */
export const MSYS_NS = 'bash-msys'

/** The MSYS2 fields this page edits — a subset of the served schema by design. */
export interface MsysSettings {
  /** Backend selector: `'msys2'` (environment injection) or `'plain'` (detected bash). */
  backend?: string
  /** MSYS2 subsystem injected as `MSYSTEM` (`UCRT64` default; `'none'` disables injection). */
  subsystem?: string
  /** MSYS2 install root; empty auto-detects. */
  msysRoot?: string
  /** Explicit bash executable; empty resolves from the root or detection. */
  bashPath?: string
  /** Foreground command timeout in milliseconds. */
  timeoutMs?: number
  /** Per-stream in-memory output cap in bytes. */
  maxOutputBytes?: number
}

/** What the MSYS2 page renders. */
export interface MsysCardState extends SettingsFormShell {
  /** Backend selector. */
  backend: SettingsFieldState
  /** MSYSTEM subsystem. */
  subsystem: SettingsFieldState
  /** MSYS2 install root. */
  msysRoot: SettingsFieldState
  /** Bash executable override. */
  bashPath: SettingsFieldState
  /** Command timeout in milliseconds. */
  timeoutMs: SettingsFieldState
  /** Per-stream output cap in bytes. */
  maxOutputBytes: SettingsFieldState
}

/** The registration-side face the MSYS2 page's slot entry injects. */
export interface MsysCardFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as useMsysCard. */
    msysCard: SnapshotStore<MsysCardState>
  }
}

/** Bridges the executor entry's form onto the page's staged form. */
export class MsysCardController {
  private readonly form: SettingsFormModel<MsysSettings>
  private readonly store: SnapshotStore<MsysCardState>

  /** @param scope - the shared configuration form of the composed executor entry. */
  constructor(scope: SettingsFormScope<MsysSettings>) {
    this.form = new SettingsFormModel(scope, [
      settingsTextField('backend'),
      settingsTextField('subsystem'),
      settingsTextField('msysRoot'),
      settingsTextField('bashPath'),
      settingsNumberField('timeoutMs'),
      settingsNumberField('maxOutputBytes'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): MsysCardState {
    return {
      ...this.form.shell(),
      backend: this.form.field('backend'),
      subsystem: this.form.field('subsystem'),
      msysRoot: this.form.field('msysRoot'),
      bashPath: this.form.field('bashPath'),
      timeoutMs: this.form.field('timeoutMs'),
      maxOutputBytes: this.form.field('maxOutputBytes'),
    }
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page's snapshot and its form actions.
   */
  inject(): MsysCardFace {
    return { hooks: { msysCard: this.store }, ...this.form.actions() }
  }

  /** Release the form subscription. */
  dispose(): void { this.form.dispose() }
}
