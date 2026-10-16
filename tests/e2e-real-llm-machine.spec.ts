/**
 * Real-LLM tier (opt-in) for this bundle's end-to-end tool chain.
 *
 * WHY THIS TIER EXISTS (evidence boundary — see docs/agents/TESTING.md):
 * the mock tier (`e2e-tool-call-machine.spec.ts`) proves THIS side up to the
 * wire: real composition, real session, real request bytes, real tool
 * execution. It CANNOT prove:
 *   1. whether the real endpoint accepts the request (auth, model name,
 *      system-prompt size limits, field compatibility, streaming shape);
 *   2. whether a real model actually issues the tool call (injection reach);
 *   3. the real credential path at all (the mock tier sends a fake key).
 * This file covers those three: it runs the real endpoint, reads the real
 * model's reply, and confirms in the session log that the model REALLY issued
 * a tool call and the instance REALLY executed it.
 *
 * GATES (loud skip, never a silent pass — unset gates print why):
 *   DSH_E2E_NODE / DSH_E2E_PLUGIN_DIR / DSH_E2E_HOST_DIR  (as in the mock tier)
 *   credentials, one of:
 *     a) DEEPSEEK_API_KEY                     — a real key, passed via env ONLY,
 *                                               never written to disk;
 *     b) DSH_E2E_REAL_CREDENTIALS_SOURCE      — path to a credentials.yaml that
 *        holds `deepseek-account-platform/*` records (account-device route, no
 *        raw key). This suite READS ONLY those records into a temp home that is
 *        deleted afterwards. Defaults to the desktop home when it has them.
 *   optional: DSH_E2E_REAL_MODEL   — pin the model id
 *             DSH_E2E_REAL_PROMPT  — override the task text
 *
 * TOOL CHOICE: the task asks for `pty_open` on purpose. It sits behind no
 * approval gate, so this tier proves provider acceptance + real model
 * behaviour + a real tool execution without entering the approval/sandbox path
 * that `shell_open` would take (that path is a separate concern).
 *
 * Isolation: temp DSH_HOME under os.tmpdir() + `--port 0`, so no fixed dev port
 * (19387 / 19501 / 19502) is ever occupied.
 *
 * @module tests/e2e-real-llm-machine
 */

import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NODE = process.env.DSH_E2E_NODE ?? "C:/Program Files/nodejs/node.exe";
const PLUGIN_DIR = process.env.DSH_E2E_PLUGIN_DIR ?? "C:/msys64/home/<user>/dsh-shellhost-src";
const HOST_DIR = process.env.DSH_E2E_HOST_DIR ?? "C:/msys64/home/<user>/dsh-host-src";
const PROFILE = "dsh-host-real";
const PROFILE_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-shell-host"];

/** Account-device credentials source (read-only). Only the account records are
 * copied, into a temp home that is removed when the suite ends. */
const ACCOUNT_SOURCE = process.env.DSH_E2E_REAL_CREDENTIALS_SOURCE ?? "C:/Users/<user>/.dsh/.credentials.yaml";
const ACCOUNT_PREFIX = "deepseek-account-platform/";

const API_KEY = process.env.DEEPSEEK_API_KEY;
const hasKey = typeof API_KEY === "string" && API_KEY.trim() !== "";

const TASK =
  process.env.DSH_E2E_REAL_PROMPT ??
  "Call the pty_open tool exactly once with command `cmd.exe /c echo real-ok`, then reply with the single word: done.";

/** Raw account-record block re-emitted verbatim (never parsed field-by-field,
 * so nothing secret is logged or reshaped). */
function accountRecordsBlock(text: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "records:");
  if (start === -1) return null;
  const out: string[] = [];
  let capturing = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.length > 0 && !/^\s/u.test(line)) break;
    const topEntry = /^ {2}(\S.*):$/u.exec(line);
    if (topEntry !== null) capturing = topEntry[1]!.trim().startsWith(ACCOUNT_PREFIX);
    if (capturing) out.push(line);
  }
  return out.length > 0 ? out.join("\n") : null;
}

