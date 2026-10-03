import { defineConfig } from 'vitest/config'
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

// ADR-0005 anchor bump (dsh-v0.2.1-alpha.1): no runtime alias table. The
// @deepseek-ai/* closure resolves through node_modules to the published dists
// (lib/index.js ships built ESM with full subpath exports), same as tsc —
// the former explicit alias enumeration over ../deepseek-harness sources is
// gone with the local-source lane.

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
  ? ['tests/descriptor.spec.ts', 'tests/registry.spec.ts', 'tests/detect.spec.ts', 'tests/permission-presets.spec.ts', 'tests/built-artifact.spec.ts', 'tests/wsl-bridge.spec.ts', 'tests/wsl-backend.spec.ts']
  : ['tests/**/*.spec.ts']

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  test: {
    environment: 'node',
    include: specInclude,
    passWithNoTests: true,
    // The alpha.1 subprocess runner's cold start (~3.7s solo) breaches the old
    // 5s default under parallel suite load — this repo's suites are live-shell
    // integrations (real MSYS2/pwsh/WSL spawns), so the per-test budget is a
    // global 30s. Logic-only assertions still fail in milliseconds.
    testTimeout: 30_000,
  },
})
