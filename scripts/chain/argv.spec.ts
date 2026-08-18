import { describe, expect, test } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChainLeg } from "./_legs.js";
import { runLegInProcess } from "./_run-shard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "__fixtures__", "argv-probe.ts");

function probeLeg(args?: readonly string[]): ChainLeg {
  return { pkg: "<fixture>", dir: HERE, script: "argv-probe", file: FIXTURE, ...(args ? { args } : {}) };
}

function readProbe(): string[] | undefined {
  return (globalThis as unknown as { __oeArgvProbe?: string[] }).__oeArgvProbe;
}

describe("batched runner threads leg.args onto process.argv", () => {
  test("args reach the imported module", async () => {
    await runLegInProcess(probeLeg(["--check", "extra"]));
    expect(readProbe()).toEqual(["--check", "extra"]);
  });

  test("no args means an empty argv tail — the negative control", async () => {
    await runLegInProcess(probeLeg());
    expect(readProbe()).toEqual([]);
  });

  test("process.argv is restored after the import", async () => {
    const before = process.argv;
    await runLegInProcess(probeLeg(["--check"]));
    expect(process.argv).toBe(before);
  });
});
