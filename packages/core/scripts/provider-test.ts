import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-provider-"));
process.env.OE_MEMORY_DIR = join(tmp, "git");
process.env.OE_SQLITE_PATH = join(tmp, "mem.sqlite3");

const { gitProvider } = await import("../agent/memory/provider.js");
const { sqliteProvider, _resetDbForTest } = await import("../agent/memory/sqlite.js");
const { WORKSPACE, SURFACE, siloTier, __resetStagingSweepForTest } = await import("../agent/memory/store.js");
import type { Partition } from "../agent/memory/partition.js";
import type { MemoryProvider } from "../agent/memory/provider.js";

function isToleratedCleanupError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOTEMPTY";
}

function cleanupTmp(): void {
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (error) {
    if (!isToleratedCleanupError(error)) throw error;
    console.warn(`provider-test: left residue at ${tmp} after retries (${(error as Error).message})`);
  }
}

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    cleanupTmp();
    process.exit(1);
  }
  passed++;
}

ok(isToleratedCleanupError(Object.assign(new Error("dir not empty"), { code: "ENOTEMPTY" })) === true,
  "cleanupTmp: ENOTEMPTY is tolerated after retries exhaust");
ok(isToleratedCleanupError(Object.assign(new Error("permission denied"), { code: "EACCES" })) === false,
  "cleanupTmp: a non-ENOTEMPTY cleanup error is NOT swallowed (negative control)");

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

{
  const pinned = process.env.OE_SQLITE_PATH!;
  const sqliteRoot = sqliteProvider.root;
  ok(typeof sqliteRoot === "function", "fixture control (memory sqlite): the provider exposes root(), which is what names the open file");
  const rootOf = (): string => sqliteRoot!.call(sqliteProvider);
  const p = partition("envpin", "general");
  await sqliteProvider.ensureTier(p, WORKSPACE);
  ok(rootOf() === pinned, "fixture control (memory sqlite): the handle is open at this suite's pinned file");

  const saved = process.env.OE_SQLITE_PATH;
  delete process.env.OE_SQLITE_PATH;
  try {
    await sqliteProvider.writeTier(p, WORKSPACE, { "MEMORY.md": "written with the env unset\n" }, "1");
    ok(
      rootOf() === pinned,
      "🔴 OPE-1933 (memory sqlite): an ABSENT OE_SQLITE_PATH keeps the OPEN file — an env read that returns undefined is not an instruction to switch databases",
    );
  } finally {
    process.env.OE_SQLITE_PATH = saved;
  }
  const back = await sqliteProvider.readTier(p, WORKSPACE);
  ok(back["MEMORY.md"] === "written with the env unset\n", "🔴 OPE-1933 (memory sqlite): the tier written while the env was unset reads back from the pinned file");

  const elsewhere = join(tmp, "mem-ope1933-elsewhere.sqlite3");
  process.env.OE_SQLITE_PATH = elsewhere;
  try {
    await sqliteProvider.ensureTier(p, WORKSPACE);
    ok(
      rootOf() === elsewhere,
      "OPE-1933 (memory sqlite) negative control: a PRESENT OE_SQLITE_PATH naming another file still switches",
    );
    const fresh = await sqliteProvider.readTier(p, WORKSPACE);
    ok(fresh["MEMORY.md"] !== "written with the env unset\n", "…and the new file is a DIFFERENT database — the pinned file's row is not visible there");
  } finally {
    process.env.OE_SQLITE_PATH = pinned;
    _resetDbForTest();
  }
}

