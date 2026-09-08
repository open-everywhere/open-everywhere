
import assert from "node:assert/strict";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

_setDeploymentIdentityForTest({ org: "acme-org", workspace: "ws1", surface: "c1" });
process.env.OE_TRUST = "internal";
delete process.env.OE_MEMORY_PROVIDER;

await import("./_register-test-config.js");

const { registerConfig, getConfig } = await import("../agent/access/config.js");
const { resolveMemoryPlan } = await import("../agent/memory/resolve.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { defineMemorySilo } = await import("../agent/memory/silo.js");
const { siloTier } = await import("../agent/memory/store.js");
const { tierSandboxDir } = await import("../agent/memory/sandbox-sync.js");
const { resolvePartition, domainKeyOf } = await import("../agent/memory/partition.js");
const { resolveWindowGated } = await import("../agent/access/window-gated.js");
const { formatWindowToken, taskWindowId } = await import("../agent/channels/window-key.js");
const { absoluteSandboxSegments, memoryWriteTarget, memoryWriteRefusal, withMemoryWriteFence } = await import(
  "../agent/memory/write-fence.js"
);

type Domain = import("../agent/memory/domain.js").Domain;
type MemorySilo = import("../agent/memory/silo.js").MemorySilo;
type MemoryPlan = import("../agent/memory/resolve.js").MemoryPlan;
type SurfaceBinding = import("../agent/identity/binding.js").SurfaceBinding;
type BindableContext = import("../agent/identity/binding.js").BindableContext;
type Partition = import("../agent/memory/partition.js").Partition;
type SessionMode = import("../agent/access/resolver.js").SessionMode;
type Trust = import("../agent/identity/binding.js").Trust;
type ToolDefinition = import("eve/tools").ToolDefinition;
type ToolContext = import("eve/tools").ToolContext;

let liveDomains: readonly Domain[] = [];
let liveSilos: readonly MemorySilo[] = [];
let configBroken = false;
{
  const base = getConfig();
  registerConfig({
    ...base,
    loadDomains: () => {
      if (configBroken) throw new Error("memory config unreadable (test)");
      return liveDomains;
    },
    loadSilos: () => liveSilos,
  });
}

async function refusal(fn: () => unknown): Promise<string> {
  try {
    await Promise.resolve(fn());
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a refusal, got none");
}

const ownedSilo = defineMemorySilo({ name: "payments-brain", provider: "sqlite" });
const secondOwnedSilo = defineMemorySilo({ name: "payments-notes", provider: "sqlite" });
const baselineSilo = defineMemorySilo({ name: "org-baseline", provider: "sqlite", readOnly: true });
const notionSilo = defineMemorySilo({ name: "handbook-cache", provider: "notion", container: "root", readOnly: true, skill: "notion" });
const CHANNEL = "slack/T/C_PAY";

function binding(mode: SessionMode, trust: Trust): SurfaceBinding {
  return { org: "default", platform: "slack", workspace: "T", surface: "C_PAY", mode, visibility: "public", trust };
}
function partition(): Partition {
  return { org: "default", platform: "slack", workspace: "T", surface: "C_PAY", workspaceKey: "slack/T", surfaceKey: CHANNEL, key: CHANNEL };
}
function planWith(silos: readonly MemorySilo[], memory: readonly string[]): MemoryPlan {
  const domain = defineDomain({ name: "payments", reach: [CHANNEL], memory: [...memory] });
  return resolveMemoryPlan(binding("channel", "internal"), partition(), { domains: [domain], silos });
}

{
  ok(absoluteSandboxSegments("memory/a/b.md").join("/") === "workspace/memory/a/b.md", "a relative path anchors at the sandbox cwd (/workspace)");
  ok(absoluteSandboxSegments("/workspace/memory/a/b.md").join("/") === "workspace/memory/a/b.md", "…and an absolute path is taken as written");
  ok(absoluteSandboxSegments("./memory/./a/b.md").join("/") === "workspace/memory/a/b.md", "`.` segments drop out");
  ok(absoluteSandboxSegments("/workspace/memory/a/../b/c.md").join("/") === "workspace/memory/b/c.md", "`..` pops, so a traversal cannot dress one silo up as another");
  ok(absoluteSandboxSegments("/../../../etc/passwd").join("/") === "etc/passwd", "a pop at the root clamps instead of escaping, exactly as the kernel does");

  ok(memoryWriteTarget("/workspace/repo/src/index.ts") === null, "🔴 an ordinary working file is NOT a memory target — the fence never looks at it");
  ok(memoryWriteTarget("/etc/passwd") === null, "…nor is a path outside the sandbox cwd");
  ok(memoryWriteTarget("/workspace/memoryish/x.md") === null, "…nor is a sibling directory whose name merely starts with `memory`");
  ok(memoryWriteTarget("/workspace/memory")?.dir === "" , "the memory ROOT itself is a target with no silo");
  ok(memoryWriteTarget("/workspace/memory/MEMORY.md")?.rel === "", "a file sitting directly at the memory root has no silo-relative path");
  const deep = memoryWriteTarget("memory/payments-brain/notes/q3.md");
  ok(deep?.dir === "payments-brain" && deep.rel === "notes/q3.md" && deep.sandboxDir === "memory/payments-brain", "a silo file resolves to its silo dir + the path under it");
  ok(memoryWriteTarget("/workspace/memory/payments-brain/../other/x.md")?.dir === "other", "🔴 a `..` hop out of an owned silo resolves to the silo it ACTUALLY lands in");
}

{
  const plan = planWith([ownedSilo, secondOwnedSilo, baselineSilo], ["payments-brain", "payments-notes", "org-baseline"]);
  ok(plan.writes.length === 2 && plan.reads.length === 3, "fixture check: the plan reads three silos and writes two");

  ok(memoryWriteRefusal("/workspace/memory/payments-brain/notes.md", plan) === null, "🔴 a write into an OWNED WRITABLE silo is allowed (=== null), which is what makes every refusal below a decision and not a blanket block");
  ok(memoryWriteRefusal("memory/payments-notes/decisions.md", plan) === null, "…including the second writable silo, named relatively");
  ok(memoryWriteRefusal("/workspace/repo/src/index.ts", plan) === null, "…and an ordinary working file is untouched");

  const unowned = memoryWriteRefusal("/workspace/memory/it-memory-brain/notes.md", plan);
  ok(unowned !== null, "🔴 a write into a silo the session does NOT own is REFUSED (the old behaviour returned isError:false and dropped the bytes)");
  ok(unowned!.includes("it-memory-brain"), "…the refusal names the silo that was asked for");
  ok(unowned!.includes("DROPPED"), "…and says WHY: the write would not persist");
  ok(unowned!.includes("memory/payments-brain/") && unowned!.includes("memory/payments-notes/"), "🔴 …and names EVERY silo this session can write, so the model can correct in the same turn");
  ok(unowned!.includes('domain "payments"'), "…plus the plan's own reason, which is what tells a confused worker it is in the wrong domain");
  ok(!unowned!.includes("org-baseline"), "…and does NOT offer the read-only silo as a write target");

  const hop = memoryWriteRefusal("/workspace/memory/payments-brain/../it-memory-brain/notes.md", plan);
  ok(hop !== null && hop.includes("it-memory-brain"), "🔴 a `..` hop out of an owned silo is refused as the silo it lands in, not allowed as the one it starts in");

  const ro = memoryWriteRefusal("/workspace/memory/org-baseline/MEMORY.md", plan);
  ok(ro !== null && ro.includes("org-baseline"), "a write into a materialised READ-ONLY silo is refused");
  ok(ro!.includes("READ-ONLY baseline"), "…in the same words the read-only banner uses");
  ok(ro!.includes("memory/payments-brain/"), "…and it names the writable route, so the edit reroutes rather than just failing");

  const idx = memoryWriteRefusal("/workspace/memory/MEMORY.md", plan);
  ok(idx !== null && idx.includes("host-generated"), "the top-level memory index is refused as host-generated");
  ok(idx!.includes("rebuilt"), "…and says the edit would be overwritten, not merely blocked");
  const root = memoryWriteRefusal("/workspace/memory/loose.md", plan);
  ok(root !== null && root.includes("memory/<silo>/<file>.md"), "a file dropped at the memory root is refused with the shape a memory path must have");

  const cachePlan = planWith([ownedSilo, notionSilo], ["payments-brain", "handbook-cache"]);
  const cache = memoryWriteRefusal("/workspace/memory/handbook-cache/MEMORY.md", cachePlan);
  ok(cache !== null && cache.includes("READ-ONLY cache of Notion"), "a projected Notion cache is refused as a cache, not as a baseline");
  ok(cache!.includes("`notion` skill"), "🔴 …and routes the update to the SOURCE's own tools, which is the only route that saves");

  const readOnlyPlan = planWith([baselineSilo], ["org-baseline"]);
  ok(readOnlyPlan.writes.length === 0, "fixture check: a read-only-only domain resolves to zero writes");
  const none = memoryWriteRefusal("/workspace/memory/payments-brain/notes.md", readOnlyPlan);
  ok(none !== null && none.includes("NO writable memory"), "🔴 a session with no writable silo says so — an empty list would read as 'try again'");
}

{
  liveSilos = [ownedSilo, baselineSilo];
  liveDomains = [defineDomain({ name: "local-payments", reach: ["local/ws1/c1"], memory: ["payments-brain"] })];

  const spyTool = (): ToolDefinition & { calls: unknown[] } => {
    const calls: unknown[] = [];
    const tool = {
      name: "write_file",
      description: "write",
      inputSchema: { type: "object", properties: {} },
      execute: async (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    } as unknown as ToolDefinition & { calls: unknown[] };
    tool.calls = calls;
    return tool;
  };

  const okTool = spyTool();
  const fencedOk = withMemoryWriteFence("write_file", okTool);
  await fencedOk.execute({ filePath: "/workspace/memory/payments-brain/notes.md", content: "hi" }, {} as ToolContext);
  ok(okTool.calls.length === 1, "🔴 a write into the LIVE plan's own writable silo reaches the framework's execute — the fence is additive");
  ok(
    JSON.stringify(okTool.calls[0]) === JSON.stringify({ filePath: "/workspace/memory/payments-brain/notes.md", content: "hi" }),
    "…with the input passed through byte-identically",
  );

  const passthrough = spyTool();
  await withMemoryWriteFence("write_file", passthrough).execute({ filePath: "/workspace/repo/src/a.ts", content: "x" }, {} as ToolContext);
  ok(passthrough.calls.length === 1, "an ordinary working file is written with no plan read at all");

  const denyTool = spyTool();
  const msg = await refusal(() =>
    withMemoryWriteFence("write_file", denyTool).execute({ filePath: "/workspace/memory/it-memory-brain/notes.md", content: "x" }, {} as ToolContext),
  );
  ok(msg.startsWith("write_file:"), "the refusal is prefixed with the TOOL that was refused");
  ok(msg.includes("it-memory-brain") && msg.includes("memory/payments-brain/"), "…naming the refused silo and the writable one");
  ok(denyTool.calls.length === 0, "🔴 …and the wrapped execute is NEVER reached — nothing is written to be dropped later");

  for (const bad of [{}, { filePath: 42 }, null]) {
    const t = spyTool();
    await withMemoryWriteFence("write_file", t).execute(bad, {} as ToolContext);
    ok(t.calls.length === 1, `an input with no readable filePath (${JSON.stringify(bad)}) passes through to the tool's own schema rejection`);
  }

  const shapeOf = (t: ToolDefinition) => JSON.stringify({ ...(t as unknown as Record<string, unknown>), execute: undefined });
  ok(shapeOf(fencedOk) === shapeOf(okTool), "the wrap replaces execute and nothing else (name/description/inputSchema survive)");

  const { writeFile } = await import("eve/tools/write_file");
  const schema = (writeFile as unknown as { inputSchema: { safeParse(v: unknown): { success: boolean } } }).inputSchema;
  ok(schema.safeParse({ filePath: "/workspace/a.md", content: "x" }).success, "🔴 eve's write_file still takes `filePath` — the field the fence reads. A rename here disarms the fence silently.");
  ok(!schema.safeParse({ path: "/workspace/a.md", content: "x" }).success, "…and the schema is strict, so the field name above is the ONLY one a validated call can carry");
}

{
  configBroken = true;
  try {
    const t = { name: "write_file", description: "w", inputSchema: {}, execute: async () => ({ ok: true }) } as unknown as ToolDefinition;
    const m = await refusal(() => withMemoryWriteFence("write_file", t).execute({ filePath: "memory/payments-brain/x.md", content: "x" }, {} as ToolContext));
    ok(m.includes("could not be read"), "🔴 an unreadable memory plan REFUSES the memory write rather than guessing it is owned");
    ok(m.includes("dropped silently"), "…and says why refusing is the safe answer");
    let reached = 0;
    const t2 = { name: "write_file", description: "w", inputSchema: {}, execute: async () => { reached++; return { ok: true }; } } as unknown as ToolDefinition;
    await withMemoryWriteFence("write_file", t2).execute({ filePath: "/workspace/repo/a.ts", content: "x" }, {} as ToolContext);
    ok(reached === 1, "…while a NON-memory write is unaffected — a broken memory config never breaks ordinary file work");
  } finally {
    configBroken = false;
  }
}

{
  const seat = {
    channel: { kind: "unified", continuationToken: `unified:${formatWindowToken({ domain: "payments", windowId: taskWindowId("slack/C1", "1720.9"), generation: 5 })}` },
    session: { id: "fence-task", auth: { current: { attributes: { oe_grain: "task" } } } },
  };
  const seatChannel = domainKeyOf(resolvePartition(seat as unknown as BindableContext));
  liveSilos = [ownedSilo];
  liveDomains = [defineDomain({ name: "seat-payments", reach: [seatChannel], memory: ["payments-brain"] })];

  const kit = (await resolveWindowGated((await import("../agent/tools/sandbox_tools.js")).default, seat as unknown as BindableContext)) as Record<
    string,
    ToolDefinition
  > | null;
  ok(kit !== null && typeof kit.write_file?.execute === "function", "the task-worker grain mounts a write_file");

  const m = await refusal(() => kit!.write_file.execute({ filePath: "/workspace/memory/it-memory-brain/notes.md", content: "x" }, seat as unknown as ToolContext));
  ok(m.includes("write_file:"), "🔴 THE WIRING: the tool the agent actually holds refuses the unowned-silo write");
  ok(m.includes("it-memory-brain") && m.includes(`${tierSandboxDir(siloTier(ownedSilo.name))}/`), "…naming the refused silo and the one this seat can persist");
}

console.log(`\n✓ memory-write-fence: ${n} assertions passed (path resolution + plan decision + wrapper + fail-closed + real mounted wiring)\n`);
