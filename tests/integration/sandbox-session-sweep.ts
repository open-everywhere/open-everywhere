import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const JUST_BASH_SESSIONS_RELPATH = join(".eve", "sandbox-cache", "just-bash", "sessions");

export function sweepStaleSandboxSessions(root: string, now: number = Date.now()): number {
  const sessionsDir = join(root, JUST_BASH_SESSIONS_RELPATH);
  if (!existsSync(sessionsDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(sessionsDir)) {
    const path = join(sessionsDir, entry);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) continue;
    if (stat.mtimeMs >= now) continue;
    rmSync(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
