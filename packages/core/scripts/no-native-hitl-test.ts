import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("no-native-hitl");

const { findEveApprovalSites, TOOL_CONSEQUENCE, NON_TOOL_APPROVAL_SITES, checkConsequenceRegistry } = await import("../agent/access/consequence.js");
const { connectorApprovalPolicy } = await import("../agent/connections/connector-auth.js");
const { registerSettings, resetSettingsForTest } = await import("../agent/settings/settings.js");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed++;
}

const toolFiles = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
  .split("\n")
  .filter((f) => /(^|\/)agent\/tools\/[^/]+\.ts$/.test(f) && !f.includes("/docs/generated/"));
ok(toolFiles.length > 50, `§1 the scan found the tool files (found ${toolFiles.length}) — an empty scan proves nothing`);
ok(toolFiles.includes("packages/core/agent/tools/post_file.ts"), "§1 the scan covers post_file.ts, the door this slice closes");
const toolSites = toolFiles.flatMap((f) => findEveApprovalSites(f, readFileSync(join(repoRoot, f), "utf8")));
assert.deepEqual(
  toolSites.map((s) => `${s.file}:${s.line}`),
  [],
  "§1 a mounted tool carries an eve-native `approval:` other than `never()` — move it to an OE card (approvals/flow.ts requestApproval)",
);
passed++;
ok(findEveApprovalSites("x.ts", "  approval: once(),").length === 1, "§1 control: the predicate flags `approval: once()`");
ok(findEveApprovalSites("x.ts", "  approval: { request: p, response: r },").length === 1, "§1 control: the predicate flags an approval configuration");
ok(findEveApprovalSites("x.ts", "  approval: never(),").length === 0, "§1 control: the predicate passes `approval: never()`");

const hitlRows = Object.entries(TOOL_CONSEQUENCE)
  .filter(([, e]) => e.via.kind === "eve-hitl")
  .map(([n]) => n);
assert.deepEqual(hitlRows, [], "§2 a TOOL_CONSEQUENCE row still declares the banned eve-hitl mechanism");
passed++;
{
  const probe = checkConsequenceRegistry(
    [{ name: "probe_tool", source: "export default defineTool({ approval: once() })" }],
    [],
    () => undefined,
    { probe_tool: { tier: "open", via: { kind: "eve-hitl" }, reason: "probe" } },
  );
  ok(
    probe.some((p) => p.includes("probe_tool") && p.includes("OE cards only")),
    `§2 the consequence lint refuses an eve-hitl row (got: ${JSON.stringify(probe)})`,
  );
}

function prompts(decision: unknown): boolean {
  if (decision === true || decision === "user-approval") return true;
  return typeof decision === "object" && decision !== null && (decision as { type?: string }).type === "user-approval";
}
function allowsOrDenies(decision: unknown): boolean {
  if (decision === "not-applicable" || decision === undefined) return true;
  if (typeof decision !== "object" || decision === null) return false;
  const t = (decision as { type?: string }).type;
  return t === "denied" || t === "not-applicable";
}
const OPS = ["notion__search", "notion__create_page", "notion__delete_page", "notion__update_page"] as const;
for (const tiering of [false, true]) {
  resetSettingsForTest();
  if (tiering) registerSettings({ connectors: { opTiering: true } });
  for (const toolName of OPS) {
    for (const approved of [new Set<string>(), new Set<string>([toolName])]) {
      const decision = await connectorApprovalPolicy()({ toolName, approvedTools: approved, callId: `c-${toolName}`, toolInput: { title: "x" } } as never);
      const label = `§3 opTiering=${String(tiering)} ${toolName} approvedTools=${approved.size}`;
      ok(!prompts(decision), `${label}: the seam answered a native prompt (${JSON.stringify(decision)})`);
      ok(allowsOrDenies(decision), `${label}: the seam answered neither not-applicable nor denied (${JSON.stringify(decision)})`);
    }
  }
}
resetSettingsForTest();
registerSettings({ connectors: { opTiering: true } });
ok(
  (await connectorApprovalPolicy()({ toolName: "notion__search", approvedTools: new Set<string>(), callId: "c-read" } as never)) === "not-applicable",
  "§3 control: under opTiering a READ is still open",
);
resetSettingsForTest();

