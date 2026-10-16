/**
 * Tarball integrity check for the published exports face (issue #36):
 * packs the current tree, unpacks it under .scratch/ (so the unpacked
 * package's up-tree lookup reaches the repo node_modules), then asserts
 *
 *   1. every concrete `exports` pointer names a real file, and
 *   2. every entry imports under Node self-reference FROM the tarball, and
 *   3. every packed target is present in the tarball.
 *
 * Exit 0 = all pointers resolvable. **Requires a prior build** (`node --run build`),
 * so it is not part of `node --run test`; run it via `node --run test:release`, which
 * builds first. When no packer is reachable it skips LOUDLY (exit 0, printing
 * `!! SKIP (loud)`) rather than reporting an unearned pass.
 * @module dsh-shell-host/scripts/verify-pack
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))

/**
 * Unpack a gzipped tar with no external `tar` binary.
 *
 * Why not shell out: the host tar dialect is not guaranteed. GNU tar reads a
 * Windows drive-letter path as a remote host spec (`C:` → "cannot connect to
 * C:"), and msys path conversion rewrites arguments on the way in. A minimal
 * ustar/pax reader over the packed bytes sidesteps both.
 */
export function untarGz(tarball, destination) {
  const buf = gunzipSync(tarball)
  let offset = 0
  const readString = (start, length) => {
    const raw = buf.subarray(start, start + length)
    const end = raw.indexOf(0)
    return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
  }
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    // Two zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) break
    const name = readString(offset, 100)
    const sizeField = readString(offset + 124, 12).trim()
    const size = sizeField === '' ? 0 : Number.parseInt(sizeField, 8)
    const typeFlag = String.fromCharCode(buf[offset + 156] ?? 0)
    const prefix = readString(offset + 345, 155)
    const fullName = prefix === '' ? name : `${prefix}/${name}`
    const dataStart = offset + 512
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      const target = join(destination, ...fullName.split('/').filter((p) => p !== '' && p !== '.'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, buf.subarray(dataStart, dataStart + size))
    } else if (typeFlag === '5') {
      mkdirSync(join(destination, ...fullName.split('/').filter(Boolean)), { recursive: true })
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
}

/** Locate a packer that needs no PATH shim.
 *
 * The bundled DSH node ships WITHOUT npm (that absence is the whole reason
 * issue #79 exists), so the search falls back to the conventional Windows node
 * install. Returns null when nothing is found — the caller then skips LOUDLY
 * rather than reporting a pass it did not earn.
 */
function findPacker() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js',
  ]
  // existsSync, NOT the async `access`: the latter returns a promise that never
  // throws here, so every candidate would "match" and we would exec a path that
  // does not exist.
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { kind: 'npm-cli', path: candidate }
  }
  // PATH-resolved fallbacks: `shell: true` because these are .cmd shims.
  for (const name of ['npm', 'pnpm']) {
    try {
      execFileSync(name, ['--version'], { stdio: 'ignore', shell: true })
      return { kind: name, path: name }
    } catch {
      continue
    }
  }
  return null
}

/** Flatten the exports map into [entryName, target] pairs; condition keys
 *  (`types`, `default`, …) keep their parent entry's name. */
function entryTargets(exportsMap, entry = '') {
  const targets = []
  for (const [key, value] of Object.entries(exportsMap)) {
    const name = key.startsWith('.') ? key : entry
    if (typeof value === 'string') targets.push([name, value])
    else targets.push(...entryTargets(value, name))
  }
  return targets
}

const allTargets = entryTargets(pkg.exports)
const entries = allTargets.filter(([, target]) => !target.includes('*'))
// Node-side import smoke covers the host entries only: `./client` is the web
// platform bundle (needs `window`), `./package.json` is not an ES module, and
// `./src/*` is a source passthrough.
const importableEntries = [...new Map(entries.filter(([entry]) =>
  entry !== './client' && entry !== './package.json'
).map(([entry]) => [entry, true])).keys()]

// 1. every concrete pointer names a real file in the working tree.
const missing = []
for (const [entry, target] of entries) {
  if (await access(join(repoRoot, target)).catch(() => 'no')) missing.push(`${entry} -> ${target}`)
}
if (missing.length > 0) {
  console.error('verify-pack: exports pointers to missing files:\n  ' + missing.join('\n  '))
  process.exit(1)
}

// 2. every entry imports under Node self-reference from the unpacked tarball.
const packdir = mkdtempSync(join(tmpdir(), 'dsh-shell-host-pack-'))
const unpackRoot = join(repoRoot, '.scratch', 'verify-pack')
try {
  // Pack through a shim-free packer: `pnpm` may be absent from PATH (the #79
// class of failure) and the bundled node ships no npm at all.
  const packer = findPacker()
  if (packer === null) {
    console.warn(
      'verify-pack: !! SKIP (loud) — 找不到打包器（Node 自带 npm / PATH 上的 npm·pnpm 皆无）。' +
        '本次未验证 tarball 完整性：exports 指针只做了存在性检查。',
    )
    rmSync(unpackRoot, { recursive: true, force: true })
    process.exit(0)
  }
  const args = ['pack', '--pack-destination', packdir]
  const out = packer.kind === 'npm-cli'
    ? execFileSync(process.execPath, [packer.path, ...args, '--silent'], { cwd: repoRoot, encoding: 'utf8' })
    : execFileSync(packer.path, [...args, '--silent'], { cwd: repoRoot, encoding: 'utf8', shell: true })
  const tarballName = out.trim().split('\n').pop().trim()
  const tarballPath = resolve(packdir, tarballName)
  rmSync(unpackRoot, { recursive: true, force: true })
  mkdirSync(unpackRoot, { recursive: true })
  untarGz(await readFile(tarballPath), unpackRoot)
} finally {
  rmSync(packdir, { recursive: true, force: true })
}

// Import smoke must run with the unpacked package as the resolving package
// (Node self-reference resolves against the importer's owning package), so a
// probe script is written INSIDE the unpacked copy and executed there.
const unpacked = join(unpackRoot, 'package')
const probe = join(unpacked, '__verify_import.mjs')
const probeLines = importableEntries.map(entry => {
  const specifier = entry === '.' ? pkg.name : pkg.name + entry.slice(1)
  return `  { entry: ${JSON.stringify(entry)}, mod: await import(${JSON.stringify(specifier)}) }`
})
writeFileSync(probe, `const results = [\n${probeLines.join(',\n')}\n]\nfor (const { entry, mod } of results) {\n  if (Object.keys(mod).length === 0) { console.error('verify-pack: ' + entry + ' exposed no exports'); process.exit(1) }\n  console.log('verify-pack: ' + entry + ' OK (' + Object.keys(mod).length + ' exports)')\n}\n`)
try {
  execFileSync(process.execPath, [probe], { cwd: unpacked, stdio: 'inherit' })
} catch {
  process.exitCode = 1
} finally {
  rmSync(probe, { force: true })
}

// 3. every packed target is present inside the tarball.
const packedFiles = new Set()
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, item.name)
    if (item.isDirectory()) await walk(full)
    else packedFiles.add(full.slice(unpacked.length + 1).replaceAll('\\', '/'))
  }
}
await walk(unpacked)
const normalize = p => p.replace(/^\.\//, '')
const notPacked = entries.filter(([, target]) => !packedFiles.has(normalize(target)))
if (notPacked.length > 0) {
  console.error('verify-pack: tarball is missing packed targets:\n  ' + notPacked.map(([e, t]) => `${e} -> ${t}`).join('\n  '))
  process.exitCode = 1
} else {
  console.log(`verify-pack: all ${entries.length} export entries packed and importable`)
}
