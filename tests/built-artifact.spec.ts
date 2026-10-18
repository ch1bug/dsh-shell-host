import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { pointerMissReport, waitForTreeReadyBriefly } from './helpers/lib-snapshot.ts'

/**
 * Live-finding regression guard (originally #10): tsdown's oxc transformer
 * passed `@Remote(...)` decorators through to the host lib, where Node
 * rejected them as a syntax error at import time — the row composed in the
 * profile but the plugin never activated. tsdown.config.ts now lowers
 * standard decorators via tsdown-plugin.ts; this smoke imports the BUILT pty
 * artifact (skip on a fresh checkout before `node --run build`) and asserts it
 * loads in plain Node.
 *
 * ## #123：判据从**采集期**挪到**运行期**，且缺席是 loud skip 不是静默 SKIP
 *
 * 原文是 `it.skipIf(!existsSync(artifactPath))(...)` —— `existsSync` 在**模块采集期**求值，
 * 而采集发生在**整条车道开跑之前**。于是 `tests/clean-lib.spec.ts`（会删 `lib/` 再重建）若
 * 恰好覆盖了那一刻，本用例就被**整条移出本次运行**，读数只是一个**静默 `SKIP`**：
 * 没人知道"这一轮其实没验"，覆盖静默丢失（本票 AC3 的原症状）。
 *
 * 现在改成运行期前置门槛：先等构件在磁盘上就位（{@link waitForTreeReadyBriefly}，判据 = 本用例
 * 自己的入口文件），等到了就**真跑**；等不到则**响亮跳过**（打 `!! SKIP (loud)` 并说明缺什么），
 * 绝不静默当 pass。这与 `docs/agents/TESTING.md` §证据纪律的 loud-skip 口径一致。
 *
 * 注意**为什么不**改成"永远红"：构件缺席有两类来源 —— ① 写者的重建窗口（环境性，该等）；
 * ② 真没构建过（新检出，属"门禁未开"，该响亮跳过）。两者的区分靠"等一个上界"，
 * 而不是靠把其中一类硬判成红。
 *
 * 也注意**为什么用 `…Briefly`**（#123 的一处成本回退）：本用例在新检出上（从没构建过）
 * 本该**立刻**响亮跳过，用满上界会让它白等 60 s。短等判据是"有没有出现任何动静" ——
 * 一件都没出现且连续几轮如此 ⇒ 判定"根本没在建"，提前收手；结论（缺件、响亮跳过）完全一样。
 * 而**库内**写者的窗口已由车道分离挡掉（`writers` 车道排在 unit 之后），故这里的等待
 * 只为**库外**构建留余量，短等足够。
 */

const artifactPath = fileURLToPath(new URL('../lib/pty/index.js', import.meta.url))

/**
 * 等构件就位的上界。
 *
 * ⚠️ **它只对本用例的**一件**成立，与 `verify-pack.spec.ts` 的 `PRELUDE_WAIT_MS`（等
 * entryTargets + manifestTargets **全量**）诊断面不同** —— 照搬数值是安全的，但**安全靠的是
 * 调用侧的 `absentRounds` 默认值**（`waitForTreeReadyBriefly` 的 8 轮 ≈ 2 s 让"新检出、
 * 一件都没有"提前收手，头注承诺的「新检出立刻响亮跳过」因此成立）。
 * 若将来有人调大 `absentRounds`、或把这里的调用换回不带早退的 `waitForTreeReady`，
 * 这个 60 s 会**立刻**变成"新检出白等一分钟"的成本回退（复核 §3 指出的一处耦合，
 * 埋在这里而不是藏进默认值里）。
 */
const ARTIFACT_WAIT_MS = 60_000

describe('built pty artifact loads in plain Node', () => {
  /** 构件是否就位（等待结果；`null` = 还在等，见下）。 */
  let missingArtifact = false

  beforeAll(async () => {
    // 运行期门槛：等 `lib/pty/index.js` 就位（写者的重建窗口里它瞬时不在）。
    // 只读判断，**不去修 `lib/`** —— 那是 `clean-lib` 的写域，抢它只会制造更坏的窗口。
    // `…Briefly`：全无动静时提前收手（新检出立刻响亮跳过，不白等 60 s）。
    const { missing, elapsedMs } = await waitForTreeReadyBriefly(
      ['lib/pty/index.js'],
      (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url)),
      { timeoutMs: ARTIFACT_WAIT_MS },
    )
    missingArtifact = missing.length > 0
    if (missingArtifact) {
      // 响亮跳过（不是静默 pass）：说清缺什么、**实际等了多久**、以及它意味着什么。
      // 报 `elapsedMs` 而不是 `ARTIFACT_WAIT_MS`：早退时两者差一个数量级（实测 2.1 s vs 60 s）。
      console.info(
        `!! SKIP (loud) built-artifact 盒：等构件仍未就位 —— ` +
          `${pointerMissReport(missing, ARTIFACT_WAIT_MS, elapsedMs)} ` +
          `（本用例要求先跑过 \`node --run build\`；新检出上这是**门禁未开**，不是缺陷。）`,
      )
    }
  })

  it('imports without a syntax error and exposes the plugin apply', async () => {
    // 运行期的缺席判据：与采集期不同，这里**看得见是被谁挡住的**。
    if (missingArtifact) {
      expect(
        existsSync(artifactPath),
        '构件缺席时本用例必须已被 loud skip 覆盖（走到这里说明门槛与判据不一致）',
      ).toBe(false)
      return
    }
    // 前置条件：构件真的在（否则下面的 import 会抛 ERR_MODULE_NOT_FOUND，
    // 那读数会被误解成"构件语法有问题"——本票要避免的正是这种错认）。
    expect(existsSync(artifactPath), '门槛说构件就位了，这里它必须真的在').toBe(true)
    const mod = await import(artifactPath)
    expect(typeof mod.apply).toBe('function')
  })
})