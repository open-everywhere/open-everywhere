import type { Partition } from "./partition.js";
import type { Tier } from "./store.js";
import type { MemoryFiles } from "./store.js";

export function safeName(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 100) || "unnamed";
}

export function tierRelDir(p: Partition, tier: Tier): string {
  switch (tier.kind) {
    case "workspace":
      return `${p.workspaceKey}/@workspace`;
    case "silo":
      return `@silos/${safeName(tier.name)}`;
    case "surface":
      return `${p.workspaceKey}/@surfaces/${p.surface}`;
  }
}

export function seedFor(p: Partition, tier: Tier): MemoryFiles {
  const body = `
## Standing instructions
(none yet)

## People / ownership
(none yet)

## Decisions
(none yet)

## Notes
(none yet)
`;
  switch (tier.kind) {
    case "workspace":
      return {
        "MEMORY.md": `# Workspace memory — index (${p.workspaceKey})

Shared across **every surface** (channel/DM) in this workspace. Put facts here
when they're true org-wide — deploy process, who owns what, standing decisions —
so a new or similar surface inherits them instead of starting blank.
${body}`,
      };
    case "silo":
      return {
        "MEMORY.md": `# Memory silo — "${tier.name}"

A shared brain. Every channel whose domain references the **${tier.name}** silo reads
and writes here, so a sibling channel isn't context-stranded. Put facts here that are
true for this team/area/topic.
${body}`,
      };
    case "surface":
      return {
        "MEMORY.md": `# Personal memory — index (${p.surfaceKey})

Specific to **this DM only** — your private universe with this person. Nothing here
leaks to shared (silo) memory.
${body}`,
      };
  }
}
