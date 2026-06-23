import type { SandboxSession } from "eve/sandbox";
import type { MemoryFiles } from "./store.js";

export const MEMORY_DIR = "memory";

export async function syncIntoSandbox(
  sandbox: SandboxSession,
  files: MemoryFiles,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await sandbox.writeTextFile({ path: `${MEMORY_DIR}/${rel}`, content });
  }
}

export async function readFromSandbox(sandbox: SandboxSession): Promise<MemoryFiles> {
  const listing = await sandbox.run({
    command: `cd ${MEMORY_DIR} 2>/dev/null && find . -type f | sed 's|^\\./||' || true`,
  });
  const out: MemoryFiles = {};
  const rels = listing.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== ".git" && !l.startsWith(".git/"));
  for (const rel of rels) {
    const content = await sandbox.readTextFile({ path: `${MEMORY_DIR}/${rel}` });
    if (content !== null) out[rel] = content;
  }
  return out;
}

export async function appendToSandboxFile(
  sandbox: SandboxSession,
  relPath: string,
  block: string,
): Promise<string> {
  const existing = (await sandbox.readTextFile({ path: `${MEMORY_DIR}/${relPath}` })) ?? "";
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const next = `${existing}${sep}${block.endsWith("\n") ? block : block + "\n"}`;
  await sandbox.writeTextFile({ path: `${MEMORY_DIR}/${relPath}`, content: next });
  return next;
}
