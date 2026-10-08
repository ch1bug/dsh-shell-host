/**
 * Local `ctx.subprocess` Context augmentation (issue #36): the canonical one
 * lives in `@deepseek-ai/dsh-subprocess`'s dist types, but this package's src
 * never imports that seam package elsewhere (the subprocess vocabulary is
 * inlined in `./types.ts`), so declaration emit under `tsconfig.build.json`
 * would not see it. Same write pattern as the `ctx.shell` augmentation in
 * `core/executor.ts`. Isolated in its own module so the seam-package type
 * import does not enter the entry d.ts.
 * @module dsh-shell-host/subprocess-context
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

declare module '@deepseek-ai/cordis' {
  interface Context {
    subprocess: SubprocessRuntime
  }
}
