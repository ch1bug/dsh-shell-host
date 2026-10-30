/**
 * #169 — the declaration & artifact face of the browser half (the headless
 * ceiling: React form interactions are out of scope per the spec's testing
 * decisions). The declaration assertions run as a PURE predicate over a
 * package manifest object — each mutation test feeds a BROKEN manifest and
 * asserts the predicate goes red (判别力: removing `dsh.client` → red). The
 * artifact assertions load the BUILT `lib/client.js` (loud skip on a fresh
 * checkout before `node --run build`, the built-artifact.spec.ts posture).
 * @module tests/client-declaration
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { waitForTreeReadyBriefly } from "./helpers/lib-snapshot.ts";
import { validateClientDeclaration } from "../src/client/declaration.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const realManifest = () => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, any>;

describe("client-half declaration face (#169): dsh.client × exports × files pairing", () => {
  it("the real package.json passes the predicate", () => {
    expect(validateClientDeclaration(realManifest())).toEqual([]);
  });

  // 反证（mutation tests）: each declared fact, when removed, goes red.
  it("mutant: dsh.client removed → red naming the missing declaration", () => {
    const pkg = realManifest();
    delete pkg.dsh.client;
    expect(validateClientDeclaration(pkg)).toContainEqual(expect.stringMatching(/dsh\.client/));
  });
  it("mutant: wrong platform → red", () => {
    const pkg = realManifest();
    pkg.dsh.client.platform = "node";
    expect(validateClientDeclaration(pkg)).toContainEqual(expect.stringMatching(/platform/));
  });
  it("mutant: exports[./client] removed → red", () => {
    const pkg = realManifest();
    delete pkg.exports["./client"];
    expect(validateClientDeclaration(pkg)).toContainEqual(expect.stringMatching(/\.\/client/));
  });
  it("mutant: exports[./client] points elsewhere → red", () => {
    const pkg = realManifest();
    pkg.exports["./client"].default = "./lib/other.js";
    expect(validateClientDeclaration(pkg)).toContainEqual(expect.stringMatching(/lib\/client\.js/));
  });
  it("mutant: lib/client.js missing from files → red", () => {
    const pkg = realManifest();
    pkg.files = (pkg.files as string[]).filter((f) => f !== "lib/client.js");
    expect(validateClientDeclaration(pkg)).toContainEqual(expect.stringMatching(/files/));
  });
  it("the row key shape is declared in the client source: <package>#<row id>", () => {
    const source = readFileSync(new URL("../src/client/index.ts", import.meta.url), "utf8");
    expect(source).toContain("'dsh-shell-host#terminal'");
    expect(source).toContain("'plugins.row.config'");
  });
});

describe("built client artifact loads as the lazy-CJS factory shape", () => {
  let missing = false;
  beforeAll(async () => {
    const { missing: m } = await waitForTreeReadyBriefly(["lib/client.js"], (rel) =>
      fileURLToPath(new URL(`../${rel}`, import.meta.url)));
    missing = m.length > 0;
    if (missing) console.log("!! SKIP (loud): lib/client.js 未构建（新检出先跑 node --run build）——声明与产物面断言未验证");
  });

  it("lib/client.js registers a factory with apply/slots inject and keeps react external", async (t) => {
    if (missing) t.skip();
    const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
    // The bundle stays self-contained: react is a bare require (the host
    // module table resolves it), never inlined (a React build inside a
    // plugin bundle would duplicate the browser identity).
    expect(source).toMatch(/require\(\s*["']react["']\s*\)/u);
    // Lazy-CJS: the module's exports ARE the plugin definition. The module
    // body requires the baseline React at materialization time — the eval
    // harness supplies the same require the host module table provides.
    const mod = { exports: {} as Record<string, unknown> };
    const factory = new Function("module", "exports", "require", source);
    const ReactStub = { createElement: (...args: unknown[]) => ({ react: args }) };
    factory(mod, mod.exports, (id: string) => {
      expect(id).toBe("react"); // the one baseline request — nothing else
      return ReactStub;
    });
    expect(typeof mod.exports.apply).toBe("function");
    // The factory registers the row-config slot under the pinned key.
    const injected: Array<{ slot: string; registered: Array<Record<string, unknown>> }> = [];
    const slots = {
      inject: (slot: string, make: () => unknown) => injected.push({ slot, registered: [make()] as Array<Record<string, unknown>> }),
      register: (spec: Record<string, unknown>) => spec,
    };
    (mod.exports.apply as (ctx: unknown) => void)({ slots });
    expect(injected[0]!.slot).toBe("plugins.row.config");
    expect(injected[0]!.registered[0]).toMatchObject({ name: "plugins.row.config", key: "dsh-shell-host#terminal" });
  });
});
