
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-write-road-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");

const { writeMemoryTier } = await import("../agent/memory/write-road.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { siloTier, SURFACE } = await import("../agent/memory/store.js");
const { OPERATIONAL_AUDIT_ACTIONS } = await import("../agent/audit/action-registry.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const ROAD = "packages/core/agent/memory/write-road.ts";
const IMPLEMENTATIONS: ReadonlySet<string> = new Set([
  "packages/core/agent/memory/provider.ts",
  "packages/core/agent/memory/store.ts",
  "packages/core/agent/memory/sqlite.ts",
  "packages/core/agent/memory/postgres.ts",
]);

function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(repoRoot, abs).split("\\").join("/");
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "scripts" || entry.name === "tests") continue;
      productionSources(abs, out);
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
    if (/(?:-test|\.test|\.spec)\.ts$/.test(entry.name)) continue;
    if (!/(?:^|\/)agent\//.test(rel)) continue;
    out.push(rel);
  }
  return out;
}

const roots = ["agent", "packages/core/agent", "packages/providers", "packages/adapters/agent"].filter((r) => {
  try {
    return statSync(join(repoRoot, r)).isDirectory();
  } catch {
    return false;
  }
});
const sources = roots.flatMap((r) => productionSources(join(repoRoot, r)));
ok(sources.length > 100, `the parity scan found the production sources (${sources.length}) — an empty scan proves nothing`);

const WRITE_TIER_CALL = /\.writeTier\s*\(/;
const bypasses = sources.filter((rel) => {
  if (rel === ROAD || IMPLEMENTATIONS.has(rel)) return false;
  return WRITE_TIER_CALL.test(readFileSync(join(repoRoot, rel), "utf-8"));
});
ok(
  bypasses.length === 0,
  `PARITY: every durable memory write goes through memory/write-road.ts — these call a provider's writeTier directly and would leave no memory.write row: ${bypasses.join(", ")}`,
);

ok(WRITE_TIER_CALL.test(readFileSync(join(repoRoot, ROAD), "utf-8")), "the detector really matches a writeTier call (proved on the road itself)");

ok(OPERATIONAL_AUDIT_ACTIONS.includes("memory.write"), "memory.write is a registered audit action");
ok(OPERATIONAL_AUDIT_ACTIONS.includes("memory.operational_write"), "memory.operational_write is a registered audit action");

const partition = {
  org: "acme",
  platform: "slack",
  workspace: "T1",
  surface: "C1",
  key: "slack/T1/C1",
  surfaceKey: "slack/T1/C1",
} as unknown as Parameters<typeof writeMemoryTier>[0]["partition"];

function stubProvider(version: string | null): Parameters<typeof writeMemoryTier>[0]["provider"] {
  return {
    id: "stub",
    readTier: async () => ({}),
    ensureTier: async () => ({}),
    writeTier: async () => version,
    deleteTier: async () => undefined,
  } as unknown as Parameters<typeof writeMemoryTier>[0]["provider"];
}

const silo = { name: "team-brain", provider: "stub" };

const changed = await writeMemoryTier({
  provider: stubProvider("sha-1"),
  partition,
  tier: siloTier("team-brain"),
  files: { "MEMORY.md": "a\n", "notes.md": "b\n" },
  message: "test write",
  silo,
  road: "session-persist",
  principalId: "U1",
  extra: { outcome: "edited", sessionId: "s-1" },
});
ok(changed.changed && changed.version === "sha-1", "a write that changed the store reports its version");

let rows = await readAudit({ org: "acme", action: "memory.write" });
ok(rows.length === 1, `a changed write leaves exactly one memory.write row (got ${rows.length})`);
const d = rows[0]!.detail as Record<string, unknown>;
ok(d.road === "session-persist", "the row names the ROAD that wrote it");
ok(d.kind === "memory", "the row names the KIND");
ok(d.silo === "team-brain" && d.provider === "stub", "the row carries the silo and its provider");
ok(d.tier === "silo:team-brain", "the row carries the tier id");
ok(d.files === 2 && d.version === "sha-1", "the row carries the file count and the version token");
ok(d.outcome === "edited" && d.sessionId === "s-1", "the road's own extra detail rides along");
ok(rows[0]!.principalId === "U1" && rows[0]!.platform === "slack", "the row is stamped with WHO and WHERE");

const noop = await writeMemoryTier({
  provider: stubProvider(null),
  partition,
  tier: siloTier("team-brain"),
  files: { "MEMORY.md": "a\n" },
  message: "idempotent",
  silo,
  road: "session-persist",
});
ok(!noop.changed && noop.version === null, "a write that changed nothing reports no version");
rows = await readAudit({ org: "acme", action: "memory.write" });
ok(rows.length === 1, "a no-op write adds no row");

await writeMemoryTier({
  provider: stubProvider("sha-2"),
  partition,
  tier: SURFACE,
  files: { "STATUS.md": "working\n" },
  message: "status",
  road: "status-board",
  kind: "operational",
});
rows = await readAudit({ org: "acme", action: "memory.write" });
ok(rows.length === 1, "an operational write adds NO memory.write row — the fact gate stays honest");
const opRows = await readAudit({ org: "acme", action: "memory.operational_write" });
ok(opRows.length === 1 && (opRows[0]!.detail as Record<string, unknown>).kind === "operational", "an operational write files under memory.operational_write");
ok((opRows[0]!.detail as Record<string, unknown>).silo === undefined, "an operational write names no silo — it has none");

await writeMemoryTier({
  provider: stubProvider("sha-3"),
  partition,
  tier: siloTier("team-brain"),
  files: { "MEMORY.md": "c\n" },
  message: "collide",
  silo,
  road: "control-edit",
  extra: { silo: "SOMETHING-ELSE", version: "FORGED", relPath: "MEMORY.md" },
});
rows = await readAudit({ org: "acme", action: "memory.write" });
ok(rows.length === 2, "the third content write leaves a second memory.write row");
const latest = rows[0]!.detail as Record<string, unknown>;
ok(latest.silo === "team-brain" && latest.version === "sha-3", "a colliding extra key is DROPPED, never allowed to restate a canonical field");
ok(latest.relPath === "MEMORY.md", "a non-colliding extra key still rides along");

rmSync(tmp, { recursive: true, force: true });
console.log(`memory write road: ${passed} assertions passed`);
