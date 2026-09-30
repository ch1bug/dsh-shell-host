import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import YAML from 'yaml'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import MsysPermissionPresets, { CUSTOM_PRESET } from '../src/permission-presets.ts'

/**
 * #10 acceptance tests: the host-only fork of `@deepseek-ai/dsh-permission-presets`
 * composes over a NON-confining executor (`sandboxMode === undefined`, the D8
 * bash-msys deployment posture) and revives the permission surfaces through the
 * SAME service identity. Pure composition — no MSYS2 install needed, so the
 * suite runs in the win32 unit lane.
 */

/** The base bundle's mounted permission table (issue #10 contract: identical defaults). */
const BASE_PRESETS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
} as const

/** Compose exactly like the win32 host plane: non-confining executor + policy home. */
async function mounted(options: {
  policyMode?: SandboxMode
  approvalDefault?: ApprovalPolicy
  config?: Record<string, unknown>
} = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, {
    mode: options.policyMode ?? 'workspace-write',
    workspaceRoot: process.cwd(),
  })
  // The regression posture itself: an executor that does NOT confine and does
  // NOT report a sandboxMode (upstream throws exactly here). We provide it to
  // prove the fork ignores the seam rather than silently assuming one.
  ctx.provide('shell', {
    sandboxMode: undefined,
    resolve() { throw new Error('fork tests do not execute bash') },
    run() { throw new Error('fork tests do not execute bash') },
    start() { throw new Error('fork tests do not execute bash') },
  })
  ctx.provide('approval', {
    config: { policy: 'approvalDefault' in options ? options.approvalDefault : 'ask' },
  })
  await ctx.plugin(MsysPermissionPresets, options.config ?? {})
  return ctx
}

function freshSession(id: string): Session {
  return Session.create(SessionId(id))
}

