import ts from 'typescript'

// Standard-decorator sources (the #10 permission-presets fork's @Remote
// methods) trip Vite's default parser; every vitest lane that loads them
// (unit / machine projects here) runs the same TypeScript pre-transform,
// mirroring upstream vitest.shared.ts's per-suite plugin contract. The
// explicit e2e lane (vitest.e2e.config.ts) predates the decorator suites
// and carries no plugins.
export const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

export function standardDecoratorPlugin() {
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
