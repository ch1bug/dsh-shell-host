/**
 * #179 守卫：本仓工具面**永不含权限变更能力**。
 *
 * 安全不变量（2026-10-30 human 拍板，#175 会话确立）：模式切换（`/permission`
 * 命令、settings 默认值）是**人类动作**；本插件只消费权限（读门，见
 * `src/permission-gate.ts`），从不变更权限——不得成为 LLM 绕过官方路径切换
 * 权限模式的通道。
 *
 * 两层断言（一个 spec，均进离线车道）：
 *
 * 1. **源码级**：扫描 `src` 下全部 `.ts`，对宿主权限写 API（`setSandboxMode` /
 *    `setApprovalPolicy`）与权限事件类型（`permission/preset` /
 *    `sandbox/mode` / `approval/policy`）**零引用**。读侧豁免是**天然的**：
 *    `permission-gate.ts` 只 `resolve` / `MODE_RANK` / 拒绝文案，不含这些
 *    字面量——若未来读侧需要其中某个字面量，该改动必须显式改这里的豁免表
 *    （棘轮口径与 patch-shape 相同）。
 * 2. **工具面级**：以假 ctx 挂载本仓全部六行（`cordis.patch.yml` 的
 *    `{pty, ssh, terminal, remote, remote-fs, wsl}`，挂载口径与
 *    `tests/permission-gate.spec.ts` / `remote-registry.spec.ts` /
 *    `wsl-plugin.spec.ts` 同款），断言注册的工具名集合与 `BASELINE`
 *    **完全一致**（棘轮：新增 / 改名 / 删除即红），且名字集中不含
 *    `/permission|preset|approval/iu` 形态。
 *
 * 检查器自身的边界用合成用例守着（第一个 describe）：给扫描器 / 名字检查
 * 函数喂含禁用标识的文本，负例常驻证明有牙齿——绿不能靠「没断言」。
 *
 * @module tests/tool-face-guard
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { apply as applyTerminal, _resetRegistrationForTests } from "../src/terminal/index.ts";
import * as wslPlugin from "../src/wsl-plugin/index.js";
import { bootPlugin } from "./helpers/fake-pty.ts";
import { fakeChannelHarness } from "./helpers/fake-channel.ts";
import { echoFakePty } from "./helpers/fake-pty.ts";

// ---------------------------------------------------------------------------
// 源码级检查器
// ---------------------------------------------------------------------------

/** 禁用标识（原文匹配，非正则）：写 API 两个 + 事件类型三个（#179 AC1）。 */
const FORBIDDEN_LITERALS = [
  "setSandboxMode",
  "setApprovalPolicy",
  "permission/preset",
  "sandbox/mode",
  "approval/policy",
] as const;

/**
 * 对一段源码文本列出命中的禁用标识（空数组 = 合规）。
 * 逐条报全而不是首条：一次改动同时引入多个标识时一次看全。
 */
function sourceScanFindings(text: string): string[] {
  return FORBIDDEN_LITERALS.filter((literal) => text.includes(literal)).map(
    (literal) => `禁用标识 \`${literal}\`（宿主权限写 API / 事件类型）`,
  );
}

// ---------------------------------------------------------------------------
// 工具面级检查器
// ---------------------------------------------------------------------------

/**
 * 工具名棘轮基线（#179 拍板：**只锁本仓行注册的工具名**；宿主贡献面不在
 * 基线内，其权限属性归宿主侧审计票）。改工具面（新增 / 改名 / 删除）必须
 * 显式改这里——与 patch-shape 的 `OWN_ROW_IDS` 同款棘轮。
 */
const BASELINE = [
  // pty（#61 起六工具）
  "pty_open", "pty_send", "pty_tail", "pty_close", "pty_list", "pty_signal",
  // ssh（#136 自 pty 分出）
  "ssh_start", "ssh_send", "ssh_tail", "ssh_close",
  // terminal（launcher presets + 会话清单）
  "shell_open", "terminal_list",
  // remote（#137 工作区面）
  "remote_open_session", "remote_close_workspace", "remote_open", "remote_list", "remote_status",
  // remote-fs（#137 文件面）
  "remote_ls", "remote_read", "remote_write", "remote_edit",
  // wsl（#143 起默认休眠，工具面仍注册）
  "win_ls", "win_read", "win_write", "win_run", "win_open", "win_path", "win_drives",
] as const;

/** 名字集中不得出现的形态（#179 AC2）。 */
const FORBIDDEN_NAME_SHAPE = /permission|preset|approval/iu;

/**
 * 对一组注册工具名列出违例（空数组 = 合规）：集合棘轮 + 形态黑名单，
 * 一次报全。
 */
