// proves: AP-MOD-core-access-seat-cut

/**
 * The seat-toolset stub seam on eve 1.x. The integration tier stubs a tool's `execute` through this
 * seam (`tests/integration/harness.ts#wrapToolExecute`), and the offered-toolset negative control
 * adds a tool through it. This suite resolves a tool slot through `seatCut` and mounts the result
 * with eve's real dynamic-tool mount (`definitions/tools.js#contributeTools`), then calls the live
 * tool's `execute` as eve's harness does.
 *
 *   §1  With no stub installed, the live tool runs the real `execute` (the negative control).
 *   §2  A stub replaces the live tool's `execute`. The stub receives the input and eve's tool context.
 *   §3  Clearing the stub restores the real `execute`, and the authored entry was never changed.
 *   §4  A stub that adds a tool makes eve mount it under its own name, beside the slot's tool.
 *   §5  Every tool that an integration spec stubs mounts through `seatCut`, so the seam reaches it,
 *       except the tools listed as unmounted on eve 1.x. The harness's wrap is this suite's wrap.
 *   §6  With the `scripted-model` valve disarmed, as in a deployment, an installed stub does nothing.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-seat-toolset-stub-")), "ops.sqlite3");
delete process.env.DATABASE_URL;

const { defineTool } = await import("eve/tools");
const { seatCut, setSeatToolsetStubForTest, stubToolExecuteForTest, seatCutApplies } = await import("../agent/access/seat-cut.js");
const { __setTestValveForTest } = await import("../agent/testing/test-valves.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n += 1;
};

const require_ = createRequire(import.meta.url);
const distSrc = join(dirname(require_.resolve("eve/package.json")), "dist", "src");
const load = async <T>(...rel: readonly string[]): Promise<T> => (await import(pathToFileURL(join(distSrc, ...rel)).href)) as T;

interface LiveTool {
  readonly name: string;
  readonly execute?: (input: unknown, options: unknown) => unknown;
}

const { contributeTools } = await load<{
  contributeTools(def: { logicalPath: string; slug: string }, value: unknown, ctx: unknown): { live?: LiveTool[] };
}>("definitions", "tools.js");
const { ContextContainer, contextStorage } = await load<{
  ContextContainer: new () => { set(key: unknown, value: unknown): unknown };
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
}>("context", "container.js");
const { SessionKey } = await load<{ SessionKey: unknown }>("context", "keys.js");

const DYNAMIC = Symbol.for("eve.dynamic");
const SLUG = "list_routines";

let realCalls = 0;
const authored = defineTool({
  description: "probe",
  inputSchema: { type: "object", properties: {} } as never,
  execute: async () => {
    realCalls += 1;
    return { source: "real" };
  },
});
const authoredExecute = (authored as unknown as { execute: unknown }).execute;

/** One model step's mount: resolve the slot through `seatCut`, then mount it with eve's real mount. */
async function mountSlot(slug: string, entry: unknown): Promise<Map<string, LiveTool>> {
  const resolve = (seatCut(slug, entry) as Record<symbol, unknown>)[DYNAMIC] as (ctx: unknown) => Promise<unknown>;
  const value = await resolve({ callId: "list", session: { id: "seat-stub-session", turn: { id: "turn-1", sequence: 1 } } });
  const live = contributeTools({ logicalPath: `agent/tools/${slug}.ts`, slug }, value, new ContextContainer()).live ?? [];
  return new Map(live.map((t) => [t.name, t]));
}

async function runLive(tool: LiveTool | undefined, label: string): Promise<unknown> {
  ok(tool !== undefined && typeof tool.execute === "function", `${label}: eve mounted a live tool with an execute`);
  const container = new ContextContainer();
  container.set(SessionKey, { sessionId: "seat-stub-session", turn: { id: "turn-1", sequence: 1 } });
  return await contextStorage.run(container, () =>
    tool!.execute!({}, { toolCallId: "call-1", messages: [], abortSignal: new AbortController().signal }),
  );
}

/** The harness's `wrapToolExecute` is this export, so the suite drives the same code. */
const wrap = stubToolExecuteForTest;

// The seam answers only while the `scripted-model` valve is armed, as the integration harness arms it.
__setTestValveForTest("scripted-model", true);