{
  const { readdirSync, readFileSync } = await import("node:fs");
  const p = partition("atomic", "general");
  const body = "# Atomic\n\n- a fact that must never read back empty\n";
  await gitProvider.writeTier(p, SURFACE, { "MEMORY.md": body }, "seed");
  const find = (dir: string): string | undefined => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const child = join(dir, e.name);
      if (e.isDirectory()) {
        const hit = find(child);
        if (hit) return hit;
      } else if (e.name === "MEMORY.md" && readFileSync(child, "utf8") === body) return child;
    }
    return undefined;
  };
  const file = find(gitProvider.root!());
  ok(file !== undefined, "OPE-2297: the probe found the file it just wrote");
  let reads = 0;
  let torn = 0;
  let done = false;
  const poll = (): void => {
    if (done) return;
    reads++;
    if (readFileSync(file!, "utf8") !== body) torn++;
    setImmediate(poll);
  };
  poll();
  for (let i = 0; i < 300; i++) await gitProvider.writeTier(p, SURFACE, { "MEMORY.md": body }, `rewrite ${i}`);
  done = true;
  ok(reads > 300, `OPE-2297: the reader really ran between the writes (${reads} reads)`);
  ok(torn === 0, `🔴 OPE-2297: no concurrent read saw a truncated or partial file (${torn} of ${reads} reads did)`);
  ok(!readdirSync(join(gitProvider.root!(), ".oe-staging")).length, "OPE-2297: every staged write was renamed into place — nothing is left in the staging dir");

  {
    const { renameOverReaders } = await import("../agent/memory/store.js");
    const busy = (code: string) => Object.assign(new Error(code), { code });
    let calls = 0;
    const flaky = async (): Promise<void> => {
      if (++calls < 3) throw busy("EPERM");
    };
    await renameOverReaders("a", "b", { rename: flaky, windows: true });
    ok(calls === 3, `OPE-2369: on Windows a rename that a reader blocks retries until it lands (${calls} calls)`);
    calls = 0;
    let posixErr: unknown;
    await renameOverReaders("a", "b", { rename: flaky, windows: false }).catch((e: unknown) => (posixErr = e));
    ok(calls === 1 && (posixErr as NodeJS.ErrnoException | undefined)?.code === "EPERM", "OPE-2369: off Windows the rename never retries — the first EPERM escapes");
    calls = 0;
    let otherErr: unknown;
    const missing = async (): Promise<void> => {
      calls++;
      throw busy("ENOENT");
    };
    await renameOverReaders("a", "b", { rename: missing, windows: true }).catch((e: unknown) => (otherErr = e));
    ok(calls === 1 && (otherErr as NodeJS.ErrnoException | undefined)?.code === "ENOENT", "OPE-2369: a non-busy error (ENOENT) escapes at once, with no retry");
    calls = 0;
    let stuckErr: unknown;
    const stuck = async (): Promise<void> => {
      calls++;
      throw busy("EBUSY");
    };
    await renameOverReaders("a", "b", { rename: stuck, windows: true, attempts: 4 }).catch((e: unknown) => (stuckErr = e));
    ok(calls === 4 && (stuckErr as NodeJS.ErrnoException | undefined)?.code === "EBUSY", "OPE-2369: the retry is bounded — a handle that stays open makes the last error escape");
  }

  const { writeFileSync, existsSync } = await import("node:fs");
  const staging = join(gitProvider.root!(), ".oe-staging");
  const dead = join(staging, `${2 ** 31 - 2}-1`);
  const live = join(staging, `${process.ppid}-1`);
  writeFileSync(dead, "- a fact a crashed persist left behind\n");
  writeFileSync(live, "- another live process's in-flight write\n");
  __resetStagingSweepForTest();
  await gitProvider.writeTier(p, SURFACE, { "MEMORY.md": body }, "after a crash");
  ok(!existsSync(dead), "🔴 OPE-2297: a staged file whose writer is gone is swept — a purge could never reach it otherwise");
  ok(existsSync(live), "OPE-2297: a staged file whose writer is still live is left alone");

  const { mkdirSync } = await import("node:fs");
  const stuck = join(staging, `${2 ** 31 - 3}-1`);
  mkdirSync(join(stuck, "stuck"), { recursive: true });
  __resetStagingSweepForTest();
  const quiet = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  let threw: unknown;
  try {
    await gitProvider.writeTier(p, SURFACE, { "MEMORY.md": "# Atomic\n\n- written past a failed sweep\n" }, "past a failed sweep");
  } catch (err) {
    threw = err;
  } finally {
    console.error = quiet;
  }
  ok(threw === undefined, `🔴 OPE-2297: a failed staging sweep does not fail the write (${String(threw)})`);
  ok((await gitProvider.readTier(p, SURFACE))["MEMORY.md"]?.includes("written past a failed sweep") === true, "OPE-2297: …and the write landed");
  ok(logged.some((l) => l.includes("staging sweep skipped")), "OPE-2297: the sweep's failure was logged, so the catch really ran");
  ok(existsSync(stuck), "OPE-2297: the entry the sweep could not remove is still there");
}

_resetDbForTest();
cleanupTmp();
console.log(`✓ provider — ${passed} assertions (git + sqlite contract, org isolation, erasure, versioning)`);
