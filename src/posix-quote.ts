/**
 * Shared POSIX single-quote helper (issue #37 smells cleanup): one
 * implementation for the two former copies — the remote executor's
 * `shellQuote` (payload composition over the ssh transport) and the pty
 * plugin's `quotePosix` (env `export` lines on shell-type backends).
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