describe('#10: fork composes over a non-confining executor', () => {
  it('starts with no error under sandboxMode === undefined and mounts the SAME service identity', async () => {
    const ctx = await mounted()
    // The context service key the stock client row and remotes inject by name.
    expect(ctx.get('permissionPresets')).toBeDefined()
    // The Typert wire namespace the stock client remote calls permissionPresets.catalog through.
    expect((ctx.permissionPresets as unknown as { typertRemote: { namespace: string } }).typertRemote.namespace).toBe('permissionPresets')
  })

  it('registers the permissions projection unit under the upstream key', async () => {
    const ctx = await mounted()
    const session = freshSession('sess-projection')
    session.append('permission/preset', { preset: 'workspace-write' })
    expect(ctx.sessionProjections.stateOf(session, 'permissions')).toMatchObject({ preset: 'workspace-write' })
  })

  it('never references the shell seam: no confinement capability is claimed anywhere', async () => {
    await mounted()
    // AC: "The executor still reports no sandboxMode; no code path claims
    // process confinement." Pinned at the source seam: the fork does not
    // import or read the shell capability at all.
    const source = readFileSync(new URL('../src/permission-presets.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/dsh-shell/)
    expect(source).not.toMatch(/ctx\.shell/)
  })
})

describe('#10: preset switching end to end (the base table)', () => {
  it('the catalog advertises the base bundle table with the composition default', async () => {
    const ctx = await mounted({ config: { presets: BASE_PRESETS } })
    const catalog = ctx.permissionPresets.catalog()
    expect(catalog.options.map(option => option.value)).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
    // sandbox-policy default workspace-write + approval ask → workspace-write.
    expect(catalog.defaultPreset).toBe('workspace-write')
  })

  it('switching writes BOTH knobs and the events land in the session log', async () => {
    const ctx = await mounted({ config: { presets: BASE_PRESETS } })
    const session = freshSession('sess-switch')
    ctx.permissionPresets.set(session, 'danger-full-access')
    expect(session.snapshotEvents().map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'danger-full-access' }],
      ['sandbox/mode', { mode: 'danger-full-access' }],
      ['approval/policy', { policy: 'never' }],
    ])
    expect(ctx.permissionPresets.current(session)).toBe('danger-full-access')

    ctx.permissionPresets.set(session, 'read-only')
    expect(session.snapshotEvents().slice(3).map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'read-only' }],
      ['sandbox/mode', { mode: 'read-only' }],
      ['approval/policy', { policy: 'ask' }],
    ])
    expect(ctx.permissionPresets.current(session)).toBe('read-only')
  })

  it('a new session is pinned to the composed default through both knob setters', async () => {
    const ctx = await mounted({ config: { presets: BASE_PRESETS } })
    const session = ctx.sessions.create(SessionId('sess-fresh'))
    expect(session.snapshotEvents().map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'workspace-write' }],
      ['sandbox/mode', { mode: 'workspace-write' }],
      ['approval/policy', { policy: 'ask' }],
    ])
  })

  it('the policy home, not the executor, supplies the empty-log sandbox fallback', async () => {
    // DSH_PERMISSION_MODE-style deployment default danger-full-access + never.
    const ctx = await mounted({
      policyMode: 'danger-full-access',
      approvalDefault: 'never',
      config: { presets: BASE_PRESETS },
    })
    const session = freshSession('sess-policy-fallback')
    expect(ctx.permissionPresets.current(session)).toBe('danger-full-access')
  })

  it('knob state matching no table entry derives custom — a state, not an error', async () => {
    const ctx = await mounted({ config: { presets: BASE_PRESETS } })
    const session = freshSession('sess-custom')
    session.append('sandbox/mode', { mode: 'read-only' })
    session.append('approval/policy', { policy: 'never' })
    expect(ctx.permissionPresets.current(session)).toBe(CUSTOM_PRESET)
    expect(ctx.permissionPresets.optionOf(CUSTOM_PRESET).value).toBe(CUSTOM_PRESET)
  })

  it('optionOf presents the preset keys with the file-policy phrased default copy', async () => {
    const ctx = await mounted()
    // Default table (no config): the two labeled defaults, identical to upstream's.
    expect(ctx.permissionPresets.optionOf('workspace-write')).toEqual({
      value: 'workspace-write',
      name: 'workspace-write',
      description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.',
    })
    expect(ctx.permissionPresets.optionOf('danger-full-access')).toEqual({
      value: 'danger-full-access',
      name: 'danger-full-access',
      description: 'Full file access without approval prompts.',
    })
  })
})

describe('#10: the bundle patch (cordis.patch.yml) — disable + insert with name guards', () => {
  const jsTag = { tag: 'tag:yaml.org,2002:js', resolve: (value: string): string => value }
  const doc = YAML.parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { customTags: [jsTag] }) as Array<Record<string, unknown>>

  it('disables the base permission row on win32 behind its name guard', () => {
    const disable = doc.find(op => op.id === 'permission' && !Array.isArray(op.insert))
    expect(disable?.name).toBe('@deepseek-ai/dsh-permission-presets')
    expect(String(disable?.disabled)).toContain("process.platform === 'win32'")
  })

  it('inserts the fork row from this package, dormant on POSIX', () => {
    const inserts = doc.flatMap(op => Array.isArray(op.insert) ? op.insert as Array<Record<string, unknown>> : [])
    const fork = inserts.find(row => row.name === 'dsh-bash-msys/permission-presets')
    expect(fork).toBeDefined()
    expect(String(fork?.disabled)).toContain("process.platform !== 'win32'")
    // The insert carries the base bundle's table verbatim (same preset surface).
    expect(fork?.config).toMatchObject({ presets: BASE_PRESETS })
  })

  it('keeps the executor insert unchanged (one id bash-msys, one fork row)', () => {
    const inserts = doc.flatMap(op => Array.isArray(op.insert) ? op.insert as Array<Record<string, unknown>> : [])
    expect(inserts.filter(row => row.id === 'bash-msys')).toHaveLength(1)
    expect(inserts.filter(row => row.id === 'permission-msys')).toHaveLength(1)
  })
})
