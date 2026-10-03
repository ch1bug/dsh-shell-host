/**
 * Host-only fork of `@deepseek-ai/dsh-permission-presets` (issue #10): the
 * upstream service refuses composition over a non-confining executor, which
 * D8's host-plane replacement made the only posture on win32 — killing all
 * three permission UI surfaces. This fork keeps the ENTIRE public contract
 * (context service key `permissionPresets`, the Typert wire namespace, the
 * `/permission` command's definition id, the `permission/preset` session
 * event, the `permissions` projection unit, the Auto review hook, and the
 * config surface) so the STOCK client UI composes against it unchanged.
 *
 * The one semantic difference: presets here bundle the FILE-policy knobs
 * only. The sandbox fallback beneath an empty session log is the deployment
 * default from `ctx.sandboxPolicy` (the same knob `sandbox/mode` writes
 * through), never an executor capability — the fork does not read the shell
 * seam at all, so no code path claims process confinement. Switching a
 * preset writes both `sandbox/mode` (governs the file sandbox and any
 * confining backend) and `approval/policy` exactly as upstream does.
 *
 * Drift policy: keep this file a minimal delta of upstream
 * packages/interaction/permission-presets/src/index.ts at the pinned tag;
 * re-diff on every upstream bump. Upstream PR explicitly NOT pursued (human
 * decision 2026-09-30, docs/adr/0002).
 *
 * @module dsh-shell-host/permission-presets
 */
// Type-only: the settings surface this service re-configures. Resolved from
// the published dist declaration (ADR-0005 npm lane); the runtime import is
// stripped, and the typecheck program stays free of the settings ->
// config-editor -> hmr source chain.
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SANDBOX_MODES, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { APPROVAL_POLICIES, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
// Type-only: resolves the required projection service and optional settings/command children.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-commands'

/** One selectable entry a client renders in a permission picker. */
export interface PresetOption {
  /** Switch target: a configured preset key, live `auto`, or `custom`. */
  value: string
  /** Display label. */
  name: string
  /** One user-facing sentence on what the option means; omitted when not configured. */
  description?: string
}

/** The process-level catalog the stock client permission surfaces read. */
export interface PermissionCatalog {
  /** Every currently selectable preset in contribution order. */
  options: PresetOption[]
  /** The configured table only (no derived/live entries). */
  defaultOptions: PresetOption[]
  /** The preset pinned into newly created sessions. */
  defaultPreset: string
}

/** The `permissions` projection unit's view: the current selection only. */
export interface PermissionSelection {
  /** Effective preset name (a table key, `auto`, or `custom`). */
  currentValue: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    permissionPresets: PermissionPresetService
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The selectable process catalog changed. Payload-free by design:
     * consumers subscribe first, then re-read the complete catalog.
     * @mode emit
     */
    'permission-presets/catalog-changed'(): void
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Latest logged permission overrides and constructor-seed status. */
    permissions: PermissionProjectionState
  }
  interface SessionProjectionMap {
    /**
     * The session's current permission, folded from the three whole-value
     * knob events ('permission/preset', 'sandbox/mode', 'approval/policy')
     * over the composition defaults. Selectable options come from the
     * process-level catalog Remote. Key absence means no permission service
     * is composed — clients hide the control.
     */
    permissions: PermissionSelection
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records the selected preset as durable, log-only user intent. The knob
     * events follow in the same turn and control execution; this event stays
     * out of the model transcript and lets the permission projection unit
     * preserve a selection when bundles match.
     */
    'permission/preset': { preset: string }
  }
}

/** One preset's sandbox/approval bundle and optional client presentation. */
export interface PresetSpec {
  /** The `sandbox/mode` value the preset writes through. */
  sandbox: SandboxMode
  /** The `approval/policy` value the preset writes through. */
  approval: ApprovalPolicy
  /** The display label a client shows for this preset; the raw table key when omitted. */
  name?: string
  /** One user-facing sentence on what the preset means; omitted when not configured. */
  description?: string
}

