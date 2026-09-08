import { describe, expect, test } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OFF_CHAIN_BY_DESIGN,
  REPO_ROOT,
  ROOT_CHAIN_EXEMPT,
  ROOT_PKG_LABEL,
  ROOT_SUBPROCESS_LEGS,
  SHARD_COUNT,
  chainLegNames,
  chainLegs,
  legLabel,
  legsForShard,
  needsSubprocess,
  rootLegs,
  rootChainScriptNames,
  workspacePackages,
} from "./_legs.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function rootScripts(): Record<string, string> {
  return (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
}

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
    for (const script of Object.keys(rootScripts())) known.add(`${ROOT_PKG_LABEL} ${script}`);
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

describe("root chain parity", () => {
  test("rootLegs() resolves a plausible, non-trivial set", () => {
    const legs = rootLegs();
    expect(legs.length).toBeGreaterThan(50);
    expect(legs.length).toBeLessThan(200);
  });

  test("every root leg's file exists on disk", () => {
    for (const leg of rootLegs()) {
      expect(existsSync(leg.file), `${legLabel(leg)}: ${leg.file} does not exist`).toBe(true);
    }
  });

  test("root legs are appended into chainLegs() and land in the shard pool", () => {
    const withRoot = chainLegs();
    const withoutRoot = chainLegs(workspacePackages(), false);
    const root = rootLegs();
    expect(withRoot.length).toBe(withoutRoot.length + root.length);
    const rootLabels = new Set(root.map(legLabel));
    expect(rootLabels.size).toBeGreaterThan(0);
    const shardLabels = new Set<string>();
    for (let i = 0; i < SHARD_COUNT; i++) {
      for (const leg of legsForShard(i, withRoot)) shardLabels.add(legLabel(leg));
    }
    for (const label of rootLabels) expect(shardLabels.has(label), `${label} is not assigned to any shard`).toBe(true);
  });

  test("root legs carry the pkg label chainLegs() uses to distinguish them", () => {
    const legs = rootLegs();
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) expect(leg.pkg).toBe(ROOT_PKG_LABEL);
  });

  test("the CLI-argument legs actually carry their args", () => {
    const byScript = new Map(rootLegs().map((l) => [l.script, l]));
    const expectArgs: Record<string, string[]> = {
      "lint:docs-generate": ["--check"],
      "lint:capabilities": ["--check"],
      "lint:ingestion": ["--check"],
      "lint:overlays": ["--check"],
      "lint:settings-docs": ["--check"],
      "lint:publish-exports": ["--check"],
      "lint:roster": ["build", "--check"],
    };
    for (const [script, args] of Object.entries(expectArgs)) {
      const leg = byScript.get(script);
      expect(leg, `root leg "${script}" was not resolved at all`).toBeDefined();
      expect(leg?.args, `root leg "${script}" should carry args ${JSON.stringify(args)}`).toEqual(args);
    }
  });

  test("lint:script-chain is the FIRST token of the root test script, and stays off the batched pool", () => {
    const scripts = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> })
      .scripts;
    const testScript = scripts["test"]!;
    const firstToken = /npm\s+run\s+([A-Za-z0-9:_-]+)/.exec(testScript)?.[1];
    expect(firstToken).toBe("lint:script-chain");
    expect(rootLegs().some((l) => l.script === "lint:script-chain")).toBe(false);
  });

  test("the provider-discord workspace echo is still mentioned by the root test script, and stays unbatched", () => {
    const scripts = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> })
      .scripts;
    const testScript = scripts["test"]!;
    expect(testScript.includes("npm run test --workspace @open-everywhere/provider-discord")).toBe(true);
    expect(rootLegs().some((l) => l.pkg === "@open-everywhere/provider-discord")).toBe(false);
  });

  test("no root leg is named twice", () => {
    const names = rootLegs().map((l) => l.script);
    expect(new Set(names).size, "rootLegs() named the same script more than once").toBe(names.length);
  });

  test("every `test:*` script the ROOT package defines is reached by the root chain, or declared off-chain", () => {
    const reached = rootChainScriptNames();
    const unexplained = Object.keys(rootScripts())
      .filter((k) => k.startsWith("test:") && k !== "test:chain")
      .filter((k) => !reached.has(k))
      .filter((k) => !OFF_CHAIN_BY_DESIGN.has(`${ROOT_PKG_LABEL} ${k}`))
      .sort();
    expect(
      unexplained,
      "root `test:*` scripts that no chain runs and no OFF_CHAIN_BY_DESIGN entry explains — either chain them, or name them with a reason",
    ).toEqual([]);
  });

  test("the root off-chain declarations are exactly the root scripts that are off the chain", () => {
    const wronglyDeclared = [...OFF_CHAIN_BY_DESIGN.keys()]
      .filter((label) => label.startsWith(`${ROOT_PKG_LABEL} `))
      .map((label) => label.slice(ROOT_PKG_LABEL.length + 1))
      .filter((script) => rootChainScriptNames().has(script))
      .sort();
    expect(wronglyDeclared, "declared off-chain, but the root chain reaches it — delete the declaration").toEqual([]);
  });

  test("every declared ROOT_CHAIN_EXEMPT reason is substantive", () => {
    for (const [label, reason] of ROOT_CHAIN_EXEMPT) {
      expect(reason.length, `ROOT_CHAIN_EXEMPT entry "${label}" carries no reason`).toBeGreaterThan(20);
    }
    expect(ROOT_CHAIN_EXEMPT.size).toBe(2);
  });

  test("every ROOT_SUBPROCESS_LEGS entry names a real root leg, carries a reason, and IS routed to a subprocess", () => {
    const byScript = new Map(rootLegs().map((l) => [l.script, l]));
    for (const [script, reason] of ROOT_SUBPROCESS_LEGS) {
      const leg = byScript.get(script);
      expect(leg, `ROOT_SUBPROCESS_LEGS names "${script}", which rootLegs() does not resolve`).toBeDefined();
      expect(reason.length, `ROOT_SUBPROCESS_LEGS entry "${script}" carries no reason`).toBeGreaterThan(20);
      expect(needsSubprocess(leg!), `${legLabel(leg!)} should be routed to runLegInSubprocess`).toBe(true);
    }
  });
});
