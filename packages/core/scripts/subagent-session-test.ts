// proves: DELG-01, DELG-05, DELG-06, DELG-07

import assert from "node:assert/strict";
import { classifySessionId, parseSubagentToken, isSubagentSessionToken, isSupervisorShapedToken, bareTokenFromEveContext, formatDmSeatToken, formatWindowToken } from "../agent/channels/window-key.js";
import { subagentParentOf, turnKind } from "../agent/hooks/spend.js";
import { checkDeclaredSubagents, listDeclaredSubagents, type DeclaredSubagentSource } from "../agent/subagents/declared.js";
import { checkConsequenceRegistry, type ConsequenceEntry } from "../agent/access/consequence.js";
import { checkWindowGateManifest } from "../agent/access/window-gate-manifest.js";
import { FRESH_EYES_REVIEW_OUTPUT } from "../agent/subagents/contracts.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const CHILD = "subagent:ses_01ABCDEF:call_7";

{
  const sid = classifySessionId(CHILD);
  eq(sid.kind, "subagent", "eve's delegated-child token classifies kind 'subagent' (was an unrecognised 'native' before OPE-45)");
  eq(sid.grain, "native", "the subagent arm's GRAIN stays 'native' — 'task' is a WIDE-HANDS grain, so promoting it would widen the tool gate");
  eq(sid.kind === "subagent" ? sid.parentSessionId : undefined, "ses_01ABCDEF", "parentSessionId is recovered (the attribution anchor: a child's spend belongs to its parent's surface)");
  eq(sid.kind === "subagent" ? sid.callId : undefined, "call_7", "callId is recovered — the parent's tool-call this child answers");

  eq(parseSubagentToken(CHILD), { parentSessionId: "ses_01ABCDEF", callId: "call_7" }, "parseSubagentToken returns both halves");
  ok(isSubagentSessionToken(CHILD), "isSubagentSessionToken recognises it");
  eq(parseSubagentToken("unified:" + CHILD), { parentSessionId: "ses_01ABCDEF", callId: "call_7" }, "eve's `unified:` send-prefix is stripped first, same as every other parse here");

  for (const junk of [undefined, null, 42, "", "subagent:", "subagent:onlyonepart", "notsubagent:a:b", {}]) {
    ok(parseSubagentToken(junk) === undefined, `parseSubagentToken is fail-soft on ${JSON.stringify(junk)}`);
    ok(classifySessionId(junk).kind !== "subagent", `classifySessionId does not over-match ${JSON.stringify(junk)}`);
  }
}

{
  ok(!isSupervisorShapedToken(CHILD), "a subagent token is NOT supervisor-shaped — routing/rotation stay inert");
  ok(!CHILD.includes(":oe-sup:g"), "…and does not carry the supervisor infix hooks/spend.ts's broad substring test looks for");
  ok(!CHILD.includes(":oe-dm:g"), "…nor the DM-seat infix");
  eq(bareTokenFromEveContext(CHILD), CHILD, "bareTokenFromEveContext passes a bare subagent token through unchanged (rule 1, structurally anchored)");
  eq(bareTokenFromEveContext("slack:" + CHILD), CHILD, "…and strips ONE namespace segment when eve reports it namespaced (rule 2)");
}

{
  const before: ReadonlyArray<readonly [unknown, string, string]> = [
    [formatWindowToken({ domain: "payments", windowId: "payments", generation: 3 }), "window", "standing"],
    [formatWindowToken({ domain: "payments", windowId: "t/slack/T1/C_PAY/1.2", generation: 3 }), "task", "task"],
    [formatWindowToken({ domain: "payments", windowId: "s/slackT1CPAY/1.2", generation: 3 }), "thread-seat", "thread"],
    ["notion:page-abc:oe-sup:g2", "container-supervisor", "standing"],
    [formatDmSeatToken("D123", 4), "dm-seat", "native"],
    ["cse_abc123", "native", "native"],
    ["", "native", "native"],
    [undefined, "native", "native"],
  ];
  for (const [tok, kind, grain] of before) {
    const sid = classifySessionId(tok);
    eq([sid.kind, sid.grain], [kind, grain], `byte-identity: ${JSON.stringify(tok)} still classifies ${kind}/${grain}`);
  }
}

