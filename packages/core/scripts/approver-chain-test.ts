import {
  APPROVER_LEVEL_ORDER,
  ELEMENT_CLAMPS,
  TRANSFORM_STAGE_ORDER,
  TRANSFORM_TABLE,
  chainAuditDetail,
  renderChainResolution,
  resolveApproverChain,
  registryVerdictOf,
  taintToleranceOf,
  toolForActionKind,
  type ApprovalChainRequest,
  type ApproverVerdict,
  type OperatorApprover,
} from "../agent/access/approver-chain.js";
import {
  registerApprovalJudgeCompletion,
  resetApprovalJudgeCompletion,
} from "../agent/access/approval-judge.js";
import { runApprovalScenarios, type ApprovalScenario } from "../agent/access/approval-scenarios.js";
import { judgeDeferredTool, TOOL_CONSEQUENCE } from "../agent/access/consequence.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function req(tool: string, extra: Partial<ApprovalChainRequest> = {}): ApprovalChainRequest {
  return { tool, unattended: false, tainted: false, principalId: "U1", ...extra };
}

const approver = (name: string, verdict: ApproverVerdict, extra: Partial<OperatorApprover> = {}): OperatorApprover => ({
  name,
  approve: () => verdict,
  ...extra,
});

ok(JSON.stringify(APPROVER_LEVEL_ORDER) === JSON.stringify(["custom", "surface", "classifier", "registry"]), "pin2: level order constant is custom → surface → classifier → registry");

{
  const res = await resolveApproverChain(req("create_ticket"), { approvers: [approver("lower", "allow")] });
  ok(res.verdict === "allow" && res.resolvedBy === "custom:lower", "pin2: L1 allow resolves before the registry's ask");
  ok(res.registryVerdict === "ask", "pin2: the registry baseline is still carried on the row");
  const ordered = await resolveApproverChain(req("create_ticket"), {
    approvers: [approver("first", undefined), approver("second", "allow"), approver("third", "ask")],
  });
  ok(ordered.resolvedBy === "custom:second", "pin2: within L1 the band is config-ordered, defer passes down");
}

for (const [tool, entry] of Object.entries(TOOL_CONSEQUENCE)) {
  const res = await resolveApproverChain(req(tool));
  const expected = entry.tier === "open" ? "allow" : "ask";
  ok(res.verdict === expected && res.resolvedBy === "registry" && res.transforms.length === 0, `parity: ${tool} resolves ${expected} by the registry, untransformed`);
}
{
  const read = await resolveApproverChain(req("notion__search"));
  ok(read.verdict === "allow" && read.resolvedBy === "verb-classifier", "parity: connector read resolves allow at the classifier");
  const write = await resolveApproverChain(req("notion__create_page"));
  ok(write.verdict === "ask" && write.askVariant === "blocking", "parity: connector write resolves ask (blocking variant reserved)");
  const unknown = await resolveApproverChain(req("no_such_tool"));
  ok(unknown.verdict === "ask" && unknown.resolvedBy === "registry", "parity: unknown name fails closed to ask at the terminal");
}

{
  let seed = 0x5eed296;
  const rand = (): number => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

  const verdicts: readonly ApproverVerdict[] = ["allow", "deny", "ask", undefined];
  const tools = ["create_ticket", "reply", "remember", "add_routine_rule", "notion__create_page", "notion__search", "no_such_tool", "open_pull_request"];
  const modes = [undefined, { mode: "DANGEROUSLY_BYPASS" as const }, { mode: "APPROVE_ALL" as const, allowlist: ["reply", "create_ticket"] }, { mode: "DENY_ALL" as const }];

  let denyIns = 0;
  for (let i = 0; i < 3000; i++) {
    const approvers: OperatorApprover[] = [];
    const n = Math.floor(rand() * 4);
    for (let j = 0; j < n; j++) {
      const v = pick(verdicts);
      const source = pick(["operator", "operator", "connector", "remote"] as const);
      const mayAllow = rand() < 0.3;
      const throws = rand() < 0.1;
      approvers.push({
        name: `f${j}`,
        source,
        ...(mayAllow ? { mayAllow: true } : {}),
        approve: throws
          ? () => {
              throw new Error("fuzzed element error");
            }
          : () => v,
      });
    }
    const request = req(pick(tools), {
      mode: pick(modes),
      unattended: rand() < 0.3,
      tainted: rand() < 0.3,
      ...(rand() < 0.2 ? { grant: { kind: "pr.open", grantedBy: "U9" } } : {}),
      ...(rand() < 0.15 ? { connectorOpRaise: pick(["write", "destructive"] as const) } : {}),
      ...(rand() < 0.15 ? { aws: { argv: pick([["logs", "describe-log-groups"], ["configure", "export-credentials"], ["s3", "cp", "a", "b"]]), allow: pick([["*"], ["logs"], undefined]) } } : {}),
    });
    const res = await resolveApproverChain(request, { approvers });
    const denyIn = res.elements.some((e) => e.verdict === "deny");
    if (denyIn) {
      denyIns++;
      ok(res.verdict === "deny", `pin1: deny-in ⇒ deny-out (iteration ${i}: got ${res.verdict} via ${res.resolvedBy})`);
      ok(res.transforms.length === 0 && res.denyAbsolute === true, `pin1: an element deny skips ALL transforms (iteration ${i})`);
    }
  }
  ok(denyIns > 200, `pin1: the fuzz actually exercised deny-in (${denyIns} times)`);
  console.log(`  pin1: deny-invariant held over 3000 fuzzed resolutions (${denyIns} deny-in cases)`);
}

