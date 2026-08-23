import { execFileSync } from "node:child_process";

const EVE_PIN_MANIFESTS = [
  "package.json",
  "packages/core/package.json",
  "packages/adapters/package.json",
  "packages/providers/notion/package.json",
  "packages/providers/slack/package.json",
  "packages/providers/discord/package.json",
  "packages/providers/linear/package.json",
  "packages/providers/github/package.json",
  "packages/providers/teams/package.json",
] as const;

function gitShow(sha: string, path: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${sha}:${path}`], { encoding: "utf8" });
  } catch {
    return undefined;
  }
}

function readJsonField(sha: string, path: string, field: string): string | undefined {
  const text = gitShow(sha, path);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const v = parsed[field];
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

const DEPENDENCY_BUCKETS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

function readDependencyField(sha: string, path: string, name: string): string | undefined {
  const text = gitShow(sha, path);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed[name] === "string") return parsed[name] as string;
    for (const bucket of DEPENDENCY_BUCKETS) {
      const v = parsed[bucket];
      if (typeof v === "object" && v !== null && typeof (v as Record<string, unknown>)[name] === "string") {
        return (v as Record<string, unknown>)[name] as string;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function commitDateAt(sha: string): string {
  const out = execFileSync("git", ["show", "-s", "--format=%cI", sha], { encoding: "utf8" }).trim();
  return out.slice(0, 10);
}

export function oeVersionAt(sha: string): string | undefined {
  return readJsonField(sha, "package.json", "version");
}

export function evePinAt(sha: string): string | undefined {
  const pins = new Map<string, string | undefined>();
  for (const manifest of EVE_PIN_MANIFESTS) pins.set(manifest, readDependencyField(sha, manifest, "eve"));
  const values = new Set([...pins.values()].filter((v): v is string => v !== undefined));
  if (values.size > 1) {
    const detail = [...pins.entries()].map(([m, v]) => `${m}=${v ?? "(absent)"}`).join(", ");
    throw new Error(`eve pin disagrees across manifests at ${sha} — this tree is already broken, refusing to derive a record from it: ${detail}`);
  }
  return values.size === 1 ? [...values][0] : undefined;
}

export function providerPackagesAt(sha: string): string[] {
  try {
    const out = execFileSync("git", ["ls-tree", "-d", "--name-only", `${sha}:packages/providers`], { encoding: "utf8" });
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .sort();
  } catch {
    return [];
  }
}
