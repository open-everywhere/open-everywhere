import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { EVE_RUNTIME_VERSION } from "../channels/runtime-rotation.js";

export interface EvePatchPart {
  readonly part: number;
  readonly marker: string;
  readonly carrier: string;
  readonly lost: string;
}

export const EVE_PATCH_PARTS: readonly EvePatchPart[] = [
  {
    part: 1,
    marker: "__oeProjectToolSetPatched",
    carrier: "dist/src/harness/tool-loop.js",
    lost:
      "the untrusted output projection (OPE-73) — connector and MCP results reach the model unfenced (a prompt-injection containment regression), and every per-wake seat cut is inert",
  },
  {
    part: 4,
    marker: "__oeCompactionContractPatched",
    carrier: "dist/src/harness/tool-loop.js",
    lost:
      "the compaction event contract (OPE-697) — `compaction.completed` carries no `reduced` field, so a pass that returned its input is indistinguishable from a real summary",
  },
  {
    part: 5,
    marker: "__oeEmptyStepTerminalPatched",
    carrier: "dist/src/harness/tool-loop.js",
    lost:
      "the empty-step terminal guard (OPE-762) — a correctly silent turn is reissued with an answer-now nudge, so the seat replies to the wake it just declined",
  },
  {
    part: 6,
    marker: "__oeProjectModelMessagesPatched",
    carrier: "dist/src/harness/tool-loop.js",
    lost:
      "the model-message projection (OPE-1396) — the `[Agents]` subtraction (OPE-593) leaves the model call, and the seat learns a live worker's agentId from the listing",
  },
  {
    part: 7,
    marker: "__oeWebFetchHopPatched",
    carrier: "dist/src/execution/web-fetch/request.js",
    lost:
      "the per-hop web_fetch egress fence (OPE-1568) — an allow-listed host can redirect the fetch to a host the session never declared. This part alone already refuses at the tool (access/web-fetch-fence.ts); the probe makes it refuse at boot instead",
  },
  {
    part: 8,
    marker: "__oeTaskCohortJoinPatched",
    carrier: "dist/src/tasks/session-index.js",
    lost:
      "the bounded task-cohort join (OPE-1856) — one worker parked on an unanswered question captures every later task, and eve delivers no later completion for the life of the session",
  },
  {
    part: 9,
    marker: "__oeSessionToolScopePatched",
    carrier: "dist/src/context/dynamic-tool-lifecycle.js",
    lost:
      "the delegated-binding refresh (OPE-2106) — a worker whose turn continues in a fresh process binds to the `subagent/…/unresolved` sentinel and its gated tools do not re-register",
  },
];

export const EVE_PATCH_CARRIERS: readonly string[] = [...new Set(EVE_PATCH_PARTS.map((p) => p.carrier))];

export type EvePatchProbeStatus = "patched" | "unpatched" | "unverifiable";

export interface EvePatchProbeResult {
  readonly status: EvePatchProbeStatus;
  readonly missing: readonly EvePatchPart[];
  readonly reason?: string;
}

export type MarkerGlobals = Readonly<Record<string, unknown>>;

export function missingEvePatchParts(globals: MarkerGlobals): readonly EvePatchPart[] {
  return EVE_PATCH_PARTS.filter((part) => globals[part.marker] !== true);
}

export function defaultEvePackageRoot(): string {
  return dirname(createRequire(import.meta.url).resolve("eve/package.json"));
}

export function evePatchRefusal(missing: readonly EvePatchPart[]): string {
  const parts = missing.map((p) => `  • part ${p.part} (${p.marker}, ${p.carrier}): ${p.lost}`).join("\n");
  return (
    `open-everywhere: this eve is UNPATCHED — refusing to boot.\n\n` +
    `${missing.length} of ${EVE_PATCH_PARTS.length} required patch part(s) are missing from the eve ` +
    `bytes this process loaded:\n${parts}\n\n` +
    `Each one fails silently when absent, which is why this is a refusal and not a warning. ` +
    `The pinned eve version is ${EVE_RUNTIME_VERSION}.\n\n` +
    `Fix — the patch is NOT shipped in the published tarball and @open-everywhere/core runs no ` +
    `postinstall of its own, so applying it is your project's step:\n` +
    `  1. copy \`patches/eve+${EVE_RUNTIME_VERSION}.patch\` from the Open Everywhere repository into ` +
    `your own project's \`patches/\` directory;\n` +
    `  2. add \`patch-package\` to your devDependencies;\n` +
    `  3. add \`"postinstall": "patch-package"\` to your own package.json, then re-install.\n` +
    `See docs/dev/publishing.md.`
  );
}

export async function probeEvePatch(
  rootFn: () => string = defaultEvePackageRoot,
  globals: MarkerGlobals = globalThis as MarkerGlobals,
): Promise<EvePatchProbeResult> {
  if (missingEvePatchParts(globals).length === 0) return { status: "patched", missing: [] };

  let root: string;
  try {
    root = rootFn();
  } catch (err) {
    return { status: "unverifiable", missing: missingEvePatchParts(globals), reason: String(err) };
  }

  await Promise.all(
    EVE_PATCH_CARRIERS.map(async (rel) => {
      try {
        await import(pathToFileURL(join(root, rel)).href);
      } catch {
      }
    }),
  );

  const missing = missingEvePatchParts(globals);
  return missing.length === 0 ? { status: "patched", missing: [] } : { status: "unpatched", missing };
}

export async function assertEvePatched(
  rootFn: () => string = defaultEvePackageRoot,
  globals: MarkerGlobals = globalThis as MarkerGlobals,
): Promise<EvePatchProbeResult> {
  const result = await probeEvePatch(rootFn, globals);
  if (result.status === "unpatched") throw new Error(evePatchRefusal(result.missing));
  return result;
}

const MEMO_KEY = "__oeEvePatchTurnCheckPassed";
const memo = globalThis as Record<string, unknown>;

export function _resetEvePatchTurnCheckForTest(): void {
  memo[MEMO_KEY] = false;
}

export function evePatchTurnCheckHasPassed(): boolean {
  return memo[MEMO_KEY] === true;
}

export function assertEvePatchedAtTurn(globals: MarkerGlobals = globalThis as MarkerGlobals): void {
  if (memo[MEMO_KEY] === true) return;
  const missing = missingEvePatchParts(globals);
  if (missing.length > 0) throw new Error(evePatchRefusal(missing));
  memo[MEMO_KEY] = true;
}
