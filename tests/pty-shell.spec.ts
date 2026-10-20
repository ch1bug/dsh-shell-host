/**
 * #149 unit suite — the session-level default shell (`shellCommand`) and the
 * surfaces it carries:
 *
 *  - the declaration channel: a bare command line, mutually exclusive with
 *    `command`, the `defaultShellCommand` fallback, and a loud error when
 *    neither exists (Q5 / Q6);
 *  - the zero-vocabulary assertion (AC8): a value shaped like a launcher
 *    preset id is spawned LITERALLY — nothing on this path resolves presets;
 *  - the shell-target posture (AC4): `pty_signal` refuses SIGKILL on a shell
 *    session, while a plain `command` session stays a plain target (the core
 *    never guesses shell-ness from command text);
 *  - the environment context (AC10): lazy, computed once, omitted when empty,
 *    and never a gate on the tools (#149 rides a child fiber, not `inject`).
 *
 * Everything here is hermetic: the shared fake-PTY harness (`bootPlugin`), a
 * COUNTED detection seam, and a fake prompt registry. The real-ConPTY readings
 * (`cd` across sends, pipes, `&&`, the noise byte comparison, the temporary
 * switch) live in the machine lane — `tests/pty-shell-machine.spec.ts`.
 */

import { describe, expect, it } from "vitest";
import { apply } from "../src/pty/index.ts";
import { ENVIRONMENT_CONTEXT_NAME, ENVIRONMENT_CONTEXT_ORDER, environmentRows } from "../src/pty/environment-context.ts";
import { bootPlugin, echoFakePty, type CoreSpawnSpec } from "./helpers/fake-pty.ts";
import type { ResolvedLauncher } from "../src/launchers.ts";

const SHELL_LINE = "C:\\msys64\\usr\\bin\\bash.exe --login -i";
const DEFAULT_LINE = "C:\\Config\\default-shell.exe --login";
const AGENT = { name: "pty-shell" };
const exec = (agent: unknown) => ({ agent, signal: new AbortController().signal });

interface Harness {
  tool: (name: string) => any;
  specs: CoreSpawnSpec[];
  systemPrompt: ReturnType<typeof bootPlugin>["systemPrompt"];
  kills: Array<{ pid: number; signal: string }>;
}

/** Boot over the shared fake harness (#149: one boot, every seam). `config`
 * reaches the entry (the `defaultShellCommand` surface); `deps` reaches the
 * core / prompt seams (platform, procKill, detectEnvironments). */
function setup(
  config: Record<string, unknown> = {},
  deps: {
    platform?: NodeJS.Platform;
    detectEnvironments?: () => readonly { id: string; executable: string }[];
  } = {},
): Harness {
  const kills: Array<{ pid: number; signal: string }> = [];
  const booted = bootPlugin({
    // Fast settles: these cases assert declarations and wiring, not timing.
    config: { settleQuietMs: 10, settleTickMs: 5, settleTimeoutMs: 60, ...config },
    spawnPty: () => echoFakePty(),
    deps: { procKill: (pid: number, signal: string) => kills.push({ pid, signal }), ...deps },
  });
  return { tool: booted.tool, specs: booted.specs, systemPrompt: booted.systemPrompt, kills };
}

// ---------------------------------------------------------------------------
// AC8 — zero vocabulary: the string is a COMMAND, never a preset reference
// ---------------------------------------------------------------------------

