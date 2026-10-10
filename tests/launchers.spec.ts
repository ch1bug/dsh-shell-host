/**
 * Launcher preset layer (issue #54, ADR-0008): pure-function resolution of
 * the (transport × shell-env) preset table. Tests are the reference
 * implementation again: every probe is injected (exists / env / PATH /
 * distro discovery), so the absent-vs-loud postures are pinned without any
 * real shell installed. ssh rides the transport dimension — the composition
 * is the pty entry's composeSshCommand (single source), asserted here for
 * the keepalive-default / suppression semantics the launcher must inherit.
 * @module tests/launchers
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  builtInLauncherIds,
  resolveLauncher,
  resolveLauncherDetailed,
  resolveLaunchers,
  type CustomLauncherConfig,
  type LauncherDeps,
  type LocalLauncherPreset,
  type ResolvedLauncher,
} from "../src/launchers.ts";
import * as ptyEntry from "../src/pty/index.ts";
import { MSYS2_ROOT_CANDIDATES } from "../src/detect.ts";

/** Narrow a resolution result to a local preset by id (tests only). */
const localPreset = (presets: readonly { id: string; transport: string }[], id: string): LocalLauncherPreset =>
  presets.find((p) => p.id === id && p.transport === "local") as LocalLauncherPreset;

// ---------------------------------------------------------------------------
// Injectable environment fakes — a machine with everything installed.
// ---------------------------------------------------------------------------

const MSYS_ROOT = "C:\\msys64";
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const SYSTEM_ROOT = "C:\\Windows";
const CMD = join(SYSTEM_ROOT, "System32", "cmd.exe");
const PYTHON_DIR = "C:\\Python312";
const WSL_DISTROS = ["Ubuntu-22.04", "Debian"];

const FULL_ENV = {
  SystemRoot: SYSTEM_ROOT,
  ProgramFiles: "C:\\Program Files",
  PATH: `${PYTHON_DIR};C:\\Windows\\System32`,
} as NodeJS.ProcessEnv;

function existsEverything(candidate: string): boolean {
  const known = [
    join(MSYS_ROOT, "usr", "bin", "bash.exe"),
    GIT_BASH,
    PWSH,
    CMD,
    join(PYTHON_DIR, "python.exe"),
    join(SYSTEM_ROOT, "System32", "wsl.exe"),
    join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ];
  return known.some((k) => k.toLowerCase() === candidate.toLowerCase());
}

function fullDeps() {
  return {
    exists: existsEverything,
    env: FULL_ENV,
    path: FULL_ENV.PATH,
    listDistros: () => WSL_DISTROS,
  };
}

const existsNothing = () => false;
// The bare-minimum machine: only cmd (SystemRoot) resolves.
const existsCmdOnly = (candidate: string) => candidate.toLowerCase() === CMD.toLowerCase();
const noShellDeps = { exists: existsCmdOnly, env: { SystemRoot: SYSTEM_ROOT } as NodeJS.ProcessEnv, path: "", listDistros: () => [] as string[] };

// ---------------------------------------------------------------------------
// AC 1 — resolution covers the issue's preset set
// ---------------------------------------------------------------------------

