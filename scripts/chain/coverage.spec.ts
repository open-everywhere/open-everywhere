import { describe, expect, test } from "vitest";
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OFF_CHAIN_BY_DESIGN,
  SHARD_COUNT,
  chainLegNames,
  chainLegs,
  legLabel,
  legsForShard,
  needsSubprocess,
  workspacePackages,
} from "./_legs.js";

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
    const seen = new Set<string>();
    for (let i = 0; i < SHARD_COUNT; i++) {
      for (const leg of legsForShard(i, legs)) {
        expect(seen.has(legLabel(leg)), `${legLabel(leg)} is assigned to more than one shard`).toBe(false);
        seen.add(legLabel(leg));
      }
    }
    expect([...seen].sort()).toEqual(legs.map(legLabel).sort());
  });

  test("every `test:*` script a package defines is on that package's chain", () => {
    for (const pkg of workspacePackages()) {
      const chain = pkg.scripts["test:chain"];
      if (!chain) continue;
      const defined = Object.keys(pkg.scripts)
        .filter((k) => k.startsWith("test:") && k !== "test:chain")
        .filter((k) => !OFF_CHAIN_BY_DESIGN.has(`${pkg.name} ${k}`))
        .sort();
      const onChain = [...chainLegNames(chain)].sort();
      expect(onChain, `${pkg.name}: test:chain and the defined test:* scripts disagree`).toEqual(defined);
    }
  });

  test("every declared off-chain exemption still names a real script", () => {
    const known = new Set<string>();
    for (const pkg of workspacePackages()) {
      for (const script of Object.keys(pkg.scripts)) known.add(`${pkg.name} ${script}`);
    }
    for (const [label, reason] of OFF_CHAIN_BY_DESIGN) {
      expect(known.has(label), `OFF_CHAIN_BY_DESIGN names "${label}", which no package defines`).toBe(true);
      expect(reason.length, `OFF_CHAIN_BY_DESIGN entry "${label}" carries no reason`).toBeGreaterThan(20);
    }
  });

  test("the in-process and subprocess routes together cover every leg", () => {
    const legs = chainLegs();
    const sub = legs.filter(needsSubprocess);
    const inProc = legs.filter((l) => !needsSubprocess(l));
    expect(sub.length + inProc.length).toBe(legs.length);
    expect(sub.length).toBeGreaterThan(0);
    expect(sub.length).toBeLessThan(legs.length / 10);
  });

  test("no package chains a leg twice", () => {
    for (const pkg of workspacePackages()) {
      const chain = pkg.scripts["test:chain"];
      if (!chain) continue;
      const names = chainLegNames(chain);
      expect(new Set(names).size, `${pkg.name}: test:chain names a leg more than once`).toBe(names.length);
    }
  });

  test("every workspace with `test:*` scripts declares a `test:chain`", () => {
    const WITHOUT_CHAIN = new Set(["@open-everywhere/provider-discord"]);
    for (const pkg of workspacePackages()) {
      const hasSuites = Object.keys(pkg.scripts).some((k) => k.startsWith("test:") && k !== "test:chain");
      if (!hasSuites) continue;
      expect(
        pkg.scripts["test:chain"] !== undefined || WITHOUT_CHAIN.has(pkg.name),
        `${pkg.name} defines test:* scripts but no test:chain — nothing runs them`,
      ).toBe(true);
    }
  });
});
