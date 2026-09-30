import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

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
// this package: on win32 the bash-local suites are excluded because "a real
// POSIX shell is unavailable on Windows" (upstream's own words — upstream's
// Windows lanes run green with these suites skipped). The zero-deviation
// fork baseline keeps that policy verbatim; T2's descriptor layer is what
// will revisit it.
const specInclude = process.platform === 'win32' ? [] : ['tests/**/*.spec.ts']

export default defineConfig({
  resolve: {
    alias: [
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
    ],
  },
  test: {
    environment: 'node',
    include: specInclude,
    passWithNoTests: true,
  },
})
