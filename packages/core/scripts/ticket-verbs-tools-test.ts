import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { execTool } from "./_tool-exec.js";
registerSlackFixtureMapper();


const dir = join(tmpdir(), `open-everywhere-ticket-verbs-tools-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_EGRESS_SPOOF;

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

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const calls: { verb: string; entityId: string; value: string }[] = [];
registerEntityActionAdapter({
  platform: "tool-test-platform",
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
  const handler = (tool as { events: Record<string, Handler> }).events["session.started"];
  return (await handler({}, c)) as T | null;
}

{
  const onAdapterPlatform = await armed(addLabelDefault, ctx("tool-test-platform", {}));
  ok(onAdapterPlatform !== null, "add_label mounts on a session whose own origin has a ticket-action adapter");

  const crossSurface = await armed(addLabelDefault, ctx("slack", {}, ["slack", "tool-test-platform"]));
  ok(crossSurface !== null, "add_label mounts on a Slack session whose domain sources include a ticket-adapter platform");

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
    /not supported on "notion"/,
    "add_label refuses cleanly on an unsupported platform (Notion — no status/label mapping)",
  );
  n++;
}

{
  const before = (await getOperationalStore().listPendingActions("default")).length;
  await assert.rejects(
    async () => { await execTool(setStateEntry)({ ref: { platform: "tool-test-platform", id: "TT-1" }, state: "Done" }, ctx("tool-test-platform", {}) as never); },
    /approval-card path/,
    "set_state refuses on a proposing surface with no approval-card path (Linear/GitHub/etc origin)",
  );
  n++;
  const after = (await getOperationalStore().listPendingActions("default")).length;
  ok(after === before, "the approval-card-path refusal fires BEFORE any pending action is written");
}
{
  process.env.OE_EGRESS_SPOOF = "1";
  const slackCtx = ctx(
    "slack",
    { team_id: "T1", channel_id: "C1", channel_type: "channel", user_id: "U_PROPOSER" },
    ["slack", "tool-test-platform"],
  );
  const out = await execTool(setStateEntry)({ ref: { platform: "tool-test-platform", id: "TT-2" }, state: "Done" }, slackCtx as never);
  ok(out.pending === true && typeof out.pendingId === "string", "a Slack-origin proposal (with the entity's platform in sources) posts a card and returns pending");
  const row = await getOperationalStore().getPendingAction("default", out.pendingId!);
  ok(row !== null && row!.kind === "ticket.set_state", "the pending row is kind ticket.set_state");
  const frozen = JSON.parse(row!.argsJson) as { platform: string; entityId: string; state: string; requestedBy: string };
  ok(frozen.platform === "tool-test-platform" && frozen.entityId === "TT-2" && frozen.state === "Done", "the FROZEN args carry the resolved platform/entityId + the target state");
  ok(frozen.requestedBy === "U_PROPOSER", "the frozen args carry the verified proposer");
  delete process.env.OE_EGRESS_SPOOF;
}

{
  process.env.OE_EGRESS_SPOOF = "1";
  const slackCtx = ctx(
    "slack",
    { team_id: "T1", channel_id: "C1", channel_type: "channel", user_id: "U_PROPOSER" },
    ["slack", "tool-test-platform"],
  );
  const out = await execTool(assignEntry)({ ref: { platform: "tool-test-platform", id: "TT-3" }, assignee: "alice" }, slackCtx as never);
  ok(out.pending === true && typeof out.pendingId === "string", "assign posts a card and returns pending");
  const row = await getOperationalStore().getPendingAction("default", out.pendingId!);
  const frozen = JSON.parse(row!.argsJson) as { platform: string; entityId: string; assignee: string };
  ok(row!.kind === "ticket.assign" && frozen.assignee === "alice" && frozen.entityId === "TT-3", "the pending row is kind ticket.assign with the frozen assignee");
  delete process.env.OE_EGRESS_SPOOF;
}

console.log(`✓ ${n} ticket-verbs-tools assertions passed`);
