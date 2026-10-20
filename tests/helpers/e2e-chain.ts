/**
 * Shared plumbing for the mock-LLM delivery chain: SSE framing, the local mock
 * provider, the real `dsh web` instance, and the typert RPC envelope.
 *
 * Why it lives here (#89): the packed-delivery tier
 * (`tests/e2e-tarball-machine.spec.ts`) and the checkout tier
 * (`tests/e2e-tool-call-machine.spec.ts`) run the SAME chain — real instance,
 * real session, real request bytes, real tool execution — and differ in ONE
 * place only: the install source (directory vs `npm pack` tarball). Two copies
 * would drift apart exactly where the domain facts are least obvious (RPC arg
 * shapes, the extra session-titling request, waiting for the child to exit
 * before killing it), which is how a green suite starts lying.
 *
 * `docs/agents/TESTING.md` states the rule this follows: shared plumbing goes in
 * a helper, not a second copy inside each spec. The install/env/gate half is in
 * `tests/helpers/e2e-install.ts`.
 *
 * The real-LLM tier (`e2e-real-llm-machine`) shares the whole MECHANISM of this
 * module — `MY_ROWS` (#101), the typert RPC envelope (#100), instance boot
 * (`startInstance`), the launch-URL token exchange (`exchangeToken`) and the
 * stop-with-verdict (`stopChild`, #97). What it keeps its own is its PROVIDER
 * WIRING, credential route and model-route assertions: those encode domain
 * facts the mock tiers cannot express, not plumbing.
 *
 * The RPC envelope has two readers with different failure behaviour on purpose
 * (#100): `rpc()` hands the raw `{status, text}` back so a tier can assert on
 * the bytes it got, and `rpcValue()` throws with the failure text and unwraps
 * `result.value` for the tiers whose next step needs the value. Both write the
 * SAME envelope (`envelope()` below) — that is the point: one wire shape, two
 * named readings, never a second copy inside a spec.
 *
 * @module tests/helpers/e2e-chain
 */

import { createServer, request as httpRequest } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { HOST_DIR, NODE, hostEnv } from "./e2e-install.ts";

/** The bundle's own loader rows (ADR-0007/0012): a failure must never blame
 * these — they are the rows this repo adds (TESTING.md failure attribution). */
export const MY_ROWS = ["pty", "terminal"];

/** Anthropic-style SSE frames — the shape the host's Messages client parses. */
export function sseFrames(content: Record<string, unknown>, stopReason: string): string {
  return [
    { type: "message_start", message: { id: "e2e-msg", model: "deepseek-v4-pro", usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: content },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

interface Captured {
  readonly body: Record<string, any>;
  /** True only for agent requests: the host also sends lightweight requests
   * (e.g. session titling) that must NOT be mistaken for the agent turn. */
  readonly isAgent: boolean;
}

/** Local mock provider. Turn 1 (agent) demands a tool call; turn 2 answers. */
export async function startMockLlm() {
  const captured: Captured[] = [];
  const sockets = new Set<import("node:net").Socket>();
  let agentTurns = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("error", () => { /* instance shutdown resets sockets — expected */ });
    res.on("error", () => { /* same */ });
    req.on("end", () => {
      let body: Record<string, any> = {};
      try { body = JSON.parse(raw) as Record<string, any>; } catch { /* keep raw */ }
      const isAgent = Array.isArray(body.tools) && body.tools.length > 0;
      captured.push({ body, isAgent });
      let content: Record<string, unknown>;
      let stopReason: string;
      if (isAgent) {
        agentTurns += 1;
        if (agentTurns === 1) {
          // pty_open's REQUIRED argument is `command` (shell_open's is `preset`).
          // pty_open is chosen deliberately: since #102 it DOES pass the host
          // policy gate, but under the default `workspace-write` composition an
          // in-bounds autoClose spawn is allowed WITHOUT an approval ask — so
          // this tier still proves the tool surface is wired without needing a
          // human approver (the escalation UI is structurally headless-blind;
          // `tests/permission-gate.spec.ts` owns that contract).
          content = { type: "tool_use", id: "toolu_e2e_1", name: "pty_open", input: { command: "cmd.exe /c echo verify-ok", autoClose: true } };
          stopReason = "tool_use";
        } else {
          content = { type: "text", text: "done" };
          stopReason = "end_turn";
        }
      } else {
        content = { type: "text", text: "title" };
        stopReason = "end_turn";
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sseFrames(content, stopReason));
    });
  });
  await new Promise<void>((resolve) => {
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => { /* expected on shutdown */ });
    });
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    captured,
    agentRequests: (): Captured[] => captured.filter((c) => c.isAgent),
    agentTurns: () => agentTurns,
    async close() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
}

