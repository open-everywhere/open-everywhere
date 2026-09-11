import type { PinResolution } from "../packages/core/scripts/e2e/deployed-build.js";

export interface PinSite {
  readonly file: string;
  readonly line: number;
  readonly sha: string;
}

export function collectShaPins(source: string, file: string): PinSite[] {
  const sites: PinSite[] = [];
  const lines = source.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const m of line.matchAll(/["'`]([0-9a-f]{40})["'`]/g)) {
      sites.push({ file, line: i + 1, sha: m[1]! });
    }
  }
  return sites;
}

export type PinVerdict = "ok" | "unreachable" | "unresolvable";

export function pinVerdict(resolution: PinResolution, reachable: boolean): PinVerdict {
  if (resolution !== "present" && resolution !== "deepened") return "unresolvable";
  return reachable ? "ok" : "unreachable";
}
