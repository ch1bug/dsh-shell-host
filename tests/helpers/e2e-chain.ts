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
          // pty_open is chosen deliberately: it sits behind no approval gate, so
          // this tier can prove the tool surface is wired without entering the
          // approval/sandbox path (which the real-LLM tier owns).
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
 * authenticated launch URL. `env` carries the tier's provider wiring. */
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
      const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u.exec(stdout);
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

/** One typert Remote envelope. Args are NAMED (`payload.args.request`). */
export function rpc(port: number, cookie: string | undefined, method: string, args: unknown) {
  const body = JSON.stringify({ type: "client-request", rpcId: `e2e-${method}`, method, payload: { args } });
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