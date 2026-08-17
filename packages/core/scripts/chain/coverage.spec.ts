import { describe, expect, test } from "vitest";
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SHARD_COUNT, chainLegs, chainLegNames, legsForShard, readCorePkg } from "./_legs.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("batched chain parity", () => {
  test("every shard index has a spec file, and every spec file has an index", () => {
    const onDisk = readdirSync(HERE)
      .filter((f) => /^shard-\d\d\.spec\.ts$/.test(f))
      .sort();
    const expected = Array.from({ length: SHARD_COUNT }, (_, i) => `shard-${String(i).padStart(2, "0")}.spec.ts`);
    expect(onDisk).toEqual(expected);
  });

  test("every chain leg is assigned to exactly one shard", () => {
    const legs = chainLegs();
    expect(legs.length).toBeGreaterThan(0);
    const seen = new Map<string, number>();
    for (let i = 0; i < SHARD_COUNT; i++) {
      for (const leg of legsForShard(i, legs)) {
        expect(seen.has(leg.script), `${leg.script} is assigned to more than one shard`).toBe(false);
        seen.set(leg.script, i);
      }
    }
    expect([...seen.keys()].sort()).toEqual(legs.map((l) => l.script).sort());
  });

  test("every `test:*` script package.json defines is on the chain", () => {
    const pkg = readCorePkg();
    const defined = Object.keys(pkg.scripts)
      .filter((k) => k.startsWith("test:") && k !== "test:chain")
      .sort();
    const onChain = [...chainLegNames(pkg)].sort();
    expect(onChain).toEqual(defined);
  });

  test("the chain names no leg twice", () => {
    const names = chainLegNames();
    expect(new Set(names).size).toBe(names.length);
  });
});
