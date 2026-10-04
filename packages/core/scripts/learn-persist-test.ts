import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryFiles } from "../agent/memory/store.js";
import { removeTempDir } from "./_temp-dir.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-learn-persist-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

const { mergePreservingConflicts, guardDestructiveWrites, hashFiles, conflictName } = await import("../agent/hooks/memory.js");
const { writeEnrichment } = await import("../agent/memory/dream/learn.js");
const { providerById } = await import("../agent/memory/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { siloTier } = await import("../agent/memory/store.js");

const provider = providerById("sqlite");
const silo = { name: "brain", provider: "sqlite" as const };
const tier = siloTier("brain");
const p = { org: "acme", platform: "acme", workspace: "acme", surface: "acme", workspaceKey: "acme", surfaceKey: "acme", key: "acme" } as never;

async function sessionEnd(sandboxSnapshot: MemoryFiles, bullet: string, sid: string): Promise<MemoryFiles> {
  const baseline = hashFiles(sandboxSnapshot);
  await writeEnrichment(p, { tier, silo }, [bullet]);
  const hostCurrent = await provider.readTier(p, tier, silo);
  const merged = mergePreservingConflicts(hostCurrent, sandboxSnapshot, baseline, sid);
  const { files } = guardDestructiveWrites(hostCurrent, merged.files, sid);
  await provider.writeTier(p, tier, files, `session ${sid}`, silo);
  ok(merged.conflicts.length === 0, `session end (${sid}): enrichment is NOT misclassified as a concurrent conflict`);
  ok(files[conflictName("RECURRING.md", sid)] === undefined, `session end (${sid}): no .conflict- sibling minted for RECURRING.md`);
  return await provider.readTier(p, tier, silo);
}

{
  const after = await sessionEnd({}, "- 2026-08-01: recurring workflow — deploy staging (seen 3x) [[MEMORY]]", "sessAAA1");
  ok(after["RECURRING.md"]?.includes("deploy staging") ?? false, "1st enrichment survives (silo had no RECURRING.md at session start)");
}

{
  const snapshot = await provider.readTier(p, tier, silo);
  const before = snapshot["RECURRING.md"] ?? "";
  const after = await sessionEnd(snapshot, "- 2026-08-02: recurring workflow — rotate keys (seen 3x) [[MEMORY]]", "sessBBB2");
  ok(after["RECURRING.md"]?.includes("deploy staging") ?? false, "2nd enrichment: the 1st session's bullet is still present");
  ok(after["RECURRING.md"]?.includes("rotate keys") ?? false, "2nd enrichment SURVIVES the same session's persist (the bug: was reverted)");
  ok((after["RECURRING.md"]?.length ?? 0) > before.length, "2nd enrichment: live RECURRING.md GREW, not reverted to the sandbox snapshot");
}

{
  const snapshot = await provider.readTier(p, tier, silo);
  const after = await sessionEnd(snapshot, "- 2026-08-03: recurring workflow — audit refunds (seen 3x) [[MEMORY]]", "sessCCC3");
  ok(["deploy staging", "rotate keys", "audit refunds"].every((s) => after["RECURRING.md"]!.includes(s)), "3rd enrichment: all three durable notes coexist (no reversion, no loss)");
}

{
  const snapshot = await provider.readTier(p, tier, silo);
  const after = await sessionEnd(snapshot, "- 2026-08-04: recurring workflow — rotate keys (seen 7x) [[MEMORY]]", "sessFFF6");
  const body = after["RECURRING.md"] ?? "";
  const rotateLines = body.split("\n").filter((l) => l.includes("rotate keys"));
  ok(rotateLines.length === 1, `🔴 a re-delivered enrichment leaves ONE line for its signature (found ${rotateLines.length})`);
  ok(rotateLines[0].includes("seen 7x"), "🔴 …and that line carries the NEW count");
  ok(!body.includes("rotate keys (seen 3x)"), "🔴 …with the superseded line gone");
  ok(["deploy staging", "audit refunds"].every((t) => body.includes(t)), "NEGATIVE CONTROL: the other signatures' bullets are untouched — only the matching key is rewritten");

  const rows = await readAudit({ org: "acme", action: "memory.write" });
  const enrichRows = rows.filter((r) => (r.detail as { road?: string } | undefined)?.road === "dream-learn");
  ok(enrichRows.length > 0, "the enrichment wrote memory.write rows on the one road");
  ok((enrichRows[0].detail as { superseded?: number }).superseded === 1, "🔴 the newest enrichment's row counts the line it REWROTE (superseded=1)");
  ok(
    enrichRows.some((r) => (r.detail as { superseded?: number }).superseded === 0),
    "NEGATIVE CONTROL: an earlier enrichment that only ADDED a bullet counts superseded=0 — the field tracks the act, it is not a constant",
  );
}

{
  const snapshot = await provider.readTier(p, tier, silo);
  const after = await sessionEnd(snapshot, "- 2026-08-05: recurring workflow — rotate certs (seen 3x) [[MEMORY]]", "sessGGG7");
  const body = after["RECURRING.md"] ?? "";
  ok(body.includes("rotate keys (seen 7x)"), "🔴 the near-miss signature did NOT delete `rotate keys` — the key is exact, not a similarity");
  ok(body.includes("rotate certs (seen 3x)"), "…and the new workflow was appended");
  ok(["deploy staging", "audit refunds"].every((t) => body.includes(t)), "…and every other workflow still stands");
}

{
  const baseline = hashFiles({ "MEMORY.md": "v1" });
  const hostCurrent = { "MEMORY.md": "v1\n- other session bullet" };
  const fromSandbox = { "MEMORY.md": "v1\n- our bullet" };
  const merged = mergePreservingConflicts(hostCurrent, fromSandbox, baseline, "sessDDD4");
  ok(merged.conflicts.length === 1 && merged.conflicts[0] === "MEMORY.md", "cross-session conflict on a normal file is STILL detected");
  ok(merged.files[conflictName("MEMORY.md", "sessDDD4")] === "v1\n- other session bullet", "…and the concurrent version is STILL preserved as a .conflict- sibling");
  ok(merged.files["MEMORY.md"] === "v1\n- our bullet", "…and our version is STILL the live file (sandbox wins for agent-owned files)");
}

{
  const hostBrain = { "RECURRING.md": ["## Recurring", "- a", "- b", "- c", "- d", "- e"].join("\n") };
  const baseline = hashFiles(hostBrain);
  const staleSandbox = { "RECURRING.md": "## Recurring\n" };
  const merged = mergePreservingConflicts(hostBrain, staleSandbox, baseline, "sessEEE5");
  ok(merged.files["RECURRING.md"] === hostBrain["RECURRING.md"], "host-owned RECURRING.md: the host copy always wins; a stale sandbox snapshot can never truncate it");
  ok(merged.conflicts.length === 0, "host-owned RECURRING.md is never reported as a conflict");
}

await removeTempDir(tmp);
console.log(`\n✓ learn-persist: ${n} assertions passed (RECURRING.md enrichment survives the same-session persist across repeated session ends; cross-session conflict detection on normal files unchanged)\n`);