describe("resolveLaunchers (#54 preset set)", () => {
  it("covers msys2 ×3 subsystems, git-bash, pwsh, powershell, wsl distros, cmd, python-repl", () => {
    const { presets, absent } = resolveLaunchers(fullDeps());
    const ids = presets.map((p) => p.id);
    expect(ids).toContain("msys2-ucrt");
    expect(ids).toContain("msys2-mingw64");
    expect(ids).toContain("msys2-msys");
    expect(ids).toContain("git-bash");
    expect(ids).toContain("pwsh");
    expect(ids).toContain("powershell");
    // One wsl preset per discovered distro (two here), first is the plain `wsl`.
    expect(ids).toContain("wsl");
    expect(ids).toContain("wsl-Debian");
    expect(ids).toContain("cmd");
    expect(ids).toContain("python-repl");
    expect(absent).toEqual([]);
    // ssh is a transport dimension, not a preset.
    expect(ids).not.toContain("ssh");
  });

  it("injects MSYSTEM per msys2 preset and CHERE_INVOKING (VS Code MSYS2 profile env)", () => {
    const { presets } = resolveLaunchers(fullDeps());
    const msystem = (id: string) => localPreset(presets, id).env.MSYSTEM;
    expect(msystem("msys2-ucrt")).toBe("UCRT64");
    expect(msystem("msys2-mingw64")).toBe("MINGW64");
    expect(msystem("msys2-msys")).toBe("MSYS");
    for (const id of ["msys2-ucrt", "msys2-mingw64", "msys2-msys"]) {
      const p = localPreset(presets, id);
      expect(p.env.CHERE_INVOKING).toBe("1");
      expect(p.executable).toContain(join(MSYS_ROOT, "usr", "bin", "bash.exe"));
      expect(p.pathPrefix.some((entry) => entry.includes("usr\\bin"))).toBe(true);
    }
  });

  it("wsl presets pin the discovered distro into the argv (no silent default switch)", () => {
    const { presets } = resolveLaunchers(fullDeps());
    const wsl = localPreset(presets, "wsl");
    expect(wsl.argv.join(" ")).toContain("-d Ubuntu-22.04");
    expect(wsl.argv.join(" ")).toContain("--login");
    const debian = localPreset(presets, "wsl-Debian");
    expect(debian.argv.join(" ")).toContain("-d Debian");
    expect(debian.executable).toContain(join(SYSTEM_ROOT, "System32", "wsl.exe"));
  });

  it("descriptor reuse: interactive argv templates come from the descriptor layer, not a second table", async () => {
    const { MSYS2_INTERACTIVE_ARGV, PWSH_INTERACTIVE_ARGV } = await import("../src/backends.ts");
    const { presets } = resolveLaunchers(fullDeps());
    const msys = localPreset(presets, "msys2-ucrt");
    expect(msys.argv).toEqual([...MSYS2_INTERACTIVE_ARGV]);
    const pwsh = localPreset(presets, "pwsh");
    expect(pwsh.argv).toEqual([...PWSH_INTERACTIVE_ARGV]);
    // powershell 5.1 is a pure-data row: `-Login` is pwsh ≥7.4 only (D7).
    const powershell = localPreset(presets, "powershell");
    expect(powershell.argv).toEqual(["-NoExit"]);
  });
});

// ---------------------------------------------------------------------------
// AC 5 — absent vs loud postures
// ---------------------------------------------------------------------------