const ctx = { channel: { kind: "local" }, session: { auth: { current: { attributes: {} } } } };

function withMode<T>(mode: string, fn: () => T): T {
  const prev = process.env.OE_MODE;
  process.env.OE_MODE = mode;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.OE_MODE;
    else process.env.OE_MODE = prev;
  }
}

{
  const projected = { ...ctx, session: { ...ctx.session, parent: { sessionId: "ses_01ABCDEF", callId: "call_7", rootSessionId: "ses_01ABCDEF", turn: { id: "turn_1", sequence: 1 } } } };
  eq(
    subagentParentOf(projected, undefined),
    { parentSessionId: "ses_01ABCDEF", callId: "call_7", rootSessionId: "ses_01ABCDEF" },
    "the parent is recovered from eve's TYPED projection with no token at all — now carrying the denormalised root too (OPE-369)",
  );
  const deeper = { ...ctx, session: { ...ctx.session, parent: { sessionId: "ses_CHILD", callId: "call_9", rootSessionId: "ses_ROOT", turn: { id: "turn_1", sequence: 1 } } } };
  eq(
    subagentParentOf(deeper, undefined),
    { parentSessionId: "ses_CHILD", callId: "call_9", rootSessionId: "ses_ROOT" },
    "🔴 OPE-369: on a GRANDCHILD the root and the immediate parent DIFFER — which is exactly the signal delegationDepthOf reads to tell a direct child from a deeper one",
  );
  eq(
    subagentParentOf(ctx, CHILD),
    { parentSessionId: "ses_01ABCDEF", callId: "call_7" },
    "…and from the continuation token with no projection at all — the two sources agree on the same child, though the TOKEN encodes no root (so none is invented)",
  );
  eq(subagentParentOf(ctx, "cse_ordinary"), undefined, "an ordinary root turn has no parent — the fail-closed answer");
  for (const junk of [undefined, null, 42, {}, { session: null }, { session: { parent: { sessionId: "" } } }, { session: { parent: { sessionId: "p" } } }]) {
    eq(subagentParentOf(junk as never, undefined), undefined, `subagentParentOf is fail-soft and never half-reads ${JSON.stringify(junk)}`);
  }
  eq(turnKind(projected, undefined), "subagent", "…and turnKind classifies from the same seam, so a projection-only child is tagged too");

  eq(turnKind(ctx, CHILD), "subagent", "a delegated child's usage row is tagged 'subagent' — delegated work is separable in the per-session cost series");
  eq(withMode("dm", () => turnKind(ctx, CHILD)), "subagent", "…including a child delegated FROM a DM: the subagent tag wins over the binding mode");
  ok(withMode("dm", () => turnKind(ctx, CHILD)) !== "dm", "a DM-delegated child does NOT classify 'dm' — the DM-seat starvation diagnostic no longer false-positives on it");

  eq(turnKind(ctx, "oe-dom:payments:oe-sup:g3"), "supervisor", "a supervisor token still tags 'supervisor' (precedence unchanged)");
  eq(withMode("dm", () => turnKind(ctx, formatDmSeatToken("D123", 2))), "dm", "a DM seat still tags 'dm'");
  eq(withMode("channel", () => turnKind(ctx, "cse_x")), "channel", "an ordinary channel turn still tags 'channel'");
  eq(turnKind(ctx, "cse_x"), "unclassified", "🔴 …and the SAME turn with nothing to resolve its mode tags 'unclassified' instead — a default may not reach the report mask as a room");
}

const FRAMEWORK = ["ask_question", "bash", "glob", "grep", "eve__skill", "read_file", "todo", "web_fetch", "web_search", "write_file"];
const GOOD_AGENT_SOURCE = "import root from \"../../agent.js\";\nexport default defineAgent({ description: \"x\", model: root.model });";
const DISABLED = "import { disableTool } from \"eve/tools\";\nexport default disableTool();\n";

function goodSubagent(overrides: Partial<DeclaredSubagentSource> = {}): DeclaredSubagentSource {
  return {
    name: "fresh_eyes_review",
    agentSource: GOOD_AGENT_SOURCE,
    hasInstructions: true,
    toolFiles: new Map(FRAMEWORK.map((t) => [t, DISABLED])),
    hookFiles: new Set(["spend"]),
    directories: new Set(["tools", "hooks"]),
    ...overrides,
  };
}

