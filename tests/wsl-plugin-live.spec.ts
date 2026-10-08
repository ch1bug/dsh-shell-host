/**
 * Machine-lane real-seam suite for the `./wsl` plugin (issue #32; promoted
 * from the #30 scratch verification `.scratch/verify-wsl-entry.mjs`). A fake
 * shell cannot observe the executor's quoting interaction, so the #32 bug
 * construction is asserted here against REAL WSL: the old trailing-`$` grep
 * pattern dies through the real launch path, while win_drives returns the
 * mounted drives. Skips loudly on a WSL-less host.
 * @module tests/wsl-plugin-live
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import { bootLiveWsl, hasLiveWsl } from './helpers/live-wsl-plugin.ts'

describe('win_ls truncation on the real WSL seam (#33 AC)', () => {
  // System32 reliably overflows the seam's default 64KB stdout cap
  // (~1000-entry tail window, pre-#33 the head entries vanished silently).
  const SYSTEM32 = '/mnt/c/Windows/System32'

  it.skipIf(!hasLiveWsl)('a >64KB listing comes back with an explicit truncation signal', { timeout: 60_000 }, async () => {
    const { ctx, tools } = await bootLiveWsl()
    onTestFinished(() => ctx.fiber.dispose())
    const out = await tools.get('win_ls')!.execute({ path: SYSTEM32 }, {})
    expect(out.exitCode).toBe(0)
    expect(out.truncated).toBe(true)
    expect(out.note).toMatch(/truncat/i)
    // The parse still yields the tail window — but visibly incomplete.
    expect(out.entries.length).toBeGreaterThan(0)
  })

  it.skipIf(!hasLiveWsl)('raising stdoutMaxBytes returns the COMPLETE entry count (#33 AC-2)', { timeout: 90_000 }, async () => {
    const { ctx, shell, tools } = await bootLiveWsl()
    onTestFinished(() => ctx.fiber.dispose())
    // Ground truth counted by the same seam, short format (names only — no
    // GBK-mojibake exposure in the timestamp columns).
    const count = await (await shell.execute(shell.resolve({
      command: `ls -1 ${SYSTEM32} | wc -l`,
    }))).result()
    const expected = Number(count.stdout.text.trim())
    expect(Number.isFinite(expected) && expected > 0).toBe(true)

    const out = await tools.get('win_ls')!.execute({ path: SYSTEM32, long: false, stdoutMaxBytes: 8 * 1024 * 1024 }, {})
    expect(out.truncated).toBe(false)
    expect(out.note).toBeNull()
    expect(out.entries.length).toBe(expected)
  })
})

describe('win_drives on the real WSL seam (#32 AC)', () => {
  it.skipIf(!hasLiveWsl)('returns the mounted drives, first C:, through the real executor', async () => {
    const { ctx, tools } = await bootLiveWsl()
    onTestFinished(() => ctx.fiber.dispose())
    const out = await tools.get('win_drives')!.execute({}, {})
    expect(out.error ?? null).toBeNull()
    expect(out.drives.length).toBeGreaterThan(0)
    expect(out.drives[0]).toEqual({ drive: 'C', wslPath: '/mnt/c', winPath: 'C:\\' })
    // And the rows agree with the raw /mnt listing after the JS filter —
    // wsl/wslg-style non-drive entries in the listing are excluded.
    const listed = out.raw.split('\n').map((s: string) => s.trim()).filter((n: string) => /^[a-z]$/.test(n))
    expect(out.drives.map((d: { wslPath: string }) => d.wslPath)).toEqual(listed.map((name) => `/mnt/${name}`))
  })

  it.skipIf(!hasLiveWsl)('the OLD bug construction (trailing-`$` grep) still fails the real quoting path', async () => {
    // Pins the mechanism, not the fix: the exact pre-#32 command, run through
    // the same real launch path, must NOT come back as a clean drive list —
    // this is what a fake shell could never catch.
    const { ctx, shell, tools } = await bootLiveWsl()
    onTestFinished(() => ctx.fiber.dispose())
    const r = await (await shell.execute(shell.resolve({
      command: `ls -1 /mnt 2>/dev/null | grep -E '^[a-z]$'`,
    }))).result()
    const broken = r.exitCode !== 0 || r.stdout.text.trim() === ''
    expect(broken).toBe(true)
    // Pin the MECHANISM, not just the outcome: a benign grep no-match exits 1
    // with empty stderr; the quoting collision is a bash syntax error.
    expect(r.stderr.text.trim()).not.toBe('')
    // The fixed tool disagrees with the broken construction on the same host.
    const out = await tools.get('win_drives')!.execute({}, {})
    expect(out.drives.length).toBeGreaterThan(0)
  })
})
