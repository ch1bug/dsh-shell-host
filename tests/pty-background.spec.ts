/**
 * #120 — `run_in_background` on `pty_send` / `ssh_send`, wired to the HOST's
 * background-job stack (`@deepseek-ai/dsh-jobs` + `@deepseek-ai/dsh-tool-jobs`).
 *
 * The unit lane stands in a registry that enforces the SAME contract refusals
 * the host one does (a `start` with no attached controller is refused) and the
 * same two reads the host exposes: the registry's pump into its output RING and
 * the model's consuming cursor (`job_output`), so "the send's output is
 * collectable" is proven through the ring, not merely at the pull source:
 *
 *   1. background returns a registry job id + the job record carries the
 *      official `terminal_send` shape (kind / label / toolCall / owner /
 *      outputLimitBytes / one pull source);
 *   2. the registry's final drain lands the delta in the ring and `job_output`
 *      reads it; the source itself is NON-CONSUMING (same offset ⇒ same bytes);
 *   3. `job_kill` cancels the pending settle and the job settles `killed`;
 *   4. both loud failures: no `jobs` service (naming BOTH packages) and
 *      `enableRunInBackground: false`.
 *
 * The foreground contract is asserted too (AC1): the same call without the
 * flag keeps the settle result byte for byte and starts no job.
 */

import { describe, it, expect } from "vitest";
import { bootPlugin, echoFakePty } from "./helpers/fake-pty.ts";

/** The owning agent. `id` is the session id the job record is fenced by. */
const AGENT = { id: "session-A", agentName: "agent-a" };

/** One tool execution: the agent plus the call ids the job record carries. */
function exec(extra: Record<string, unknown> = {}) {
  return { agent: AGENT, signal: new AbortController().signal, callId: "call-1", rootCallId: "root-1", ...extra };
}

// ---------------------------------------------------------------------------
// The fake registry: the host contract, narrowed to what a producer touches
// ---------------------------------------------------------------------------

interface FakeJob {
  spec: any;
  hooks: { cancel: (reason?: string) => void; done: Promise<any> };
  /** The registry's output RING — bytes pumped from the pull sources. */
  ring: string;
  /** Per-source resume offsets (the registry owns these, not the source). */
  offsets: number[];
  /** The MODEL's consuming cursor — what `job_output` reads from. */
  cursor: number;
  settled?: { status: string; detail?: string };
}

/**
 * A job registry that behaves like the host's: `start` REFUSES while no
 * controller is attached (`dsh-tool-jobs` is what attaches one), the registry
 * pumps the pull sources into its own ring, and the two reads the model has are
 * reproduced — `readModel` (the consuming `job_output` cursor) and `kill`
 * (`job_kill`, forwarded to the producer's hooks).
 *
 * Character offsets (not UTF-8 bytes) are fine here: this double only has to
 * model the two cursors' RELATION, which the byte-exact positions do not change.
 */
