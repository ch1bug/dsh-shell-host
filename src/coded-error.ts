/**
 * The shared coded-error helper (#172): one shape for the structured-error
 * pattern `Object.assign(new Error(message), { code })` that used to be
 * hand-rolled across launcher / pty / remote / remote-fs / tool-support.
 * `code` is the stable fact consumers branch on; the message is for humans.
 *
 * The generic keeps the code literal at the type level, so callers can keep
 * narrowing (`Error & { code: LauncherErrorCode }`, #171 口径) without a cast.
 */
export type CodedError<C extends string = string> = Error & { code: C }

/** Build an Error carrying its stable structured `code` (plus optional extra facts, spread after `code`). */
export function codedError<C extends string>(message: string, code: C, extra: Record<string, unknown> = {}): CodedError<C> {
  return Object.assign(new Error(message), { code, ...extra })
}