ok(JSON.stringify(TRANSFORM_STAGE_ORDER) === JSON.stringify(["mode", "unattended", "taint", "floor"]), "pin3: transform stage order is mode → unattended → taint → floor (OPE-318 phase 2 removed the inert judge stage — the judge is a resolution step now)");
{
  const names = TRANSFORM_TABLE.map((t) => t.name);
  ok(
    JSON.stringify(names) === JSON.stringify([
      "mode:DANGEROUSLY_BYPASS",
      "mode:APPROVE_ALL",
      "mode:DENY_ALL",
      "unattended",
      "taint:refuse",
      "beneficiary-clicker-floor",
    ]),
    "pin3: the transform table declares exactly the six known arrows (OPE-318 phase 2 removed judge:AUTO — a judge verdict is resolution, not a transform)",
  );
  ok(!names.includes("judge:AUTO"), "pin3: there is NO judge arrow — the armed judge resolves before the pipeline, it does not ride it");
  ok(!names.includes("taint:card"), "pin3: there is NO taint:card arrow — a taint marking does not move a verdict (OPE-307)");
  ok(TRANSFORM_TABLE.filter((t) => t.stage === "taint").length === 1, "pin3: exactly ONE taint arrow survives, and it is the four-sink refusal");
  ok(TRANSFORM_TABLE.every((t) => !(t.from as readonly string[]).includes("deny")), "pin3: no arrow's `from` contains deny — deny never enters the pipeline");

  const bypass = await resolveApproverChain(req("create_ticket", { mode: { mode: "DANGEROUSLY_BYPASS" } }));
  ok(bypass.verdict === "allow" && bypass.transforms.length === 1 && bypass.transforms[0]!.name === "mode:DANGEROUSLY_BYPASS", "pin3: BYPASS moves ask → allow");
  const bypassOpen = await resolveApproverChain(req("reply", { mode: { mode: "DANGEROUSLY_BYPASS" } }));
  ok(bypassOpen.verdict === "allow" && bypassOpen.transforms.length === 0, "pin3: BYPASS has no arrow from allow");

  const floor = await resolveApproverChain(req("read_channel", { mode: { mode: "APPROVE_ALL" } }));
  ok(floor.verdict === "ask" && floor.transforms[0]!.name === "mode:APPROVE_ALL", "pin3: APPROVE_ALL floors allow → ask");
  const kept = await resolveApproverChain(req("read_channel", { mode: { mode: "APPROVE_ALL", allowlist: ["read_channel"] } }));
  ok(kept.verdict === "allow" && kept.transforms.length === 0, "pin3: APPROVE_ALL allowlist keeps the registry default");
  const restored = await resolveApproverChain(req("create_ticket", { mode: { mode: "APPROVE_ALL", allowlist: ["create_ticket"] } }), {
    approvers: [approver("lower", "allow")],
  });
  ok(restored.verdict === "ask" && restored.transforms[0]!.to === "ask", "pin3: APPROVE_ALL restoration is to the REGISTRY default, tightening a lowered allow");

  const dAllow = await resolveApproverChain(req("reply", { mode: { mode: "DENY_ALL" } }));
  const dAsk = await resolveApproverChain(req("create_ticket", { mode: { mode: "DENY_ALL" } }));
  ok(dAllow.verdict === "deny" && dAsk.verdict === "deny", "pin3: DENY_ALL tightens every verdict to deny ([OPEN] arrow implemented as * → deny)");
  ok(dAsk.transforms[0]!.reason === "mode-deny-all", "pin3: DENY_ALL denies carry their reason");

}

