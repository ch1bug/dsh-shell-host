import { describe, expect, expectTypeOf, it } from 'vitest';
import { codedError, type CodedError } from '../src/coded-error.ts';
import { launcherError } from '../src/launchers.ts';

describe('codedError (#172 shared helper)', () => {
  it('builds a real Error carrying the structured code', () => {
    const err = codedError('boom: detail', 'INVALID_ARGS');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('boom: detail');
    expect(err.code).toBe('INVALID_ARGS');
  });

  it('keeps the code literal at the type level (same-source narrowing, #171 口径)', () => {
    const err = codedError('boom', 'PRESET_CONFIG_INVALID');
    expectTypeOf(err.code).toEqualTypeOf<'PRESET_CONFIG_INVALID'>();
  });

  it('spreads extra structured facts after code (cause etc.)', () => {
    const cause = new Error('ENOENT');
    const err = codedError('spawn failed', 'SPAWN_FAILED', { cause });
    expect(err.code).toBe('SPAWN_FAILED');
    expect((err as Error & { cause: unknown }).cause).toBe(cause);
  });

  it('is the single shape behind launcherError (#165 public API unchanged)', () => {
    const err = launcherError('PRESET_UNKNOWN', "launcher: unknown preset 'x'") as CodedError;
    expect(err.code).toBe('PRESET_UNKNOWN');
  });
});
