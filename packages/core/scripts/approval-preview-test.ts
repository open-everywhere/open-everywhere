import assert from "node:assert/strict";

import { TOOL_CONSEQUENCE } from "../agent/access/consequence.js";
import { WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS, withheldFromGrain, memoryRecallRouteFor } from "../agent/access/window-gate-manifest.js";
import { allowedOnLeanSeat } from "../agent/access/lean-seat.js";
import { routinePermissionKind } from "../agent/approvals/session-grant.js";
import { approvalPreviewFor, renderApprovalPreview, renderApprovalPreviewFor } from "../agent/access/approval-preview.js";
import type { WindowGrain } from "../agent/identity/binding.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const GRAINS: readonly WindowGrain[] = ["standing", "native", "thread", "task"];

const leanFor = (grain: WindowGrain): boolean => {
  const route = memoryRecallRouteFor(grain);
  return (grain === "standing" || grain === "thread") && (route === "agent" || route === "spawn_task");
};
const holds = (name: string, grain: WindowGrain): boolean => {
  const mounted = WINDOW_GATED_TOOLS[name] ? WINDOW_GATED_TOOLS[name].includes(grain) : WINDOW_UNGATED_TOOLS.has(name);
  return mounted && (!leanFor(grain) || allowedOnLeanSeat(name));
};

const CARDED = Object.entries(TOOL_CONSEQUENCE)
  .filter(([, e]) => e.via.kind === "action-kind")
  .map(([name]) => name)
  .sort();

ok(CARDED.length > 0, "fixture: the consequence registry has action-kind rows at all");

for (const grain of GRAINS) {
  const p = approvalPreviewFor(grain);
  const all = [...p.member, ...p.admin, ...p.elsewhere].sort();
  eq(all, CARDED, `[${grain}] the three buckets cover EXACTLY the registry's action-kind rows (a new gated tool cannot be silently omitted)`);
  eq(new Set(all).size, all.length, `[${grain}] the buckets are disjoint — no tool is claimed twice`);
  eq([...p.member].sort(), [...p.member], `[${grain}] member bucket is sorted (stable prose bytes)`);
  eq([...p.admin].sort(), [...p.admin], `[${grain}] admin bucket is sorted`);
  eq([...p.elsewhere].sort(), [...p.elsewhere], `[${grain}] elsewhere bucket is sorted`);
}

const nonCarding = Object.entries(TOOL_CONSEQUENCE)
  .filter(([, e]) => e.via.kind !== "action-kind")
  .map(([name]) => name);
for (const grain of GRAINS) {
  const p = approvalPreviewFor(grain);
  const claimed = new Set([...p.member, ...p.admin, ...p.elsewhere]);
  const leaked = nonCarding.filter((name) => claimed.has(name));
  eq(leaked, [], `[${grain}] no open/admin-roles/eve-hitl tool is presented as something a human must click`);
}
ok(TOOL_CONSEQUENCE["memory_admin_read"].via.kind === "admin-roles", "fixture: memory_admin_read is admin-ROLES — it refuses without standing, it never posts a card");
ok(TOOL_CONSEQUENCE["post_file"].via.kind === "eve-hitl", "fixture: post_file is eve-hitl — a session-private confirm with no approver standing");
ok(!approvalPreviewFor("task").member.includes("post_file"), "post_file is not sold as an approval a human must come and click");

const hitl = nonCarding.filter((name) => TOOL_CONSEQUENCE[name].via.kind === "eve-hitl").sort();
for (const grain of GRAINS) {
  const p = approvalPreviewFor(grain);
  const expected = hitl.filter((name) => holds(name, grain));
  eq([...p.confirm], expected, `[${grain}] the confirm bucket is exactly the eve-hitl rows this seat holds (mount tables minus the lean filter)`);
}
ok(approvalPreviewFor("task").confirm.includes("post_file"), "a worker holding post_file is told it may be asked to confirm");
ok(!approvalPreviewFor("standing").confirm.includes("post_file"), "a standing seat does not mount post_file, so it is not told about a confirm it will never see");
ok(/may ask YOU to confirm/.test(renderApprovalPreviewFor("task")), "the confirm clause renders where the tool is held");
ok(!/may ask YOU to confirm/.test(renderApprovalPreviewFor("standing")), "…and is absent where it is not");

