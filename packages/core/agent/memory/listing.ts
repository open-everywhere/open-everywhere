import type { ResolvedMemory } from "./resolve.js";
import type { MemorySilo } from "./silo.js";
import { isProjectedCache, isAppendOnlyBacking } from "./readonly.js";
import { tierSandboxDir } from "./sandbox-sync.js";
import type { MemoryRecallRoute } from "../access/window-gate-manifest.js";

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

function accessClause(silo: MemorySilo, readOnly: boolean, recall: MemoryRecallRoute): string {
  const delegated = recall === "agent";
  const saveVerb = delegated
    ? `to save something, delegate it THIS turn — \`${recall}\` with \`mode: "sync"\` and a brief of exactly this shape: ` +
      `"Call remember to save this fact for the team (category \\"note\\", or \\"decision\\" if it records a choice): <the fact, verbatim>". ` +
      `A fact is not a standing rule — never frame it as one. Only after the worker confirms the write, reply naming what was saved ("Saved: <the fact>") — never before, and never a bare "Done."`
    : "save durable facts here with the `remember` tool";
  if (!readOnly) {
    return isAppendOnlyBacking(silo)
      ? `writable but APPEND-ONLY — ${saveVerb}. Add new lines at the END of a file; changing or removing an existing line is REFUSED and does NOT save`
      : `writable — ${saveVerb}`;
  }
  if (isProjectedCache(silo)) {
    const via = silo.skill ? `the ${code(silo.skill)} skill` : "the Notion tools";
    return `read-only cache — edits are BLOCKED; to update, use ${via} (never edit these files)`;
  }
  return delegated
    ? "read-only — edits are blocked; this channel's own memory is written the same delegated way"
    : "read-only — edits are blocked; use `remember` for this channel's own memory";
}

const RECALL_GUIDANCE: Readonly<Record<MemoryRecallRoute, { readonly lead: string; readonly heading: string }>> = {
  "file-tools": {
    lead: "Read the relevant silo with your tools before acting.",
    heading: "## Silos — read with file tools",
  },
  agent: {
    lead:
      "This seat has NO file tools, so you cannot open these files yourself. To recall anything from " +
      "memory, delegate a lookup: `agent` with `mode: \"sync\"` and a brief naming the paths below and " +
      "what you need out of them (the worker has the file tools, greps the tree, and returns what it " +
      "found this turn). Do that before answering from guesswork — and if the lookup comes back empty, " +
      "say so rather than inventing the answer.",
    heading: "## Silos — read by delegating a lookup",
  },
  none: {
    lead:
      "This seat has NO file tools and cannot delegate, so it CANNOT read these files. If a question " +
      "turns on what is in them, say plainly that you can't check memory from here — never answer as " +
      "if you had read it.",
    heading: "## Silos — on disk, but unreachable from this seat",
  },
};

const RECALL_DELTA_TAILS: Readonly<Record<MemoryRecallRoute, { readonly content: string; readonly index: string }>> = {
  "file-tools": {
    content: "re-read a path with your file tools ONLY if it bears on the current message, otherwise ignore it:",
    index: "re-read the relevant path before answering from memory if it bears on the current message.",
  },
  agent: {
    content:
      "this seat has no file tools — ONLY if it bears on the current message, delegate a lookup " +
      "(`agent`, `mode: \"sync\"`) naming the path; otherwise ignore it:",
    index:
      "this seat has no file tools, so delegate a lookup (`agent`, `mode: \"sync\"`) naming the path " +
      "before answering from memory, if it bears on the current message.",
  },
  none: {
    content:
      "this seat CANNOT open these files — ONLY if it bears on the current message, say you can't " +
      "check memory from here rather than answering as if you had:",
    index:
      "this seat CANNOT open it — if it bears on the current message, say you can't check memory from " +
      "here rather than answering as if you had.",
  },
};

export function recallDeltaTail(recall: MemoryRecallRoute, shape: "content" | "index"): string {
  return (RECALL_DELTA_TAILS[recall] ?? RECALL_DELTA_TAILS["file-tools"])[shape];
}

export function renderMemoryIndex(
  reads: readonly ResolvedMemory[],
  failedSilos: readonly string[] = [],
  recall: MemoryRecallRoute = "file-tools",
): string {
  const guidance = RECALL_GUIDANCE[recall] ?? RECALL_GUIDANCE["file-tools"];
  const lines: string[] = [
    "# Memory index",
    "",
    "Your durable memory for this channel — files on disk, **not** in your context automatically.",
    guidance.lead,
    "",
  ];

  if (reads.length === 0 && failedSilos.length === 0) {
    lines.push("(No memory is configured for this channel.)", "");
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  if (reads.length > 0) {
    lines.push(guidance.heading);
    for (const r of reads) {
      const dir = tierSandboxDir(r.tier);
      const desc = r.silo.description ? `${r.silo.description} — ` : "";
      lines.push(`- **${r.silo.name}** (${dir + "/"}) — ${desc}source: ${sourceLabel(r.silo)}; ${accessClause(r.silo, r.readOnly, recall)}. Start with ${code(dir + "/MEMORY.md")}.`);
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