const accountBlock = hasKey ? null : await readFile(ACCOUNT_SOURCE, "utf8").then(accountRecordsBlock).catch(() => null);
const usesAccount = !hasKey && accountBlock !== null;

function missingEnvironment(): string[] {
  return [
    !existsSync(PLUGIN_DIR) ? `plugin tree ${PLUGIN_DIR}` : null,
    !existsSync(join(PLUGIN_DIR, "lib/pty/index.js")) ? `built artifact ${PLUGIN_DIR}/lib/pty/index.js` : null,
    !existsSync(join(HOST_DIR, "apps/cli/src/bin.ts")) ? `DSH host tree ${HOST_DIR}` : null,
    !existsSync(NODE) ? `node executable ${NODE}` : null,
    !hasKey && !usesAccount
      ? `credentials: DEEPSEEK_API_KEY or a source with ${ACCOUNT_PREFIX}* (tried ${ACCOUNT_SOURCE})`
      : null,
  ].filter((v): v is string => v !== null);
}

const absent = missingEnvironment();
const skipReason = `real-LLM tier needs: ${absent.join(" / ")} — provider acceptance and real-model behaviour stay UNVERIFIED without it`;

interface SessionEvent {
  readonly type?: string;
  readonly data?: any;
  readonly [k: string]: unknown;
}

/** Every durable session event, read through the HOST's own history RPC.
 *
 * NOT read from `session.v4.jsonl.zstd`: the store flushes events in batches,
 * so a finished turn can still leave a header-only file — reading that file is
 * how a successful run gets misreported as "the turn never started" (observed
 * independently in the adjacent workspace, and here).
 *
 * `session/page` requires `throughSeq`, and it must not exceed the session's
 * own cursor: a larger value fails with
 * "session page through seq N is past cursor M". The cursor comes from
 * `session/list`'s `asOfSeq` — the projections snapshot the host publishes.
 */
async function readDurableEvents(port: number, cookie: string, sessionId: string): Promise<SessionEvent[]> {
  const list = await rpcZeroArg(port, cookie, "session/list").catch(() => null);
  const item = (list?.items ?? []).find((i: any) => i?.sessionId === sessionId);
  const cursor: number | undefined = item?.projections?.asOfSeq;
  if (typeof cursor !== "number" || cursor <= 0) return [];

  const address = { kind: "session", sessionId };
  const page = await rpc(
    port,
    cookie,
    "session/page",
    { address, throughSeq: cursor, maxMessages: 200 },
    "request",
  ).catch(() => null);
  const records: any[] = Array.isArray(page?.records) ? page.records : [];
  // Records may be wrapped ({ type: 'event', event: {...} }) or already bare.
  return records.map((record) => {
    const event = record?.event ?? record;
    return { ...(event as object), type: event?.type ?? record?.type, data: event?.data ?? event } as SessionEvent;
  });
}

/** One typert Remote envelope.
 *
 * The gateway validates argument NAMES against each method's descriptor, and
 * the naming differs per method — this tripped a real run:
 *   - method with a `request` parameter → { request: value }
 *   - zero-argument method               → { _request: {} }
 *   - some zero-argument methods         → {} (plain empty args)
 * Verified against the RC host: `session/list` wants `_request`, while
 * `session/modelCatalog` REJECTS `_request` ("unexpected _request") and wants
 * plain `{}`. Callers therefore pass the envelope explicitly via `argShape`.
 */
type ArgShape = "request" | "named" | "none";

function rpc(port: number, cookie: string, method: string, args: unknown, argShape: ArgShape = "request") {
  const wrapped = argShape === "request" ? { request: args } : argShape === "named" ? { _request: {} } : {};
  const body = JSON.stringify({ type: "client-request", rpcId: `real-${method}`, method, payload: { args: wrapped } });
  return fetch(`http://127.0.0.1:${port}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body,
  }).then(async (res) => {
    if (!res.ok) throw new Error(`${method} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const parsed = (await res.json()) as any;
    if (parsed?.result?.ok !== true) throw new Error(`${method}: ${JSON.stringify(parsed?.result?.error ?? parsed).slice(0, 300)}`);
    return parsed.result.value as any;
  });
}

