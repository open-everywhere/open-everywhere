import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVE_PATCH_CARRIERS,
  EVE_PATCH_PARTS,
  assertEvePatched,
  defaultEvePackageRoot,
  evePatchRefusal,
  missingEvePatchParts,
  probeEvePatch,
  type MarkerGlobals,
} from "../agent/access/eve-patch-probe.js";
import { EVE_RUNTIME_VERSION } from "../agent/channels/runtime-rotation.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const bagWithout = (...absent: readonly string[]): MarkerGlobals =>
  Object.fromEntries(EVE_PATCH_PARTS.filter((p) => !absent.includes(p.marker)).map((p) => [p.marker, true]));

const unresolvableRoot = (): string => {
  throw new Error("Cannot find module 'eve/package.json'");
};

ok(EVE_PATCH_PARTS.length === 3, `parts: three live patch parts are declared (got ${EVE_PATCH_PARTS.length})`);
ok(!EVE_PATCH_PARTS.some((p) => p.part === 5), "parts: part 5 (the empty-step terminal guard) is RETIRED onto native `endsTurn` (OPE-2252) and must not come back");
ok(!EVE_PATCH_PARTS.some((p) => p.part === 6), "parts: part 6 (the model-message projection) is RETIRED (OPE-2251) and must not come back");
ok(
  new Set(EVE_PATCH_PARTS.map((p) => p.marker)).size === EVE_PATCH_PARTS.length,
  "parts: every part declares a DISTINCT marker — two parts sharing one marker would let either hunk vouch for the other",
);
ok(
  new Set(EVE_PATCH_PARTS.map((p) => p.part)).size === EVE_PATCH_PARTS.length,
  "parts: every part number is distinct",
);
ok(
  EVE_PATCH_PARTS.every((p) => p.marker.startsWith("__oe") && p.marker.endsWith("Patched")),
  "parts: every marker follows the `__oe<Part>Patched` shape part 7 established",
);
ok(
  EVE_PATCH_CARRIERS.length === 2 && EVE_PATCH_CARRIERS.every((c) => c.startsWith("dist/src/")),
  `parts: the parts collapse to the two eve dist carriers the probe loads (got ${EVE_PATCH_CARRIERS.join(", ")})`,
);

ok(missingEvePatchParts(bagWithout()).length === 0, "full: a bag carrying every live marker reports NOTHING missing (negative control)");
{
  const result = await probeEvePatch(unresolvableRoot, bagWithout());
  ok(result.status === "patched", "full: a complete bag probes `patched` without reaching for the eve root at all");
}

for (const part of EVE_PATCH_PARTS) {
  const bag = bagWithout(part.marker);
  const missing = missingEvePatchParts(bag);
  ok(
    missing.length === 1 && missing[0]?.marker === part.marker,
    `absent-${part.part}: dropping ${part.marker} reports exactly that part missing (got ${missing.map((m) => m.marker).join(", ") || "none"})`,
  );
  const message = evePatchRefusal(missing);
  ok(message.includes(`part ${part.part}`), `absent-${part.part}: the refusal names the part NUMBER`);
  ok(message.includes(part.marker), `absent-${part.part}: the refusal names the missing MARKER`);
  ok(message.includes(part.carrier), `absent-${part.part}: the refusal names the eve file whose hunk is absent`);
  ok(message.includes(part.lost), `absent-${part.part}: the refusal says what is silently lost, not just that a marker is gone`);
  ok(message.includes(EVE_RUNTIME_VERSION), `absent-${part.part}: the refusal names the PINNED eve version (${EVE_RUNTIME_VERSION})`);
  ok(message.includes("patch-package"), `absent-${part.part}: the refusal names the FIX`);
  ok(message.includes("docs/dev/publishing.md"), `absent-${part.part}: the refusal points at the document that explains it`);
  ok(message.includes("npx oe-eve-patch"), `absent-${part.part}: the refusal names the one command that fixes it`);
  ok(
    !/NOT shipped in the published tarball/u.test(message),
    `absent-${part.part}: 🔴 the refusal does NOT claim the patch is unshipped — core packs it (see its \`files\` allowlist)`,
  );
  ok(
    !/from the Open Everywhere repository/u.test(message),
    `absent-${part.part}: 🔴 the refusal does NOT send a consumer to the repository — the patch is in the tarball they already have`,
  );

  await assert.rejects(
    async () => await assertEvePatched(defaultEvePackageRoot, bag),
    (err: unknown) => err instanceof Error && err.message.includes(`part ${part.part}`) && err.message.includes(part.marker),
    `absent-${part.part}: assertEvePatched THROWS, and the thrown message names this part`,
  );
  n++;
}

{
  const empty: MarkerGlobals = {};
  const missing = missingEvePatchParts(empty);
  ok(missing.length === EVE_PATCH_PARTS.length, "all-absent: an empty bag reports every live part missing");
  const message = evePatchRefusal(missing);
  for (const part of EVE_PATCH_PARTS) {
    ok(message.includes(`part ${part.part}`), `all-absent: the refusal names part ${part.part} — it must list every missing part, not the first`);
  }
  ok(
    message.includes(`${EVE_PATCH_PARTS.length} of ${EVE_PATCH_PARTS.length}`),
    "all-absent: the refusal counts the missing parts against the total",
  );
}

{
  const result = await probeEvePatch(unresolvableRoot, {});
  ok(result.status === "unverifiable", `inlined: an unresolvable eve root with no markers probes \`unverifiable\` (got ${result.status})`);
  ok(typeof result.reason === "string" && result.reason.length > 0, "inlined: the unverifiable result carries WHY the root did not resolve");
  await assert.doesNotReject(async () => await assertEvePatched(unresolvableRoot, {}), "inlined: assertEvePatched does NOT throw on the unverifiable state");
  n++;

  const live = await probeEvePatch();
  ok(
    live.status === "patched",
    `live: this tree's installed eve publishes every live marker (got ${live.status}` +
      `${live.missing.length > 0 ? `, missing ${live.missing.map((m) => `part ${m.part}/${m.marker}`).join(", ")}` : ""}` +
      `). Run \`npm ci\` from the repo root — postinstall applies patches/eve+${EVE_RUNTIME_VERSION}.patch`,
  );
  const root = defaultEvePackageRoot();
  for (const part of EVE_PATCH_PARTS) {
    const carrierFile = join(root, part.carrier);
    ok(existsSync(carrierFile), `live: ${part.carrier} exists under the eve root the probe resolves (part ${part.part})`);
    ok(
      readFileSync(carrierFile, "utf8").includes(`globalThis.${part.marker}=!0;`),
      `live: ${part.carrier} itself plants \`${part.marker}\` (part ${part.part}) — without this row the verdict above ` +
        `would pass on a marker some OTHER module happened to set on globalThis`,
    );
  }
}

console.log(`\n✓ eve-patch-probe: ${n} assertions passed (${EVE_PATCH_PARTS.length} live parts, each proven to name itself in the refusal)\n`);
