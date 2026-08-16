import { loadBundles, loadBindings } from "../agent/access/bundles.js";
import { resolveApproverChain, taintToleranceOf, type ApprovalChainRequest } from "@open-everywhere/core/agent/access/approver-chain.js";

let passed = 0;
let failed = 0;
function ok(cond: boolean, what: string): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  ✗ ${what}`);
  }
}

const FIXTURE_BUNDLE = "e2e-taint-floor-fixture";
const FIXTURE_ELEMENT = "e2e-taint-lower";
const LOWERED_TOOL = "add_routine_rule";

const bundle = loadBundles().find((b) => b.name === FIXTURE_BUNDLE);
ok(bundle !== undefined, `the deployment declares the \`${FIXTURE_BUNDLE}\` bundle — without it the taint floor has nothing to refuse and ARM E can only skip`);

if (bundle !== undefined) {
  const approvers = bundle.approvers ?? [];
  ok(approvers.length === 1, `\`${FIXTURE_BUNDLE}\` carries exactly ONE approver (got ${approvers.length}) — a fixture that grew a second element is no longer the narrow thing this was reviewed as`);
  const element = approvers[0];
  ok(element?.name === FIXTURE_ELEMENT, `…and it is named \`${FIXTURE_ELEMENT}\` — the live ARM E asserts on \`custom:${FIXTURE_ELEMENT}\` in the trace, so a rename here silently turns that arm into a skip`);
  ok(element?.source === undefined || element.source === "operator", "…and it is operator-authored — a connector/remote source is clamped raise-only and could never produce the `allow` the floor needs to refuse");
  ok(element?.mayAllow === undefined, "…and it carries no `mayAllow` escape — that flag is meaningless on an operator element and config validation refuses it");

  if (element !== undefined) {
    const mustDefer = ["remove_routine_rule", "declare_webhook", "rotate_webhook", "open_pull_request", "set_spend_limit", "create_skill", "remember"];
    for (const tool of mustDefer) {
      const verdict = element.approve({ tool, unattended: false });
      ok(verdict === undefined, `the fixture element DEFERS on \`${tool}\` — it answers for one tool only (got ${JSON.stringify(verdict)})`);
    }
    ok(element.approve({ tool: LOWERED_TOOL, unattended: false }) === "allow", `the fixture element lowers \`${LOWERED_TOOL}\` to allow — the thing the floor is supposed to refuse actually exists`);
  }
}

const fixtureBindings = loadBindings().filter((b) => b.bundle === FIXTURE_BUNDLE);
ok(fixtureBindings.length === 1, `\`${FIXTURE_BUNDLE}\` is bound exactly ONCE (got ${fixtureBindings.length}) — a second binding is a second lowered surface`);
ok(
  fixtureBindings.every((b) => b.scope.level === "surface"),
  `…at SURFACE scope only (got ${fixtureBindings.map((b) => b.scope.level).join(", ")}) — an org/tenant/domain binding would lower a gate-tier sink across every channel beneath it`,
);

ok(taintToleranceOf(LOWERED_TOOL) === "gate", `\`${LOWERED_TOOL}\` is a \`taint: "gate"\` sink — the arrow's \`fires\` predicate reads exactly this, so a registry change that dropped the column would make the fixture inert`);

const approversForFixture = (bundle?.approvers ?? []).map((a) => ({ ...a }));

function request(extra: Partial<ApprovalChainRequest>): ApprovalChainRequest {
  return { tool: LOWERED_TOOL, action: "routine.policy.add", unattended: false, principalId: "U-fixture", ...extra };
}

async function main(): Promise<void> {
  const clean = await resolveApproverChain(request({ tainted: false }), { approvers: approversForFixture });
  ok(clean.verdict === "allow", `CLEAN: the fixture lowering lands — an untainted attended turn resolves ALLOW (got ${clean.verdict})`);
  ok(clean.resolvedBy === `custom:${FIXTURE_ELEMENT}`, `CLEAN: …resolved by \`custom:${FIXTURE_ELEMENT}\` specifically (got ${clean.resolvedBy})`);
  ok(clean.registryVerdict === "ask", "CLEAN: …against a registry baseline of `ask` — the divergence is what makes this a real lowering rather than an already-open verb");
  ok(clean.transforms.length === 0, `CLEAN: …and NO transform fired (got ${JSON.stringify(clean.transforms.map((t) => t.name))}) — the floor is taint-conditional, not a blanket gate`);
  ok(clean.tainted === false, "CLEAN: …and the resolution reports the untainted turn it read");

  const tainted = await resolveApproverChain(request({ tainted: true }), { approvers: approversForFixture });
  ok(tainted.verdict === "ask", `TAINTED: the same lowering is refused — an attended tainted turn resolves ASK (got ${tainted.verdict})`);
  const taintTransform = tainted.transforms.find((t) => t.name === "taint:ask");
  ok(taintTransform !== undefined, "TAINTED: …and the resolution NAMES the `taint:ask` arrow — queryable, not inferred from the verdict");
  ok(
    taintTransform?.from === "allow" && taintTransform.to === "ask" && taintTransform.reason === "taint-ask",
    `TAINTED: …moving allow → ask with reason \`taint-ask\` (got ${JSON.stringify(taintTransform)}) — the DIRECTION is the claim; a transform firing from any other verdict is not lowering-prevention`,
  );
  ok(tainted.resolvedBy === `custom:${FIXTURE_ELEMENT}`, `TAINTED: …and the pre-transform verdict still came from \`custom:${FIXTURE_ELEMENT}\` (got ${tainted.resolvedBy}) — the arrow refused a lowering that really happened`);
  ok(tainted.tainted === true, "TAINTED: …and the resolution reports the taint the arrow read, so a caller cannot disagree with it");

  const fire = await resolveApproverChain(request({ tainted: true, unattended: true, principalId: undefined }), { approvers: approversForFixture });
  ok(fire.verdict === "deny", `UNATTENDED+TAINTED: a lowered gate-sink on an unwatched tainted run DENIES (got ${fire.verdict}) — an ask with nobody to ask IS a deny`);
  ok(
    fire.transforms.map((t) => t.name).join(",") === "taint:ask,unattended",
    `UNATTENDED+TAINTED: …and the ORDER is on the row — the taint floor raised it to ask, then \`unattended\` read that ask and denied (got ${JSON.stringify(fire.transforms.map((t) => t.name))})`,
  );

  if (failed > 0) {
    console.error(`✗ taint-floor-fixture: ${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(
    `✓ taint-floor-fixture: ${passed} assertions — the deployment's ONE gate-sink lowering (\`${FIXTURE_BUNDLE}\`) is narrow and surface-bound, it genuinely lands on a clean turn, the \`taint:ask\` floor refuses it on a tainted one (allow → ask, reason taint-ask), and an unattended tainted run denies. This is the offline half of S-TAINT-ROUTE-LIVE's ARM E (OPE-470 item 3).`,
  );
}

void main();