/**
 * Returned when effective knob values match no available preset. Clients may
 * show it as the current value, but it is never a switch target or event payload.
 */
export const CUSTOM_PRESET = 'custom'

/** Canonical identity of the experimental per-call review preset. */
export const AUTO_PRESET = 'auto'

/**
 * Fixed execution bundle for the live Auto integration. `ask` routes reviewer
 * denials to the user; a stored Auto identity also matches `never`, which a
 * delegated child pins so its reviewer denials stay final.
 */
const AUTO_PRESET_SPEC: PresetSpec = {
  sandbox: 'danger-full-access',
  approval: 'ask',
}

/**
 * The projection unit's knob state: the last seen value of each knob event,
 * null before an override (composition defaults apply at view time).
 */
export interface KnobState {
  /** Last `permission/preset` payload, or null. */
  preset: string | null
  /** Last `sandbox/mode` payload, or null. */
  sandbox: SandboxMode | null
  /** Last `approval/policy` payload, or null. */
  approval: ApprovalPolicy | null
}

/** Projection state for permission overrides and constructor-seed status. */
interface PermissionProjectionState extends KnobState {
  /** Whether the log contains a constructor-seed boundary. */
  seeded: boolean
}

const permissionStateSchema: zod.ZodType<PermissionProjectionState> = zod.object({
  preset: zod.string().nullable(),
  sandbox: zod.union([
    zod.literal('read-only'),
    zod.literal('workspace-write'),
    zod.literal('danger-full-access'),
  ]).nullable(),
  approval: zod.union([zod.literal('ask'), zod.literal('never')]).nullable(),
  seeded: zod.boolean(),
}).strict()

/** State for the empty log: every knob at its composition default. */
const EMPTY_KNOBS: KnobState = { preset: null, sandbox: null, approval: null }

/**
 * One-event permission-state transition (the projection unit's `apply`). Unrelated
 * events return the same reference — the registry's change gate.
 * @param state - the folded knob state before `event`.
 * @param event - one committed session event.
 * @returns the next state; the same reference when the event is unrelated.
 */
function applyPermissionEvent(
  state: PermissionProjectionState,
  event: SessionEvent,
): PermissionProjectionState {
  switch (event.type) {
    case 'permission/preset':
      return { ...state, preset: event.data.preset }
    case 'sandbox/mode':
      return { ...state, sandbox: event.data.mode }
    case 'approval/policy':
      return { ...state, approval: event.data.policy }
    case 'session/end-seed':
      return { ...state, seeded: true }
    default:
      return state
  }
}

/** User setting resolved when a new session receives its initial permission. */
export interface PermissionSettings {
  /** Preset pinned into a newly created session. */
  defaultPreset: string
}

/** The {@link PermissionPresetService} config: preset table and composition default. */
export interface Config {
  /**
   * The preset table: name → knob bundle. Defaults to `workspace-write`
   * (workspace-write + ask) and `danger-full-access` (danger-full-access +
   * never). The names `custom` and `auto` are reserved for derived state and
   * the Auto review integration respectively.
   */
  presets: Record<string, PresetSpec>
  /**
   * Default for new sessions. When omitted, the preset matching the composed
   * sandbox and approval defaults is used.
   */
  defaultPreset: Volatile<string | undefined>
}

/**
 * Owns the deployment's configured permission presets, the fixed Auto
 * integration hook, and their write path. Composes over ANY executor —
 * unlike upstream, a non-confining executor is not a misconfiguration here:
 * presets bundle the file-policy knobs (`ctx.sandboxPolicy` + `ctx.approval`),
 * never an executor capability. Requires `ctx.approval`; unmatched knob
 * values are reported as {@link CUSTOM_PRESET}, not an error.
 */
