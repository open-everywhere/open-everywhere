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

function accessClause(silo: MemorySilo, readOnly: boolean, recall: MemoryRecallRoute, dir: string): string {
  const delegated = recall === "agent" || recall === "work";
  const unreachable = recall === "none";
  const file = code(dir + "/MEMORY.md");
  const appendOnly = isAppendOnlyBacking(silo);
  const rewriteInPlace = appendOnly ? "" : " Where a line already states the fact you are saving, CHANGE that line to the new value rather than adding a second one.";
  const rewriteInBrief = appendOnly ? "" : "If a line there already states that fact, CHANGE that line to the new value instead of adding a second one. ";
  const saveVerb = unreachable
    ? "this seat CANNOT write these files and cannot delegate — say plainly that you can't save anything to memory from here, never that you saved it"
    : delegated
      ? `to save something, ${recall === "work" ? "hand it off" : "delegate it"} THIS turn — ${handOffCall(recall)} of exactly this shape: ` +
        `"Open ${dir}/MEMORY.md with your file tools and add this fact for the team under the right heading (as a note, or as a decision if it records a choice): <the fact, verbatim>. ` +
        rewriteInBrief +
        `Reply with the exact line you wrote and the path you wrote it to.". ` +
        `A fact is not a standing rule — never frame it as one. Only after the worker reports the line it WROTE, reply naming what was saved ("Saved: <the fact>") — never before, and never a bare "Done."` +
        (recall === "work" ? ` That report arrives as the job's result on a later message, so this turn says only that you will save it.` : "")
      : `save durable facts here by EDITING ${file} (or another file in this silo) with your file tools — the edit IS the save, and the host persists it when the turn ends. Nothing is saved by saying it is.${rewriteInPlace}`;
  if (!readOnly) {
    return appendOnly
      ? `writable but APPEND-ONLY — ${saveVerb}. Add new lines at the END of a file; changing or removing an existing line is REFUSED and does NOT save`
      : `writable — ${saveVerb}`;
  }
  if (isProjectedCache(silo)) {
    const via = silo.skill ? `the ${code(silo.skill)} skill` : "the Notion tools";
    return `read-only cache — edits are BLOCKED; to update, use ${via} (never edit these files)`;
  }
  return delegated
    ? "read-only — edits are blocked; this channel's own memory is written the same delegated way"
    : unreachable
      ? "read-only — and this seat cannot open or write these files at all"
      : "read-only — edits are blocked; edit this channel's OWN writable silo above instead";
}

/** The hand-off call a delegating route names. `agent` waits for its worker; `work` returns at once, and the result comes back later. */
function handOffCall(recall: MemoryRecallRoute): string {
  return recall === "work" ? "`work` with a `message`" : '`agent` with `mode: "sync"` and a brief';
}

const NEWEST_WINS =
  "Where two lines state one fact, the one with the LATER date is the current value — answer with it, " +
  "and do not report the pair as a conflict. If the two carry the SAME date, or either is undated, " +
  "nothing orders them: say the files disagree rather than choosing one.";

const HELD_IN_CONVERSATION =
  "A fact this conversation already holds is not a lookup: something a person said earlier here, " +
  "or your own earlier reply. Answer from it directly.";

const RECALL_GUIDANCE: Readonly<Record<MemoryRecallRoute, { readonly lead: string; readonly heading: string }>> = {
  "file-tools": {
    lead: "Read the relevant silo with your tools before acting. " + NEWEST_WINS,
    heading: "## Silos — read with file tools",
  },
  agent: {
    lead:
      "This seat has NO file tools, so you cannot open these files yourself. " + HELD_IN_CONVERSATION + " " +
      "To recall anything else from memory, delegate a lookup: `agent` with `mode: \"sync\"` and a brief naming the paths below and " +
      "what you need out of them (the worker has the file tools, greps the tree, and returns what it " +
      "found this turn). Do that before answering from guesswork — and if the lookup comes back empty, " +
      "say so rather than inventing the answer. " + NEWEST_WINS,
    heading: "## Silos — read by delegating a lookup",
  },
  work: {
    lead:
      "This seat has NO file tools, so you cannot open these files yourself. " + HELD_IN_CONVERSATION + " " +
      "To recall anything else from memory, hand off a lookup: `work` with a `message` naming the paths below and " +
      "what you need out of them (the worker has the file tools, greps the tree, and reports what it " +
      "found). `work` returns at once, and the answer arrives later as the job's result. Do that before answering from guesswork — and if the lookup comes back empty, " +
      "say so rather than inventing the answer. " + NEWEST_WINS,
    heading: "## Silos — read by handing off a lookup",
  },
  none: {
    lead:
      "This seat has NO file tools and cannot delegate, so it CANNOT read these files. " + HELD_IN_CONVERSATION + " " +
      "If a question turns on what is in the files and nowhere else, say plainly that you can't check memory from here — never answer as " +
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
      "this seat has no file tools — ONLY if it bears on the current message and this conversation does " +
      "not already hold the answer, delegate a lookup (`agent`, `mode: \"sync\"`) naming the path; otherwise ignore it:",
    index:
      "this seat has no file tools, so delegate a lookup (`agent`, `mode: \"sync\"`) naming the path " +
      "before answering from memory, if it bears on the current message and this conversation does not already hold the answer.",
  },
  work: {
    content:
      "this seat has no file tools — ONLY if it bears on the current message and this conversation does " +
      "not already hold the answer, hand off a lookup (`work`, with a `message` naming the path); otherwise ignore it:",
    index:
      "this seat has no file tools, so hand off a lookup (`work`, with a `message` naming the path) " +
      "before answering from memory, if it bears on the current message and this conversation does not already hold the answer.",
  },
  none: {
    content:
      "this seat CANNOT open these files — ONLY if it bears on the current message and this conversation " +
      "does not already hold the answer, say you can't check memory from here rather than answering as if you had:",
    index:
      "this seat CANNOT open it — if it bears on the current message and this conversation does not already " +
      "hold the answer, say you can't check memory from here rather than answering as if you had.",
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
      const entry = recall === "none" ? `The index entry is ${code(dir + "/MEMORY.md")}` : `Start with ${code(dir + "/MEMORY.md")}`;
      lines.push(`- **${r.silo.name}** (${dir + "/"}) — ${desc}source: ${sourceLabel(r.silo)}; ${accessClause(r.silo, r.readOnly, recall, dir)}. ${entry}.`);
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
