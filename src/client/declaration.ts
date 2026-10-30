/**
 * #169: the client-half DECLARATION predicate — the pure fact list a package
 * manifest must satisfy for the browser half to load at all (the host's
 * `dsh.client` scan: a declaration without a `./client` bundle export throws
 * at composition, and an undeclared artifact is not packed). The test
 * mutation face (tests/client-declaration.spec.ts) feeds broken manifests
 * through this same predicate, so each asserted fact is demonstrably red
 * when removed. Node-side module — no browser imports.
 * @module dsh-shell-host/client/declaration
 */

/**
 * Validate one package manifest's client-half declaration:
 * `dsh.client{platform:'web'}` + `exports["./client"] → lib/client.js` +
 * `lib/client.js` in `files` — the decoration-template pairing (host asar
 * L427564/L321541, #169 spec D3).
 */
export function validateClientDeclaration(pkg: Record<string, unknown>): string[] {
  const problems: string[] = []
  const dsh = pkg['dsh'] as Record<string, unknown> | undefined
  const client = dsh === undefined || typeof dsh !== 'object' ? undefined : dsh['client'] as Record<string, unknown> | undefined
  if (client === undefined || typeof client !== 'object') {
    problems.push('dsh.client declaration missing — the host scan skips the browser half')
    return problems
  }
  if (client['platform'] !== 'web') {
    problems.push(`dsh.client.platform must be 'web', got: ${JSON.stringify(client['platform'])}`)
  }
  const exportsMap = pkg['exports'] as Record<string, unknown> | undefined
  const clientExport = exportsMap === undefined ? undefined : exportsMap['./client'] as { default?: unknown } | undefined
  if (clientExport === undefined || typeof clientExport !== 'object') {
    problems.push('exports["./client"] missing — dsh.client without a client bundle fails composition loudly')
  } else if (clientExport['default'] !== './lib/client.js') {
    problems.push(`exports["./client"].default must be './lib/client.js', got: ${JSON.stringify(clientExport['default'])}`)
  }
  const files = pkg['files'] as unknown
  const filesOk = Array.isArray(files) && (files as unknown[]).includes('lib/client.js')
  if (!filesOk) {
    problems.push('files must declare lib/client.js — an undeclared artifact is never packed')
  }
  return problems
}