export class PermissionPresetService extends TypertRemoteService {
  // Inline schema call: the config catalog walks `static Config` statically.
  // Cast to the hand-written Config face: the inferred type reaches
  // schemastery's Dict (cosmokit), which TS2883 refuses to name portably in
  // emitted declarations under the npm lane (ADR-0006). Runtime validation
  // is unchanged — the cast records the declared face, nothing more.
  static Config = z.object({
    presets: z.dict(z.object({
      sandbox: z.union(SANDBOX_MODES as SandboxMode[]).required(),
      approval: z.union(APPROVAL_POLICIES as ApprovalPolicy[]).required(),
      name: z.string(),
      description: z.string(),
    })).default({
      'workspace-write': {
        sandbox: 'workspace-write', approval: 'ask',
        name: 'workspace-write', description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.',
      },
      'danger-full-access': {
        sandbox: 'danger-full-access', approval: 'never',
        name: 'danger-full-access', description: 'Full file access without approval prompts.',
      },
    }),
    defaultPreset: z.string().volatile(),
  }) as unknown as Schemastery<Config>

  static inject = ['sandboxPolicy', 'approval', 'sessions', 'sessionProjections']

  private readonly presets: Record<string, PresetSpec>
  private autoAdmit: (() => void) | undefined
  private defaultSettings: () => PermissionSettings