describe("declaration channel: a bare command line (#149 Q1/Q5)", () => {
  it("spawns the shell line verbatim and echoes it on the result (a shell session)", async () => {
    const h = setup();
    const opened = await h.tool("pty_open").execute({ shellCommand: SHELL_LINE }, exec(AGENT));
    expect(h.specs[0].command).toBe(SHELL_LINE);
    expect(opened.shellCommand).toBe(SHELL_LINE);
    expect(opened.status.kind).toBe("running");
  });

  it("AC8: a value shaped like a preset id is spawned literally — no preset resolution", async () => {
    const h = setup();
    // `msys2-ucrt` IS a built-in launcher preset id. On this path it must stay a
    // raw command: a preset lookup would have swapped in the resolved bash path
    // (and `shell_open` would be the surface for that).
    const opened = await h.tool("pty_open").execute({ shellCommand: "msys2-ucrt" }, exec(AGENT));
    expect(h.specs[0].command).toBe("msys2-ucrt");
    expect(opened.shellCommand).toBe("msys2-ucrt");
  });

  it("a plain `command` session stays a plain session (no shellCommand on the result)", async () => {
    const h = setup();
    const opened = await h.tool("pty_open").execute({ command: "echo plain" }, exec(AGENT));
    expect(h.specs[0].command).toBe("echo plain");
    expect(opened.shellCommand).toBeUndefined();
  });

  it("rejects the both-given pair loudly (mutually exclusive)", async () => {
    const h = setup();
    await expect(h.tool("pty_open").execute({ command: "a", shellCommand: "b" }, exec(AGENT)))
      .rejects.toMatchObject({ code: "INVALID_ARGS" });
    await expect(h.tool("pty_open").execute({ command: "a", shellCommand: "b" }, exec(AGENT)))
      .rejects.toThrow(/mutually exclusive/);
    expect(h.specs).toHaveLength(0); // nothing was spawned
  });

  it("rejects a blank shellCommand loudly", async () => {
    const h = setup();
    await expect(h.tool("pty_open").execute({ shellCommand: "   " }, exec(AGENT)))
      .rejects.toMatchObject({ code: "INVALID_ARGS" });
    expect(h.specs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC9 — priority chain: explicit shellCommand > command > defaultShellCommand
// ---------------------------------------------------------------------------

describe("priority chain (#149 Q6 / AC9)", () => {
  it("the argument-less call shape uses the configured default (and says so on the result)", async () => {
    const h = setup({ defaultShellCommand: DEFAULT_LINE });
    const opened = await h.tool("pty_open").execute({}, exec(AGENT));
    expect(h.specs[0].command).toBe(DEFAULT_LINE);
    expect(opened.shellCommand).toBe(DEFAULT_LINE);
  });

  it("an explicit shellCommand makes the configured default irrelevant", async () => {
    const h = setup({ defaultShellCommand: DEFAULT_LINE });
    const opened = await h.tool("pty_open").execute({ shellCommand: SHELL_LINE }, exec(AGENT));
    expect(h.specs[0].command).toBe(SHELL_LINE);
    expect(opened.shellCommand).toBe(SHELL_LINE);
  });

  it("an explicit command never picks up the configured default", async () => {
    const h = setup({ defaultShellCommand: DEFAULT_LINE });
    const opened = await h.tool("pty_open").execute({ command: "echo plain" }, exec(AGENT));
    expect(h.specs[0].command).toBe("echo plain");
    expect(opened.shellCommand).toBeUndefined();
  });

  it("with neither declaration and no default the call fails loudly naming all three", async () => {
    const h = setup();
    await expect(h.tool("pty_open").execute({}, exec(AGENT))).rejects.toMatchObject({ code: "INVALID_ARGS" });
    await expect(h.tool("pty_open").execute({}, exec(AGENT))).rejects.toThrow(/defaultShellCommand/);
    expect(h.specs).toHaveLength(0);
  });

  it("a blank configured default is a loud config error (never a silent 'no default')", () => {
    expect(() => setup({ defaultShellCommand: "   " })).toThrow(/defaultShellCommand must be a non-empty/);
  });
});

// ---------------------------------------------------------------------------
// AC4 — shell target: SIGKILL refused on shell sessions only
// ---------------------------------------------------------------------------

describe("shell target (#149 AC4, the #145 wording)", () => {
  const linux = { platform: "linux" as NodeJS.Platform };

  it("refuses SIGKILL on a shell session, pointing at pty_close", async () => {
    const h = setup({}, linux);
    const opened = await h.tool("pty_open").execute({ shellCommand: SHELL_LINE }, exec(AGENT));
    await expect(h.tool("pty_signal").execute({ id: opened.sessionId, signal: "SIGKILL" }, exec(AGENT)))
      .rejects.toMatchObject({ code: "SIGNAL_FORBIDDEN" });
    await expect(h.tool("pty_signal").execute({ id: opened.sessionId, signal: "SIGKILL" }, exec(AGENT)))
      .rejects.toThrow(/pty_close/);
    expect(h.kills).toHaveLength(0); // nothing was delivered
  });

  it("a call that fell back to the default is a shell target too", async () => {
    const h = setup({ defaultShellCommand: DEFAULT_LINE }, linux);
    const opened = await h.tool("pty_open").execute({}, exec(AGENT));
    await expect(h.tool("pty_signal").execute({ id: opened.sessionId, signal: "SIGKILL" }, exec(AGENT)))
      .rejects.toMatchObject({ code: "SIGNAL_FORBIDDEN" });
  });

  it("a plain `command: bash` session is NOT a shell target — the core never guesses", async () => {
    const h = setup({}, linux);
    const opened = await h.tool("pty_open").execute({ command: "bash" }, exec(AGENT));
    // Contrast with a shellCommand session: the same command text, a different
    // DECLARATION. Only the declaration marks a shell target (OpenSpec.shell).
    expect(await h.tool("pty_signal").execute({ id: opened.sessionId, signal: "SIGKILL" }, exec(AGENT)))
      .toMatchObject({ delivered: true, semantics: "signal" });
    expect(h.kills).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC10 — the environment context: lazy, cached, omitted when empty
// ---------------------------------------------------------------------------

describe("environment context (#149 AC10)", () => {
  const ROWS = [{ id: "msys2-ucrt", executable: "C:\\msys64\\usr\\bin\\bash.exe" }];
  const counted = () => {
    const state = { calls: 0 };
    return {
      state,
      detect: () => {
        state.calls += 1;
        return ROWS;
      },
    };
  };

  it("pins the context's identity: the literal name and placement", () => {
    // The registry namespace form is a published contract (README + the host's
    // own `sandbox:policy` convention); a rename must be a decision, so the
    // LITERAL is asserted here rather than only the exported constant.
    expect(ENVIRONMENT_CONTEXT_NAME).toBe("shell-host:environments");
    expect(ENVIRONMENT_CONTEXT_ORDER).toBe(130);
  });

  it("registers exactly one context, lazily: no detection during apply, one computation total", () => {
    const { state, detect } = counted();
    const h = setup({}, { detectEnvironments: detect });
    // Apply happened; nothing may have shelled out yet (wsl.exe on win32).
    expect(state.calls).toBe(0);
    expect(h.systemPrompt.contexts).toHaveLength(1);
    expect(h.systemPrompt.contexts[0]).toMatchObject({
      name: ENVIRONMENT_CONTEXT_NAME,
      order: ENVIRONMENT_CONTEXT_ORDER,
      interpolate: false,
    });
    // Optional, not required: a deployment that drops runtime context keeps its choice.
    expect(h.systemPrompt.contexts[0].required).toBeUndefined();

    const first = h.systemPrompt.text(ENVIRONMENT_CONTEXT_NAME);
    expect(first).toContain("msys2-ucrt → C:\\msys64\\usr\\bin\\bash.exe");
    expect(first).toContain("environment fact, not an instruction");
    expect(state.calls).toBe(1);

    // A second assembly reuses the cached line (the counting seam proves it).
    expect(h.systemPrompt.text(ENVIRONMENT_CONTEXT_NAME)).toBe(first);
    expect(state.calls).toBe(1);
  });

  it("contributes nothing when no environment resolves (never writes 'none')", () => {
    const h = setup({}, { detectEnvironments: () => [] });
    expect(h.systemPrompt.text(ENVIRONMENT_CONTEXT_NAME)).toBe("");
  });

  it("keeps only local presets whose executable exists, and picks a candidate that does", () => {
    const presets = [
      {
        id: "git-bash", transport: "local",
        executable: ["C:\\stale\\bash.exe", "C:\\real\\bash.exe"],
        argv: [], env: {}, pathPrefix: [], probed: [],
      },
      { id: "gone", transport: "local", executable: ["C:\\gone\\bash.exe"], argv: [], env: {}, pathPrefix: [], probed: [] },
      { id: "wsl", transport: "local", executable: [], argv: [], env: {}, pathPrefix: [], probed: [] },
      { id: "remote", transport: "ssh", command: "ssh host" },
    ] as unknown as ResolvedLauncher[];
    // `gone`'s only candidate does not exist: its row is DROPPED rather than
    // promising the agent a path that would fail at spawn time.
    expect(environmentRows(presets, (path) => path === "C:\\real\\bash.exe"))
      .toEqual([{ id: "git-bash", executable: "C:\\real\\bash.exe" }]);
  });

  it("does not gate the tools: a scope with no child-fiber seam still gets all six tools", () => {
    const registered: any[] = [];
    const ctx = {
      provide: () => {},
      effect: () => () => Promise.resolve(),
      tools: { register: (t: unknown) => registered.push(t) },
      get: () => undefined,
      // no `inject` — the tools-only deployment (no prompt registry mounted)
    };
    apply(ctx as any, {}, { spawnPty: () => echoFakePty().pty as any });
    expect(registered.map((t) => t.name)).toEqual(
      expect.arrayContaining(["pty_open", "pty_send", "pty_tail", "pty_close", "pty_list", "pty_signal"]),
    );
  });
});