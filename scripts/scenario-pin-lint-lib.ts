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
