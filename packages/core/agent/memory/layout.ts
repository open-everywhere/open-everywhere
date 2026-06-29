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
      return `@domains/${safeName(tier.name)}`;
    case "surface":
      return `${p.workspaceKey}/@surfaces/${p.surface}`;
    case "org-default":
      return `@org-default`;
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
        "MEMORY.md": `# Domain memory — "${tier.name}"

The shared brain of the **${tier.name}** domain — every channel grouped into this
domain reads and writes here. Put facts here that are true for this team/area, so a
sibling channel in the same domain isn't context-stranded.
${body}`,
      };
    case "surface":
      return {
        "MEMORY.md": `# Personal memory — index (${p.surfaceKey})

Specific to **this DM only** — your private universe with this person. Nothing here
leaks to shared (domain/org) memory.
${body}`,
      };
    case "org-default":
      return {
        "MEMORY.md": `# Org baseline — index

The curated, **read-only** baseline every unassigned channel inherits — how the org
works, who owns what, standing decisions. Edited by humans (config/PR), not written
to by the agent. Channels that should accumulate their own memory get a domain.
${body}`,
      };
  }
}
