import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SetupRoute } from "./engine.js";

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

export function missNote(route: SetupRoute): string {
  const where = route === "docker" ? "the container's environment" : "the Vercel project";
  const list = route === "docker" ? "`docker inspect` lists the names there" : "`npx vercel env ls production` lists the names there";
  return `Did you set these on ${where} instead? Re-run with --host https://<host>: the env step then also reads the deployment's own verdicts from its status route. Without --host it reads only .env.local and this shell (${list})`;
}