describe("absent / loud postures (#54)", () => {
  it("missing environments are absent from the resolution (not errors), naming the probe points", () => {
    const { presets, absent } = resolveLaunchers(noShellDeps);
    const ids = presets.map((p) => p.id);
    expect(ids).not.toContain("msys2-ucrt");
    expect(ids).not.toContain("pwsh");
    expect(ids).not.toContain("wsl");
    expect(ids).not.toContain("python-repl");
    const msysAbsent = absent.find((a) => a.id === "msys2-ucrt")!;
    expect(msysAbsent.probed).toEqual(MSYS2_ROOT_CANDIDATES.map((root) => join(root, "usr", "bin", "bash.exe")));
    // cmd needs only the SystemRoot — still present.
    expect(ids).toContain("cmd");
  });

  it("selecting an absent preset fails loudly naming every probe point", () => {
    expect(() => resolveLauncher("msys2-ucrt", noShellDeps)).toThrow(/Probed:/);
    expect(() => resolveLauncher("msys2-ucrt", noShellDeps)).toThrow(
      new RegExp(MSYS2_ROOT_CANDIDATES.map((root) => join(root, "usr", "bin", "bash.exe")).join(", ").replace(/\\/g, "\\\\")),
    );
  });

  it("selecting an unknown id fails loudly naming the id and the resolved preset ids", () => {
    const { presets } = resolveLaunchers(fullDeps());
    expect(() => resolveLauncher("no-such-shell", fullDeps())).toThrow(/no-such-shell/);
    try {
      resolveLauncher("no-such-shell", fullDeps());
    } catch (e: any) {
      for (const id of presets.map((p) => p.id)) expect(e.message).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// AC 3 — custom presets: config shape + merge
// ---------------------------------------------------------------------------

describe("custom presets (#54 config shape)", () => {
  const customLocal = {
    id: "my-shell",
    transport: "local" as const,
    executable: ["C:\\tools\\mysh.exe"],
    argv: ["--interactive"],
    env: { MYVAR: "1" },
    pathPrefix: ["C:\\tools"],
    cwd: "C:\\work",
  };

  it("a custom local preset merges into the resolution with its declared fields", () => {
    const { presets, absent } = resolveLaunchers(fullDeps(), [customLocal]);
    const mine = localPreset(presets, "my-shell");
    expect(mine.transport).toBe("local");
    expect(mine.executable).toEqual(["C:\\tools\\mysh.exe"]);
    expect(mine.argv).toEqual(["--interactive"]);
    expect(mine.env).toEqual({ MYVAR: "1" });
    expect(mine.cwd).toBe("C:\\work");
    expect(absent.map((a) => a.id)).not.toContain("my-shell");
  });

  it("a custom preset with a built-in id overrides the built-in view; `base` references one", () => {
    const override = { ...customLocal, id: "cmd" };
    const { presets } = resolveLaunchers(fullDeps(), [override]);
    const cmd = localPreset(presets, "cmd");
    expect(cmd.executable).toEqual(["C:\\tools\\mysh.exe"]);

    // base reference: inherit a resolved built-in view, overlay fields.
    const derived = { id: "msys2-ucrt-dev", transport: "local" as const, base: "msys2-ucrt", env: { EXTRA: "x" } };
    const r2 = resolveLaunchers(fullDeps(), [derived]);
    const dev = localPreset(r2.presets, "msys2-ucrt-dev");
    expect(dev.executable).toContain(join(MSYS_ROOT, "usr", "bin", "bash.exe"));
    expect(dev.env.MSYSTEM).toBe("UCRT64");
    expect(dev.env.EXTRA).toBe("x");
  });

  it("an unusable custom local preset (no executable) is loudly rejected", () => {
    expect(() => resolveLaunchers(fullDeps(), [{ id: "broken", transport: "local" }])).toThrow(/executable/);
  });
});

// ---------------------------------------------------------------------------
// AC 4 — ssh transport dimension reuses the ssh composition
// ---------------------------------------------------------------------------

describe("ssh transport dimension (#54, ADR-0008 decision 1)", () => {
  // The composition itself is single-sourced in the pty entry and pinned by
  // ssh-pty.spec.ts; here the launcher layer only proves it inherits it.
  const { composeSshCommand, SSH_KEEPALIVE_INTERVAL_DEFAULT, SSH_KEEPALIVE_COUNT_DEFAULT } = ptyEntry;

  it("composes host + remote shell over the shared ssh composition (keepalive defaults ride)", () => {
    const launch = composeSshCommand({ host: "example.com", shell: "bash --login" });
    expect(launch).toContain("-tt");
    expect(launch).toContain(`-o ${SSH_KEEPALIVE_INTERVAL_DEFAULT}`);
    expect(launch).toContain(`-o ${SSH_KEEPALIVE_COUNT_DEFAULT}`);
    expect(launch.trim().endsWith("example.com bash --login")).toBe(true);
  });

  it("keepalive defaults stay suppressible via options; jump/port/options pass through", () => {
    const suppressed = composeSshCommand({
      host: "h",
      options: [{ key: "ServerAliveInterval", value: "5" }],
    });
    expect(suppressed).not.toContain(SSH_KEEPALIVE_INTERVAL_DEFAULT);
    expect(suppressed).toContain(SSH_KEEPALIVE_COUNT_DEFAULT);
    expect(suppressed).toContain("ServerAliveInterval=5");

    const full = composeSshCommand({ host: "h", jump: "bastion", port: 2222 });
    expect(full).toContain("-J bastion");
    expect(full).toContain("-p 2222");
  });

  it("a custom ssh preset resolves to the composed command", () => {
    const customSsh = { id: "prod-box", transport: "ssh" as const, host: "prod.example.com", shell: "zsh" };
    const { presets } = resolveLaunchers(fullDeps(), [customSsh]);
    const prod = presets.find((p): p is Extract<ResolvedLauncher, { transport: "ssh" }> => p.id === "prod-box")!;
    expect(prod.transport).toBe("ssh");
    expect(prod.command).toContain("ssh -tt");
    expect(prod.command).toContain("prod.example.com zsh");
  });
});

// ---------------------------------------------------------------------------
// #68 — POSIX launcher preset rows: zsh / bash / fish
// ---------------------------------------------------------------------------

const POSIX_ETC_SHELLS = [
  "/bin/sh",
  "/bin/bash",
  "/usr/bin/bash",
  "/bin/zsh",
  "/usr/bin/fish",
  "/opt/homebrew/bin/fish", // a user-appended Homebrew line rides the same file (#26 fact)
].join("\n");

function posixDeps(overrides: Partial<LauncherDeps> = {}): LauncherDeps {
  return Object.assign(
    {
      exists: (candidate: string) => !candidate.includes("homebrew") && !candidate.includes("fish"),
      env: {} as NodeJS.ProcessEnv,
      readEtcShells: () => POSIX_ETC_SHELLS,
      userInfoShell: () => "/usr/bin/zsh",
      listDistros: () => [] as string[],
      platform: "linux" as NodeJS.Platform,
    },
    overrides,
  );
}

describe("POSIX preset rows (#68)", () => {
  it("resolves zsh/bash/fish rows on POSIX from /etc/shells lines (exists-filtered, order preserved)", () => {
    const { presets, absent } = resolveLaunchers(posixDeps());
    const ids = presets.map((p) => p.id);
    expect(ids).toContain("zsh");
    expect(ids).toContain("bash");
    // fish is in /etc/shells but not on disk → ABSENT, not resolved.
    expect(ids).not.toContain("fish");
    const fish = absent.find((a) => a.id === "fish")!;
    expect(fish.probed).toEqual(["/usr/bin/fish", "/opt/homebrew/bin/fish"]);

    const bash = localPreset(presets, "bash");
    expect(bash.transport).toBe("local");
    expect(bash.executable).toEqual(["/bin/bash", "/usr/bin/bash"]);
    // Linux shells carry no login flags (posixInteractiveArgv single source).
    expect(bash.argv).toEqual([]);
  });

  it("prepend the detected passwd shell when it matches the row name (detectPosixShell consumed, not a second table)", async () => {
    // /usr/bin/zsh is the passwd shell but NOT in /etc/shells → still a candidate.
    const { presets } = resolveLaunchers(posixDeps({ readEtcShells: () => "/bin/bash\n", platform: "linux" }));
    const zsh = localPreset(presets, "zsh");
    expect(zsh.executable).toEqual(["/usr/bin/zsh"]);
    const { posixInteractiveArgv } = await import("../src/detect.ts");
    expect(zsh.argv).toEqual([...posixInteractiveArgv("/usr/bin/zsh", "linux")]);
  });

  it("macOS login flags ride the single source: darwin zsh gets -l, bash gets --login", async () => {
    const { presets } = resolveLaunchers(posixDeps({ platform: "darwin" }));
    const { posixInteractiveArgv } = await import("../src/detect.ts");
    const zsh = localPreset(presets, "zsh");
    expect(zsh.argv).toEqual([...posixInteractiveArgv(zsh.executable[0]!, "darwin")]);
    expect(zsh.argv).toEqual(["-l"]);
    expect(localPreset(presets, "bash").argv).toEqual(["--login"]);
  });

  it("rows with no probe hit at all are absent with an empty probed list (posture, never loud)", () => {
    const { presets, absent } = resolveLaunchers(posixDeps({ readEtcShells: () => undefined, userInfoShell: () => undefined, platform: "linux" }));
    expect(presets.map((p) => p.id)).not.toContain("zsh");
    expect(absent.find((a) => a.id === "zsh")).toBeDefined();
    expect(absent.find((a) => a.id === "zsh")!.probed).toEqual([]);
  });

  it("win32 keeps the POSIX rows dormant: no ids, not even absent entries", () => {
    const { presets, absent } = resolveLaunchers(posixDeps({ platform: "win32" }));
    for (const r of [...presets, ...absent]) {
      expect(["zsh", "bash", "fish"]).not.toContain(r.id);
    }
  });

  it("builtInLauncherIds enumerates the POSIX rows on POSIX, not on win32", () => {
    const linuxIds = builtInLauncherIds(posixDeps());
    expect(linuxIds).toContain("zsh");
    expect(linuxIds).toContain("bash");
    expect(linuxIds).toContain("fish");
    const win32Ids = builtInLauncherIds(posixDeps({ platform: "win32" }));
    expect(win32Ids).not.toContain("zsh");
    expect(win32Ids).not.toContain("fish");
  });

  it("the loud unknown-id / absent postures cover the POSIX rows", () => {
    expect(() => resolveLauncher("fish", posixDeps())).toThrow(/Probed: .*fish/);
    expect(() => resolveLauncher("zsh", posixDeps())).not.toThrow();
  });
});

describe("resolveLauncherDetailed (#56 source/overrode)", () => {
  it("a built-in view reports source builtin, overrode false", () => {
    const detail = resolveLauncherDetailed("pwsh", fullDeps());
    expect(detail.source).toBe("builtin");
    expect(detail.overrode).toBe(false);
    expect(detail.launcher.id).toBe("pwsh");
  });

  it("a custom id over a built-in view reports source custom + overrode true", () => {
    const custom: CustomLauncherConfig[] = [
      { id: "pwsh", transport: "local", executable: ["X:\\pwsh.exe"], argv: [] },
    ];
    const detail = resolveLauncherDetailed("pwsh", fullDeps(), custom);
    expect(detail.source).toBe("custom");
    expect(detail.overrode).toBe(true);
  });

  it("a custom-only id reports source custom + overrode false (nothing was overridden)", () => {
    const custom: CustomLauncherConfig[] = [
      { id: "dev", transport: "local", executable: ["X:\\pwsh.exe"], argv: [] },
    ];
    const detail = resolveLauncherDetailed("dev", fullDeps(), custom);
    expect(detail.source).toBe("custom");
    expect(detail.overrode).toBe(false);
  });

  it("a custom id shadowing an ABSENT built-in is NOT an override (no built-in view existed)", () => {
    const custom: CustomLauncherConfig[] = [
      { id: "msys2-ucrt", transport: "local", executable: ["X:\\bash.exe"], argv: [] },
    ];
    const detail = resolveLauncherDetailed("msys2-ucrt", noShellDeps, custom);
    expect(detail.source).toBe("custom");
    expect(detail.overrode).toBe(false);
  });

  it("loud postures are inherited: unknown id and absent built-in throw exactly as resolveLauncher", () => {
    expect(() => resolveLauncherDetailed("no-such-shell", fullDeps())).toThrow(/unknown preset/);
    expect(() => resolveLauncherDetailed("pwsh", { exists: () => false, env: FULL_ENV, path: "", listDistros: () => [] }))
      .toThrow(/not serviceable/);
  });
});
