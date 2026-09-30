import ts from 'typescript'

/**
 * Standard-decorator lowering for the host lib build: oxc (tsdown's
 * transformer) passes `@Remote(...)` decorators through to the output, where
 * Node 24 rejects them as a syntax error at import time ("Invalid or
 * unexpected token" — issue #10 live finding). TypeScript's transpileModule
 * lowers standard decorators to __decorate/__esDecorate helpers. Same
 * transform upstream applies to source-mode tests (vitest.shared.ts
 * standardDecoratorPlugin, mirrored in vitest.config.ts here).
 */
const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

export function standardDecoratorLoweringPlugin(): { name: string, transform(code: string, id: string): { code: string, map: unknown } | undefined } {
  return {
    name: 'dsh-standard-decorator-lowering',
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          sourceMap: true,
        },
      })
      return { code: result.outputText, map: result.sourceMapText }
    },
  }
}
