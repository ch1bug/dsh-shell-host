/**
 * Local `ShellExecutor` base class (issue #23, AC1/AC10): the shell-seam
 * contract `ShellHostExecutor` implements, inlined instead of inherited from
 * `@deepseek-ai/dsh-shell`. Members and semantics are field-identical to the
 * upstream abstract class at the pinned tag — constructor binds the cordis
 * `'shell'` service key, `sandboxMode` defaults to `undefined` (a
 * non-confining executor), `resolve`/`execute` stay abstract. The Context
 * service-key augmentation lives here so `ctx.shell` keeps its type face for
 * any in-repo consumer; at runtime DSH loads this executor the same way.
 * @module dsh-shell-host/core/executor
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxMode, ShellExecRequest, ShellExecSpec, ShellExecution } from '../types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    shell: ShellExecutor
  }
}

/**
 * Abstract bash execution service. Subclass, implement the abstract methods,
 * and load the subclass as a plugin — it registers as `ctx.shell` (one
 * implementation per context; loading a second throws, which is cordis'
 * standard duplicate-service behavior).
 */
export abstract class ShellExecutor extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shell')
  }

  /**
   * The sandbox mode this executor applies by default, or `undefined` when it
   * does not sandbox commands.
   * @returns the configured default sandbox mode, when supported.
   */
  get sandboxMode(): SandboxMode | undefined {
    return undefined
  }

  /**
   * Apply implementation-owned defaults and caps to a request before execution.
   * @param request - the caller's request; omitted fields get this
   *   implementation's defaults, capped fields are clamped.
   * @returns the fully-specified spec to hand to {@link execute}.
   */
  abstract resolve(request: ShellExecRequest): ShellExecSpec

  /**
   * Prepare and spawn the command under its resolved deadline.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @returns the prepared handle; preparation timeout yields an
   *   already-settled handle with no output.
   */
  abstract execute(spec: ShellExecSpec): Promise<ShellExecution>
}

export default ShellExecutor
