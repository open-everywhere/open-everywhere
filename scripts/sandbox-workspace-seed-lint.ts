import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEED_DIR = join("agent", "sandbox", "workspace");

const FORBIDDEN = "memory";

function offendingSeedEntries(root: string): string[] {
  const dir = join(root, SEED_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry === FORBIDDEN)
    .map((entry) => join(SEED_DIR, entry));
}

const REPO_ROOT = process.cwd();
const offenders = offendingSeedEntries(REPO_ROOT);

if (offenders.length > 0) {
  console.error(
    `✗ sandbox-workspace-seed: the sandbox seed subtree carries the memory tree — ${offenders.join(", ")}\n` +
      "  eve copies this subtree into /workspace in EVERY sandbox, so it pre-creates a memory tier\n" +
      "  directory outside the session's plan. The root fence cannot fence a directory that already\n" +
      "  exists, and `persistMemoryNow` never reads it, so writes there are dropped silently.\n" +
      "  Delete it. Memory directories are materialised per session by hooks/memory.ts, from the plan.",
  );
  process.exit(1);
}

{
  const fake = mkdtempSync(join(tmpdir(), "oe-seed-lint-"));
  try {
    mkdirSync(join(fake, SEED_DIR, FORBIDDEN, "surface"), { recursive: true });
    writeFileSync(join(fake, SEED_DIR, FORBIDDEN, "surface", "MEMORY.md"), "# seeded\n");
    const dirty = offendingSeedEntries(fake);
    if (dirty.length !== 1 || dirty[0] !== join(SEED_DIR, FORBIDDEN)) {
      console.error(`✗ sandbox-workspace-seed: the gate did NOT flag a seeded memory tree (got ${JSON.stringify(dirty)}).`);
      process.exit(1);
    }
    rmSync(join(fake, SEED_DIR, FORBIDDEN), { recursive: true, force: true });
    writeFileSync(join(fake, SEED_DIR, "README.md"), "ordinary seed file\n");
    if (offendingSeedEntries(fake).length !== 0) {
      console.error("✗ sandbox-workspace-seed: the gate flagged an ordinary seed file — it is over-broad.");
      process.exit(1);
    }
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
}

console.log("✅ sandbox-workspace-seed: the sandbox seed subtree carries no memory tree (2 controls checked)");
