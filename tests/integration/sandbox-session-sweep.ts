import { chmodSync, existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const JUST_BASH_SESSIONS_RELPATH = join(".eve", "sandbox-cache", "just-bash", "sessions");

function chmodTreeWritable(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined || stat.isSymbolicLink()) return;
  try {
    chmodSync(path, stat.mode | 0o200);
  } catch {
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path)) chmodTreeWritable(join(path, entry));
}

export function sweepStaleSandboxSessions(root: string, now: number = Date.now()): number {
  const sessionsDir = join(root, JUST_BASH_SESSIONS_RELPATH);
  if (!existsSync(sessionsDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(sessionsDir)) {
    const path = join(sessionsDir, entry);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) continue;
    if (stat.mtimeMs >= now) continue;
    chmodTreeWritable(path);
    rmSync(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
