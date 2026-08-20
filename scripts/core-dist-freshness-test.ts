import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDistStale, newestMtimeMs } from "./core-dist-freshness.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

{
  ok(isDistStale(200, 100) === true, "isDistStale: source newer than dist -> stale");
  ok(isDistStale(100, 200) === false, "isDistStale: dist newer than source -> fresh");
  ok(isDistStale(100, 100) === false, "isDistStale: equal mtimes -> fresh (not strictly newer)");
  ok(isDistStale(undefined, 100) === false, "isDistStale: no source files found -> nothing to be stale against");
  ok(isDistStale(100, undefined) === true, "isDistStale: dist has no files at all -> stale (never built)");

  const invertedIsStale = (srcMs: number | undefined, distMs: number | undefined) =>
    srcMs !== undefined && distMs !== undefined && srcMs < distMs;
  ok(isDistStale(200, 100) !== invertedIsStale(200, 100), "negative control: isDistStale disagrees with an inverted (wrong) comparator on the stale case");
}

{
  const root = mkdtempSync(join(tmpdir(), "oe-dist-freshness-test-"));
  try {
    ok(newestMtimeMs(join(root, "does-not-exist"), [".ts"]) === undefined, "newestMtimeMs: a missing directory reports undefined");

    const sub = join(root, "a", "b");
    mkdirSync(sub, { recursive: true });
    const older = join(root, "a", "old.ts");
    const newer = join(sub, "new.ts");
    const ignored = join(sub, "new.d.ts.map");
    writeFileSync(older, "// old");
    writeFileSync(newer, "// new");
    writeFileSync(ignored, "// ignored");
    const t0 = new Date(2020, 0, 1);
    const t1 = new Date(2024, 0, 1);
    utimesSync(older, t0, t0);
    utimesSync(newer, t1, t1);
    utimesSync(ignored, new Date(2030, 0, 1), new Date(2030, 0, 1));

    const newest = newestMtimeMs(root, [".ts"]);
    ok(newest !== undefined && Math.abs(newest - t1.getTime()) < 1000, "newestMtimeMs: recurses into subdirectories and picks the newest matching file");
    ok(newest !== undefined && newest < new Date(2030, 0, 1).getTime(), "newestMtimeMs: ignores a file whose extension is not in the filter, even if it is newer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`✓ core-dist-freshness: ${passed} assertions passed`);
