import type { ResolvedMemory } from "./resolve.js";
import { isPointer } from "./silo.js";
import { isProjectedCache } from "./readonly.js";
import { tierSandboxDir } from "./sandbox-sync.js";

const code = (s: string): string => "`" + s + "`";

export function renderMemoryIndex(reads: readonly ResolvedMemory[]): string {
  const onDisk = reads.filter((r) => !isPointer(r.silo));
  const pointers = reads.filter((r) => isPointer(r.silo));

  const lines: string[] = [
    "# Memory index",
    "",
    "Your durable memory for this channel. It is **not** in your context automatically —",
    "read the relevant silo with your tools before acting.",
    "",
  ];

  if (onDisk.length > 0) {
    lines.push("## On disk — read with file tools");
    for (const r of onDisk) {
      const dir = tierSandboxDir(r.tier);
      const how = !r.readOnly
        ? "(writable — save durable facts here with the `remember` tool)"
        : isProjectedCache(r.silo)
          ? "(read-only cache of Notion — edits are BLOCKED; to update, use the Notion tools/connector, never by editing these files)"
          : "(read-only — edits are blocked; use `remember` for this channel's own memory)";
      lines.push(`- **${r.silo.name}** — ${code(dir + "/")} ${how}. Start with ${code(dir + "/MEMORY.md")}.`);
    }
    lines.push("");
  }

  if (pointers.length > 0) {
    lines.push("## External knowledge bases — use the connector (NOT on disk)");
    for (const r of pointers) {
      const s = r.silo;
      const where = s.location ? `at ${s.location} — ` : "";
      const via = s.skill ? `${code(s.connector!)} connector (skill ${code(s.skill)})` : `${code(s.connector!)} connector`;
      const note = s.note ? ` ${s.note}` : "";
      lines.push(`- **${s.name}** — ${where}use the ${via} to search/read/update. Don't expect files for this.${note}`);
    }
    lines.push("");
  }

  if (onDisk.length === 0 && pointers.length === 0) {
    lines.push("(No memory is configured for this channel.)");
    lines.push("");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
