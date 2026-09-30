import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import ts from 'typescript'

// Standard-decorator sources (the #10 permission-presets fork's @Remote
// methods) trip Vite's default parser; upstream runs the same TypeScript
// pre-transform (vitest.shared.ts standardDecoratorPlugin) for every suite.
const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m
function standardDecoratorPlugin() {
  return {
    name: 'dsh-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, sourceMap: true },
      })
      return {
        code: result.outputText
          .replace(/^(\s*)(__esDecorate\()/gmu, '$1/* v8 ignore next -- compiler-synthetic decorator accessors have no source behavior */ $2')
          .replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

// Upstream resolves @deepseek-ai/* to SOURCE through tsconfig.base.json's
// paths facade + vite-tsconfig-paths, whose match-all scope only covers
// importers INSIDE the monorepo root — this repo sits outside it, so the
// plugin cannot be reused. Instead the runtime closure is aliased
// explicitly. It is small: the deep packages (dsh-sandbox, dsh-llm, ...)
// appear in the graph only as `import type`, which the transform strips.
// tsc typecheck keeps using the inherited paths map (extends), which needs
// no such enumeration.
const H = resolve(import.meta.dirname, '../deepseek-harness')
const toSrc = (p: string) => resolve(H, p, 'src/index.ts')
const alias = (name: string, p: string) => ({ find: new RegExp(`^${name}$`), replacement: toSrc(p) })

// Mirrors upstream vitest.config.ts `windowsUnsupportedPackages` policy for
// this package: on win32 the ported bash-local suites stay excluded ("a real
// POSIX shell is unavailable on Windows" — upstream's own words). T2's
// descriptor layer reopens the lane for what a Windows shell CAN serve: the
// msys2 backend suite runs through the explicit-config public boundary
// (ADR-0001 Consequences), so the executor's msys2 behavior is regression-
// guarded on Windows; the ported POSIX suites stay excluded until a later
// ticket serves them a POSIX lane.
// The T5 engine-side E2E checklist is an EXPLICIT lane (spec #1 testing
// decision: end-to-end acceptance stays out of the unit loop) — see
// vitest.e2e.config.ts / `pnpm test:e2e`.
const specInclude = process.platform === 'win32'
  ? ['tests/descriptor.spec.ts', 'tests/detect.spec.ts', 'tests/permission-presets.spec.ts']
  : ['tests/**/*.spec.ts']

export const testAliases = [
  alias('@deepseek-ai/cordis', 'vendor/cordis'),
  alias('@deepseek-ai/cosmokit', 'vendor/cosmokit'),
  alias('@deepseek-ai/schemastery', 'vendor/schemastery'),
  alias('@deepseek-ai/cordis-plugin-loader', 'vendor/loader'),
  alias('@deepseek-ai/dsh-shell', 'packages/shell/shell'),
  alias('@deepseek-ai/dsh-subprocess', 'packages/subprocess/subprocess'),
  alias('@deepseek-ai/dsh-subprocess-local', 'packages/subprocess/subprocess-local'),
  alias('@deepseek-ai/dsh-timeout', 'packages/util/timeout'),
  alias('@deepseek-ai/dsh-http-proxy', 'packages/util/http-proxy'),
  alias('@deepseek-ai/dsh-lazy-require', 'packages/util/lazy-require'),
  // #10: the permission-presets fork's host-side value closure.
  alias('@deepseek-ai/dsh-sandbox', 'packages/sandbox/sandbox'),
  alias('@deepseek-ai/dsh-sandbox-policy', 'packages/sandbox/sandbox-policy'),
  alias('@deepseek-ai/dsh-user-approval', 'packages/interaction/user-approval'),
  alias('@deepseek-ai/dsh-typert-protocol', 'packages/typert/protocol'),
  alias('@deepseek-ai/dsh-session', 'packages/core/session'),
  alias('@deepseek-ai/dsh-session-projection', 'packages/session/session-projection'),
  { find: '@deepseek-ai/dsh-commands/brand', replacement: resolve(H, 'packages/interaction/commands/src/brand.ts') },
  alias('@deepseek-ai/dsh-commands', 'packages/interaction/commands'),
]

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: {
    alias: testAliases,
  },
  test: {
    environment: 'node',
    include: specInclude,
    passWithNoTests: true,
  },
})
