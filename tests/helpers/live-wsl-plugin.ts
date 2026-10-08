/**
 * Live-WSL fixture for the `./wsl` plugin (issue #32; promoted from the #30
 * scratch verification `.scratch/verify-wsl-entry.mjs`, which #33 also
 * reuses). Boots a REAL cordis context with a REAL shell service
 * (LocalBashExecutor, backend 'wsl') against a REAL WSL distro — no fakes —
 * and applies the plugin, collecting the registered win_* tools. Loud-skip
 * detection follows the wsl-backend.spec posture (probe wsl.exe + distro
 * list; `hasLiveWsl` gates `it.skipIf`).
 * @module tests/helpers/live-wsl-plugin
 */
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '../../src/index.ts'
import { detectWslExe } from '../../src/detect.ts'
import { parseWslDistroList } from '../../src/backends.ts'
import * as wslPlugin from '../../src/wsl-plugin/index.ts'

/** The registered win_* tool surface, keyed by tool name. */
export type WslToolMap = Map<string, { execute: (args: any, exec?: unknown) => Promise<any> }>

/** A booted real-seam context: dispose `ctx.fiber` when the test finishes. */
export interface LiveWsl {
  ctx: Context
  tools: WslToolMap
  shell: LocalBashExecutor
}

const wslExe = process.platform === 'win32' ? detectWslExe() : undefined

/** Distros visible to the host's wsl.exe (empty on a WSL-less machine). */
export function liveDistros(): string[] {
  if (wslExe === undefined) return []
  try {
    return [...parseWslDistroList(execFileSync(wslExe, ['--list', '--quiet'], { encoding: 'utf16le' }))]
  } catch {
    return []
  }
}

export const hasLiveWsl = wslExe !== undefined && liveDistros().length > 0

/**
 * Boot the real seam: subprocess runtime + wsl-backend executor + the plugin
 * applied against a minimal `tools` collector (the DSH tool registry is
 * host-layer; the seam under test is the SHELL side, which is real).
 */
export async function bootLiveWsl(): Promise<LiveWsl> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { backend: 'wsl', graceMs: 200 })
  const registered: WslToolMap = new Map()
  ctx.provide('tools', { register: (t: { name: string }) => registered.set(t.name, t as never) })
  // sandboxPolicy absent, like a default composition without the sandbox row.
  ctx.provide('sandboxPolicy', undefined)
  wslPlugin.apply(ctx as never)
  return { ctx, tools: registered, shell: ctx.get('shell') as LocalBashExecutor }
}
