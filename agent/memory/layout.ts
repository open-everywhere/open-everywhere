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
    case "domain":
      return `${p.workspaceKey}/@domains/${safeName(tier.name)}`;
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
    case "domain":
      return {
        "MEMORY.md": `# Domain memory — "${tier.name}" (${p.workspaceKey})

Shared across the surfaces grouped into the **${tier.name}** domain. Put facts
here when they're true for this area/domain but not the whole workspace — a
sibling surface in the same domain inherits them, so it isn't context-stranded.
${body}`,
      };
    case "surface":
      return {
        "MEMORY.md": `# Surface memory — index (${p.surfaceKey})

Specific to **this surface only**. Put facts here when they matter here but not
workspace- or domain-wide. If something generalises, save it to the wider tier.
${body}`,
      };
  }
}