function fakeJobs(opts: { controller?: boolean } = {}) {
  const attached = opts.controller !== false;
  const jobs = new Map<string, FakeJob>();
  let seq = 0;
  const mustGet = (id: string): FakeJob => {
    const job = jobs.get(id);
    if (job === undefined) throw new Error(`unknown job ${id}`);
    return job;
  };
  return {
    attached,
    /** Every spec handed to `start`, in order. */
    specs: [] as any[],
    start(spec: any) {
      if (!attached) throw new Error("jobs.start refused: no attached job controller serves this owner");
      this.specs.push(spec);
      const jobId = `pty-send-${++seq}`;
      const hooks = spec.run({ id: jobId, append() {}, updateProgress() {} });
      const job: FakeJob = { spec, hooks, ring: "", offsets: [], cursor: 0 };
      jobs.set(jobId, job);
      void hooks.done.then((outcome: any) => {
        job.settled = outcome;
        return outcome;
      });
      return jobId;
    },
    /** The registry's own pump: drain every pull source into the ring. */
    drain(id: string): string {
      const job = mustGet(id);
      (job.spec.output ?? []).forEach((source: any, i: number) => {
        const page = source.read(job.offsets[i] ?? 0);
        job.offsets[i] = page.nextOffset;
        job.ring += page.text;
      });
      return job.ring;
    },
    /** `job_output`: the registry drains, then the MODEL consumes from its cursor. */
    readModel(id: string): string {
      const job = mustGet(id);
      this.drain(id);
      const text = job.ring.slice(job.cursor);
      job.cursor = job.ring.length;
      return text;
    },
    /** One raw pull-source read at an absolute offset — the source contract's
     * "read everything captured since `fromByte` WITHOUT consuming it". */
    readSourceAt(id: string, offset: number): { text: string; nextOffset: number; lossy: boolean } {
      return mustGet(id).spec.output[0].read(offset);
    },
    /** `job_kill`: the registry's cancellation reaches the producer's hooks. */
    kill(id: string) {
      mustGet(id).hooks.cancel("job_kill");
    },
    /** Await the producer's `done` (the registry awaits it) and then perform the
     * documented FINAL drain before the ring closes (`JobSpec.run`'s contract:
     * "drains every source one last time before settlement closes the ring"). */
    async settle(id: string): Promise<{ status: string; detail?: string }> {
      const job = mustGet(id);
      for (let i = 0; i < 400 && job.settled === undefined; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (job.settled === undefined) throw new Error(`job ${id} never settled`);
      this.drain(id);
      return job.settled;
    },
  };
}

/** Boot the pty entry over the echo fake and hand it a job registry (the
 * registry is mounted the way the host mounts it: a service on the context). */
function boot(opts: { jobs?: ReturnType<typeof fakeJobs>; config?: unknown } = {}) {
  const h = bootPlugin({ spawnPty: () => echoFakePty(), config: opts.config });
  if (opts.jobs !== undefined) h.provided.set("jobs", opts.jobs);
  return h;
}

/** Open one echo session on the fresh boot. */
async function open(h: ReturnType<typeof boot>) {
  return h.tool("pty_open").execute({ command: "fake-shell" }, exec());
}

// ---------------------------------------------------------------------------
// AC2 — background returns a job id, and the job record has the official shape
// ---------------------------------------------------------------------------

describe("#120 pty_send run_in_background", () => {
  it("returns a registry job id and registers the official job record", async () => {
    const jobs = fakeJobs();
    const h = boot({ jobs });
    const opened = await open(h);

    const result: any = await h.tool("pty_send").execute({ id: opened.sessionId, data: "echo-hi", run_in_background: true }, exec());
    expect(result).toEqual({ kind: "background", jobId: "pty-send-1" });

    expect(jobs.specs).toHaveLength(1);
    const spec = jobs.specs[0];
    expect(spec.kind).toBe("pty-send");
    expect(spec.label).toBe(`${opened.sessionId}: echo-hi`);
    expect(spec.owner).toBe("session-A");
    expect(spec.toolCall).toEqual({ callId: "call-1", rootCallId: "root-1" });
    expect(spec.outputLimitBytes).toBe(256 * 1024);
    expect(spec.output).toHaveLength(1);
    expect(typeof spec.output[0].read).toBe("function");
  });

  // AC2/AC3 — settlements and the two read faces the host exposes.
  it("settles completed and job_output reads the delta out of the registry's ring", async () => {
    const jobs = fakeJobs();
    const h = boot({ jobs });
    const opened = await open(h);

    const result: any = await h.tool("pty_send").execute({ id: opened.sessionId, data: "collect-me", run_in_background: true }, exec());
    const outcome = await jobs.settle(result.jobId);

    expect(outcome.status).toBe("completed");
    expect(outcome.detail).toContain("bytes read");
    expect(outcome.detail).toContain("session running");
    // The ring got the delta and the MODEL's cursor reads it (`job_output`).
    expect(jobs.readModel(result.jobId)).toContain("collect-me");
    // ...and that cursor is CONSUMING: a second read yields nothing new.
    expect(jobs.readModel(result.jobId)).toBe("");
  });

  // The source contract is explicitly non-consuming: the same offset re-serves
  // the same bytes (a consuming source would hand back "" and mislabel it).
  it("the output source is non-consuming: re-reading an offset re-serves it", async () => {
    const jobs = fakeJobs();
    const h = boot({ jobs });
    const opened = await open(h);

    const result: any = await h.tool("pty_send").execute({ id: opened.sessionId, data: "idempotent", run_in_background: true }, exec());
    await jobs.settle(result.jobId);

    const first = jobs.readSourceAt(result.jobId, 0);
    const second = jobs.readSourceAt(result.jobId, 0);
    expect(first.text).toContain("idempotent");
    expect(second).toEqual(first);
    expect(first.lossy).toBe(false);
    // A read at the end is an empty page, never a lossy one.
    const atEnd = jobs.readSourceAt(result.jobId, first.nextOffset);
    expect(atEnd).toEqual({ text: "", nextOffset: first.nextOffset, lossy: false });
  });

  // AC3 — job_kill cancels the pending settle; the job reports `killed`.
  it("job_kill cancels the pending settle and the job settles killed", async () => {
    const jobs = fakeJobs();
    const h = boot({ jobs });
    const opened = await open(h);

    const result: any = await h.tool("pty_send").execute({ id: opened.sessionId, data: "kill-me", run_in_background: true }, exec());
    // Kill before the echo line lands (the fake emits it on a 5 ms timer), so
    // the send's settle is cut short rather than completing normally.
    jobs.kill(result.jobId);
    const outcome = await jobs.settle(result.jobId);

    expect(outcome.status).toBe("killed");
    expect(outcome.detail).toContain("cancelled");
  });

  // AC5/AC1 — the foreground path starts NO job and keeps its result shape.
  it("the foreground call is unchanged: settle result, no job started", async () => {
    const jobs = fakeJobs();
    const h = boot({ jobs });
    const opened = await open(h);

    const sent: any = await h.tool("pty_send").execute({ id: opened.sessionId, data: "foreground" }, exec());
    expect(sent.delta).toContain("foreground");
    expect(Object.keys(sent).sort()).toEqual(["delta", "status"]);
    expect(sent.kind).toBeUndefined();
    expect(jobs.specs).toHaveLength(0);
  });

  // The model-facing faces: render reports only the job id, presentCall swaps
  // to the generic card (the official terminal_send posture).
  it("renders the started job id and swaps the card for the background form", async () => {
    const h = boot({ jobs: fakeJobs() });
    const ptySend: any = h.tool("pty_send");

    expect(ptySend.output.render({}, { kind: "background", jobId: "pty-send-7" })[0].text).toBe("started background job pty-send-7");
    expect(ptySend.presentCall({ id: "pty-1", data: "x", run_in_background: true })).toMatchObject({ card: "generic", kind: "execute", rawInput: "x" });
    expect(ptySend.presentCall({ id: "pty-1", data: "x" })).toMatchObject({ card: "terminal", title: "x" });
  });
});

// ---------------------------------------------------------------------------
// AC4 — both loud failures, and neither degrades to a foreground send
// ---------------------------------------------------------------------------

describe("#120 background-send gates", () => {
  it("fails loudly naming BOTH host packages when no jobs service is mounted", async () => {
    const h = boot();
    const opened = await open(h);

    await expect(h.tool("pty_send").execute({ id: opened.sessionId, data: "x", run_in_background: true }, exec()))
      .rejects.toThrow("@deepseek-ai/dsh-jobs");
    await expect(h.tool("pty_send").execute({ id: opened.sessionId, data: "x", run_in_background: true }, exec()))
      .rejects.toThrow("@deepseek-ai/dsh-tool-jobs");
  });

  it("ssh_send fails loudly the same way (one gate, both tools)", async () => {
    const h = boot();
    const opened = await h.tool("ssh_start").execute({ host: "example.test" }, exec());

    await expect(h.tool("ssh_send").execute({ id: opened.sessionId, data: "x", run_in_background: true }, exec()))
      .rejects.toThrow("@deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
  });

  it("enableRunInBackground: false refuses the request and does not advertise the parameter", async () => {
    const jobs = fakeJobs();
    const h = boot({ jobs, config: { enableRunInBackground: false } });
    const opened = await open(h);
    const ptySend: any = h.tool("pty_send");

    expect(ptySend.parameters.properties.run_in_background).toBeUndefined();
    expect(h.tool("ssh_send").parameters.properties.run_in_background).toBeUndefined();
    await expect(ptySend.execute({ id: opened.sessionId, data: "x", run_in_background: true }, exec()))
      .rejects.toThrow("enableRunInBackground: false");
    expect(jobs.specs).toHaveLength(0);
    // The foreground path is untouched by the gate.
    const sent: any = await ptySend.execute({ id: opened.sessionId, data: "still-works" }, exec());
    expect(sent.delta).toContain("still-works");
  });

  // The "two packages are a PAIR" fact: the registry refuses a job whose owner
  // no controller serves. Our code must surface that refusal, not swallow it.
  it("propagates the registry's refusal when no controller is attached", async () => {
    const jobs = fakeJobs({ controller: false });
    const h = boot({ jobs });
    const opened = await open(h);

    await expect(h.tool("pty_send").execute({ id: opened.sessionId, data: "x", run_in_background: true }, exec()))
      .rejects.toThrow("no attached job controller");
  });
});

// ---------------------------------------------------------------------------
// ssh_send — the same path, the same evidence (one shared branch)
// ---------------------------------------------------------------------------

describe("#120 ssh_send run_in_background", () => {
  it("returns a job id and settles completed with its output collectable", async () => {
    const jobs = fakeJobs();
    const h = boot({ jobs });
    // host/jump are the only ssh atoms; the echo fake stands in for the remote.
    const opened = await h.tool("ssh_start").execute({ host: "example.test" }, exec());

    const result: any = await h.tool("ssh_send").execute({ id: opened.sessionId, data: "uptime", run_in_background: true }, exec());
    expect(result).toEqual({ kind: "background", jobId: "pty-send-1" });
    expect(jobs.specs[0].label).toBe(`${opened.sessionId}: uptime`);

    const outcome = await jobs.settle(result.jobId);
    expect(outcome.status).toBe("completed");
    expect(jobs.readModel(result.jobId)).toContain("uptime");
  });
});