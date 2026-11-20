// proves: DELG-30, DELG-31

import { __setTestValveForTest } from "../agent/testing/test-valves.js";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { execTool } from "./_tool-exec.js";
import { _dynamicResolverForTest } from "../agent/access/window-gated.js";
registerSlackFixtureMapper();

const dir = join(tmpdir(), `open-everywhere-ticket-verbs-tools-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
__setTestValveForTest("egress-spoof", false);

const { registerEntityActionAdapter } = await import("../agent/channels/entity-actions.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { registerConfig } = await import("../agent/access/config.js");
const addLabelDefault = (await import("../agent/tools/add_label.js")).default;
const { addLabelEntry } = await import("../agent/tools/add_label.js");
const setStateDefault = (await import("../agent/tools/set_state.js")).default;
const { setStateEntry } = await import("../agent/tools/set_state.js");
const assignDefault = (await import("../agent/tools/assign.js")).default;
const { assignEntry } = await import("../agent/tools/assign.js");
await import("../agent/approvals/flow.js");
type BindableContext = import("../agent/identity/binding.js").BindableContext;

const WORK_ROLE = "project-key";
const { registerIdentityMapper } = await import("../agent/identity/binding.js");
const { defineDomain } = await import("../agent/memory/domain.js");
for (const platform of ["tool-test-platform", "slack", "linear", "notion"]) {
  registerIdentityMapper(platform, (c) => {
    const attrs = ((c as { session?: { auth?: { current?: { attributes?: Record<string, string> } } } }).session?.auth?.current?.attributes) ?? {};
    return { workspace: "W1", surface: attrs["room"] ?? platform, mode: "channel", visibility: "public", trust: "internal", principalId: attrs["user_id"] ?? "U_TEST" };
  });
}
const VERB_DOMAINS = [
  defineDomain({
    name: "filing",
    reach: ["tool-test-platform/W1/tool-test-platform", "linear/W1/linear"],
    credentials: [
      { connector: "tool-test-platform", credential: WORK_ROLE, use: "filing-key" },
      { connector: "linear", credential: "workspace", use: "filing-linear" },
    ],
  }),
  defineDomain({
    name: "filing-slack",
    reach: ["slack/W1/granted"],
    credentials: [{ connector: "tool-test-platform", credential: WORK_ROLE, use: "filing-key" }],
  }),
  defineDomain({ name: "chat", reach: ["slack/W1/slack", "notion/W1/notion"] }),
];
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => VERB_DOMAINS,
  loadSilos: () => [],
  domainsForSurface: ({ workspaceKey, surface }) =>
    VERB_DOMAINS.filter((d) => (d.reach ?? []).includes(`${workspaceKey}/${surface}`)).map((d) => d.name),
});

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const calls: { verb: string; entityId: string; value: string }[] = [];
registerEntityActionAdapter({
  platform: "tool-test-platform",
  workRole: WORK_ROLE,
  setState: async (id, v) => {
    calls.push({ verb: "setState", entityId: id, value: v });
    return `set ${id} → ${v}`;
  },
  assign: async (id, v) => {
    calls.push({ verb: "assign", entityId: id, value: v });
    return `assigned ${id} → ${v}`;
  },
  addLabel: async (id, v) => {
    calls.push({ verb: "addLabel", entityId: id, value: v });
    return `labeled ${id} → ${v}`;
  },
});

function ctx(platform: string, attrs: Record<string, string> = {}, sources?: readonly string[]): BindableContext {
  return {
    channel: { kind: platform },
    session: { auth: { current: { attributes: { ...attrs, ...(sources ? { oe_sources: sources.join(",") } : {}) } } } },
  } as unknown as BindableContext;
}

type Handler = (event: unknown, ctx: unknown) => unknown;
async function armed<T>(tool: unknown, c: BindableContext): Promise<T | null> {
  const handler = _dynamicResolverForTest(tool);
  return (await handler({}, c)) as T | null;
}

{
  const onAdapterPlatform = await armed(addLabelDefault, ctx("tool-test-platform", {}));
  ok(onAdapterPlatform !== null, "add_label mounts on a session whose own origin has a ticket-action adapter");

  const crossSurface = await armed(addLabelDefault, ctx("slack", { room: "granted" }, ["slack", "tool-test-platform"]));
  ok(crossSurface !== null, "add_label mounts on a Slack session whose DOMAIN holds a ticket-adapter platform's work grant");

  const sourcedButUngranted = await armed(addLabelDefault, ctx("slack", {}, ["slack", "tool-test-platform"]));
  ok(sourcedButUngranted === null, "add_label is ABSENT on a Slack session that SOURCES the tracker but holds no grant for it");

  const plainChat = await armed(addLabelDefault, ctx("slack", {}));
  ok(plainChat === null, "add_label is ABSENT on a plain chat session with no ticket-adapter source and no default entity");

  const linearDefault = await armed(addLabelDefault, ctx("linear", { issue_id: "ENG-1" }));
  ok(linearDefault !== null, "add_label mounts on a Linear session even with no domain sources stamped (currentTurnEntityRef resolves the default)");

  ok((await armed(setStateDefault, ctx("slack", {}))) === null, "set_state is likewise absent on plain chat");
  ok((await armed(assignDefault, ctx("slack", {}))) === null, "assign is likewise absent on plain chat");
  ok((await armed(setStateDefault, ctx("tool-test-platform", {}))) !== null, "set_state mounts on a ticket-adapter-origin session");
  ok((await armed(assignDefault, ctx("tool-test-platform", {}))) !== null, "assign mounts on a ticket-adapter-origin session");
}

{
  calls.length = 0;
  const out = await execTool(addLabelEntry)(
    { ref: { platform: "tool-test-platform", id: "TT-1" }, label: "bug" },
    ctx("tool-test-platform", {}) as never,
  );
  ok(out.message.includes("labeled TT-1"), `add_label executes the mutation directly (${out.message})`);
  ok(calls.length === 1 && calls[0].verb === "addLabel" && calls[0].value === "bug", "the adapter fn ran with the right entityId/value");
}
{
  await assert.rejects(
    async () => { await execTool(addLabelEntry)({ label: "bug" }, ctx("slack", {}) as never); },
    /no ticket entity for this turn/,
    "add_label refuses cleanly when there's no ref and no default entity (chat surface)",
  );
  n++;
}
{
  await assert.rejects(
    async () => { await execTool(addLabelEntry)({ ref: { platform: "notion", id: "page-1" }, label: "x" }, ctx("notion", {}) as never); },
    /not one of this session's work destinations/,
    "add_label refuses cleanly on a platform no work adapter registered (Notion — no status/label mapping)",
  );
  n++;
}

{
  const before = (await getOperationalStore().listPendingActions("default")).length;
  await assert.rejects(
    async () => { await execTool(setStateEntry)({ ref: { platform: "tool-test-platform", id: "TT-1" }, state: "Done" }, ctx("tool-test-platform", {}) as never); },
    /I can't change that ticket's status from here.*has no approval-card path.*no Slack, Discord or Teams channel to put the card in.*domains\/[a-z0-9<>-]+\.ts\)/s,
    "set_state on a card-less origin refuses with the VENUE's copy (OPE-326) — its own verb, and the config change that would unblock it, not a flat 'this surface is not Slack'",
  );
  n++;
  const after = (await getOperationalStore().listPendingActions("default")).length;
  ok(after === before, "the venue refusal fires BEFORE any pending action is written");
}
{
  __setTestValveForTest("egress-spoof", true);
  const slackCtx = ctx(
    "slack",
    { room: "granted", team_id: "T1", channel_id: "C1", channel_type: "channel", user_id: "U_PROPOSER" },
    ["slack", "tool-test-platform"],
  );
  const out = await execTool(setStateEntry)({ ref: { platform: "tool-test-platform", id: "TT-2" }, state: "Done" }, slackCtx as never);
  ok(out.pending === true && typeof out.pendingId === "string", "a Slack-origin proposal (with the entity's platform in sources) posts a card and returns pending");
  const row = await getOperationalStore().getPendingAction("default", out.pendingId!);
  ok(row !== null && row!.kind === "ticket.set_state", "the pending row is kind ticket.set_state");
  const frozen = JSON.parse(row!.argsJson) as { platform: string; entityId: string; state: string; requestedBy: string };
  ok(frozen.platform === "tool-test-platform" && frozen.entityId === "TT-2" && frozen.state === "Done", "the FROZEN args carry the resolved platform/entityId + the target state");
  ok(frozen.requestedBy === "U_PROPOSER", "the frozen args carry the verified proposer");
  __setTestValveForTest("egress-spoof", false);
}

{
  await assert.rejects(
    async () => { await execTool(assignEntry)({ ref: { platform: "tool-test-platform", id: "TT-1" }, assignee: "alice" }, ctx("tool-test-platform", {}) as never); },
    /I can't assign that ticket from here.*has no approval-card path.*no Slack, Discord or Teams channel to put the card in.*domains\/[a-z0-9<>-]+\.ts\)/s,
    "assign refuses with the same venue copy and its own verb",
  );
  n++;
}
{
  __setTestValveForTest("egress-spoof", true);
  const slackCtx = ctx(
    "slack",
    { room: "granted", team_id: "T1", channel_id: "C1", channel_type: "channel", user_id: "U_PROPOSER" },
    ["slack", "tool-test-platform"],
  );
  const out = await execTool(assignEntry)({ ref: { platform: "tool-test-platform", id: "TT-3" }, assignee: "alice" }, slackCtx as never);
  ok(out.pending === true && typeof out.pendingId === "string", "assign posts a card and returns pending");
  const row = await getOperationalStore().getPendingAction("default", out.pendingId!);
  const frozen = JSON.parse(row!.argsJson) as { platform: string; entityId: string; assignee: string };
  ok(row!.kind === "ticket.assign" && frozen.assignee === "alice" && frozen.entityId === "TT-3", "the pending row is kind ticket.assign with the frozen assignee");
  __setTestValveForTest("egress-spoof", false);
}

console.log(`✓ ${n} ticket-verbs-tools assertions passed`);

// proves: TOOL-add_label, TOOL-assign, TOOL-set_state
