import type { MemorySelection } from "./selection.js";

export interface MemorySilo {
  readonly name: string;
  readonly description?: string;
  readonly provider: string;
  readonly container?: string;
  readonly path?: string;
  readonly readOnly?: boolean;
  readonly skill?: string;
  readonly recursive?: boolean;
  readonly select?: MemorySelection;
}

export function defineMemorySilo(silo: MemorySilo): MemorySilo {
  return silo;
}

export function assertSilosValid(silos: readonly MemorySilo[]): void {
  const bad: string[] = [];
  for (const s of silos) {
    const hasProvider = typeof s.provider === "string" && s.provider.length > 0;
    if (!hasProvider) bad.push(`  "${s.name ?? "(unnamed)"}" has no provider (every silo is materialized — set provider)`);
    if (s.select && s.recursive !== undefined) {
      bad.push(`  "${s.name}" sets BOTH select and recursive (select supersedes the simple toggle — drop recursive)`);
    }
    if (s.select) {
      const d = s.select.default;
      if (d !== "recurse" && d !== "include") bad.push(`  "${s.name}" select.default must be "recurse" or "include" (got ${JSON.stringify(d)})`);
      for (const r of s.select.rules ?? []) {
        if (r.mode !== "recurse" && r.mode !== "include" && r.mode !== "exclude") {
          bad.push(`  "${s.name}" select rule "${r.path}" has invalid mode ${JSON.stringify(r.mode)}`);
        }
        if (typeof r.path !== "string" || r.path.trim().length === 0) bad.push(`  "${s.name}" has a select rule with an empty path`);
      }
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid memory silo(s):\n" + bad.join("\n") + "\n(memory/silo.ts / docs/capabilities/memory.md)",
    );
  }
}