console.log("§1 negative control: with no stub, the live tool runs the real execute");
{
  ok(setSeatToolsetStubForTest(undefined) === undefined, "no stub is installed at the start");
  const live = await mountSlot(SLUG, authored);
  ok([...live.keys()].join(",") === SLUG, `eve mounts the slot's one tool under the slot name (got ${[...live.keys()].join(",")})`);
  const out = (await runLive(live.get(SLUG), "§1")) as { source?: string };
  ok(out.source === "real" && realCalls === 1, "the real execute ran");
}

console.log("§2 a stub replaces the live tool's execute");
{
  const seen: unknown[][] = [];
  const restore = wrap(SLUG, async (...args: unknown[]) => {
    seen.push(args);
    return { source: "stub" };
  });
  const live = await mountSlot(SLUG, authored);
  ok([...live.keys()].join(",") === SLUG, "the stub changes no tool name");
  const out = (await runLive(live.get(SLUG), "§2")) as { source?: string };
  ok(out.source === "stub", `🔴 the live tool ran the STUB (got ${JSON.stringify(out)})`);
  ok(realCalls === 1, "🔴 the real execute did not run");
  ok(seen.length === 1, "the stub ran once");
  const ctx = seen[0]?.[1] as { callId?: unknown; toolName?: unknown; session?: { id?: unknown } } | undefined;
  ok(
    ctx?.callId === "call-1" && ctx.toolName === SLUG && ctx.session?.id === "seat-stub-session",
    `the stub receives eve's tool context: the call id, the tool name and the session (got ${JSON.stringify({ callId: ctx?.callId, toolName: ctx?.toolName })})`,
  );

  const other = await mountSlot("list_inbox", authored);
  const otherOut = (await runLive(other.get("list_inbox"), "§2 other slot")) as { source?: string };
  ok(otherOut.source === "real" && realCalls === 2, "a stub on one tool leaves another tool's execute real");
  restore();
}

console.log("§3 clearing the stub restores the real execute, and the authored entry is unchanged");
{
  ok(setSeatToolsetStubForTest(undefined) === undefined, "the restore removed the stub");
  const live = await mountSlot(SLUG, authored);
  const out = (await runLive(live.get(SLUG), "§3")) as { source?: string };
  ok(out.source === "real" && realCalls === 3, "the real execute runs again");
  ok((authored as unknown as { execute: unknown }).execute === authoredExecute, "the authored entry still holds its own execute");

  const restoreOuter = wrap(SLUG, async () => ({ source: "outer" }));
  const restoreInner = wrap(SLUG, async () => ({ source: "inner" }));
  const nested = (await runLive((await mountSlot(SLUG, authored)).get(SLUG), "§3 nested")) as { source?: string };
  ok(nested.source === "inner", "a later wrap takes the tool");
  restoreInner();
  const back = (await runLive((await mountSlot(SLUG, authored)).get(SLUG), "§3 unwound")) as { source?: string };
  ok(back.source === "outer", "its restore puts the earlier wrap back");
  restoreOuter();
  ok(setSeatToolsetStubForTest(undefined) === undefined, "the last restore leaves no stub");
}

console.log("§4 a stub that adds a tool makes eve mount it under its own name (the OPE-2687 control)");
{
  const EXTRA = "seat_stub_extra_tool";
  setSeatToolsetStubForTest((slug, toolset) => {
    const donor = toolset["reply"];
    if (slug === "reply" && donor !== undefined) toolset[EXTRA] = donor;
  });
  const live = await mountSlot("reply", authored);
  ok(live.has("reply") && live.has(EXTRA), `🔴 eve mounts the slot's tool AND the added tool (got ${[...live.keys()].join(",")})`);
  const other = await mountSlot(SLUG, authored);
  ok(!other.has(EXTRA), "the control adds the tool once, on its donor slot only");
  setSeatToolsetStubForTest(undefined);
  const after = await mountSlot("reply", authored);
  ok([...after.keys()].join(",") === "reply", "with the stub cleared, the slot mounts its one tool again");
}

