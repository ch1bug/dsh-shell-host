/**
 * Tarball integrity check for the published exports face (issue #36):
 * packs the current tree, unpacks it under .scratch/ (so the unpacked
 * package's up-tree lookup reaches the repo node_modules), then asserts
 *
 *   1. every concrete `exports` pointer names a real file, and
 *   2. every entry imports under Node self-reference FROM the tarball, and
 *   3. every packed target is present in the tarball, and
 *   4. every published-manifest pointer (`main` / `types` / `dsh.bundle.patch` — string or
 *      ordered array) names a real file AND is present in the tarball: the install face that
 *      `exports` alone never covered (#88). It adds no new pass — the existence half rides
 *      criterion 1 (noted 1b below) and the tarball half rides criterion 3.
 *   5. (#111, THE fix) no chunk FAMILY has two generations in the tarball: criteria 1–4 only
 *      ever ask "is the declared target THERE", and `lib/pty-*.js` legitimately declares the
 *      PREVIOUS generation too — so a stale chunk rides along and everything stays green.
 *      `duplicateChunkFamilies` counts members per `files` chunk glob; ≥2 = stale output.
 *   6. (#111, DEFENSIVE) no `lib/` file outside the `files` face. Honestly downgraded: npm's
 *      `files` allowlist already blocks these at pack time, so the CLI never sees them — kept
 *      for a future looser `files` / packer. Wording must never imply it guards stale chunks.
 *   0. (#118) 守卫**自检**（先于以上各条）：判据 4/5 的判据清单来自 `files`，`files` 被宽写成
 *      `lib/**` 时两者**双双静默失效**。自检没有触发面时**响亮**报错（exit 1），不静默全绿。
 *
 * Exit 0 = all pointers resolvable. **Requires a prior build** (`node --run build`),
 * so it is not part of `node --run test`; run it via `node --run test:release`, which
 * builds first. When no packer is reachable it skips LOUDLY (exit 0, printing
 * `!! SKIP (loud)`) rather than reporting an unearned pass.
 *
 * 结构（#86）：`entryTargets` / `manifestTargets` / `untarGz` / `compileFilesMatcher` /
 * `chunkFamilyDeclarations` / `duplicateChunkFamilies` / `unexpectedPackedFiles` /
 * `guardSelfCheck`（#118）是**纯函数**
 * （导出，见 `tests/verify-pack.spec.ts` 的离线单测）；
 * `findPacker` 亦导出但**非纯**（碰文件系统与 PATH 探针）：装箱交付链 e2e 现场打包时复用它，
 * 否则打包器候选顺序会有第二份。
 * `main` **亦导出（#90）且同样非纯** —— 它碰真实文件系统与打包器，**不在**上面那份纯函数清单里。
 * 导出它是刻意的取舍，理由：#90 修的是**控制流属性**（`return` 取代 `process.exit` ⇒ 那条 `finally`
 * 得以执行、`packdir` 得以回收），而该属性**只有 `main` 的控制流能演示** —— 断言 `findPacker`
 * 返回 `null` 证明不了它；不导出则用例只能恒 skip 或只做纯函数断言，锁不住 #90 真正修的属性。
 * 这与 `findPacker` 的导出同属"非纯但为可测性/复用而导出"的一类（同形先例见上），**不是顺手导出**。
 * 用例驱动它时**必须**注入 `detect` 制造"必然找不到打包器"，否则会真的 spawn 打包器。
 * `isDirectInvocation` **原样转出**自 `scripts/script-entry.mjs`（#85 的单一来源，本文件不再自带
 * 一份实现）。顶层流程收进 `main()` —— **只有直接执行才跑 CLI**，import 本模块零副作用
 * （改前顶层 `await` 会直接打包 + 写 `.scratch/`）。导出 `main` **不改变**这条保证：模块求值时
 * `main` 只是被定义、不被调用，CLI 仍只由下方 `isDirectInvocation` 守卫触发。
 * @module dsh-shell-host/scripts/verify-pack
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { isDirectInvocation } from './script-entry.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
 *
 * 导出（#89）：装箱交付链 e2e 要对**同一个**插件树现场打包，复用这份候选顺序；
 * 第二份实现在两处各漂一次就是等着「这个宿主找得到打包器、那个找不到」。
 *
 *  ## 可测性注入缝（#90，人类裁决）
 *
 *  候选里那条**硬编码** `C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js` 在本机
 *  **真实存在**，且排在 PATH 兜底**之前** ⇒ 真实环境下本函数**永远**返回 npm-cli，
 *  `main()` 的 loud-skip 分支因而**结构性不可达**：仓内回归用例只能恒为 loud skip（0 实证），
 *  在打包器可达的机器上反而会真跑一次完整 `npm pack`（重 e2e）。于是开这个缝让用例注入
 *  「必然找不到打包器」。
 *
 *  **注入只解决可测性，不重构查找语义**：候选数组、候选顺序、`existsSync` 而非 `access`
 *  的理由**一律不变**（票面 Out of scope：不改打包器查找的候选顺序与路径）。不传参时两个
 *  依赖回落到本模块真实 import 的 `existsSync` / `execFileSync` ⇒ 探测逐字等同于改动前。
 *
 *  @param detect              可选注入：`{ candidateExists, probe }` 两个探测依赖。
 *  @param detect.candidateExists 判定硬编码候选是否存在（默认 `node:fs` 的 `existsSync`）。
 *  @param detect.probe         PATH 兜底探针（默认 `node:child_process` 的 `execFileSync`）；
 *                              **同步**语义 —— 它不抛即视为命中，抛错即视为该名字不可用。
 *  @returns `{ kind, path }`，或找不到时 `null`（调用方据此 loud skip）。
 */
