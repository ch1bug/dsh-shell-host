/**
 * Tarball integrity check for the published exports face (issue #36):
 * packs the current tree, unpacks it under .scratch/ (so the unpacked
 * package's up-tree lookup reaches the repo node_modules), then asserts
 *
 *   1. every concrete `exports` pointer names a real file, and
 *   2. every entry imports under Node self-reference FROM the tarball, and
 *   3. every packed target is present in the tarball.
 *
 * Exit 0 = all pointers resolvable. Run after `pnpm build`.
 * @module dsh-shell-host/scripts/verify-pack
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { access, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))

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
  // shell: true — pnpm is a .cmd shim on Windows, spawnable only through a shell.
  const out = execFileSync('pnpm', ['pack', '--pack-destination', packdir], { cwd: repoRoot, encoding: 'utf8', shell: true })
  const tarballPath = out.trim().split('\n').pop().trim()
  rmSync(unpackRoot, { recursive: true, force: true })
  mkdirSync(unpackRoot, { recursive: true })
  execFileSync('tar', ['-xzf', tarballPath, '-C', unpackRoot], { cwd: repoRoot })
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