function expectProblem(subject: DeclaredSubagentSource, needle: string, label: string): void {
  const problems = checkDeclaredSubagents([subject], FRAMEWORK, []);
  ok(
    problems.some((p) => p.includes(needle)),
    `${label} (expected a problem mentioning "${needle}", got: ${problems.join(" | ") || "none"})`,
  );
}

{
  eq(checkDeclaredSubagents([goodSubagent()], FRAMEWORK, []), [], "a conforming subagent package passes clean");
  eq(checkDeclaredSubagents([], FRAMEWORK, []), [], "no subagents at all is legal (a fork may declare none)");
  eq(listDeclaredSubagents([goodSubagent({ name: "b_b" }), goodSubagent({ name: "a_a" })]), ["a_a", "b_b"], "listDeclaredSubagents returns the names sorted");

  const STATIC_MODEL = "import { PRIMARY_MODEL } from \"../../model/models.js\";\nexport default defineAgent({ description: \"x\", model: PRIMARY_MODEL });";
  expectProblem(goodSubagent({ agentSource: STATIC_MODEL }), "does not import the root agent", "a subagent that names a static model id is caught: it would skip the primary model resolver");
  expectProblem(
    goodSubagent({ agentSource: "import root from \"../../agent.js\";\nexport default defineAgent({ description: \"x\", model: \"vendor/model-a\" });" }),
    "sets `model` to `\"vendor/model-a\"`, not `root.model`",
    "a subagent that imports the root but still names a literal model id is caught",
  );
  expectProblem(
    goodSubagent({ agentSource: "import root from \"../../agent.js\";\nexport default defineAgent({ description: \"x\" });" }),
    "sets `model` to nothing",
    "a subagent with no `model` field is caught: eve would not run the primary model resolver for it",
  );
  expectProblem(
    goodSubagent({ agentSource: "import root from \"../../agent.js\";\nexport default defineAgent({ description: \"x\", model: root.model, \"model\": \"vendor/x\" });" }),
    "sets `model` to `root.model`, `\"vendor/x\"`",
    "a quoted duplicate `model` key is caught: the last key wins, so the subagent would call the static id",
  );
  expectProblem(
    goodSubagent({ agentSource: "import root from \"../../agent.js\";\nexport default defineAgent({ description: \"x\", model: root.model, [\"model\"]: \"vendor/x\" });" }),
    "sets `model` to `root.model`, `\"vendor/x\"`",
    "a computed `[\"model\"]` key beside `model: root.model` is caught",
  );
  expectProblem(
    goodSubagent({ agentSource: "import root from \"../../agent.js\";\nexport default defineAgent({ description: \"x\", model: root.model, [`model`]: \"vendor/x\" });" }),
    "sets `model` to `root.model`, `\"vendor/x\"`",
    "a computed template-literal `model` key beside `model: root.model` is caught",
  );
  expectProblem(
    goodSubagent({ agentSource: "import root from \"../../agent.js\";\nexport default defineAgent({ description: \"x\", 'model': 'vendor/x' });" }),
    "not `root.model`",
    "a single-quoted `model` key with a static id is caught",
  );
  eq(
    checkDeclaredSubagents([goodSubagent({ agentSource: "import parent from \"../../agent.ts\";\nexport default defineAgent({ description: \"x\", model: parent.model });" })], FRAMEWORK, []),
    [],
    "the root agent's model under another import name passes",
  );

  expectProblem(
    goodSubagent({ toolFiles: new Map(FRAMEWORK.filter((t) => t !== "bash").map((t) => [t, DISABLED])) }),
    "tools/bash.ts is missing",
    "a MISSING sentinel is caught — an absent slot mounts eve's built-in unfenced (hooks are not inherited either)",
  );
  expectProblem(
    goodSubagent({ toolFiles: new Map(FRAMEWORK.map((t) => [t, t === "bash" ? "export default defineTool({});" : DISABLED])) }),
    "is not a `disableTool()` sentinel",
    "a sentinel REPLACED by a real tool is caught",
  );
  expectProblem(
    goodSubagent({ toolFiles: new Map([...FRAMEWORK.map((t) => [t, DISABLED] as const), ["read_memory", "export default defineTool({});"]]) }),
    "is an authored tool",
    "an EXTRA authored tool is caught — giving a subagent hands is a posture change that must move its manifest rows first",
  );

  const REPLACEMENT = "import { defineTool } from \"eve/tools\";\nexport default defineTool({});\n";
  const withTool = (name: string, src: string): DeclaredSubagentSource =>
    goodSubagent({ toolFiles: new Map(FRAMEWORK.map((t) => [t, t === name ? src : DISABLED])) });

  eq(
    checkDeclaredSubagents([goodSubagent({ toolFiles: new Map(FRAMEWORK.filter((t) => t !== "bash").map((t) => [t, DISABLED])) })], FRAMEWORK, [], ["bash"]),
    [],
    "a RESERVED slot with NO FILE passes clean — eve itself refuses to let the subagent fill it, so an absent file is the only legal state",
  );
  ok(
    checkDeclaredSubagents([goodSubagent()], FRAMEWORK, [], ["bash"]).some((p) => p.includes("eve RESERVES") && p.includes("Delete it")),
    "…and a `disableTool()` sentinel at a RESERVED slot is caught, with the reason named — instead of eve's build throwing after every gate went green",
  );
  ok(
    checkDeclaredSubagents([withTool("bash", REPLACEMENT)], FRAMEWORK, [], ["bash"]).some((p) => p.includes("eve RESERVES") && p.includes("Delete it")),
    "…and so is a no-op REPLACEMENT there: eve 0.69.0 refuses every authored layer, so the route OPE-1537 took is gone and the message must not offer it",
  );
  ok(
    checkDeclaredSubagents([goodSubagent({ toolFiles: new Map(FRAMEWORK.filter((t) => t !== "bash").map((t) => [t, DISABLED])) })], FRAMEWORK, [], []).some((p) =>
      p.includes("tools/bash.ts is missing"),
    ),
    "negative control: the SAME absent file at a NON-reserved slot is still a hole — the exemption is per-slot, not blanket",
  );
  ok(
    checkDeclaredSubagents([withTool("bash", REPLACEMENT)], FRAMEWORK, [], []).some((p) => p.includes("is not a `disableTool()` sentinel")),
    "…and the same replacement at a NON-reserved slot is still a posture change",
  );
  ok(
    checkDeclaredSubagents(
      [goodSubagent({ toolFiles: new Map([...FRAMEWORK.map((t) => [t, DISABLED] as const), ["connection_search", DISABLED]]) })],
      FRAMEWORK,
      [],
      ["connection_search"],
    ).some((p) => p.includes("eve RESERVES") && p.includes("no posture change that makes this file legal")),
    "a file at a reserved slot eve does NOT default-mount is caught too, and gets the reserved message rather than \"re-tier it and update this lint\"",
  );
  ok(
    checkDeclaredSubagents([withTool("bash", `// this slot used to be a disableTool() sentinel\n${REPLACEMENT}`)], FRAMEWORK, [], []).some((p) =>
      p.includes("is not a `disableTool()` sentinel"),
    ),
    "a real tool that only MENTIONS disableTool() in a comment is not mistaken for a sentinel",
  );
  eq(
    checkDeclaredSubagents([withTool("bash", `// a sentinel: disableTool()\n${DISABLED}`)], FRAMEWORK, [], []),
    [],
    "…and a genuine sentinel still passes with such a comment above it",
  );

  expectProblem(goodSubagent({ agentSource: undefined }), "agent.ts is missing", "a missing config module is caught");
  expectProblem(goodSubagent({ agentSource: "export default defineAgent({ model: m() });" }), "no `description`", "a missing description is caught (eve fails the build on it too)");
  expectProblem(
    goodSubagent({ agentSource: "export default defineAgent({ description: \"x\", model: m(), outputSchema: modelFacingOutputSchema(S) });" }),
    "binds `outputSchema`",
    "a re-added outputSchema is caught — eve 0.69.0 removed the field, so it applies to nothing and fails the typecheck with no cause named",
  );
  expectProblem(goodSubagent({ hasInstructions: false }), "instructions.md is missing", "missing instructions are caught — a subagent inherits none from the root");

  expectProblem(goodSubagent({ hookFiles: new Set() }), "hooks/spend.ts is missing", "a missing spend hook is caught — hooks are NOT inherited, so the child would burn tokens off the ledger");

  expectProblem(goodSubagent({ name: "fresh-eyes-review" }), "not lower snake_case", "a dashed directory name is caught (it IS the model-visible tool name, in one namespace with agent/tools/*)");
  ok(
    checkDeclaredSubagents([goodSubagent({ name: "reply" })], FRAMEWORK, ["reply"]).some((p) => p.includes("collides with the tool")),
    "a subagent colliding with a real tool name is caught — eve rejects the build rather than picking a winner",
  );
  expectProblem(goodSubagent({ directories: new Set(["tools", "hooks", "schedules"]) }), "schedules/ is not supported", "a schedules/ dir is caught — schedules are root-only and eve fails the build");
  expectProblem(goodSubagent({ directories: new Set(["tools", "hooks", "prompts"]) }), "is not a slot eve discovers", "an unknown slot dir is caught — eve would silently ignore it");
}

