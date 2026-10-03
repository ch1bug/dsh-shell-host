/**
 * The WSL bridge (ADR-0003 decision 5, ticket #15): the `wsl` backend's
 * dedicated cross-VM path-mapping layer. Both directions are owned here —
 * toShell (host path → WSL path: `C:\x → /mnt/c/x` over the default drvfs
 * mount points, `\\wsl$\<distro>\` host views folded back onto their in-VM
 * path) and fromShell (`/mnt/<drive>/` reverse, VM-internal paths projected
 * through `\\wsl$\<distro>\`). The generic descriptor mapping functions and
 * pass-through never carry this responsibility (ADR-0003 decision 5).
 *
 * Documented limitations (deliberate, tested edges): non-default drvfs mount
 * points (a distro that remounts or disables `/mnt/<drive>` automount) are not
 * recognized — such a path is projected through `\\wsl$` on the way out rather
 * than silently mis-mapped; a `\\wsl$\<other-distro>\` host path maps onto its
 * own in-VM location regardless of the configured distro (the share names the
 * VM — mapping a foreign distro's share into this distro would be the wrong
 * VM); relative paths fail loudly instead of being guessed. The bridge is pure
 * string mapping — it never touches the
 * filesystem, so unreadable VM paths surface where they are actually opened.
 * @module dsh-shell-host/wsl-bridge
 */

/**
 * Map a host (Windows) path to the WSL-side path. Drive paths ride the
 * default drvfs mount points (`C:\x\y → /mnt/c/x/y`); a `\\wsl$` /
 * `\\wsl.localhost` UNC path is a host view of VM files, so it maps back onto
 * its in-VM path.
 * @throws Error on a relative path (the bridge maps absolute locations; it never guesses).
 */
export function toWslPath(winPath: string): string {
  const wsl$ = /^\\\\wsl\$\\([^\\]+)\\(.+)$/i.exec(winPath)
  if (wsl$ !== null) return `/${toPosix(wsl$[2]!)}`
  const wslLocalhost = /^\\\\wsl\.localhost\\([^\\]+)\\(.+)$/i.exec(winPath)
  if (wslLocalhost !== null) return `/${toPosix(wslLocalhost[2]!)}`
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(winPath)
  if (drive !== null) {
    const rest = toPosix(drive[2]!)
    return `/mnt/${drive[1]!.toLowerCase()}${rest.length > 0 ? `/${rest}` : ''}`
  }
  throw new Error(`wsl bridge: '${winPath}' is not an absolute Windows path (drive or \\\\wsl$ UNC); the bridge maps, it never guesses`)
}

/**
 * Map a WSL-side path back to a host-usable path. Default drvfs mount points
 * reverse to their drives (`/mnt/c/x → C:\x`); every other absolute path is
 * VM-internal and projects through the `\\wsl$\<distro>\` share for the
 * configured distro.
 * @param distro - the backend's distro, naming the `\\wsl$` share root.
 * @throws Error on a relative path (same posture as {@link toWslPath}).
 */
export function fromWslPath(shellPath: string, distro: string): string {
  const mnt = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(shellPath)
  if (mnt !== null) {
    const rest = mnt[2] ?? ''
    return `${mnt[1]!.toUpperCase()}:\\${rest.replaceAll('/', '\\')}`
  }
  if (!shellPath.startsWith('/')) {
    throw new Error(`wsl bridge: '${shellPath}' is not an absolute WSL path; the bridge maps, it never guesses`)
  }
  return `\\\\wsl$\\${distro}\\${shellPath.replace(/^\//, '').replaceAll('/', '\\').replace(/\\$/, '')}`
}

function toPosix(p: string): string {
  return p.replaceAll('\\', '/').replace(/\/$/, '')
}