  constructor(ctx: Context, config: Config) {
    super(ctx, 'permissionPresets')

    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
    // The schema defaulted the table — the cast records that runtime fact.
    this.presets = config.presets
    if (CUSTOM_PRESET in this.presets) {
      throw new Error(`permission: "${CUSTOM_PRESET}" is reserved for the derived not-a-preset state and cannot name a table entry`)
    }
    if (AUTO_PRESET in this.presets) {
      throw new Error(`permission: "${AUTO_PRESET}" is reserved and cannot name a configured preset`)
    }
    // #10 fork delta: NO executor-capability check. The empty-log sandbox
    // fallback is the deployment's file-policy default (`ctx.sandboxPolicy`),
    // which exists identically over confining and non-confining executors.
    const inferredDefault = this.derive(EMPTY_KNOBS)
    const defaultPreset = config.defaultPreset.get() ?? inferredDefault
    if (defaultPreset === CUSTOM_PRESET) {
      throw new Error('permission: composed sandbox and approval defaults match no preset; configure defaultPreset explicitly')
    }
    this.resolve(defaultPreset)
    this.defaultSettings = () => {
      const defaultPreset = config.defaultPreset.get() ?? inferredDefault
      if (!Object.hasOwn(this.presets, defaultPreset)) throw new Error(`permission: unknown default preset "${defaultPreset}"`)
      return { defaultPreset }
    }

    const selectionSchema = zod.object({
      currentValue: zod.string().min(1),
    }) as zod.ZodType<PermissionSelection>
    ctx.sessionProjections.register({
      key: 'permissions',
      stateVersion: 2,
      stateSchema: permissionStateSchema,
      init: () => ({ ...EMPTY_KNOBS, seeded: false }),
      apply: applyPermissionEvent,
      wire: { viewSchema: selectionSchema, view: state => ({ currentValue: this.derive(state) }) },
    })
    ctx.on('session/created', (session) => {
      this.pinInitialPermission(session)
    })
    for (const session of ctx.sessions.list()) {
      this.pinInitialPermission(session)
    }

    // The /permission command: the one write path a web client uses (the
    // popup contribution submits the picked preset as this line). The child
    // activates only when a command registry is composed. The definition id
    // stays upstream's so the client's builtin-command presentation (localized
    // token, icon) keeps resolving.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        definitionId: CommandDefinitionId('@deepseek-ai/dsh-permission-presets'),
        name: 'permission',
        description: 'Switch the permission preset (sandbox mode + approval policy)',
        input: { hint: '<preset>' },
        // No settlement text labels its value with this command's own name: a
        // surface that renders `name · text` (the web command row) would
        // otherwise read `permission · Permission preset: workspace-write.`
        handler: ({ agent, rawInput }) => {
          const name = rawInput.trim()
          if (name === '') {
            return { kind: 'success', text: `current preset ${this.current(agent.session)} (available: ${this.names.join(', ')})` }
          }
          if (!this.names.includes(name)) {
            return { kind: 'error', text: `unknown preset "${name}" (available: ${this.names.join(', ')})` }
          }
          this.apply(agent.session, name, (policy) => { this.ctx.approval.setPolicy(agent, policy) })
          return { kind: 'success', text: `preset ${name}` }
        },
      })
    })
  }

  /**
   * The advertised preset names: configured entries in declaration order,
   * followed by Auto while its integration is live.
   * @returns every switchable preset name.
   */
  get names(): readonly string[] {
    return [...Object.keys(this.presets), ...(this.autoAdmit === undefined ? [] : [AUTO_PRESET])]
  }

  /**
   * Read the complete process-level catalog exposed to current-session UI.
   * @returns every currently selectable preset in contribution order.
   */
  @Remote('catalog')
  catalog(): PermissionCatalog {
    return {
      options: this.names.map(name => this.optionOf(name)),
      defaultOptions: Object.keys(this.presets).map(name => this.optionOf(name)),
      defaultPreset: this.defaultSettings().defaultPreset,
    }
  }

  /**
   * Publish the fixed current-session Auto preset for the calling
   * integration's effect lifetime.
   * @param admit - synchronous gate run before live Auto selection or restore.
   * @returns the async effect disposer that removes Auto.
   */
  registerAuto(admit: () => void): () => Promise<void> {
    return this.ctx.effect(() => {
      if (this.autoAdmit !== undefined) throw new Error('permission: preset "auto" is already registered')
      this.autoAdmit = admit
      this.emitCatalogChanged()
      return () => {
        this.autoAdmit = undefined
        this.emitCatalogChanged()
      }
    }, 'permissionPresets.registerAuto()')
  }

  /**
   * The preset currently selected as the default for future sessions.
   * @returns the resolved settings value, or the composition default without
   * a mounted settings provider.
   */
  get defaultPreset(): string {
    return this.defaultSettings().defaultPreset
  }

  private permissionState(session: Session): PermissionProjectionState {
    const state = this.ctx.sessionProjections.stateOf(session, 'permissions')
    if (state === undefined) throw new Error('permission: permissions session projection is not registered')
    return state
  }

  /**
   * Resolve the preset matching the effective knob values. A still-matching
   * last selection wins shared-bundle ties, and a still-selected Auto also
   * matches the `never` approval policy; otherwise the first configured
   * match wins. Returns
   * {@link CUSTOM_PRESET} when no available preset matches.
   * @param session - the session whose knob state is read.
   * @returns the effective preset name, or `custom` when nothing matches.
   */
  current(session: Session): string {
    return this.derive(this.permissionState(session))
  }

  /** Resolve the preset for one folded knob state (the shared mathematics of `current` and the projection unit). */
  private derive(state: KnobState): string {
    // #10 fork delta: the empty-log sandbox fallback is the file-policy
    // default, not an executor capability.
    const sandbox = state.sandbox ?? this.ctx.sandboxPolicy.defaultMode
    const approval = state.approval ?? this.ctx.approval.config.policy ?? 'ask'
    const matches = (spec: PresetSpec): boolean => spec.sandbox === sandbox && spec.approval === approval
    if (state.preset !== null) {
      const spec = this.specOf(state.preset)
      if (spec !== undefined && matches(spec)) return state.preset
      if (state.preset === AUTO_PRESET && spec?.sandbox === sandbox && approval === 'never') return AUTO_PRESET
    }
    for (const [name, spec] of Object.entries(this.presets)) {
      if (matches(spec)) return name
    }
    return CUSTOM_PRESET
  }

  /**
   * Resolve an available preset's knob bundle.
   * @param name - the preset name to resolve.
   * @returns the configured bundle.
   * @throws when `name` is neither configured nor the currently live Auto preset.
   */
  resolve(name: string): PresetSpec {
    const spec = this.specOf(name)
    if (spec === undefined) {
      throw new Error(`permission: unknown preset "${name}" (known: ${this.names.join(', ')})`)
    }
    return spec
  }

  /**
   * Build the client option for an available preset or {@link CUSTOM_PRESET}.
   * A missing label falls back to the preset key.
   * @param name - a configured preset key, live `auto`, or `custom`.
   * @returns the option a client renders.
   * @throws when `name` is neither a configured preset, live `auto`, nor `custom`.
   */
  optionOf(name: string): PresetOption {
    if (name === CUSTOM_PRESET) {
      return { value: CUSTOM_PRESET, name: 'Custom', description: 'Current sandbox and approval settings do not match a preset.' }
    }
    const spec = this.resolve(name)
    return { value: name, name: spec.name ?? name, ...spec.description !== undefined ? { description: spec.description } : {} }
  }

  /**
   * Record a changed preset, then update each changed knob through its own
   * setter. Selecting the effective preset again appends nothing.
   * @param session - the session the switch belongs to.
   * @param name - the preset to switch to; unknown names throw.
   */
  set(session: Session, name: string): void {
    this.apply(session, name, (policy) => { setApprovalPolicy(session, policy) })
  }

  /** Apply one preset through its durable identity and canonical knob setters. */
  private apply(session: Session, name: string, setApproval: (policy: ApprovalPolicy) => void): void {
    const spec = this.resolve(name)
    if (name === AUTO_PRESET) this.autoAdmit?.()
    const current = this.current(session)
    const knobs = this.permissionState(session)
    const updateKnobs = (): void => {
      if (spec.sandbox !== (knobs.sandbox ?? this.ctx.sandboxPolicy.defaultMode)) {
        setSandboxMode(session, spec.sandbox)
      }
      if (spec.approval !== (knobs.approval ?? this.ctx.approval.config.policy ?? 'ask')) {
        setApproval(spec.approval)
      }
    }
    if (current !== name) session.append('permission/preset', { preset: name })
    updateKnobs()
  }

  /**
   * Fill every missing permission fact before a session is published. A
   * genuinely fresh session uses the current user default; seeded or partially
   * initialized sessions preserve their effective knob values and only gain
   * the missing durable facts. A stored Auto identity requires its live
   * integration and passes its admission check before
   * publication.
   */
  private pinInitialPermission(session: Session): void {
    const state = this.permissionState(session)
    const { preset, sandbox, approval, seeded } = state
    if (preset === AUTO_PRESET) {
      if (this.autoAdmit === undefined) {
        throw new Error('permission: cannot restore preset "auto" without its active integration')
      }
      this.autoAdmit()
    }
    if (preset === null && sandbox === null && approval === null && !seeded) {
      const name = this.defaultPreset
      const spec = this.resolve(name)
      session.append('permission/preset', { preset: name })
      setSandboxMode(session, spec.sandbox)
      setApprovalPolicy(session, spec.approval)
      return
    }

    const effective = this.derive(state)
    if (preset === null && effective !== CUSTOM_PRESET) {
      session.append('permission/preset', { preset: effective })
    }
    if (sandbox === null) {
      // #10 fork delta: the materialized default is the file-policy default.
      setSandboxMode(session, this.ctx.sandboxPolicy.defaultMode)
    }
    if (approval === null) {
      setApprovalPolicy(session, this.ctx.approval.config.policy ?? 'ask')
    }
  }

  /** Publish a non-vetoing payload-free catalog invalidation. */
  private emitCatalogChanged(): void {
    for (const listener of this.ctx.events.dispatch('emit', ['permission-presets/catalog-changed']) as Array<() => unknown>) {
      try {
        const returned = listener()
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).catch((error: unknown) => {
            this.ctx.logger.warn(`permission: catalog-changed listener failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`permission: catalog-changed listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Resolve one configured or currently live fixed preset without throwing. */
  private specOf(name: string): PresetSpec | undefined {
    return this.presets[name]
      ?? (name === AUTO_PRESET && this.autoAdmit !== undefined ? AUTO_PRESET_SPEC : undefined)
  }
}

export default PermissionPresetService
