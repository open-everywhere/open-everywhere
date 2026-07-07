import type { ResolvedMemory } from "./resolve.js";
import type { MemorySilo } from "./silo.js";
import { isProjectedCache } from "./readonly.js";
import { tierSandboxDir } from "./sandbox-sync.js";

const code = (s: string): string => "`" + s + "`";

export function sourceLabel(silo: MemorySilo): string {
  switch (silo.provider) {
    case "notion":
      return "Notion";
    case "github":
      return silo.container ? `GitHub (${silo.container})` : "GitHub";
    case "git":
      return "git";
    case "postgres":
    case "sqlite":
      return "database";
    default:
      return silo.provider;
  }
}

function accessClause(silo: MemorySilo, readOnly: boolean): string {
  if (!readOnly) return "writable — save durable facts here with the `remember` tool";
  if (isProjectedCache(silo)) {
    const via = silo.skill ? `the ${code(silo.skill)} skill` : "the Notion tools";
    return `read-only cache — edits are BLOCKED; to update, use ${via} (never edit these files)`;
  }
  return "read-only — edits are blocked; use `remember` for this channel's own memory";
}

export function renderMemoryIndex(reads: readonly ResolvedMemory[], failedSilos: readonly string[] = []): string {
  const lines: string[] = [
    "# Memory index",
    "",
    "Your durable memory for this channel — files on disk, **not** in your context automatically.",
    "Read the relevant silo with your tools before acting.",
    "",
  ];

  if (reads.length === 0 && failedSilos.length === 0) {
    lines.push("(No memory is configured for this channel.)", "");
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  if (reads.length > 0) {
    lines.push("## Silos — read with file tools");
    for (const r of reads) {
      const dir = tierSandboxDir(r.tier);
      const desc = r.silo.description ? `${r.silo.description} — ` : "";
      lines.push(`- **${r.silo.name}** (${dir + "/"}) — ${desc}source: ${sourceLabel(r.silo)}; ${accessClause(r.silo, r.readOnly)}. Start with ${code(dir + "/MEMORY.md")}.`);
    }
    lines.push("");
  }

  if (failedSilos.length > 0) {
    lines.push(
      "## ⚠ Unavailable this session",
      ...failedSilos.map((name) => `- **${name}** failed to load — its knowledge is MISSING from disk right now, not empty. Say so if asked about anything it might hold; do not answer as if memory were complete.`),
      "",
    );
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
