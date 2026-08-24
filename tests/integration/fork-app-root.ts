import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ISOLATED_EVE_ENTRY = ".workflow-data";

export function constructForkAppRoot(repoRoot: string): string {
  const forkRoot = mkdtempSync(join(tmpdir(), "oe-it-approot-"));
  for (const entry of readdirSync(repoRoot)) {
    if (entry === ".eve") continue;
    symlinkSync(join(repoRoot, entry), join(forkRoot, entry));
  }
  const forkEve = join(forkRoot, ".eve");
  mkdirSync(forkEve);
  const repoEve = join(repoRoot, ".eve");
  for (const entry of readdirSync(repoEve, { withFileTypes: true }).map((d) => d.name)) {
    if (entry === ISOLATED_EVE_ENTRY) continue;
    symlinkSync(join(repoEve, entry), join(forkEve, entry));
  }
  mkdirSync(join(forkEve, ISOLATED_EVE_ENTRY));
  return forkRoot;
}

export function removeForkAppRoot(forkRoot: string): void {
  removeTreeWithoutFollowingLinks(forkRoot);
}

function removeTreeWithoutFollowingLinks(dir: string): void {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    if (stat.isDirectory()) removeTreeWithoutFollowingLinks(path);
    else unlinkSync(path);
  }
  try {
    rmdirSync(dir);
  } catch {
  }
}