{
  const ordinaryLowered = await resolveApproverChain(req("create_ticket"), { approvers: [approver("lower", "allow")] });
  ok(ordinaryLowered.verdict === "allow" && ordinaryLowered.transforms.length === 0, "floor: an ordinary (non-beneficiary) verb's config lowering is untouched");

  const beneficiaryLowered = await resolveApproverChain(req("rotate_webhook", { action: "webhook.rotate", beneficiaryClicker: true }), {
    approvers: [approver("lower", "allow")],
  });
  ok(beneficiaryLowered.verdict === "ask", "floor: a config-lowered beneficiary-clicker kind is floored BACK to ask");
  ok(
    beneficiaryLowered.transforms.length === 1 && beneficiaryLowered.transforms[0]!.name === "beneficiary-clicker-floor" && beneficiaryLowered.transforms[0]!.to === "ask",
    "floor: the floor is recorded as a TRANSFORM (allow → ask), so the audit row shows the lowering AND its refusal",
  );
  ok(beneficiaryLowered.resolvedBy === "custom:lower", "floor: resolvedBy still names the element that tried to lower it — the floor doesn't hide who attempted it");

  const beneficiaryBypassed = await resolveApproverChain(req("rotate_webhook", { action: "webhook.rotate", beneficiaryClicker: true, mode: { mode: "DANGEROUSLY_BYPASS" } }));
  ok(beneficiaryBypassed.verdict === "ask", "floor: DANGEROUSLY_BYPASS cannot lift a beneficiary-clicker kind's floor either");
  ok(
    beneficiaryBypassed.transforms.map((t) => t.name).join(",") === "mode:DANGEROUSLY_BYPASS,beneficiary-clicker-floor",
    "floor: BYPASS's ask→allow is recorded, then the floor tightens it straight back — both transforms visible on the row",
  );

  const beneficiaryUnlowered = await resolveApproverChain(req("rotate_webhook", { action: "webhook.rotate", beneficiaryClicker: true }));
  ok(beneficiaryUnlowered.verdict === "ask" && beneficiaryUnlowered.transforms.length === 0, "floor: an unlowered beneficiary-clicker kind cards exactly as before — no transform fires");
}

ok(ELEMENT_CLAMPS.connector.includes("deny") && !ELEMENT_CLAMPS.connector.includes("allow"), "pin4: connector clamp is raise-only by default");
ok(ELEMENT_CLAMPS.remote.includes("deny") && !ELEMENT_CLAMPS.remote.includes("allow"), "pin4: remote clamp is raise-only by default");
ok(!ELEMENT_CLAMPS.registry.includes("defer"), "pin4: the registry may not defer");
{
  const clamped = await resolveApproverChain(req("create_ticket"), { approvers: [approver("vendor", "allow", { source: "connector" })] });
  const el = clamped.elements.find((e) => e.element === "custom:vendor")!;
  ok(el.verdict === "defer" && el.clamped === true, "pin4: out-of-clamp allow ⇒ defer + clamped:true on the row");
  ok(clamped.verdict === "ask" && clamped.resolvedBy === "registry", "pin4: resolution continues past a clamped element (worked example 5)");
  const escaped = await resolveApproverChain(req("create_ticket"), { approvers: [approver("vendor", "allow", { source: "connector", mayAllow: true })] });
  ok(escaped.verdict === "allow" && escaped.resolvedBy === "custom:vendor", "pin4: config-granted mayAllow escapes the clamp");
  const vendorDeny = await resolveApproverChain(req("reply"), { approvers: [approver("vendor", "deny", { source: "connector" })] });
  ok(vendorDeny.verdict === "deny", "pin4: a connector element may always deny");

  const erroring = await resolveApproverChain(req("reply"), {
    approvers: [
      { name: "boom", approve: () => { throw new Error("kaput"); } },
      approver("wouldAllow", "allow"),
    ],
  });
  const boom = erroring.elements.find((e) => e.element === "custom:boom")!;
  ok(boom.verdict === "ask" && boom.error === true, "pin4: element error ⇒ ask + element-error on the row");
  ok(erroring.verdict === "ask" && erroring.resolvedBy === "custom:boom", "pin4: an erroring element fails CLOSED (its ask resolves, shadowing later allows)");
}