/** Boot the real `dsh web` CLI on an OS-assigned port and wait for its
 * authenticated launch URL. `env` carries the tier's provider wiring.
 *
 * The readiness contract is deliberately the TOKEN-CARRYING URL, not "any URL
 * the host printed": that token is what the chain's next step exchanges for a
 * cookie, so a URL without one is not ready for this harness. The host part is
 * NOT pinned to `127.0.0.1` — one shared matcher serves all three tiers, and a
 * tier that is handed a different host must not hang on a matcher's spelling. */
export function startInstance(profile: string, dshHome: string, env: Record<string, string | undefined> = {}) {
  const child: ChildProcess = spawn(
    NODE,
    ["--import", "tsx/esm", "apps/cli/src/bin.ts", "--profile", profile, "--no-open", "--port", "0"],
    {
      cwd: HOST_DIR,
      env: hostEnv(dshHome, env),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`instance not ready in 120s\nstdout=${stdout}\nstderr=${stderr}`));
    }, 120_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /https?:\/\/[^\s]+\/\?token=[^\s]+/u.exec(stdout);
      if (match?.[0] !== undefined) { clearTimeout(timer); resolve(match[0]); }
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`instance exited early (${String(code)})\n${stderr}`)); });
  });
  return { child, ready, stderr: () => stderr };
}

/** Stop the real instance and WAIT for it to exit.
 *
 * Why waiting is not optional: killing while the agent loop is live leaves libuv
 * teardown noise and ECONNRESET in the report. Why it is bounded and returns a
 * verdict: an instance that ignores SIGTERM *and* SIGKILL must not hang the
 * caller's cleanup ring — "the child never exited" is a reading, not a hang.
 * Why the pre-check: `once('exit')` registered after the child is already gone
 * never fires, which is a silent hang in exactly the failure path this exists for.
 */
export async function stopChild(child: ChildProcess, budgetMs = 15_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  const exited = new Promise<boolean>((resolve) => { child.once("exit", () => { resolve(true); }); });
  child.kill("SIGTERM");
  const forced = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
  try {
    return await Promise.race([
      exited,
      new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false); }, budgetMs); }),
    ]);
  } finally {
    clearTimeout(forced);
  }
}

/** The argument-name shape a typert method validates (GLOSSARY 「#82」):
 *  a method that has a `request` parameter wants `{ request: value }`, while
 *  zero-argument methods want either `{ _request: {} }` or plain `{}` — and the
 *  host REJECTS the wrong one ("unexpected _request" for `session/modelCatalog`).
 *  Callers pass the value, never a hand-wrapped envelope: the wire spelling is
 *  written once, in `envelope()`. */
export type ArgShape = "request" | "named" | "none";

/** The ONE place the typert Remote envelope is written. */
function envelope(method: string, args: unknown, argShape: ArgShape): string {
  const wrapped = argShape === "request" ? { request: args } : argShape === "named" ? { _request: {} } : {};
  return JSON.stringify({ type: "client-request", rpcId: `e2e-${method}`, method, payload: { args: wrapped } });
}

/** One RPC round trip, read RAW: `{ status, text }`, never throws.
 *
 * This is the mock tiers' reading (#100): they hand the response bytes to an
 * assertion, so a transport failure must surface AS a reading (`status: 0` plus
 * the error code in `text`) rather than as a thrown stack that hides which
 * method produced it. */
