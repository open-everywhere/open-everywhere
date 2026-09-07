import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

const require = createRequire(import.meta.url);

export function eveDistSrc(): string {
  return join(dirname(require.resolve("eve/package.json")), "dist", "src");
}

export function readEveDist(rel: string): string {
  return readFileSync(join(eveDistSrc(), rel), "utf8");
}

let cached: readonly string[] | undefined;

function allJsFiles(): readonly string[] {
  if (cached !== undefined) return cached;
  const root = eveDistSrc();
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".js")) out.push(relative(root, full));
    }
  };
  walk(root);
  cached = out.sort();
  return cached;
}

export function filesMatching(shape: RegExp): readonly string[] {
  const re = new RegExp(shape.source, shape.flags.replace(/[gy]/gu, ""));
  return allJsFiles().filter((rel) => re.test(readFileSync(join(eveDistSrc(), rel), "utf8")));
}

export function eveDistCarries(shape: RegExp): boolean {
  return filesMatching(shape).length > 0;
}

export function filesContainingAll(...needles: readonly string[]): readonly string[] {
  return allJsFiles().filter((rel) => {
    const src = readFileSync(join(eveDistSrc(), rel), "utf8");
    return needles.every((n) => src.includes(n));
  });
}
