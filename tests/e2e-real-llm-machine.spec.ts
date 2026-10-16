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
 *   DSH_E2E_NODE / DSH_E2E_PLUGIN_DIR / DSH_E2E_HOST_DIR / DSH_E2E_PNPM_DIR
 *     (as in the mock tier; DSH_E2E_PNPM_DIR must hold a pnpm shim because
 *      `dsh plugin add` shells out to pnpm)
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
 * OWNERSHIP OF THE TEMP TREE (#97): the whole body — temp tree creation, the
 * official install, the credential copy, the spawn — sits inside ONE `try`, and
 * two `Z cleanup` rings report whether the instance stopped and whether the temp
 * tree is really gone. Before #97 the `finally` began AFTER `spawn`, so any
 * failure or interruption before it (a red install, a failed credential
 * read/write, a thrown spawn) skipped the cleanup and left the entire temp
 * DSH_HOME — the copied account records included — in %TEMP%, with no reading.
 * The table is printed FROM the `finally`, so it survives an exception thrown
 * between rings as well (only `mkdtemp` sits outside a ring).
 *
 * Rings (each one assertion group, exactly one report line per ring):
 *
 *   1 install      — `dsh plugin add` leaves all three installation faces
 *   2 credentials  — only this suite writes a credential copy into the temp home
 *                    (the key route copies nothing; the file stays absent)
 *   3 boot         — real instance on `--port 0`, stderr clean
 *   4 auth         — the launch URL exchanges its token for a cookie
 *   5 session+model — a session is created and the credential-matched route pinned
 *   6 real turn    — the provider BILLED, no attempt failure, the tool really ran
 *   Z cleanup      — the instance stopped and the temp tree is gone (both paths)
 *
 * The ring table follows the packed-delivery tier
 * (`tests/e2e-tarball-machine.spec.ts`, #89): every ring emits exactly one line —
 * `✓` pass, `✗` fail, `–` not reached — and the run reds ONCE at the end carrying
 * the whole table, so a red run is locatable from its READINGS and never has to
 * be diagnosed from a leftover scene. Where that tier nests one `if`/`else` per
 * ring and writes each "not run" note by hand, a red ring here BLOCKS the rest
 * BY NAME (every `–` line says which ring stopped it): a later ring against a
 * dead instance would only burn its settle budget before saying anything.
 *
 * @module tests/e2e-real-llm-machine
 */

import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopChild } from "./helpers/e2e-chain.ts";
import {
  HOST_DIR,
  NODE,
  PLUGIN_DIR,
  hostEnv,
  installPlugin,
  missingEnvironment,
} from "./helpers/e2e-install.ts";

const PROFILE = "dsh-host-real";

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

const absent = missingEnvironment([
  !hasKey && !usesAccount
    ? `credentials: DEEPSEEK_API_KEY or a source with ${ACCOUNT_PREFIX}* (tried ${ACCOUNT_SOURCE})`
    : null,
]);
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
    // ── ring table (see the header): one line per ring, red once at the end ──
    const results: string[] = [];
    const failures: string[] = [];
    /** Untruncated failure texts: the table keeps every ring on ONE line (300
     * characters), but this tier's assertions put their evidence in long tails
     * (stats / events / stderr), so the full message is printed below the table.
     * The diagnosis an assertion carries must not be lost to the table's budget. */
    const failureDetails: string[] = [];
    /** vitest's AssertionError body is multi-line (expected/received); the table needs one line. */
    const oneLine = (error: unknown, max = 300): string => {
      const text = error instanceof Error ? error.message : String(error);
      return text.replace(/\s+/gu, " ").trim().slice(0, max);
    };
    const ok = (name: string, detail = ""): void => { results.push(`  ✓ ${name}${detail === "" ? "" : ` — ${detail}`}`); };
    const bad = (name: string, error: unknown): void => {
      results.push(`  ✗ ${name} — ${oneLine(error)}`);
      failures.push(name);
      failureDetails.push(`${name}\n${error instanceof Error ? error.message : String(error)}`);
    };
    /** An earlier ring is red, so this one cannot run: said out loud, never a missing line. */
    const note = (line: string): void => { results.push(`  – ${line}`); };
    /** One ring = its own assertions. Exceptions are RECORDED, not thrown: throwing
     * would make every later ring silently absent, which is the defect this shape fixes.
     * A red ring also blocks the rest — named, so `–` lines say WHICH ring stopped them. */
    let blocked: string | null = null;
    const ring = async (name: string, body: () => string | Promise<string> | void): Promise<void> => {
      if (blocked !== null) { note(`${name} — not run: ring "${blocked}" is red`); return; }
      try { ok(name, (await body()) ?? ""); } catch (error) { bad(name, error); blocked = name; }
    };

    // Cleanup state, declared OUTSIDE the `try`: the `finally` must see whatever
    // the body managed to create (#97 — the leak came from state created before
    // the old `finally` even started).
    let root: string | undefined;
    let instance: ChildProcess | undefined;
    let instOut = "";
    let instErr = "";
    let launchUrl: string | undefined;
    let port = 0;
    let cookie: string | undefined;
    let sessionId: string | undefined;
    let selection: { provider: string; model: string } | undefined;

    /** Ring 4's output, required by rings 5–6: the guard means we only reach them
     * when ring 4 was green, but the type does not know that. */
    const needAuth = (): { port: number; cookie: string } => {
      if (cookie === undefined) throw new Error("no auth cookie (ring 4 red above)");
      return { port, cookie };
    };

    try {
      root = await mkdtemp(join(tmpdir(), "dsh-shellhost-real-"));
      const tempRoot = root;
      const dshHome = join(tempRoot, ".dsh");

      // ── ring 1: install — through the OFFICIAL plugin commands ─────────────
      // `--from-default-profile web` seeds the profile (writes cordis.yml etc.);
      // `plugin add` then registers the bundle and runs pnpm. A hand-made
      // node_modules symlink is explicitly NOT an installation — and it would skip
      // the peer-resolution check pnpm runs against the linked package.
      await ring("1 install: the official commands leave all three faces", async () => {
        const installed = await installPlugin(dshHome, PROFILE);
        expect(installed.code, `dsh plugin add succeeded (output: ${installed.out.slice(-500)})`).toBe(0);
        const profileDir = join(dshHome, "profiles", PROFILE);
        // All three faces of a real installation (TESTING.md): a registration record
        // alone still boots and still creates sessions, so assert every face.
        const record = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8")) as any;
        expect(record?.dsh?.profile?.bundles, "bundle registered in dsh.profile.bundles").toContain("dsh-shell-host");
        expect(record?.dependencies?.["dsh-shell-host"], "plugin recorded as a profile dependency").toBeTruthy();
        expect(
          existsSync(join(profileDir, "node_modules", "dsh-shell-host", "package.json")),
          "pnpm resolved the plugin into the profile node_modules",
        ).toBe(true);
        return `${PROFILE}: registered + dependency + node_modules`;
      });

      // ── ring 2: credentials — only THIS suite writes the copy ───────────────
      // The key route writes nothing at all (the key travels via env ONLY), and
      // the account route copies ONLY the account records. Written AFTER the
      // install so the profile seed cannot overwrite the file.
      await ring("2 credentials: only this suite writes the temp home's copy", async () => {
        const copied = join(dshHome, ".credentials.yaml");
        // Non-vacuity anchor for BOTH routes: neither the profile seed nor
        // `plugin add` may put a credentials file into the temp home, so its
        // presence right here can only be this suite's own copy.
        expect(existsSync(copied), "the install writes no credentials file into the temp home").toBe(false);
        if (!usesAccount) return "api-key route: no copy written (asserted absent above)";
        const original = await readFile(ACCOUNT_SOURCE, "utf8");
        const versionLine = original.split("\n").find((l) => l.startsWith("version:")) ?? "version: 1";
        await writeFile(copied, `${versionLine}\nrecords:\n${accountBlock}\n`, "utf8");
        // The reading names the file, never its content: this copy must not
        // outlive the run, and must not be printed either.
        expect(existsSync(copied), "the copied account records sit in the temp home").toBe(true);
        return `account records copied to ${copied}`;
      });

      // ── ring 3: boot — real instance on an OS-assigned port ────────────────
      await ring("3 boot: real instance up on --port 0, stderr clean", async () => {
        const child: ChildProcess = spawn(
          NODE,
          ["--import", "tsx/esm", "apps/cli/src/bin.ts", "--profile", PROFILE, "--no-open", "--port", "0"],
          {
            cwd: HOST_DIR,
            env: hostEnv(dshHome, hasKey ? { DEEPSEEK_API_KEY: API_KEY } : {}),
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        instance = child;
        child.stdout?.on("data", (c: Buffer) => { instOut += c.toString(); });
        child.stderr?.on("data", (c: Buffer) => { instErr += c.toString(); });

        const launch = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => { reject(new Error(`instance not ready in 120s: ${instErr.slice(-400)}`)); }, 120_000);
          child.stdout?.on("data", () => {
            const match = /dsh web: (http:\/\/\S+)/u.exec(instOut);
            if (match?.[1] !== undefined) { clearTimeout(timer); resolve(match[1]); }
          });
          child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`instance exited ${String(code)}: ${instErr.slice(-400)}`)); });
        });
        launchUrl = launch;

        expect(instErr.trim(), "instance stderr is clean at startup").toBe("");
        port = Number(new URL(launch).port);
        expect(Number.isInteger(port) && port > 0, "instance bound a real port").toBe(true);
        // The launch URL carries its one-time auth token: report the port, not the token.
        return `http://127.0.0.1:${String(port)}`;
      });

      // ── ring 4: auth exchange — the browser-trust handshake ────────────────
      await ring("4 auth: the launch URL exchanges its token for a cookie", async () => {
        const url = launchUrl;
        if (url === undefined) throw new Error("no launch URL (ring 3 red above)");
        const exchange = await fetch(url, { redirect: "manual" });
        const setCookie = exchange.headers.get("set-cookie");
        expect(exchange.status, "token exchange redirects").toBe(303);
        expect(setCookie, "exchange issues a cookie").toBeTruthy();
        cookie = setCookie!.split(";", 1)[0]!;
        return `303 → cookie on port ${String(port)}`;
      });

      // ── ring 5: session + model route ──────────────────────────────────────
      await ring("5 session+model: the credential-matched route is pinned", async () => {
        const auth = needAuth();
        const created = await rpc(auth.port, auth.cookie, "session/create", { cwd: PLUGIN_DIR });
        expect(created?.sessionId, "real session created").toBeTruthy();
        const sid = String(created.sessionId);
        sessionId = sid;

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
        const catalog = await rpcZeroArg(auth.port, auth.cookie, "session/modelCatalog");
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

        const selected = await rpc(auth.port, auth.cookie, "session/selectModel", {
          sessionId: sid,
          provider: pick.provider,
          model: pick.model,
        });
        expect(selected?.selected?.model, "the session accepted the model selection").toBeTruthy();
        selection = { provider: String(pick.provider), model: String(pick.model) };
        return `${String(pick.provider)}/${String(pick.model)}`;
      });

      // ── ring 6: the real turn, and the evidence it really happened ─────────
      await ring("6 real turn: provider billed, no attempt failure, tool executed", async () => {
        const auth = needAuth();
        const sid = sessionId;
        const chosen = selection;
        if (sid === undefined || chosen === undefined) throw new Error("no session/model selected (ring 5 red above)");

        await rpc(auth.port, auth.cookie, "session/prompt", {
          requestId: `real-${Date.now()}`,
          sessionId: sid,
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
          const list = await rpcZeroArg(auth.port, auth.cookie, "session/list").catch(() => null);
          const item = (list?.items ?? []).find((i: any) => i?.sessionId === sid);
          lastValues = item?.projections?.values ?? lastValues;
          lastTurn = lastValues?.turnOutline?.[0] ?? lastTurn;
          lastStats = lastValues?.sessionStats ?? lastStats;
          // Done when the provider billed usage AND the turn is no longer running.
          if (item?.running === false && usageOf(lastValues) > 0) break;
          await new Promise((r) => { setTimeout(r, 1500); });
        }

        // The durable history through the host's own RPC — the authoritative
        // record of what the model asked for and whether the instance ran it.
        const events = await readDurableEvents(auth.port, auth.cookie, sid);
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
          `the REAL provider billed a round trip (usage=${String(usage)} route=${chosen.provider}/${chosen.model} lastUsed=${JSON.stringify(lastValues?.modelSelection?.lastUsed ?? null)} stats=${JSON.stringify(lastStats)} events=${types} stderr=${instErr.slice(-400) || "(empty)"})`,
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
        return `usage=${String(usage)} route=${chosen.provider}/${chosen.model} tools=${callNames.join(",") || "none"}`;
      });
    } finally {
      // ── Z cleanup: one of the ACs, so it needs a READING on both paths ──────
      // Stop the instance before touching the tree (killing while the agent loop
      // is live leaves libuv teardown noise and ECONNRESET in the report), and
      // report whether it actually stopped: a hung child is a reading, not a hang.
      // Guarded like the removal below: a throw here would skip the `rm` and the
      // table — the very "no reading + leftover tree" shape #97 removes.
      if (instance === undefined) {
        note("Z cleanup: instance stopped — no instance was started");
      } else {
        try {
          if (await stopChild(instance)) ok("Z cleanup: instance stopped", "SIGTERM → exit");
          else bad("Z cleanup: instance stopped", "ignored SIGTERM and SIGKILL within the budget");
        } catch (error) {
          bad("Z cleanup: instance stopped", error);
        }
      }

      // The temp root may not exist at all (a failure in `mkdtemp` itself, or an
      // installation that never got that far), and then the reading says so.
      const tree = root;
      if (tree === undefined) {
        note("Z cleanup: temp tree removed — no temp tree was created");
      } else {
        try {
          await rm(tree, { recursive: true, force: true });
          if (existsSync(tree)) bad("Z cleanup: temp tree removed", `still present: ${tree}`);
          else ok("Z cleanup: temp tree removed", tree);
        } catch (error) {
          bad("Z cleanup: temp tree removed", error);
        }
      }

      // Printed from the `finally`, not after it: when the body throws outside a
      // ring (e.g. `mkdtemp`), code after the `try` never runs — and a red run
      // without the table is exactly the "no reading" defect #97 is about.
      console.log(`\n=== real-LLM tier rings (install → credentials → boot → auth → session+model → turn → cleanup) ===\n${results.join("\n")}`);
      // Same reason, for the message bodies the one-line table had to cut.
      if (failureDetails.length > 0) {
        console.log(`\n--- red rings, full messages ---\n${failureDetails.join("\n\n")}`);
      }
    }

    // One red at the end, carrying the whole table: locatable to the ring, and
    // no ring is ever a missing line.
    expect(failures, `real-LLM e2e: ${String(failures.length)} ring(s) red — full table:\n${results.join("\n")}`).toEqual([]);
  });
});

afterAll(() => {
  if (absent.length > 0) console.warn(`  !! SKIP (loud) — ${skipReason}`);
});