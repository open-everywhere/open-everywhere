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
    part: 7,
    marker: "__oeWebFetchHopPatched",
    carrier: "dist/src/execution/web-fetch/request.js",
    lost:
      "the per-hop web_fetch egress fence (OPE-1568) — an allow-listed host can redirect the fetch to a host the session never declared. This part alone already refuses at the tool (access/web-fetch-fence.ts); the probe makes it refuse at boot instead",
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
    `Fix — @open-everywhere/core ships both the patch and the applier, and it runs no postinstall of ` +
    `its own, so applying the patch is your project's explicit step:\n` +
    `  npm i eve@${EVE_RUNTIME_VERSION}\n` +
    `  npx oe-eve-patch\n\n` +
    `The applier is idempotent and refuses any eve version but the pin. To apply the patch by hand ` +
    `instead, copy \`patches/eve+${EVE_RUNTIME_VERSION}.patch\` out of the installed ` +
    `@open-everywhere/core package into your own \`patches/\` directory, add \`patch-package\` to your ` +
    `devDependencies, and add \`"postinstall": "patch-package"\` to your own package.json.\n` +
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

export function evePatchTurnRefusal(globals: MarkerGlobals = globalThis as MarkerGlobals): string | undefined {
  if (memo[MEMO_KEY] === true) return undefined;
  const missing = missingEvePatchParts(globals);
  if (missing.length > 0) return evePatchRefusal(missing);
  memo[MEMO_KEY] = true;
  return undefined;
}

export function assertEvePatchedAtTurn(globals: MarkerGlobals = globalThis as MarkerGlobals): void {
  const refusal = evePatchTurnRefusal(globals);
  if (refusal !== undefined) throw new Error(refusal);
}