{
  const noTools: never[] = [];
  const emptyShims = new Map<string, string>();

  const untieredProblems = checkConsequenceRegistry(noTools, [], () => undefined, {}, ["my_reviewer"]);
  ok(untieredProblems.some((p) => p.includes("my_reviewer") && p.includes("NO consequence declaration")), "an un-tiered subagent fails the consequence registry (fail-closed)");

  const openEntry: Record<string, ConsequenceEntry> = { my_reviewer: { tier: "open", via: { kind: "none" }, reason: "zero tools" } };
  eq(checkConsequenceRegistry(noTools, [], () => undefined, openEntry, ["my_reviewer"]), [], "an open/none subagent row passes");

  const gatedEntry: Record<string, ConsequenceEntry> = { my_reviewer: { tier: "gate:admin", via: { kind: "admin-roles" }, reason: "x" } };
  ok(
    checkConsequenceRegistry(noTools, [], () => undefined, gatedEntry, ["my_reviewer"]).some((p) => p.includes("must be open/none")),
    "a subagent cannot declare a gated tier — there is no source to scan and no ActionKind to own it; gate its OWN tools/ dir instead",
  );

  const noPosture = checkWindowGateManifest(noTools, emptyShims, [], {}, new Set(), ["task"], ["my_reviewer"]);
  ok(noPosture.some((p) => p.includes("my_reviewer") && p.includes("NO window-gate posture")), "a subagent with no declared grain posture fails the window-gate manifest (fail-closed)");
  eq(checkWindowGateManifest(noTools, emptyShims, [], {}, new Set(["my_reviewer"]), ["task"], ["my_reviewer"]), [], "…and passes once it is declared ungated");
  const gatedPosture = checkWindowGateManifest(noTools, emptyShims, [], { my_reviewer: ["standing"] }, new Set(), ["task"], ["my_reviewer"]);
  ok(!gatedPosture.some((p) => p.includes("disableTool") || p.includes("windowGatedKit")), "a GATED subagent is not asked for a sentinel shim or a kit provider (rule 4 skips it — the whole agent IS the tool)");
}

{
  const review = FRESH_EYES_REVIEW_OUTPUT.parse({
    recommendation: "block",
    summary: "No change was supplied.",
    evidenceSeen: false,
    findings: [{ severity: "high", category: "security", title: "No diff", detail: "Nothing to review." }],
  });
  eq(review.recommendation, "block", "fresh_eyes_review parses the fail-closed shape (evidenceSeen false ⇒ block)");
  eq(FRESH_EYES_REVIEW_OUTPUT.shape.recommendation.options, ["approve", "block"], "the review verdict stays two-valued — no 'approve with reservations' escape hatch");
  ok(!FRESH_EYES_REVIEW_OUTPUT.safeParse({ recommendation: "maybe", summary: "", evidenceSeen: true, findings: [] }).success, "an unknown recommendation is rejected");
}

console.log(`subagent-session-test: ${n} assertions passed`);
