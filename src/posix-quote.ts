/**
 * Shared POSIX single-quote helper (issue #37 smells cleanup): one
 * implementation shared by the pty plugin's `quotePosix` (env `export` lines
 * on shell-type sessions) and other SSH command-composition sites. [ADR-0013:
 * the former remote-executor consumer left with the executor world.]
 * INTERNAL shared module, not an ADR-0007 entry — no package export address.
 */

/**
 * POSIX single-quote a string so it survives as ONE shell word: wrap in
 * single quotes, escaping embedded `'` as `'\''` (close the quote, an
 * escaped quote, reopen — the canonical form the remote fake-ssh fixture
 * unwraps).
 */
export function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
