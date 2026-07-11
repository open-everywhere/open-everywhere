import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-provider-"));
process.env.OE_MEMORY_DIR = join(tmp, "git");
process.env.OE_SQLITE_PATH = join(tmp, "mem.sqlite3");

const { gitProvider } = await import("../agent/memory/provider.js");
const { sqliteProvider, _resetDbForTest } = await import("../agent/memory/sqlite.js");
const { WORKSPACE, SURFACE, siloTier } = await import("../agent/memory/store.js");
import type { Partition } from "../agent/memory/partition.js";
import type { MemoryProvider } from "../agent/memory/provider.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

function partition(workspace: string, surface: string, org = "default"): Partition {
  const workspaceKey = `slack/${workspace}`;
  const surfaceKey = `${workspaceKey}/${surface}`;
  return { org, platform: "slack", workspace, surface, workspaceKey, surfaceKey, key: surfaceKey };
}

async function runContract(provider: MemoryProvider): Promise<void> {
  const id = provider.id;
  const p = partition(`ws-${id}`, "general");

  ok(Object.keys(await provider.readTier(p, WORKSPACE)).length === 0, `${id}: fresh tier reads empty`);

  const seeded = await provider.ensureTier(p, WORKSPACE);
  ok("MEMORY.md" in seeded && seeded["MEMORY.md"].includes("Workspace memory"), `${id}: ensureTier seeds workspace MEMORY.md`);

  const afterSeed = await provider.readTier(p, WORKSPACE);
  ok(afterSeed["MEMORY.md"] === seeded["MEMORY.md"], `${id}: readTier returns seeded content`);

  const reseed = await provider.ensureTier(p, WORKSPACE);
  ok(reseed["MEMORY.md"] === seeded["MEMORY.md"], `${id}: ensureTier idempotent`);

  ok((await provider.writeTier(p, WORKSPACE, seeded, "noop")) === null, `${id}: unchanged write returns null`);

  const v1 = await provider.writeTier(p, WORKSPACE, { "MEMORY.md": "# changed\n" }, "edit");
  ok(typeof v1 === "string" && v1.length > 0, `${id}: changed write returns a version token`);
  ok((await provider.readTier(p, WORKSPACE))["MEMORY.md"] === "# changed\n", `${id}: write is durable`);

  await provider.writeTier(p, WORKSPACE, { "people.md": "@ana owns deploys\n" }, "add file");
  const both = await provider.readTier(p, WORKSPACE);
  ok(both["MEMORY.md"] === "# changed\n" && both["people.md"] === "@ana owns deploys\n", `${id}: write unions files`);

  ok(typeof provider.tierVersion === "function", `${id}: provider exposes the tierVersion probe`);
  const fresh = partition(`ws-${id}-never-written`, "general");
  ok((await provider.tierVersion!(fresh, WORKSPACE)) === null, `${id}: tierVersion is null for a never-written tier`);
  const vBefore = await provider.tierVersion!(p, WORKSPACE);
  ok(typeof vBefore === "string" && vBefore.length > 0, `${id}: tierVersion is non-null once the tier has been written`);
  ok((await provider.tierVersion!(p, WORKSPACE)) === vBefore, `${id}: tierVersion is stable while nothing changes (the skip gate)`);
  await provider.writeTier(p, WORKSPACE, { "version-probe.md": "advanced\n" }, "bump");
  const vAfter = await provider.tierVersion!(p, WORKSPACE);
  ok(typeof vAfter === "string" && vAfter !== vBefore, `${id}: tierVersion advances on a changed write`);
  await provider.deleteFile!(p, WORKSPACE, "version-probe.md");
  const vDelete = await provider.tierVersion!(p, WORKSPACE);
  ok(typeof vDelete === "string" && vDelete !== vAfter, `${id}: tierVersion advances on a per-file delete (erasure is detectable by the re-sync)`);
  ok(!("version-probe.md" in (await provider.readTier(p, WORKSPACE))), `${id}: the deleted file is gone from the tier`);

  await provider.ensureTier(p, SURFACE);
  await provider.writeTier(p, SURFACE, { "MEMORY.md": "surface-only\n" }, "s");
  await provider.ensureTier(p, siloTier("payments"));
  ok((await provider.readTier(p, WORKSPACE))["MEMORY.md"] === "# changed\n", `${id}: surface/domain writes don't touch workspace`);
  ok((await provider.readTier(p, SURFACE))["MEMORY.md"] === "surface-only\n", `${id}: surface tier isolated`);
  ok((await provider.readTier(p, siloTier("payments")))["MEMORY.md"].includes('"payments"'), `${id}: silo tier seeded under its name`);

  await provider.deleteTier(p, WORKSPACE);
  ok(Object.keys(await provider.readTier(p, WORKSPACE)).length === 0, `${id}: deleteTier erases the tier`);
  await provider.deleteTier(p, WORKSPACE);
  ok(true, `${id}: deleteTier is idempotent`);
  ok((await provider.readTier(p, SURFACE))["MEMORY.md"] === "surface-only\n", `${id}: delete is tier-scoped`);
}

await runContract(gitProvider);
await runContract(sqliteProvider);

for (const provider of [gitProvider, sqliteProvider]) {
  const id = provider.id;
  const a = partition("acme", "general", `${id}-org-a`);
  const b = partition("acme", "general", `${id}-org-b`);

  await provider.ensureTier(a, WORKSPACE);
  await provider.writeTier(a, WORKSPACE, { "MEMORY.md": "A's secret\n" }, "a");

  ok(Object.keys(await provider.readTier(b, WORKSPACE)).length === 0, `${id}: org-b cannot see org-a's tier (same workspace/surface, different org)`);
  await provider.ensureTier(b, WORKSPACE);
  await provider.writeTier(b, WORKSPACE, { "MEMORY.md": "B's secret\n" }, "b");
  ok((await provider.readTier(b, WORKSPACE))["MEMORY.md"] === "B's secret\n", `${id}: org-b sees only its own content`);
  ok((await provider.readTier(a, WORKSPACE))["MEMORY.md"] === "A's secret\n", `${id}: org-a unaffected by org-b's write`);

  await provider.deleteTier(a, WORKSPACE);
  ok(Object.keys(await provider.readTier(a, WORKSPACE)).length === 0, `${id}: org-a erased`);
  ok((await provider.readTier(b, WORKSPACE))["MEMORY.md"] === "B's secret\n", `${id}: org-b survives org-a's erasure`);
}

{
  const p = partition("ver", "general");
  await sqliteProvider.ensureTier(p, WORKSPACE);
  const a = await sqliteProvider.writeTier(p, WORKSPACE, { "MEMORY.md": "one\n" }, "1");
  const b = await sqliteProvider.writeTier(p, WORKSPACE, { "MEMORY.md": "two\n" }, "2");
  ok(a !== null && b !== null && Number(b) > Number(a), "sqlite version token is monotonic across changes");
}

_resetDbForTest();
rmSync(tmp, { recursive: true, force: true });
console.log(`✓ provider — ${passed} assertions (git + sqlite contract, org isolation, erasure, versioning)`);