console.log("§5 every tool an integration spec stubs mounts through seatCut");
{
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const itRoot = join(repoRoot, "tests", "integration");
  const harness = readFileSync(join(itRoot, "harness.ts"), "utf8");
  const wrapAt = harness.indexOf("export function wrapToolExecute(");
  const wrapBody = harness.slice(wrapAt, harness.indexOf("\n}\n", wrapAt));
  ok(wrapAt !== -1 && /return stubToolExecuteForTest\(toolName, stub\);/.test(wrapBody), "🔴 the harness's wrapToolExecute is the seat cut's stubToolExecuteForTest, the wrap this suite drives");
  ok(!wrapBody.includes("__oeToolResultProjection") && !wrapBody.includes("throw new Error"), "the harness's wrapToolExecute no longer reaches for the eve 0.x hook, and does not throw");

  const lock = JSON.parse(readFileSync(join(repoRoot, "roster.lock.json"), "utf8")) as {
    packages: Record<string, { contributions: Record<string, string> }>;
  };
  const mountedTools = new Set(
    Object.values(lock.packages).flatMap((p) =>
      Object.entries(p.contributions).flatMap(([key, state]) => (key.startsWith("tool/") && state === "mounted" ? [key.slice("tool/".length)] : [])),
    ),
  );

  // A spec stub whose tool eve 1.x does not mount. The seam cannot reach it, so the spec stops at
  // that tool, not at the seam. Each entry names why.
  // No spec stubs such a tool today: the connector specs drive eve 1.x's `eve__search` and the
  // connector mount, not the eve 0.x `connection_search`.
  const UNMOUNTED_ON_EVE_1: Readonly<Record<string, string>> = {};

  const specs: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith(".test.ts")) specs.push(join(dir, e.name));
    }
  };
  walk(itRoot);

  const targets = new Map<string, string[]>();
  for (const file of specs.sort()) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/wrapToolExecute\(\s*("([^"]+)"|[A-Za-z_][A-Za-z0-9_]*)/g)) {
      const literal = m[2];
      const name = literal ?? new RegExp(`const ${m[1]} = "([^"]+)"`).exec(src)?.[1];
      const rel = relative(repoRoot, file);
      ok(name !== undefined, `${rel}: the stub target ${m[1]} resolves to a tool name`);
      targets.set(name!, [...new Set([...(targets.get(name!) ?? []), rel])]);
    }
  }
  const files = new Set([...targets.values()].flat());
  ok(files.size >= 16, `the scan finds every spec that stubs a tool (found ${files.size})`);

  for (const [name, users] of [...targets].sort()) {
    const why = UNMOUNTED_ON_EVE_1[name];
    if (why !== undefined) {
      ok(!mountedTools.has(name), `🔴 ${name} is listed as unmounted on eve 1.x, and the roster still does not mount it — drop the entry when it does`);
      console.log(`  ! ${name} (${users.length} spec): not mounted on eve 1.x — ${why}`);
      continue;
    }
    ok(mountedTools.has(name), `🔴 ${name} (stubbed by ${users.join(", ")}) is a mounted tool slot in roster.lock.json`);
    ok(seatCutApplies(name), `🔴 ${name} mounts through seatCut (it is not a static slot), so the seam reaches it`);
    console.log(`  ✓ ${name}: ${users.length} spec(s)`);
  }
}

console.log("§6 with the scripted-model valve disarmed, an installed stub does nothing");
{
  const restore = wrap(SLUG, async () => ({ source: "stub" }));
  __setTestValveForTest("scripted-model", false);
  const out = (await runLive((await mountSlot(SLUG, authored)).get(SLUG), "§6 disarmed")) as { source?: string };
  ok(out.source === "real", `🔴 a deployment (valve disarmed) runs the real execute even with a stub installed (got ${JSON.stringify(out)})`);
  setSeatToolsetStubForTest((slug, toolset) => {
    if (slug === "reply") toolset["seat_stub_extra_tool"] = toolset["reply"];
  });
  const extra = await mountSlot("reply", authored);
  ok([...extra.keys()].join(",") === "reply", "🔴 …and a stub cannot add a tool to the seat");
  __setTestValveForTest("scripted-model", true);
  const armed = (await runLive((await mountSlot("reply", authored)).get("seat_stub_extra_tool"), "§6 re-armed")) as { source?: string };
  ok(armed.source === "real", "control: re-armed, the same installed stub adds the tool again");
  setSeatToolsetStubForTest(undefined);
  restore();
  __setTestValveForTest("scripted-model", false);
}

console.log(`\nseat-toolset-stub: ${n} assertions passed`);