export function findPacker({ candidateExists = existsSync, probe = execFileSync } = {}) {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js',
  ]
  // existsSync, NOT the async `access`: the latter returns a promise that never
  // throws here, so every candidate would "match" and we would exec a path that
  // does not exist.
  for (const candidate of candidates) {
    if (candidateExists(candidate)) return { kind: 'npm-cli', path: candidate }
  }
  // PATH-resolved fallbacks: `shell: true` because these are .cmd shims.
  for (const name of ['npm', 'pnpm']) {
    try {
      probe(name, ['--version'], { stdio: 'ignore', shell: true })
      return { kind: name, path: name }
    } catch {
      continue
    }
  }
  return null
}

/** Flatten the exports map into [entryName, target] pairs; condition keys
 *  (`types`, `default`, …) keep their parent entry's name. */
export function entryTargets(exportsMap, entry = '') {
  const targets = []
  for (const [key, value] of Object.entries(exportsMap)) {
    const name = key.startsWith('.') ? key : entry
    if (typeof value === 'string') targets.push([name, value])
    else targets.push(...entryTargets(value, name))
  }
  return targets
}

/** 发布面的**契约指针**（#88）：`main` / `types` / `dsh.bundle.patch` 指向的文件同样必须
 *  在工作树与 tarball 内 —— 只认 `pkg.exports` 的旧判据对它们视而不见（变异已证实：
 *  `files` 去掉 `cordis.patch.yml` 仍全绿）。
 *
 *  形态以宿主 `bundlePatchFiles()` 为权威（rc.2 发布副本 `dsh-app-boot/lib/index.js:495`）：
 *  字符串 = 单文件，数组 = **有序**多文件（逐元素校验，label 带下标顺序）。顺序固定为
 *  `main` → `types` → `dsh.bundle.patch`（先库入口、后装载契约）；数组严格按声明顺序。
 *
 *  契约外形态（`main: 42`、数组里夹非字符串）**安静跳过**：本票只守"契约指针指向的文件在不在"
 *  （triage 口径：不试图证明 tarball 完备，也不做 manifest 形状校验——形状由宿主在装载期响亮拒绝）。
 *  数组里可用的字符串元素照旧逐个校验，不因兄弟元素形状非法而整条漏检。
 *
 *  @returns `[label, target]` 列表；无契约指针时为空。
 */
export function manifestTargets(pkg) {
  const targets = []
  for (const [label, value] of [['main', pkg.main], ['types', pkg.types]]) {
    if (typeof value === 'string') targets.push([label, value])
  }
  const patch = pkg.dsh?.bundle?.patch
  if (typeof patch === 'string') targets.push(['dsh.bundle.patch', patch])
  else if (Array.isArray(patch)) {
    patch.forEach((file, index) => {
      if (typeof file === 'string') targets.push([`dsh.bundle.patch[${index}]`, file])
    })
  }
  return targets
}