{
  const saved = process.env.OE_APPROVAL_JUDGE;
  let transportCalls = 0;
  registerApprovalJudgeCompletion(async () => {
    transportCalls++;
    return "NO";
  });
  try {
    const flipped = Object.entries(TOOL_CONSEQUENCE)
      .filter(([, e]) => e.judgeDefer === true)
      .map(([t]) => t)
      .sort();
    ok(
      JSON.stringify(flipped) === JSON.stringify(["create_routine", "forget", "open_pull_request", "request_access", "set_spend_limit"]),
      `pin5: exactly the five shadow-evidenced rows carry the defer flip (got ${flipped.join(", ")})`,
    );
    ok(judgeDeferredTool("open_pull_request") && !judgeDeferredTool("create_ticket"), "pin5: judgeDeferredTool reads the flip, and an unflipped gated row stays plain ask");
    ok(!judgeDeferredTool("notion__create_page"), "pin5: connector ops carry NO flip — the class-policy half is a seam, not an implementation (no evidence yet)");

    process.env.OE_APPROVAL_JUDGE = "enforce";
    const noOptIn = await resolveApproverChain(req("open_pull_request"));
    ok(noOptIn.verdict === "ask" && noOptIn.judge === undefined && noOptIn.transforms.length === 0, "pin5: without the caller's judge opt-in an armed deploy still resolves the plain ask (simulators stay judge-free)");

    const unflipped = await resolveApproverChain(req("create_ticket"), { judge: true });
    ok(unflipped.verdict === "ask" && unflipped.judge === undefined, "pin5: an unflipped gated row never reaches the judge, whatever the env and caller say");

    process.env.OE_APPROVAL_JUDGE = "shadow";
    const shadowMode = await resolveApproverChain(req("open_pull_request"), { judge: true });
    ok(shadowMode.verdict === "ask" && shadowMode.judge === undefined, "pin5: under shadow a defer row resolves exactly as ask (shadow's own observation seam lives in the propose plane, not here)");
    delete process.env.OE_APPROVAL_JUDGE;
    const off = await resolveApproverChain(req("open_pull_request"), { judge: true });
    ok(off.verdict === "ask" && off.judge === undefined && off.resolvedBy === "registry", "pin5: with the judge off a defer row is byte-identical to the pre-flip chain");

    ok(transportCalls === 0, "pin5: across every gate-missing combination the transport was NEVER called");
  } finally {
    resetApprovalJudgeCompletion();
    if (saved === undefined) delete process.env.OE_APPROVAL_JUDGE;
    else process.env.OE_APPROVAL_JUDGE = saved;
  }
}

{
  const request = req("create_ticket", { action: "ticket.create", domain: "support", mode: { mode: "DANGEROUSLY_BYPASS" }, tainted: true });
  const res = await resolveApproverChain(request, { approvers: [approver("vendor", "allow", { source: "connector" }), approver("boom", undefined)] });
  const detail = chainAuditDetail(request, res);
  ok(detail.tool === "create_ticket" && detail.action === "ticket.create", "pin6: row carries tool + action");
  ok(detail.registryVerdict === "ask" && typeof detail.verdict === "string", "pin6: row carries BOTH the registry verdict and the final verdict");
  ok(typeof detail.resolvedBy === "string", "pin6: row carries resolvedBy");
  const elements = detail.elements as readonly { element: string; verdict: string; clamped?: boolean }[];
  ok(elements.length === res.elements.length && elements.every((e) => typeof e.element === "string" && typeof e.verdict === "string"), "pin6: EVERY element's verdict is on the row (defers included)");
  ok(elements.some((e) => e.clamped === true), "pin6: clamped:true marks survive onto the row");
  ok(Array.isArray(detail.transforms), "pin6: the ordered transform list is on the row");
  ok(detail.unattended === false && detail.tainted === true && detail.mode === "DANGEROUSLY_BYPASS", "pin6: context (unattended/tainted/mode) is on the row");
  const lines = renderChainResolution(request, res);
  ok(lines.some((l) => l.includes("registry baseline")) && lines.some((l) => l.includes("custom:vendor")), "pin6: the shared renderer shows the same trace");
}