const builderSource = readFileSync(join(repoRoot, "packages/core/agent/connections/mcp-server-connection.ts"), "utf8");
const builderSites = findEveApprovalSites("mcp-server-connection.ts", builderSource);
ok(builderSites.length === 1, "§4 the shared MCP connection builder carries exactly one approval line");
ok(/^\s*approval:\s*connectorApprovalPolicy\(\),?\s*$/m.test(builderSource), "§4 the builder's approval is connectorApprovalPolicy() and nothing else");
const notionSource = readFileSync(join(repoRoot, "packages/core/agent/connections/notion.ts"), "utf8");
ok(findEveApprovalSites("notion.ts", notionSource).length === 0 && /export default buildMcpConnection\(/.test(notionSource), "§4 notion.ts builds through the shared builder and sets no approval of its own");
const notionReason = NON_TOOL_APPROVAL_SITES["packages/core/agent/connections/mcp-server-connection.ts"] ?? "";
ok(/never prompts/i.test(notionReason), "§5 the notion allowlist row says the seam never prompts");
ok(!/once\(\)/.test(notionReason.replace(/never returns `?once\(\)`?/gi, "")), "§5 the notion allowlist row no longer describes a live once()");

{
  const { withOeConnectorCard } = await import("../agent/connections/connector-auth.js");
  const memos = new Map<string, { createdAt: string; expiresAt: string }>();
  const seen = new Set<string>();
  const store = {
    getSessionApproval: async (_org: string, sessionId: string, kind: string) => {
      const m = memos.get(`${sessionId}|${kind}`);
      return m === undefined ? null : ({ org: "o", sessionId, kind, grantedBy: "U1", ...m } as never);
    },
    markEventSeen: async (_org: string, key: string) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    hasEventSeen: async (_org: string, key: string) => seen.has(key),
  };
  const offers: { tool: string; memoKind: string; grain: string }[] = [];
  let offerAnswer: "carded" | "refused" = "carded";
  const offer = async (o: { tool: string; memoKind: string; grain: string }) => {
    offers.push(o);
    return offerAnswer === "carded" ? ({ outcome: "carded", pendingId: "pend-1", where: "in this conversation" } as const) : ({ outcome: "refused", reason: "the room cannot host a card" } as const);
  };
  const prompt = () => "user-approval" as const;
  type Reach = "call" | "routine";
  const wrap = (key: string | undefined, reach: Reach) =>
    withOeConnectorCard(prompt, { store: store as never, offer: offer as never, grantScope: () => (key === undefined ? undefined : { key, reach }), tainted: () => false });
  let callSeq = 0;
  const call = (toolName: string, input: unknown, key: string | null = "win-1", callId = `c-${++callSeq}`, reach: Reach = "call") =>
    wrap(key ?? undefined, reach)({ toolName, approvedTools: new Set<string>(), callId, toolInput: input } as never);
  const reasonOf = (d: unknown) => String((d as { reason?: string }).reason ?? "");

  resetSettingsForTest();
  registerSettings({ connectors: { opTiering: true } });
  const first = await call("notion__create_page", { title: "a" });
  ok((first as { type?: string }).type === "denied" && reasonOf(first).includes("pend-1"), "§6 an unapproved write posts a card and is denied, naming the pending id");
  ok(reasonOf(first).includes("did NOT run"), "§6 the deny says the op did not run");
  ok(offers.length === 1 && offers[0]!.grain === "call", "🔴 §6 OPE-2363: the write is carded at the ONE-CALL grain, never a conversation grain");
  const writeKind = offers[0]!.memoKind;
  ok(writeKind.startsWith("connector.approved:notion__create_page#"), "§6 OPE-2363: …and its approval is keyed on the input digest");
  memos.set(`win-1|${writeKind}`, { createdAt: "2026-10-06T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" });
  ok((await call("notion__create_page", { title: "a" }, "win-2")) !== "not-applicable", "§6 the approval does not reach another conversation");
  ok((await call("notion__create_page", { title: "a" }, "win-1", "c-write")) === "not-applicable", "§6 the approved write runs once");
  ok((await call("notion__create_page", { title: "a" }, "win-1", "c-write")) === "not-applicable", "§6 eve's replay of the SAME call (same call id) passes again — the spend is replay-stable");
  ok((await call("notion__create_page", { title: "a" })) !== "not-applicable", "🔴 §6 OPE-2363: a SECOND identical write in the same conversation is carded again — the click covered one act");
  ok((await call("notion__create_page", { title: "b" })) !== "not-applicable", "§6 a write with another input is not covered");
  offers.length = 0;
  const del = await call("notion__delete_page", { id: "p1" });
  ok((del as { type?: string }).type === "denied" && offers[0]?.grain === "destructive", "§6 an unapproved delete is carded at the destructive grain");
  const delKind = offers[0]!.memoKind;
  ok(delKind.startsWith("connector.approved:notion__delete_page#"), "§6 the destructive approval is keyed on the input digest");
  memos.set(`win-1|${delKind}`, { createdAt: "2026-10-06T00:00:01.000Z", expiresAt: "2999-01-01T00:00:00.000Z" });
  ok((await call("notion__delete_page", { id: "p1" }, "win-1", "c-del")) === "not-applicable", "§6 the approved delete runs once");
  ok((await call("notion__delete_page", { id: "p1" })) !== "not-applicable", "§6 a second delete with the same input is carded again — the approval was spent");
  offerAnswer = "refused";
  const refused = await call("notion__update_page", { id: "x" });
  ok((refused as { type?: string }).type === "denied" && reasonOf(refused).includes("cannot host a card"), "§6 a refused card denies with its reason");
  const noKey = await call("notion__update_page", { id: "x" }, null);
  ok((noKey as { type?: string }).type === "denied" && reasonOf(noKey).includes("no conversation"), "§6 a call with no conversation key denies");
  offerAnswer = "carded";
  offers.length = 0;
  await call("notion__create_page", { title: "top" }, "oe-grant:slack/T1/C1:call", undefined, "call");
  await call("notion__create_page", { title: "top" }, "oe-grant:slack/T1/C1:thread:1.1", undefined, "call");
  ok(offers.length === 2 && offers.every((o) => o.grain === "call") && offers[0]!.memoKind === offers[1]!.memoKind, "§6 OPE-2363: a thread and a channel's top level card a write the SAME way: one call, the same digest kind");
  ok((await withOeConnectorCard(() => "not-applicable", { store: store as never, offer: offer as never, grantScope: () => ({ key: "win-1", reach: "call" }) })({ toolName: "notion__search", approvedTools: new Set<string>(), callId: "c" } as never)) === "not-applicable", "§6 a verdict that does not prompt passes through");
  resetSettingsForTest();
  offerAnswer = "carded";
  offers.length = 0;
  await call("notion__search", {});
  ok(offers[0]?.grain === "call" && offers[0]!.memoKind.startsWith("connector.approved:notion__search#"), "§6 with tiering off a read is carded at the one-call grain");
}

{
  const { connectorCardContext } = await import("../agent/approvals/connector-op.js");
  const surface = { channel: { kind: "subagent" }, session: { auth: { current: { principalId: "U1" } } } };
  const session = { id: "sess-child", turn: { id: "turn-7" }, parent: { sessionId: "sess-w", callId: "call-3" }, auth: { current: { principalId: "U1" } } };
  const merged = connectorCardContext(surface as never, session) as unknown as { channel: { kind: string }; session: { id: string; turn: { id: string }; parent: { callId: string } } };
  ok(merged.session.turn.id === "turn-7" && merged.session.parent.callId === "call-3" && merged.session.id === "sess-child", "§6b the card context carries the approval session's turn and parent");
  ok(merged.channel.kind === "subagent", "§6b …and keeps the surface kind resolved from the auth");
  ok(connectorCardContext(surface as never, undefined) === (surface as never), "§6b no session: the surface context stands");
}

{
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const req = createRequire(import.meta.url);
  const eveDist = dirname(req.resolve("eve/package.json"));
  const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveDist, "dist/src/context/container.js")).href)) as {
    ContextContainer: new () => unknown;
    contextStorage: { run<T>(store: unknown, fn: () => T): T };
  };
  const { projectToolSet } = await import("../agent/access/untrusted-projection.js");
  const { setWorkTierWake } = await import("../agent/access/lean-seat-state.js");
  const { WORK_QUESTION_TOOL } = await import("../agent/tools/ask_room.js");
  ok(WORK_QUESTION_TOOL === "ask_room", "§8 the tool's export and the projection's literal are one spelling");
  const kit = () => ({ ask_question: { description: "q" }, ask_room: { description: "r" }, reply: { description: "x" } }) as Record<string, unknown>;
  const project = (tier: "work" | "forwards" | "child" | "none") =>
    contextStorage.run(new ContextContainer(), () => {
      setWorkTierWake(tier);
      const t = kit();
      projectToolSet(t);
      return Object.keys(t);
    });
  const child = project("child");
  ok(!child.includes("ask_question") && child.includes("ask_room"), `§8 a child of W holds ask_room and not ask_question (got ${child.join(",")})`);
  for (const tier of ["none", "forwards"] as const) {
    const keys = project(tier);
    ok(keys.includes("ask_question") && !keys.includes("ask_room"), `§8 a ${tier} wake keeps ask_question and never holds ask_room (got ${keys.join(",")})`);
  }
}

{
  const askRoom = (await import("../agent/tools/ask_room.js")).default as unknown as {
    description: string;
    execute: (input: unknown, ctx: unknown) => Promise<unknown>;
  };
  const { renderRoomQuestion } = await import("../agent/tools/ask_room.js");
  let refusal = "";
  try {
    await askRoom.execute({ question: "which bucket?" }, { session: { auth: { current: { attributes: {} } } } });
  } catch (err) {
    refusal = String((err as Error).message);
  }
  ok(refusal.includes("only a job of this conversation's work session"), `§9 ask_room refuses outside a child of W (got: ${refusal})`);
  ok(/does NOT wait/.test(askRoom.description) && /finish your task/i.test(askRoom.description), "§9 the description says the call does not wait and the child must finish");
  const card = renderRoomQuestion("use staging?\nor prod?", ["staging", "prod"]);
  ok(card.includes("> use staging? or prod?") && card.includes("Options: staging · prod"), "§9 the card quotes the question on one line and lists the options");
}

console.log(`no-native-hitl: ${passed} assertions passed`);