/** 把 `files` 声明**编译**成匹配器（纯函数，导出）。
 *
 * 支持 npm 打包面实际用到的 glob 形态（不引 minimatch/picomatch —— 仓里没有这两个依赖，
 * 也不该为一条判据加一个；本仓 `files` 里**从未**出现 `!` 取反 / `?` / 花括号 / 字符类，
 * 故刻意不实现：真出现只会被读成普通字面量字符，从而响亮误报"声明了却没进 tarball"，
 * 属 fail-visible，不会静默假绿）：
 *   - `*`  —— **单段**内任意字符（不跨 `/`）；`lib/pty-*.js` → `^lib/pty-[^/]*\.js$`；
 *   - `**` —— **跨段**任意字符（`**` 与相邻 `/` 一起吸收，覆盖 `lib/types/**\/*.d.ts` 命中
 *             `lib/types/pty/index.d.ts` 这类深层声明 —— 退化成单层 `*` 正是本判据要堵的漏检）；
 *   - 其余字符**逐字转义**（`.js` 里的点必须是字面点，不能当通配）。
 *
 * @returns 锚定的 `RegExp` 数组；`files` 非数组（形状不合契约）时为空数组。
 */
export function compileFilesMatcher(files) {
  if (!Array.isArray(files)) return []
  return files
    .filter((pattern) => typeof pattern === 'string')
    .map((pattern) => new RegExp(`^${globToRegExpBody(pattern)}$`))
}

/** 单个 glob 模式 → 正则体（不含锚定），供 `compileFilesMatcher` 使用。 */
function globToRegExpBody(pattern) {
  let body = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char !== '*') {
      body += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      continue
    }
    // `**` 连写：跨段；后随的 `/` 一并吸收，这样 `a/**/b` 同时命中 `a/b`（零层）与 `a/x/b`。
    // `***` 这类怪形态按 `**` + `*` 理解 —— `**` 已能跨段，多加一颗星不改变匹配集。
    if (pattern[i + 1] === '*') {
      i += 1
      if (pattern[i + 1] === '/') i += 1
      body += '.*'
    } else {
      body += '[^/]*'
    }
  }
  return body
}

/** tarball 里的**多余件**（纯函数，导出）—— ⚠️ **防御性判据，不是本票的修复面**。
 *
 *  ## 可达性边界（先读这段，否则会误以为它守住了历史 chunk）
 *
 *  **它在 CLI 端收不到 `files` 之外的输入。** 实测：往 `lib/` 放 `lib/sta.js` 与
 *  `lib/legacy/index.js` 后 `npm pack --dry-run --json` 的 tarball 仍是 16 files，这两件
 *  **完全不在**其中 —— npm 的 `files` 白名单已在**打包阶段**把"多余件"挡掉，`main()` 的
 *  `walk(unpacked)` 自然永远看不到它们。所以本函数在 CLI 上**结构性无触发面**；它的红只在
 *  离线单测（直接喂 `packedPaths`）里出现过。
 *
 *  **它也管不了 `files` 之内的多余件**：`lib/pty-*.js` 这类宽松 glob 同时合法声明了两代 chunk，
 *  上一代因此"在声明面之内"—— 那正是本票的原始症状，由 `duplicateChunkFamilies` 负责
 *  （按族计数 ≥2 判红），**不是本函数**。
 *
 *  ⇒ 保留它是因为**将来仍可能有触发面**（`files` 放宽 / 换一个不严格过滤的打包器），届时它立刻有用。
 *  但**不得**在任何输出里宣称它守住了历史 chunk —— 一个看起来在守、实际守不住的判据比没有更危险。
 *
 *  ## 判据
 *
 *  从解包后的文件全集里挑出**既没被 `files` 任何一条 glob 覆盖**、又在判据范围内（见下）的路径。
 *
 *  **为什么只覆盖 `lib/`**（判据边界 = 该判据不假红的关键）：打包器**总会**带上 `package.json` /
 *  `README.md` / `LICENSE` 之类与 `files` 无关的文件（npm 的强制集 + 默认忽略规则），对它们做
 *  "多余件"判定必然假红 —— 而假红会让人学会忽略这条判据，比没有更糟。范围写死在 `SCOPE_PREFIX`，
 *  越界的路径一律不判。
 *
 *  目录形态（`lib/zzz-fake/x.js`）同样会被判为多余件：其父目录 `lib/zzz-fake/` 若不在声明面，
 *  该目录整棵在 tarball 里就是多余载荷 —— 放行它等于留着同一个缺口换条路径进来。
 *
 *  其余克制之处：`files` 为空 / 非数组 / 全是非字符串时**不做判定返回空**——"什么都没声明"
 *  不是"什么都没多余"的证据，此时普通 glob 会命中所有路径，把整棵 `lib/` 报成违规（假红）。
 *
 *  @param files      `package.json` 的 `files` 列表（glob 字符串）。
 *  @param packedPaths tarball 内全部文件的相对路径（`/` 分隔，如 `lib/pty/index.js`）。
 *  @returns 违规路径，**排序稳定**（字典序）；无违规 / 判据不适用时为空数组。
 */
