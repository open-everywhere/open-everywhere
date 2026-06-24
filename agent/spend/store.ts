import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Partition } from "../memory/partition.js";
import { safeName } from "../memory/layout.js";
import { addUsage, emptyWindow, windowTokens, type SurfaceLedger, type Usage } from "./spend.js";

const ROOT = process.env.OE_SPEND_DIR ? process.env.OE_SPEND_DIR : join(process.cwd(), ".open-everywhere-spend");

export function spendRoot(): string {
  return ROOT;
}

function surfaceFile(org: string, surfaceKey: string): string {
  return join(ROOT, safeName(org), ...surfaceKey.split("/"), "spend.json");
}

function git(args: string[]): boolean {
  try {
    const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf-8" });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}
function ensureRepo(): void {
  if (existsSync(join(ROOT, ".git"))) return;
  if (!git(["init", "--quiet"])) return;
  git(["config", "user.email", "open-everywhere@local"]);
  git(["config", "user.name", "Open Everywhere"]);
}

async function readLedger(org: string, surfaceKey: string): Promise<SurfaceLedger> {
  const file = surfaceFile(org, surfaceKey);
  if (!existsSync(file)) return { windows: {} };
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8"));
    return parsed && typeof parsed === "object" && parsed.windows ? (parsed as SurfaceLedger) : { windows: {} };
  } catch {
    return { windows: {} };
  }
}

export async function recordUsage(p: Partition, period: string, usage: Usage): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  ensureRepo();
  const ledger = await readLedger(p.org, p.surfaceKey);
  ledger.windows[period] = addUsage(ledger.windows[period] ?? emptyWindow(), usage);
  const file = surfaceFile(p.org, p.surfaceKey);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(ledger, null, 2) + "\n", "utf-8");
  if (git(["add", "-A"]) && git(["diff", "--cached", "--quiet"]) === false) {
    git(["commit", "--quiet", "-m", `spend ${p.org}/${p.surfaceKey} ${period}`]);
  }
}

export async function surfaceTokens(org: string, surfaceKey: string, period: string): Promise<number> {
  return windowTokens((await readLedger(org, surfaceKey)).windows[period]);
}

export async function workspaceTokens(org: string, workspaceKey: string, period: string): Promise<number> {
  let total = 0;
  for (const l of await allLedgers()) {
    if (l.org === org && l.surfaceKey.startsWith(workspaceKey + "/")) {
      total += windowTokens(l.ledger.windows[period]);
    }
  }
  return total;
}

export async function allLedgers(): Promise<{ org: string; surfaceKey: string; ledger: SurfaceLedger }[]> {
  if (!existsSync(ROOT)) return [];
  const out: { org: string; surfaceKey: string; ledger: SurfaceLedger }[] = [];
  async function walk(dir: string, parts: string[]): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) await walk(child, [...parts, entry.name]);
      else if (entry.name === "spend.json") {
        try {
          const parsed = JSON.parse(await readFile(child, "utf-8"));
          if (parsed?.windows && parts.length >= 2) {
            const [org, ...rest] = parts;
            out.push({ org, surfaceKey: rest.join("/"), ledger: parsed as SurfaceLedger });
          }
        } catch {
        }
      }
    }
  }
  await walk(ROOT, []);
  return out;
}