const EXAMPLES: readonly ApprovalScenario[] = [
  {
    name: "example 1: custom deny survives DANGEROUSLY_BYPASS",
    request: req("reply", { mode: { mode: "DANGEROUSLY_BYPASS" } }),
    approvers: [approver("never-announcements", "deny")],
    expect: { verdict: "deny", resolvedBy: "custom:never-announcements", transforms: [] },
  },
  {
    name: "example 2: gated verb, no config",
    request: req("create_ticket"),
    expect: { verdict: "ask", resolvedBy: "registry", transforms: [], registryVerdict: "ask" },
  },
  {
    name: "example 3: unattended fire denies fast",
    request: req("create_ticket", { unattended: true, principalId: undefined }),
    expect: { verdict: "deny", resolvedBy: "registry", transforms: ["unattended"], registryVerdict: "ask" },
  },
  {
    name: "example 4: config lowers create_ticket",
    request: req("create_ticket"),
    approvers: [approver("support-lower", "allow")],
    expect: { verdict: "allow", resolvedBy: "custom:support-lower", registryVerdict: "ask" },
  },
  {
    name: "example 5: connector allow clamps to defer",
    request: req("create_ticket"),
    approvers: [approver("vendor", "allow", { source: "connector" })],
    expect: { verdict: "ask", resolvedBy: "registry" },
  },
  {
    name: "example 6: taint refusal survives BYPASS (§6 ordering)",
    request: req("add_routine_rule", { tainted: true, mode: { mode: "DANGEROUSLY_BYPASS" } }),
    expect: { verdict: "deny", transforms: ["mode:DANGEROUSLY_BYPASS", "taint:refuse"] },
  },
  {
    name: "example 7: beneficiary-clicker floor refuses a config lowering",
    request: req("rotate_webhook", { action: "webhook.rotate", beneficiaryClicker: true }),
    approvers: [approver("support-lower", "allow")],
    expect: { verdict: "ask", resolvedBy: "custom:support-lower", registryVerdict: "ask", transforms: ["beneficiary-clicker-floor"] },
  },
  {
    name: "example 8: beneficiary-clicker floor survives BYPASS",
    request: req("rotate_webhook", { action: "webhook.rotate", beneficiaryClicker: true, mode: { mode: "DANGEROUSLY_BYPASS" } }),
    expect: { verdict: "ask", transforms: ["mode:DANGEROUSLY_BYPASS", "beneficiary-clicker-floor"] },
  },
];
{
  const failures = await runApprovalScenarios(EXAMPLES);
  ok(failures.length === 0, `worked examples: all eight pass through the scenario runner${failures.length > 0 ? ` — ${failures.join(" | ")}` : ""}`);
}