export function unexpectedPackedFiles(files, packedPaths) {
  const matchers = compileFilesMatcher(files)
  if (matchers.length === 0) return []
  const declarations = files.filter((pattern) => typeof pattern === 'string')
  // 判据范围：`lib/`（见函数头注释）。前缀必须以 `/` 收口 —— `libfoo/x.js` 不是 `lib/` 里的件。
  const SCOPE_PREFIX = 'lib/'
  const violations = []
  for (const raw of packedPaths) {
    const path = String(raw).replace(/^\.\//u, '')
    if (!path.startsWith(SCOPE_PREFIX)) continue
    if (matchers.some((matcher) => matcher.test(path))) continue
    // 目录级声明（`files: ["lib/pty"]`）照 npm 口径覆盖整棵子树 —— 少了这一步，合法的
    // 目录形态声明会被判成"多余件"（假红）。
    if (declarations.some((pattern) => path.startsWith(pattern.replace(/\/+$/u, '') + '/'))) continue
    violations.push(path)
  }
  return violations.sort()
}

/** `files` 里的 **chunk glob 族**（纯函数，导出）：形如 `lib/<name>-*.js` 的声明。
 *
 *  为什么是这个形状：tsdown 把每个源码模块切成一个带内容哈希的 chunk（`lib/pty-C0_H63de.js`），
 *  而 `files` 用 **`lib/pty-*.js`** 这类宽松 glob 声明它 —— 一条 glob 覆盖"该模块的任意一代 chunk"。
 *  于是两代 chunk（当次的 + 上一代的）**在声明面上无法区分**：它能进 tarball，多余件判据也放行它。
 *  本函数把这类声明单独挑出来，交给 `duplicateChunkFamilies` 数成员。
 *
 *  识别口径：basename 里含 `-*` 且以 `.js` 结尾、且 `-*` 之后没有 `/`（即通配落在文件名段内）。
 *  `lib/pty/index.js`（具体名）与 `lib/types/**\/*.d.ts`（跨段通配）都**不是** chunk 族 —— 前者点名
 *  一个文件，后者的 `**` 不是哈希位。故意收窄到"文件名段内的 `-*`"，避免把结构性通配误判成族。
 *
 *  @returns 族声明字符串，按 `files` 声明顺序（报告顺序稳定、可复现）。
 */
export function chunkFamilyDeclarations(files) {
  if (!Array.isArray(files)) return []
  return files.filter((pattern) => {
    if (typeof pattern !== 'string') return false
    const segments = pattern.split('/')
    const basename = segments[segments.length - 1] ?? ''
    return basename.endsWith('.js') && basename.includes('-*') && !basename.includes('**')
  })
}

/** 每个 chunk 族在 tarball 里的命中数（纯函数，导出，#111 路线 B 的**可达**守卫面）。
 *
 *  判据：**每个 chunk 族的命中数必须 ≤ 1**。同一次构建里，一个模块只该产出一个 chunk，故
 *  **≥2 即**是上一代 chunk 与前一代同时躺在 `lib/` 里 —— 正是本票的原始症状
 *  （`lib/pty-g32VoH8_.js` 46509 B 与 `lib/pty-C0_H63de.js` 46520 B 同行）。
 *
 *  **粒度取舍：族 = `files` 声明的 glob，不是 chunk 主干。** 另一条口径是"剥掉 hash 段得主干
 *  （`lib/pty-C0_H63de.js` → `lib/pty-`），按主干聚合"。实测后**不采用**，理由是可判性：
 *  剥离必须假定 hash 段可识别（当前 8 字符、`[A-Za-z0-9_-]`），但**主干自身可能长得一样** ——
 *  `src-v2-Ab12Cd34.js` 剥成主干 `src-v2` 还是 `src-`？`my-module-12345678.js` 更不可判。
 *  而两条口径的**唯一分歧形态**（同族出现两个主干不同的**合法** chunk）在本仓实测**不存在**：
 *  连续多次构建顶层 chunk 恒为 `pty-C0_H63de.js` 一个，且它只 import 外部包与 `node:*`，
 *  没有兄弟 chunk import（rolldown 当前未做 chunk 拆分）。用确定的可判性去换一个尚未发生
 *  的形态的正确性不划算，故取族粒度。
 *
 *  那个分歧形态若真出现（同族两个不同 chunk），红的归因是**声明面与产物面脱节**：`files` 用
 *  一条 `lib/pty-*.js` 同时声明了两个语义不同的产物，此刻"该收敛声明"是事实，红是正确信号，
 *  不是误伤 —— 归因写在这里，它因此是判据的定义，而不是判据的例外。
 *
 *  **为什么是 `≤ 1` 而不是 `== 1`**：某族**可能**在某次构建里一个成员都不产（`lib/posix-quote-*.js`
 *  这类 helper 是否被内联进某个 entry chunk，取决于内联结果；实测四族当前均为 0 命中）——
 *  "没产出"不是缺陷，红在那里就是假红。而 `≥ 2` 在任何情况下都表示累积残留，没有合法解释。
 *
 *  **为什么它比 `unexpectedPackedFiles` 有意义（可达性）**：本函数判的是"`files` **之内**的件
 *  多了一份"，输入是 tarball 里真实解包出的文件 —— **CLI 端收得到**，所以能被变异验证触发。
 *  反过来"`files` **之外**的 `lib/` 件"在打包阶段就被 npm 白名单挡掉了，CLI 端永远收不到
 *  （详见 `unexpectedPackedFiles` 的可达性说明）。
 *
 *  @param files       `package.json` 的 `files` 列表。
 *  @param packedPaths tarball 内全部文件的相对路径（`/` 分隔）。
 *  @returns `[{ family, matches }]`，**只含违规族**（matches 已排序）；无违规时空数组。
 */
export function duplicateChunkFamilies(files, packedPaths) {
  const families = chunkFamilyDeclarations(files)
  if (families.length === 0) return []
  const paths = [...packedPaths].map((raw) => String(raw).replace(/^\.\//u, ''))
  const violations = []
  for (const family of families) {
    // 逐族复用同一份 glob 编译（`compileFilesMatcher` 是单一来源，这里不写第二套匹配逻辑）。
    const [matcher] = compileFilesMatcher([family])
    const matches = paths.filter((path) => matcher.test(path)).sort()
    if (matches.length > 1) violations.push({ family, matches })
  }
  return violations
}

/** 守卫**自检**（纯函数，导出）：判"本轮这两条判据是否还有触发面"，而不是判产物。
 *
 *  ## 它修的是什么（#118）
 *
 *  判据 4/5 的**判据清单本身**来自 `package.json` 的 `files`：
 *  `duplicateChunkFamilies` 从 `files` 里挑 chunk 族再计数，`unexpectedPackedFiles`
 *  判"没被 `files` 任何一条 glob 覆盖的 `lib/` 件"。两者都**假定族声明在场**。
 *  于是有人把族名宽写成 `lib/**`（或把族声明整行删掉）时，**两条判据双双静默失效** ——
 *  无族可数、无件在声明面之外，守卫全绿放行历史 chunk（票面证据逐字复现：
 *  `duplicateChunkFamilies(['lib/**'], …)` → `[]`，`unexpectedPackedFiles(['lib/**'], …)` → `[]`）。
 *
 *  一个**看起来在守、实际守不住**的判据比没有更危险（#111 已把这条写进本文件的口径）。
 *  本函数就是那条**可见信号**：让守卫在被架空时自己说出来，而不是安静地打绿行。
 *
 *  ## 为什么是"自检"而不是"再加一条产物判据"
 *
 *  票面 Out of scope 明写不改 `files` 面本身、不改族判据语义。故本函数**只读 `files` 声明**、
 *  不碰产物，也就不可能对正常构建假红（它连 `packedPaths` 都不接）。方向 2（`lib/*.js` 总数上限）
 *  被否：它与 #111 已论证过的"rolldown 将来可能切多个 chunk"的假红面直接冲突。
 *
 *  ## 判据（返回违规清单，空数组 = 自检通过）
 *
 *  - `no-chunk-family`：可读的 `files` 里**一条 chunk 族都没有** ⇒ 判据 4 被架空。
 *    这是 `lib/**` 宽写与"删掉族声明"的共同归宿，故 `detail` 列出**实际声明**，让人一眼看出是哪一行。
 *  - `unreadable-files`：`files` 非数组 / 全非字符串 ⇒ 连声明面都读不懂，同样不能算"已守"。
 *
 *  **`lib/**` 与族声明共存时不报**：那时族判据仍有触发面 —— `duplicateChunkFamilies` 逐族用
 *  **该族自己的 glob** 计数，`lib/**` 本身不是族（`chunkFamilyDeclarations` 排除含 `**` 的声明），
 *  故它不会把子目录件或 `.d.ts` 混进任何族的命中数。实测（本票）：`['lib/**','lib/pty-*.js']`
 *  喂两代 `pty` chunk ⇒ 照常报 `lib/pty-*.js -> 2 matches`；喂单代 + 子目录件 ⇒ 空（无假红）。
 *  多一条宽声明是**宽窄**问题，不是**有无**问题 —— 宽窄归 `#117` 的面（那份 `lib/types/` 下的
 *  跨段 `.d.ts` 声明是**内容盲** glob），本判据不越界；票面 Comments 已明写两票"判据面不同，别合并"。
 *
 *  ⚠️ **本判据不覆盖"部分宽写"**：若族声明只剩一条而 `files` 同时含 `lib/**`，自检静默 ——
 *  因为判据 4 对**剩下的那条族**仍有效。这是刻意的边界（票面 Out of scope：不改族判据语义），
 *  不是漏洞；真要收紧"族声明条数"属结构断言，票面列为**非强制**方向 ③，未采纳。
 *
 *  @param files `package.json` 的 `files` 列表。
 *  @returns `[{ code, detail }]`，空数组表示自检通过（判据 4 有触发面）。
 */
export function guardSelfCheck(files) {
  const declarations = Array.isArray(files) ? files.filter((pattern) => typeof pattern === 'string') : []
  if (declarations.length === 0) {
    return [
      {
        code: 'unreadable-files',
        detail: `package.json 的 "files" 不是可读的字符串数组：${JSON.stringify(files)}`,
      },
    ]
  }
  if (chunkFamilyDeclarations(declarations).length === 0) {
    return [
      {
        code: 'no-chunk-family',
        detail: `没有任何 chunk 族声明（形如 lib/<name>-*.js）—— 实际声明：${declarations.join(', ')}`,
      },
    ]
  }
  return []
}

/** 逐个契约指针查**工作树**存在性（碰 I/O，故不导出）：返回缺失行 `label -> target`。
 *
 *  存在性判据**只此一处** —— exports 指针（判据 1）与 manifest 指针（#88）走同一实现：
 *  两处各写一遍就是等着口径漂移。哨兵写法沿用本文件既有约定（`access(...).catch(() => 'no')`；
 *  为什么用 `access` 而不是 `existsSync` 的提醒见 `findPacker` 上方）。
 */
async function missingInTree(pairs) {
  const missing = []
  for (const [label, target] of pairs) {
    if (await access(join(repoRoot, target)).catch(() => 'no')) missing.push(`${label} -> ${target}`)
  }
  return missing
}

/** CLI 主体（碰真实文件系统 / 打包器，故覆盖它要真实环境；见下方"导出"说明）：装箱 → 解包 → 四条断言。
 *
 *  **返回退出码（#90），不在内部 `process.exit`**：loud-skip 分支原先在自己 `try` 内直接
 *  `process.exit(0)`，而 `process.exit` 同步终止进程 ⇒ 该 `try` 的 `finally`（`rmSync(packdir)`）
 *  永远跑不到，`%TEMP%` 每次遗留一个空的 `dsh-shell-host-pack-*`。改为 return 后由调用点统一
 *  `process.exit(await main())`，回收走正常控制流。
 *  判据 1/1b 是**早失败**（`return 1`：指针都不存在时没必要继续）；判据 0/2/3/4/5 用局部
 *  `exitCode` 累积（保住"多条判据可同时红、不提前返回"的既有语义），末尾 `return exitCode`。
 *  loud-skip 分支（找不到打包器）同理 `return exitCode`（#118 前写死的 `return 0` 会吞掉
 *  判据 0 已设的红 —— 见该分支内的说明）。
 *
 *  `detect` 是给用例的**可选**注入（#90），原样透传给 `findPacker()`；不传时探测依赖
 *  回落到真实实现 —— 真实入口（下方调用点）**不传参**，故行为零变化。
 *
 *  @param detect 见 `findPacker`；省略即用真实文件系统 / 真实 `execFileSync`。
 *
 *  导出（#90）见 @module 头注：非纯，导出只为让用例能注入驱动 loud-skip 的回收面。
 */
export async function main({ detect } = {}) {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  const allTargets = entryTargets(pkg.exports)
  const entries = allTargets.filter(([, target]) => !target.includes('*'))
  // 发布面的其它契约指针（#88）：`exports` 之外，`main` / `types` / `dsh.bundle.patch`
  // 同样被 tarball 的 `files` 面决定 —— 缺件只在装载期炸，故这里与 exports 同等对待。
  const manifestPointers = manifestTargets(pkg)
  // Node-side import smoke covers the host entries only: `./package.json` is not an
  // ES module. (`./client` is vestigial — ADR-0013 removed the web bundle — and
  // `./src/*` never gets here because the wildcard targets are filtered out above.
  // Both exclusions stay verbatim: #86 does not touch the boxing criteria.)
  const importableEntries = [...new Map(entries.filter(([entry]) =>
    entry !== './client' && entry !== './package.json'
  ).map(([entry]) => [entry, true])).keys()]
  // 判据 2/3/4/5 共同累积的退出码（#90）：这些分支**不提前返回**，末尾一次性 return。
  let exitCode = 0

  // 0. **守卫自检**（#118）：判据 4/5 的判据清单来自 `files`，`files` 宽写成 `lib/**`（或族声明
  //    被删）时两条判据**双双静默失效**。故先问一句"这轮我还有触发面吗" —— 没有就**响亮**，
  //    而不是打绿行。放在最前：族面都不存在时，后面的判据 4 输出只会是空洞的绿。
  const selfCheck = guardSelfCheck(pkg.files)
  if (selfCheck.length > 0) {
    console.error(
      'verify-pack: !! 守卫自检失败 —— 本次运行的 chunk 族判据没有触发面，其"全绿"不代表产物干净：',
    )
    for (const { code, detail } of selfCheck) console.error(`  [${code}] ${detail}`)
    console.error(
      'verify-pack: 若确实要放宽 "files"，请同时确认族声明仍在（`lib/<name>-*.js` 形态）；' +
        '详见 #118。',
    )
    exitCode = 1
  }

  // 1. every concrete pointer names a real file in the working tree.
  const missing = await missingInTree(entries)
  if (missing.length > 0) {
    console.error('verify-pack: exports pointers to missing files:\n  ' + missing.join('\n  '))
    return 1
  }

  // 1b. 同一存在性判据，管到 exports 之外的契约指针（#88）：工作树里就没有的文件，
  // 打包器再怎么样也进不了 tarball —— 早失败，且与"打包器缺失即 loud skip"的路径无关。
  const manifestMissing = await missingInTree(manifestPointers)
  if (manifestMissing.length > 0) {
    console.error('verify-pack: manifest pointers to missing files:\n  ' + manifestMissing.join('\n  '))
    return 1
  }

  // 2. every entry imports under Node self-reference from the unpacked tarball.
  const packdir = mkdtempSync(join(tmpdir(), 'dsh-shell-host-pack-'))
  const unpackRoot = join(repoRoot, '.scratch', 'verify-pack')
  try {
    // Pack through a shim-free packer: `pnpm` may be absent from PATH (the #79
    // class of failure) and the bundled node ships no npm at all.
    const packer = findPacker(detect)
    if (packer === null) {
      // 文案按 #88 的 AC **逐字不变**（此后存在性检查还覆盖了 manifest 指针，但那句只陈述
      // exports 指针"只做了存在性检查"——仍是事实，故不借机改写 Skip 面）。
      console.warn(
        'verify-pack: !! SKIP (loud) — 找不到打包器（Node 自带 npm / PATH 上的 npm·pnpm 皆无）。' +
          '本次未验证 tarball 完整性：exports 指针只做了存在性检查。',
      )
      rmSync(unpackRoot, { recursive: true, force: true })
      // **`return exitCode`，不是 `return 0`（#118）**：loud skip 只该放弃**tarball 那半**的验证，
      // 不该赦免**已经判定过的**失败。守卫自检（上面的判据 0）在这之前就设了 `exitCode = 1`；
      // 早先写死的 `return 0` 会把它**吞掉** —— 于是"`files` 已被宽写到没有族声明"的环境下，
      // 自检**报了红却退出 0**（实测：注入 `detect` 造"必然找不到打包器" ⇒ `main()` 返回 0，
      // 而 stderr 同时有自检红与 SKIP 文案）。这与 #90 修的是**同一类**洞：一条退出路径
      // 悄悄丢弃先前累积的结论。判据 1/1b 的 `return 1` 是**早失败**，不走这里，保持不变。
      return exitCode
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
    exitCode = 1
  } finally {
    rmSync(probe, { force: true })
  }

  // 3. every packed target — exports entries AND the manifest pointers (#88) — is present
  // inside the tarball.
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
  const notPacked = [...entries, ...manifestPointers].filter(([, target]) => !packedFiles.has(normalize(target)))
  if (notPacked.length > 0) {
    console.error('verify-pack: tarball is missing packed targets:\n  ' + notPacked.map(([e, t]) => `${e} -> ${t}`).join('\n  '))
    exitCode = 1
  } else {
    console.log(`verify-pack: all ${entries.length} export entries packed and importable`)
  }

  // 4. **本票的修复面**（#111 路线 B，可达判据）：同一个 chunk 族在 tarball 里不得有两代同行。
  //    判据 3 只问"声明目标在不在"，而 `lib/pty-*.js` 这类宽松 glob 把上一代 chunk 也合法声明了 ——
  //    于是历史 chunk 能一直跟着 tarball 走而**全绿**（实测：`lib/pty-C0_H63de.js` + `lib/pty-zzz-fake.js`
  //    会一起进 tarball，且旧判据放行）。用已 walk 出的 `packedFiles`（不第二次 walk），
  //    用 `exitCode` 累积报告 —— 与判据 3、5 一样**不提前返回**；判据 1/1b 则是**早失败**
  //    （`return 1`：指针都不存在时没必要继续，那时本判据不会执行）。
  const duplicateFamilies = duplicateChunkFamilies(pkg.files, packedFiles)
  if (duplicateFamilies.length > 0) {
    console.error(
      'verify-pack: tarball carries more than one generation of a chunk family ' +
        '(stale build output alongside the current one):',
    )
    for (const { family, matches } of duplicateFamilies) {
      console.error(`  ${family} -> ${matches.length} matches: ${matches.join(', ')}`)
    }
    console.error('verify-pack: clean lib/ (node --run build) and re-run.')
    exitCode = 1
  } else {
    console.log(`verify-pack: no chunk family has two generations in tarball (${packedFiles.size} packed)`)
  }

  // 5. **防御性判据**（#111 路线 B，CLI 端结构性无触发面）：tarball 里不得有 `files` 之外的 `lib/` 件。
  //    文案**如实**说明它是防御性的 —— 不宣称它守住了历史 chunk（那是判据 4 的活）：
  //    实测 npm 的 `files` 白名单已在打包阶段挡掉这类件（放 `lib/sta.js` 后 tarball 仍是 16 files），
  //    故 CLI 端收不到输入，它的红只在离线单测里出现过。保留是因为将来仍可能有触发面
  //    （`files` 放宽 / 换不严格过滤的打包器）。看似在守、实则守不住的判据比没有更危险，故如实降级。
  const unexpected = unexpectedPackedFiles(pkg.files, packedFiles)
  if (unexpected.length > 0) {
    console.error(
      'verify-pack: tarball carries lib/ files outside the package.json "files" face:\n  ' +
        unexpected.join('\n  '),
    )
    exitCode = 1
  } else {
    console.log(
      `verify-pack: no unexpected lib/ files in tarball (defensive check; ${packedFiles.size} packed)`,
    )
  }

  return exitCode
}

/**
 * 是否**直接执行**（而非被 import）——被 import 时不跑 CLI。
 *
 * 真正实现在 `scripts/script-entry.mjs`（`#85` 收敛成的单一来源：realpath 归一 + 纯函数 + spec）。
 * 这里**原样转出**，让既有调用面与其它脚本共用同一份守卫。
 *
 * ADR-0014 那句「守卫与唯一检查入口共用同一份逻辑」讲的是**门禁判据**（pre-commit 就是靠
 * 调 `node --run typecheck` 复用）；而入口守卫的单一来源由 `#85` 落地为 `script-entry.mjs`。
 */
export { isDirectInvocation }

// 只有**直接执行**才跑 CLI：被单测 import 时不得打包、不得写 `.scratch/`、不得 spawn 打包器。
// 退出码由 `main()` 的返回值决定 —— 与 `scripts/privacy-scan.mjs` 同形（#90：main 内不再
// `process.exit`，否则 loud-skip 会跳过回收 `packdir` 的 `finally`）。
if (isDirectInvocation(process.argv[1], import.meta.url)) process.exit(await main())