function toolNameFindings(names: readonly string[]): string[] {
  const findings: string[] = [];
  const actual = [...names].sort();
  const expected = [...BASELINE].sort();
  if (actual.join(",") !== expected.join(",")) {
    findings.push(
      `注册工具名集合 = {${actual.join(", ")}}，期望恰好 {${expected.join(", ")}}` +
        "（改工具面必须显式改 BASELINE：#179 棘轮口径见文件头注）",
    );
  }
  const offenders = names.filter((name) => FORBIDDEN_NAME_SHAPE.test(name));
  if (offenders.length > 0) {
    findings.push(
      `工具名含权限形态（/${FORBIDDEN_NAME_SHAPE.source}/）：${offenders.map((n) => `\`${n}\``).join(" / ")}` +
        "—— 权限变更是人类动作，插件只消费权限（#179 不变量）",
    );
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 检查器自身的边界（合成负例：证明有牙齿）
// ---------------------------------------------------------------------------

describe("检查器自身的边界（合成文本/合成名单）", () => {
  it("源码扫描器：干净文本返回空", () => {
    expect(sourceScanFindings("const mode = ctx.get('sandboxPolicy').resolve();\nconst rank = MODE_RANK[mode];")).toEqual([]);
  });

  it("源码扫描器：每个禁用标识各自被接住（负例常驻）", () => {
    for (const literal of FORBIDDEN_LITERALS) {
      const findings = sourceScanFindings(`await ctx.emit('${literal}', {});`);
      expect(findings, `标识 \`${literal}\` 必须被接住`).toContain(`禁用标识 \`${literal}\`（宿主权限写 API / 事件类型）`);
    }
    // 两个写 API 同时出现 → 一次报全（两条 finding）。
    expect(sourceScanFindings("ctx.setSandboxMode('x'); ctx.setApprovalPolicy('y');")).toHaveLength(2);
  });

  it("名字检查器：合规基线名单返回空", () => {
    expect(toolNameFindings([...BASELINE])).toEqual([]);
  });

  it("名字检查器：多一行 / 改名即红（棘轮）", () => {
    const withExtra = toolNameFindings([...BASELINE, "permission_set"]);
    expect(withExtra.join("\n")).toContain("注册工具名集合");
    expect(withExtra.join("\n")).toContain("含权限形态");

    const renamed = toolNameFindings([...BASELINE.filter((n) => n !== "pty_open"), "pty_start"]);
    expect(renamed.join("\n")).toContain("= {pty_close, pty_list, pty_send, pty_signal, pty_start, pty_tail");
    expect(renamed.some((f) => f.includes("期望恰好"))).toBe(true);
  });

  it("名字检查器：permission / preset / approval 形态各自被接住（大小写不敏感）", () => {
    for (const name of ["Permission_Preset", "mode_preset", "set_approval"]) {
      const findings = toolNameFindings([...BASELINE, name]);
      expect(findings.some((f) => f.includes("含权限形态")), `\`${name}\` 必须被接住`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 活体仓第一层：src/** 源码零引用
// ---------------------------------------------------------------------------

describe("活体仓：src/** 对权限写面零引用（#179 AC1）", () => {
  it("每个 src 下的 .ts 文件对禁用标识零命中", () => {
    const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
    const findings: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          for (const finding of sourceScanFindings(readFileSync(full, "utf8"))) {
            findings.push(`${full}: ${finding}`);
          }
        }
      }
    };
    walk(srcRoot);
    expect(findings, `src/** 踩到权限写面（findings 见上）。读侧豁免不是文件级：若读侧确需某字面量，显式改本守卫的 FORBIDDEN_LITERALS 豁免表`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 活体仓第二层：六行挂载面的工具名棘轮
// ---------------------------------------------------------------------------

describe("活体仓：全部行的注册工具名棘轮（#179 AC2）", () => {
  /** 挂载一次，全 describe 共享（挂载面是静态事实，不是每个用例的状态）。 */
  const state: { names: string[]; error?: unknown } = { names: [] };
  beforeAll(() => {
    // remote 行的通道 seam：假 harness（离线，不起实例——remote-registry 同款）。
    const harness = fakeChannelHarness();
    // wsl 行的 shell seam：假执行器（wsl-plugin.spec 同款）。
    const fakeShell = {
      resolve: (request: unknown) => request,
      execute: async (request: unknown) => ({ request, result: async () => ({ exitCode: 0, stdout: { text: "", truncated: false }, stderr: { text: "", truncated: false } }) }),
    };
    const booted = bootPlugin({
      // 快 settle（本守卫不执行任何 spawn，只看注册面）。
      config: { settleQuietMs: 10, settleTickMs: 5, settleTimeoutMs: 60 },
      spawnPty: () => echoFakePty().pty,
      ssh: true,
      remote: { anchorRoot: process.env.TEMP ?? ".", keepaliveMs: 0, reconnectMax: 0 },
      remoteDeps: { spawner: harness.spawner, platform: "win32" },
      remoteFs: {},
      services: { shell: fakeShell },
    });
    // terminal 行：pty 服务的消费者（permission-gate.spec 的 bootTerminal 同款，
    // deps.exists 假化避开 launcher 探测——守卫看注册面，不看可执行存在性）。
    _resetRegistrationForTests();
    applyTerminal(booted.ctx, {}, { exists: () => true });
    // wsl 行（默认休眠）：独立 apply，shell seam 由 services 提供。
    wslPlugin.apply(booted.ctx);
    state.names = booted.registered.map((tool: { name: string }) => tool.name);
  });

  it("六行注册的工具名集合与棘轮基线完全一致", () => {
    expect(state.names.length, "挂载面必须真的注册了工具（假 ctx 接住 = defineTool 走了官方路径）").toBeGreaterThan(0);
    const findings = toolNameFindings(state.names);
    expect(findings.join("\n"), "工具面踩到 #179 棘轮/形态口径（findings 见上）").toBe("");
  });
});
