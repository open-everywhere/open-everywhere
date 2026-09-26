// proves: AP-MOD-core-access-resource-grant-manifest, AP-RG-dm_person, AP-RG-post_message

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkResourceGrantMounts,
  isResourceGrantTool,
  RESOURCE_GRANT_TIERS,
  RESOURCE_GRANT_TOOL_MOUNTS,
  tierGate,
  type ResourceGrantToolFile,
} from "../agent/access/resource-grant-manifest.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "tools");
const realTool = (name: string): ResourceGrantToolFile => ({ name, source: readFileSync(join(toolsDir, `${name}.ts`), "utf8") });

{
  ok(RESOURCE_GRANT_TIERS.length === 2, "exactly two tiers are classifiable — P0 needs no grant, P3/P4 have no config spelling");
  for (const tier of RESOURCE_GRANT_TIERS) {
    const gate = tierGate(tier);
    ok(gate.mount.length > 0 && gate.fence.length > 0, `tier ${tier} names both a mount and a fence`);
    ok(gate.mount !== gate.fence, `tier ${tier}'s mount and fence are DIFFERENT symbols — one decides what is seen, the other what is admitted`);
    ok(gate.summary.length > 0, `tier ${tier} carries operator-facing copy for its refusals`);
  }
  ok(tierGate("P1").fence !== tierGate("P2").fence, "the two tiers' fences are distinct");
  ok(tierGate("P1").mount !== tierGate("P2").mount, "the two tiers' mounts are distinct");
}

{
  ok(Object.keys(RESOURCE_GRANT_TOOL_MOUNTS).length >= 2, "the real manifest classifies both shipped tiers' tools — an empty table would pass every check below vacuously");
  const real = Object.keys(RESOURCE_GRANT_TOOL_MOUNTS).map(realTool);
  const problems = checkResourceGrantMounts(real);
  ok(problems.length === 0, `the real manifest is clean over the real tool sources (got: ${problems.join(" | ")})`);
  for (const [name, tier] of Object.entries(RESOURCE_GRANT_TOOL_MOUNTS)) {
    const gate = tierGate(tier);
    const source = realTool(name).source;
    ok(source.includes(gate.mount), `${name} names its tier-${tier} mount ${gate.mount}`);
    ok(source.includes(gate.fence), `${name} names its tier-${tier} fence ${gate.fence}`);
  }
}

{
  const stowaway: ResourceGrantToolFile = {
    name: "broadcast_notice",
    source: "import { chatWriteMount, assertChatWriteAllowed } from '../access/chat-write-grant.js';",
  };
  ok(isResourceGrantTool(stowaway.source), "a file naming a chat-write grant symbol IS a resource-grant tool");
  const problems = checkResourceGrantMounts([stowaway], {});
  ok(problems.length === 1, "an un-classified tool on the plane produces exactly one problem");
  ok(problems[0]!.includes("broadcast_notice"), "…naming the tool");
  ok(problems[0]!.includes("under no tier"), "…and saying it must be classified");

  const unrelated: ResourceGrantToolFile = { name: "read_channel", source: "import { assertSurfaceAllowed } from '../channels/channel-read.js';" };
  ok(isResourceGrantTool(unrelated.source) === false, "a tool that names no grant symbol is NOT on this plane");
  ok(checkResourceGrantMounts([unrelated], {}).length === 0, "…and an un-classified one produces no problem");
}

{
  const gate = tierGate("P1");

  const unfenced: ResourceGrantToolFile = { name: "post_message", source: `const x = ${gate.mount};` };
  const a = checkResourceGrantMounts([unfenced], { post_message: "P1" });
  ok(a.length === 1 && a[0]!.includes(gate.fence), "a tool that mounts and never fences FAILS, naming the missing fence");
  ok(a[0]!.includes("the mount alone is not a gate"), "…and says why the pair is the invariant");

  const unmounted: ResourceGrantToolFile = { name: "post_message", source: `await ${gate.fence}(ctx, d, t);` };
  const b = checkResourceGrantMounts([unmounted], { post_message: "P1" });
  ok(b.length === 1 && b[0]!.includes(gate.mount), "a tool that fences and never mounts FAILS, naming the missing mount");
  ok(b[0]!.includes("OPE-927"), "…and names the mounted-but-impossible class it prevents");

  const whole: ResourceGrantToolFile = { name: "post_message", source: `${gate.mount} ${gate.fence}` };
  ok(checkResourceGrantMounts([whole], { post_message: "P1" }).length === 0, "a tool naming BOTH halves is clean");
}

{
  const p1 = tierGate("P1");
  const p2 = tierGate("P2");
  const crossed: ResourceGrantToolFile = { name: "post_message", source: `${p1.mount} ${p1.fence} ${p2.fence}` };
  const problems = checkResourceGrantMounts([crossed], { post_message: "P1" });
  ok(problems.length === 1, "a tier-P1 tool naming the tier-P2 fence produces exactly one problem");
  ok(problems[0]!.includes(p2.fence), "…naming the foreign fence");
  ok(problems[0]!.includes("one tool, one tier"), "…and stating the rule");

  const asP2 = checkResourceGrantMounts([crossed], { post_message: "P2" });
  ok(asP2.some((p) => p.includes(p2.mount)), "the same source declared P2 fails for its MISSING P2 mount, not for the same crossing");
}

{
  const problems = checkResourceGrantMounts([], { deleted_verb: "P1" });
  ok(problems.length === 1 && problems[0]!.includes("no such tool file was scanned"), "a declared row whose tool file is gone FAILS");
  ok(problems[0]!.includes("deleted_verb"), "…naming the stale row");
}

{
  const problems = checkResourceGrantMounts([{ name: "x", source: "" }], { x: "P9" as never });
  ok(problems.length === 1 && problems[0]!.includes("unknown tier"), "a row declaring a tier this manifest cannot classify FAILS");
  ok(problems[0]!.includes("P1") && problems[0]!.includes("P2"), "…listing the tiers that ARE classifiable");
}

console.log(`resource-grant-mount-lint: ${n} assertions passed`);