/** Try the argument shapes a zero-arg session method might want, in the order
 * the RC host is known to use, so a descriptor mismatch self-corrects instead
 * of failing the run on envelope trivia. */
async function rpcZeroArg(port: number, cookie: string, method: string) {
  const shapes: ArgShape[] = ["none", "named"];
  let lastError: unknown = null;
  for (const shape of shapes) {
    try {
      return await rpc(port, cookie, method, undefined, shape);
    } catch (error) {
      lastError = error;
      if (!/arguments-invalid/u.test(String(error))) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

describe.skipIf(absent.length > 0)("e2e REAL LLM tier: provider acceptance + real model behaviour", () => {
  it("runs a real turn whose tool call the instance really executes", { timeout: 300_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-shellhost-real-"));
    const dshHome = join(root, ".dsh");
    const profileDir = join(dshHome, "profiles", PROFILE);
    await mkdir(profileDir, { recursive: true });

    await writeFile(
      join(profileDir, "package.json"),
      JSON.stringify(
        {
          name: `dsh-profile-${PROFILE}`,
          private: true,
          dependencies: { "dsh-shell-host": `link:${PLUGIN_DIR}` },
          dsh: { profile: { bundles: PROFILE_BUNDLES } },
        },
        null,
        2,
      ),
    );
    await writeFile(join(profileDir, "cordis.yml"), "[]\n");
    await writeFile(join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");
    await writeFile(join(profileDir, "cordis.patch.yml"), "[]\n");
    const linkPath = join(profileDir, "node_modules", "dsh-shell-host");
    await mkdir(join(profileDir, "node_modules"), { recursive: true });
    try { await symlink(PLUGIN_DIR, linkPath, "junction"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    // Credentials: account route copies ONLY the account records, into a home
    // that is deleted with the temp root. The key route writes nothing at all.
    if (usesAccount) {
      const original = await readFile(ACCOUNT_SOURCE, "utf8");
      const versionLine = original.split("\n").find((l) => l.startsWith("version:")) ?? "version: 1";
      await writeFile(join(dshHome, ".credentials.yaml"), `${versionLine}\nrecords:\n${accountBlock}\n`, "utf8");
    }

    const instance: ChildProcess = spawn(
      NODE,
      ["--import", "tsx/esm", "apps/cli/src/bin.ts", "--profile", PROFILE, "--no-open", "--port", "0"],
      {
        cwd: HOST_DIR,
        env: {
          ...process.env,
          DSH_HOME: dshHome,
          DSH_TELEMETRY_DISABLED: "1",
          ...(hasKey ? { DEEPSEEK_API_KEY: API_KEY } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let instOut = "";
    let instErr = "";
    instance.stdout?.on("data", (c: Buffer) => { instOut += c.toString(); });
    instance.stderr?.on("data", (c: Buffer) => { instErr += c.toString(); });

    try {
      const launch = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error(`instance not ready in 120s: ${instErr.slice(-400)}`)); }, 120_000);
        instance.stdout?.on("data", () => {
          const match = /dsh web: (http:\/\/\S+)/u.exec(instOut);
          if (match?.[1] !== undefined) { clearTimeout(timer); resolve(match[1]); }
        });
        instance.once("exit", (code) => { clearTimeout(timer); reject(new Error(`instance exited ${String(code)}: ${instErr.slice(-400)}`)); });
      });

      expect(instErr.trim(), "instance stderr is clean at startup").toBe("");

      // ── auth exchange ────────────────────────────────────────────────────
      const exchange = await fetch(launch, { redirect: "manual" });
      const setCookie = exchange.headers.get("set-cookie");
      expect(exchange.status, "token exchange redirects").toBe(303);
      expect(setCookie, "exchange issues a cookie").toBeTruthy();
      const cookie = setCookie!.split(";", 1)[0]!;
      const port = Number(new URL(launch).port);

      // ── real session ─────────────────────────────────────────────────────
      const created = await rpc(port, cookie, "session/create", { cwd: PLUGIN_DIR });
      expect(created?.sessionId, "real session created").toBeTruthy();

      // MODEL ROUTE BEFORE THE PROMPT — order matters, and so does WHICH route.
      //
      // Observed failure shape when the route is merely "routable": the turn
      // runs, `turn/end` is recorded, stderr stays EMPTY, and the only trace is
      //   assistant/attempt → finish → { code: "MISSING_CREDENTIAL" }
      // with `usage = 0`. The route must match the credential we actually have:
      //   - account-device records  → `deepseek-account`
      //   - DEEPSEEK_API_KEY        → `deepseek-official`
      // Picking the catalog `default` (deepseek-official) while holding only
      // account records produces exactly that silent failure.
      const catalog = await rpcZeroArg(port, cookie, "session/modelCatalog");
      const groups: any[] = Array.isArray(catalog?.groups) ? catalog.groups : [];
      const routable: string[] = Array.isArray(catalog?.routableProviders) ? catalog.routableProviders : [];
      const pinnedProvider = process.env.DSH_E2E_REAL_PROVIDER;
      const pinnedModel = process.env.DSH_E2E_REAL_MODEL;
      const defaultSelection = catalog?.default;

      /** Credential-aware preference: the provider this suite can actually pay
       * with, falling back to the catalog default only when nothing matches. */
      const preferredProviders = usesAccount
        ? ["deepseek-account", "deepseek-official"]
        : ["deepseek-official", "deepseek-account"];
      const modelsOf = (id: string): any[] => (groups.find((g) => g?.id === id)?.models ?? []) as any[];
      const orderedGroups = [
        ...preferredProviders.filter((p) => modelsOf(p).length > 0).map((p) => ({ id: p, models: modelsOf(p) })),
        ...groups.filter((g) => !preferredProviders.includes(g?.id)),
      ];
      const pick =
        pinnedModel !== undefined
          ? { provider: pinnedProvider ?? orderedGroups[0]?.id, model: pinnedModel }
          : (() => {
              const first = orderedGroups.flatMap((g) => (g.models ?? []).map((m: any) => ({ provider: g.id, model: m.id })))[0];
              if (first !== undefined) return first;
              return defaultSelection?.provider !== undefined && defaultSelection?.model !== undefined
                ? { provider: defaultSelection.provider, model: defaultSelection.model }
                : undefined;
            })();
      expect(
        pick?.provider && pick?.model,
        `a model matching the available credential is routable (providers: ${routable.join(",") || "none"} | credential: ${usesAccount ? "account-device" : "api-key"})`,
      ).toBeTruthy();
      // Guard the silent-failure pairing explicitly: account credentials must
      // never be spent on the api-key-only route.
      if (usesAccount && pinnedProvider === undefined) {
        expect(pick.provider, "account credentials select the account route, not the api-key route").toBe("deepseek-account");
      }

      const selected = await rpc(port, cookie, "session/selectModel", {
        sessionId: created.sessionId,
        provider: pick.provider,
        model: pick.model,
      });
      expect(selected?.selected?.model, "the session accepted the model selection").toBeTruthy();

      await rpc(port, cookie, "session/prompt", {
        requestId: `real-${Date.now()}`,
        sessionId: created.sessionId,
        mode: "queue",
        content: [{ type: "text", text: TASK }],
        clientTimeZone: "Asia/Shanghai",
      });

      // Settling is judged by TOKEN USAGE — the billed-round-trip signal.
      //
      // Not `llmMs`/`toolMs`: observed on this host, a completed real turn can
      // still report llmMs=0/toolMs=0 (waiting on them hangs to the deadline).
      // Not `modelSelection.lastUsed` either: the route is consumed the moment
      // the request starts, so it flips true BEFORE the turn finishes — breaking
      // out on it reads a response that does not exist yet (a false red).
      const deadline = Date.now() + 180_000;
      let lastStats: any = null;
      let lastTurn: any = null;
      let lastValues: any = null;
      const usageOf = (values: any) =>
        (values?.tokenUsage?.uncachedInputTokens ?? 0) +
        (values?.tokenUsage?.cacheReadTokens ?? 0) +
        (values?.tokenUsage?.outputTokens ?? 0);
      while (Date.now() < deadline) {
        const list = await rpcZeroArg(port, cookie, "session/list").catch(() => null);
        const item = (list?.items ?? []).find((i: any) => i?.sessionId === created.sessionId);
        lastValues = item?.projections?.values ?? lastValues;
        lastTurn = lastValues?.turnOutline?.[0] ?? lastTurn;
        lastStats = lastValues?.sessionStats ?? lastStats;
        // Done when the provider billed usage AND the turn is no longer running.
        if (item?.running === false && usageOf(lastValues) > 0) break;
        await new Promise((r) => { setTimeout(r, 1500); });
      }

      // The durable history through the host's own RPC — the authoritative
      // record of what the model asked for and whether the instance ran it.
      const events = await readDurableEvents(port, cookie, created.sessionId);
      const types = events.map((e) => e.type).filter(Boolean).join(",");
      const usage = usageOf(lastValues);

      // A credential failure is recorded ONLY inside the attempt event — the
      // instance exits clean, stderr stays empty, and turn/end still appears.
      // Surface it explicitly so this tier can never read it as success.
      const attemptErrors = events
        .filter((e) => e.type === "assistant/attempt")
        .flatMap((e) => {
          const stream: any[] = Array.isArray((e.data as any)?.stream) ? (e.data as any).stream : [];
          return stream
            .map((frame) => frame?.chunk?.reason?.failure)
            .filter((failure) => failure !== undefined && failure !== null);
        });
      expect(
        attemptErrors,
        `the model attempt reported no failure (failures: ${JSON.stringify(attemptErrors).slice(0, 400)})`,
      ).toEqual([]);

      // The REAL provider accepted the request: usage was BILLED. `turns:1, steps:1,
      // llmMs:0, stderr empty` is the silent-failure shape and must not pass.
      expect(lastStats, "the session reports stats after the turn").toBeTruthy();
      expect(
        usage > 0,
        `the REAL provider billed a round trip (usage=${String(usage)} route=${pick.provider}/${pick.model} lastUsed=${JSON.stringify(lastValues?.modelSelection?.lastUsed ?? null)} stats=${JSON.stringify(lastStats)} events=${types} stderr=${instErr.slice(-400) || "(empty)"})`,
      ).toBe(true);
      expect(String(lastTurn?.response ?? "").trim(), "the REAL model produced a response").not.toBe("");

      // ── the real model ISSUED a tool call (injection reach) ──────────────
      const callEvents = events.filter((e) => e.type === "tool/call");
      const callNames = callEvents.map((e) => e.data?.name ?? e.data?.toolName).filter(Boolean);

      // ── the live instance EXECUTED it ────────────────────────────────────
      const resultEvents = events.filter((e) => e.type === "tool/result" || e.type === "tool/call/result");
      // `toolMs` is NOT a reliable signal here (a completed tool step can report
      // 0 on this host), so execution is established from the durable record.
      expect(
        resultEvents.length > 0 || (lastStats?.toolMs ?? 0) > 0,
        `the instance EXECUTED a tool call (results=${resultEvents.length} toolMs=${String(lastStats?.toolMs)} names=${callNames.join(",") || "none"} events=${types})`,
      ).toBe(true);
    } finally {
      const exited = new Promise<void>((resolve) => { instance.once("exit", () => { resolve(); }); });
      instance.kill("SIGTERM");
      const forced = setTimeout(() => { instance.kill("SIGKILL"); }, 10_000);
      await exited;
      clearTimeout(forced);
      await rm(root, { recursive: true, force: true });
    }
  });
});

afterAll(() => {
  if (absent.length > 0) console.warn(`  !! SKIP (loud) — ${skipReason}`);
});