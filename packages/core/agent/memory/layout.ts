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
  const linkGuidance =
    "Link related subjects like `[[name]]` — facts about the same person/system/decision " +
    "connect up. This index keeps only the most recent few bullets per section; each " +
    "category's full history lives in its own topic file (`people.md`, `decisions.md`, …). " +
    "If a fact came from outside this conversation — a fetched page, an issue or PR body, a " +
    "connector result, an uploaded file — say so on the bullet: nothing else records where it " +
    "came from.";

  switch (tier.kind) {
    case "workspace":
      return {
        "MEMORY.md": `# Workspace memory — index (${p.workspaceKey})

Shared across **every surface** (channel/DM) in this workspace. Put facts here
when they're true org-wide — deploy process, who owns what, standing decisions —
so a new or similar surface inherits them instead of starting blank. ${linkGuidance}
${body}`,
      };
    case "silo":
      return {
        "MEMORY.md": `# Memory silo — "${tier.name}"

A shared brain. Every channel whose domain references the **${tier.name}** silo reads
and writes here, so a sibling channel isn't context-stranded. Put facts here that are
true for this team/area/topic. ${linkGuidance}
${body}`,
      };
    case "surface":
      return {
        "MEMORY.md": `# Personal memory — index (${p.surfaceKey})

Specific to **this DM only** — your private universe with this person. Nothing here
leaks to shared (silo) memory. ${linkGuidance}
${body}`,
      };
  }
}