export function rpc(
  port: number,
  cookie: string | undefined,
  method: string,
  args: unknown,
  argShape: ArgShape = "request",
): Promise<{ status: number; text: string }> {
  const body = envelope(method, args, argShape);
  return new Promise<{ status: number; text: string }>((resolve) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: `/api/${method}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(cookie === undefined ? {} : { cookie }),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => { text += c.toString(); });
        res.on("end", () => { resolve({ status: res.statusCode ?? 0, text }); });
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => { resolve({ status: 0, text: `__rpc_error__ ${e.code ?? e.message}` }); });
    req.end(body);
  });
}

/** The SAME envelope, read STRICT: throws on a transport failure or on a body
 * whose `result.ok` is not true, and returns `result.value` unwrapped.
 *
 * This is the real-LLM tier's reading (#100): its caller acts on the value, so
 * a failure must be an exception carrying the host's own failure text — a
 * `session/list` loop that silently got `undefined` would spin to its deadline
 * and report a timeout instead of the actual error. */
export async function rpcValue(
  port: number,
  cookie: string | undefined,
  method: string,
  args: unknown,
  argShape: ArgShape = "request",
): Promise<any> {
  const { status, text } = await rpc(port, cookie, method, args, argShape);
  if (status < 200 || status >= 300) throw new Error(`${method} HTTP ${String(status)}: ${text.slice(0, 200)}`);
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${method}: response is not JSON (${text.slice(0, 200)})`);
  }
  if (parsed?.result?.ok !== true) {
    throw new Error(`${method}: ${JSON.stringify(parsed?.result?.error ?? parsed).slice(0, 300)}`);
  }
  return parsed.result.value as any;
}

/** Try the argument shapes a zero-arg session method might want, in the order
 * the RC host is known to use (`none`, then `named`), so a descriptor mismatch
 * self-corrects instead of failing the run on envelope trivia. Only an
 * `arguments-invalid` rejection counts as "wrong shape"; any other error is the
 * real failure and propagates on the first shape. */
export async function rpcZeroArg(port: number, cookie: string | undefined, method: string): Promise<any> {
  const shapes: ArgShape[] = ["none", "named"];
  let lastError: unknown = null;
  for (const shape of shapes) {
    try {
      return await rpcValue(port, cookie, method, undefined, shape);
    } catch (error) {
      lastError = error;
      if (!/arguments-invalid/u.test(String(error))) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** The OS-assigned port the instance actually bound, read from its launch URL.
 *  Kept separate from the token exchange below because the boot ring needs the
 *  port BEFORE the one-time token is spent: `--port 0` means the URL is the only
 *  place the port exists. Accepts a parsed `URL` too, so a caller that already
 *  parsed the launch URL does not parse it twice. */
export function portOf(launchUrl: string | URL): number {
  return Number(new URL(launchUrl).port);
}

/** The browser-trust handshake every tier performs: GET the instance's launch
 *  URL (it carries a one-time token) and read back the redirect status, the auth
 *  cookie, and the port.
 *
 *  Why a helper (#100): the same dozen lines were spelled out in all three tiers,
 *  and a drift there is silent — a wrong `pathname`/`search` slice still returns
 *  *a* status. The ASSERTIONS stay in each tier (`303`, cookie truthy, port real):
 *  this returns readings, it does not judge them. Transport failure resolves
 *  `status: 0` rather than throwing, so a dead instance is one red at the
 *  caller's own assertion (with the tier's own wording) instead of a stack. */
export async function exchangeToken(launchUrl: string): Promise<{ status: number; cookie?: string; port: number }> {
  const url = new URL(launchUrl);
  const port = portOf(url);
  const res = await new Promise<{ status: number; setCookie?: string[] }>((resolve) => {
    const req = httpRequest(
      { hostname: url.hostname, port, path: `${url.pathname}${url.search}` },
      (r) => { resolve({ status: r.statusCode ?? 0, setCookie: r.headers["set-cookie"] }); },
    );
    req.on("error", () => { resolve({ status: 0 }); });
    req.end();
  });
  return { status: res.status, cookie: res.setCookie?.[0]?.split(";")[0], port };
}
