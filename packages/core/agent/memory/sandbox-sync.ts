import type { SandboxSession } from "eve/sandbox";
import type { MemoryFiles, Tier } from "./store.js";
import { safeName } from "./layout.js";

const BASE = "memory";

export function tierSandboxDir(tier: Tier): string {
  switch (tier.kind) {
    case "workspace":
      return `${BASE}/workspace`;
    case "silo":
      return `${BASE}/${safeName(tier.name)}`;
    case "surface":
      return `${BASE}/surface`;
  }
}

export async function syncTierIntoSandbox(
  sandbox: SandboxSession,
  tier: Tier,
  files: MemoryFiles,
): Promise<void> {
  const dir = tierSandboxDir(tier);
  for (const [rel, content] of Object.entries(files)) {
    await sandbox.writeTextFile({ path: `${dir}/${rel}`, content });
  }
}

export async function readTierFromSandbox(
  sandbox: SandboxSession,
  tier: Tier,
): Promise<MemoryFiles> {
  const dir = tierSandboxDir(tier);
  const listing = await sandbox.run({
    command: `cd ${dir} 2>/dev/null && find . -type f | sed 's|^\\./||' || true`,
  });
  const out: MemoryFiles = {};
  const rels = listing.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== ".git" && !l.startsWith(".git/"));
  for (const rel of rels) {
    const content = await sandbox.readTextFile({ path: `${dir}/${rel}` });
    if (content !== null) out[rel] = content;
  }
  return out;
}

export async function removeTierFiles(
  sandbox: SandboxSession,
  tier: Tier,
  rels: readonly string[],
): Promise<void> {
  if (rels.length === 0) return;
  const dir = tierSandboxDir(tier);
  const quoted = rels.map((rel) => `'${`${dir}/${rel}`.replace(/'/g, "'\\''")}'`).join(" ");
  await sandbox.run({ command: `rm -f ${quoted}` });
}

export async function removeTierDir(sandbox: SandboxSession, tier: Tier): Promise<void> {
  const dir = tierSandboxDir(tier);
  await sandbox.run({ command: `rm -rf '${dir.replace(/'/g, "'\\''")}'` });
}

export async function readTierFile(
  sandbox: SandboxSession,
  tier: Tier,
  rel: string,
): Promise<string | null> {
  return sandbox.readTextFile({ path: `${tierSandboxDir(tier)}/${rel}` });
}

export async function writeTierFile(
  sandbox: SandboxSession,
  tier: Tier,
  rel: string,
  content: string,
): Promise<void> {
  await sandbox.writeTextFile({ path: `${tierSandboxDir(tier)}/${rel}`, content });
}