ok(taintToleranceOf("add_routine_rule") === "refuse", "taint: add_routine_rule is a refuse-sink");
ok(taintToleranceOf("remember") === "disclose", "taint: remember DISCLOSES — the column is now marking vocabulary, not a gate (OPE-307)");
ok(taintToleranceOf("reply") === undefined, "taint: an open conversational verb carries no tolerance — a tainted turn can still reply");
ok(taintToleranceOf("notion__create_page") === "disclose", "taint: a connector write discloses on a tainted turn");
ok(taintToleranceOf("notion__search") === undefined, "taint: a connector read is not taint-gated");
ok(taintToleranceOf("no_such_tool") === "refuse", "taint: an unknown name fails closed to refuse");
{
  const refusing = Object.entries(TOOL_CONSEQUENCE)
    .filter(([, e]) => e.taint === "refuse")
    .map(([t]) => t)
    .sort();
  ok(
    JSON.stringify(refusing) === JSON.stringify(["add_routine_rule", "declare_webhook", "remove_routine_rule", "rotate_webhook"]),
    `taint: exactly the four standing-instruction/ingress sinks declare refuse (got ${refusing.join(", ")})`,
  );

  const read = await resolveApproverChain(req("notion__search", { tainted: true }));
  ok(read.verdict === "allow", "taint: tainted connector read stays allow (no blanket all-tools-to-ask)");
  const write = await resolveApproverChain(req("notion__create_page", { tainted: true }));
  ok(write.verdict === "ask" && write.transforms.length === 0, "taint: a tainted connector write was ALREADY ask — no taint arrow moved it");

  const lowered = await resolveApproverChain(req("remember", { tainted: true }), { approvers: [approver("domain-lower", "allow")] });
  ok(lowered.verdict === "allow", "taint: a tainted turn's CONFIG-LOWERED allow proceeds — the demoted arrow is really gone");
  ok(lowered.transforms.length === 0, "taint: …and no transform fired at all on that resolution");
  const detail = chainAuditDetail(req("remember", { tainted: true }), lowered);
  ok(detail.tainted === true, "taint: …while the audit row still DISCLOSES the provenance (marking, not gating)");

  const clean = await resolveApproverChain(req("remember", { tainted: false }), { approvers: [approver("domain-lower", "allow")] });
  ok(clean.verdict === "allow" && clean.transforms.length === 0, "taint: the untainted control resolves the same way");

  const grantedFire = await resolveApproverChain(
    req("open_pull_request", { tainted: true, unattended: true, principalId: undefined, grant: { kind: "pr.open", grantedBy: "U7" } }),
  );
  ok(grantedFire.verdict === "allow", "taint: a GRANTED action on a tainted unattended fire proceeds — no card is minted into an empty room");
  ok(grantedFire.transforms.length === 0, "taint: …and the fire's resolution applies no transform at all");

  const refused = await resolveApproverChain(req("add_routine_rule", { tainted: true }), { approvers: [approver("domain-lower", "allow")] });
  ok(refused.verdict === "deny" && refused.transforms.some((t) => t.name === "taint:refuse"), "taint: a refuse-sink still denies — even against a config-lowered allow");
}

ok(toolForActionKind("ticket.create") === "create_ticket", "kind map: ticket.create → create_ticket");
ok(toolForActionKind("session.checkpoint") === undefined, "kind map: a non-tool kind maps to nothing (caller falls back fail-closed)");
ok(registryVerdictOf("session.checkpoint") === "ask", "kind map: the fallback name resolves ask at the terminal");

{
  const ordinaryFire = await resolveApproverChain(req("open_pull_request", { unattended: true, principalId: undefined }));
  ok(ordinaryFire.verdict === "deny" && ordinaryFire.transforms[0]!.reason === "ask-unattended", "P3: an ORDINARY fire (thread grain) takes ask → deny");
  const granted = await resolveApproverChain(req("open_pull_request", { unattended: true, principalId: undefined, grant: { kind: "pr.open", grantedBy: "U7" } }));
  ok(granted.verdict === "allow" && granted.resolvedBy === "session-grant", "P3: a standing grant lets the unattended fire proceed (no ask arises)");
  const attended = await resolveApproverChain(req("open_pull_request"));
  ok(attended.verdict === "ask", "P3: attended ask is untouched");
}

{
  const refused = await resolveApproverChain(req("aws", { aws: { argv: ["logs", "--endpoint-url", "https://attacker/", "describe-log-groups"], allow: ["logs"] } }));
  ok(refused.verdict === "deny" && refused.resolvedBy === "aws-allow-list" && refused.denyAbsolute === true, "aws: the L2 screen denies a redirect option absolutely");
  const clean = await resolveApproverChain(req("aws", { aws: { argv: ["logs", "describe-log-groups"], allow: ["logs"] } }));
  ok(clean.verdict === "allow" && clean.resolvedBy === "registry", "aws: a clean screened command defers to the registry's open allow");
}

{
  const request = req("create_ticket", { mode: { mode: "APPROVE_ALL", allowlist: ["reply"] } });
  const approvers = [approver("a", undefined), approver("b", "ask")];
  const t0 = performance.now();
  const N = 2000;
  for (let i = 0; i < N; i++) await resolveApproverChain(request, { approvers });
  const perResolution = (performance.now() - t0) / N;
  console.log(`  P0 latency: evaluate-all over a ${2 + 5}-element chain ≈ ${(perResolution * 1000).toFixed(1)}µs/resolution`);
}

console.log(`✓ approver-chain: ${passed} assertions — six pins held (deny-invariant fuzzed, level order pinned, transform table honoured, clamps fail closed, judge consult triple-gated, audit rows complete), registry parity exact, all eight worked examples green (incl. the OPE-310 beneficiary-clicker floor)`);