for (const grain of GRAINS) {
  const p = approvalPreviewFor(grain);
  for (const name of p.admin) eq(TOOL_CONSEQUENCE[name].tier, "gate:admin", `[${grain}] ${name} is in the admin bucket because its ROW says gate:admin`);
  for (const name of p.member) eq(TOOL_CONSEQUENCE[name].tier, "gate:member", `[${grain}] ${name} is in the member bucket because its ROW says gate:member`);

  const withheld = new Set(withheldFromGrain(grain));
  const expected = CARDED.filter((name) => !holds(name, grain)).sort();
  eq([...p.elsewhere], expected, `[${grain}] elsewhere == the carded tools this seat does not hold (posture tables minus the lean filter)`);
  for (const name of expected.filter((x) => WINDOW_GATED_TOOLS[x] !== undefined && !leanFor(grain))) {
    ok(withheld.has(name), `[${grain}] gated elsewhere entry ${name} agrees with withheldFromGrain (the independent computation)`);
  }
}

const standing = approvalPreviewFor("standing");
eq([...standing.member, ...standing.admin], [], "a DELEGATING standing seat holds no carded verb itself — the lean roster cards nothing");
eq([...standing.elsewhere], CARDED, "…so every carded verb is elsewhere: reachable through a worker, carded the same there");

const dmStanding = approvalPreviewFor("standing", undefined, undefined, undefined, "none");
eq([...dmStanding.elsewhere], ["create_skill", "delete_skill", "open_pull_request"], "a NON-delegating standing seat's carded-but-absent set is still just the skill-authoring pair + open_pull_request");
ok(dmStanding.member.includes("create_routine") && dmStanding.member.includes("create_ticket"), "a non-delegating standing seat DOES hold carded routine/ticket verbs — nothing was stripped from the seat that cannot route");
ok(dmStanding.admin.includes("set_spend_limit"), "spend control is in the admin bucket");

eq([...approvalPreviewFor("task").elsewhere], [], "the one-shot worker holds every carded verb — its section has no out-of-reach clause");

for (const grain of GRAINS) {
  eq(approvalPreviewFor(grain).route, memoryRecallRouteFor(grain), `[${grain}] the preview's route IS memoryRecallRouteFor's — one answer, not two`);
}

const renderedStanding = renderApprovalPreviewFor("standing");
for (const name of [...standing.member, ...standing.admin, ...standing.elsewhere]) {
  ok(renderedStanding.includes("`" + name + "`"), `standing prose names ${name}`);
}
ok(renderedStanding.includes("`" + memoryRecallRouteFor("standing") + "`"), "standing prose names the delegation verb this grain holds, not a hardcoded one");
ok(/never moves an action past a gate/.test(renderedStanding), "standing prose states that delegating does not skip the card");
ok(/will need approving/.test(renderedStanding) && /never its absence/.test(renderedStanding), "prose carries the asymmetry: promise the gate, never its absence");

const unreachable = renderApprovalPreview({ ...standing, route: "none" });
ok(/out of reach here/.test(unreachable), "route `none` renders the out-of-reach sentence instead of naming a delegation verb");
ok(!/`agent`|`spawn_task`/.test(unreachable), "route `none` names NO delegation verb — the OPE-121 failure mode, at consequence granularity");

const grantable = CARDED.filter((name) => {
  const via = TOOL_CONSEQUENCE[name].via;
  return via.kind === "action-kind" && routinePermissionKind(via.action) !== null;
});
eq(grantable, ["open_pull_request"], "exactly ONE carded tool is declarable as a standing routine permission — the rest always ask");
ok(routinePermissionKind("connector:notion") !== null, "the other grantable grain is a connector write, which carries no static registry row (runtime-injected ops)");

for (const grain of GRAINS) {
  eq(renderApprovalPreviewFor(grain), renderApprovalPreviewFor(grain), `[${grain}] the block is a pure function of grain — re-rendering it cannot churn the prompt cache`);
}
eq(renderApprovalPreview({ member: [], admin: [], elsewhere: [], confirm: [], route: "file-tools" }), "", "a seat with no carded verbs renders no section at all");

console.log(`approval-preview: ${n} assertions passed`);
