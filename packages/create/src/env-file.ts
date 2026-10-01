import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeEnv } from "@open-everywhere/core/agent/ops/quickstart.js";

export function envLocalPath(cwd: string): string {
  return join(cwd, ".env.local");
}

function readEnvLocal(cwd: string): Record<string, string> {
  const p = envLocalPath(cwd);
  if (!existsSync(p)) return {};
  const text = readFileSync(p, "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function mergedEnv(cwd: string, processEnv: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return { ...readEnvLocal(cwd), ...processEnv };
}

export function isSet(v: string | undefined): boolean {
  return v !== undefined && v.trim() !== "";
}

export function writeEnvLocal(cwd: string, values: Readonly<Record<string, string>>): void {
  const p = envLocalPath(cwd);
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  writeFileSync(p, mergeEnv(existing, values), "utf8");
}

export const HOSTED_MISS_NOTE =
  "If you set these in the Vercel project instead, ignore this miss: the check reads only .env.local and this shell, never the project's env (`npx vercel env ls production` lists the names there)";
