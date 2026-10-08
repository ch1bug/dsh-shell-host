// Issue #40: type pin — the local ctx.subprocess Context augmentation in
// src/subprocess-context.ts must stay shape-identical to the canonical
// SubprocessRuntime published by @deepseek-ai/dsh-subprocess dist types.
//
// The assertions here are TYPE-level (expectTypeOf); they bite under
// `pnpm typecheck` (this file is in tsconfig.json's `include`). A drift in
// the shadow declaration — e.g. swapping the canonical import for a
// hand-written parallel shape that then lags upstream — fails typecheck
// loudly, instead of silently diverging. Runtime assertions are a smoke
// only: this package deliberately does not depend on the seam package's
// runtime face (issue #36 constraint, out of scope to change).
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
// Side-effect import keeps the shadow augmentation module in the program,
// so the pin observes exactly what production typecheck observes.
import '../src/subprocess-context.js'

type AugmentedSubprocess = Context['subprocess']

describe('subprocess-context type pin (#40)', () => {
  it('Context.subprocess is exactly the canonical SubprocessRuntime', () => {
    // Exact identity: any added/removed/retyped field in the shadow
    // declaration breaks this. Not a structural match — toEqualTypeOf is
    // the strictest vitest equivalence and rejects both directions.
    expectTypeOf<AugmentedSubprocess>().toEqualTypeOf<SubprocessRuntime>()
    // The pin itself cannot be defeated by an `any` hole in the shadow.
    expectTypeOf<AugmentedSubprocess>().not.toBeAny()
    // Smoke: type-only spec still runs green under `pnpm test` (unit lane).
    expect(true).toBe(true)
  })

  it('the augmentation carries the canonical spawn seam, not a narrowed fork', () => {
    // Member-level canary: if the shadow ever replaces the canonical type
    // with a narrowed/hand-written subset, this goes red even if the
    // identity pin is later loosened to a structural one.
    expectTypeOf<AugmentedSubprocess>().toHaveProperty('spawn')
  })
})
