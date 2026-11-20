import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("connector-replay");

const { withOeConnectorCard } = await import("../agent/connections/connector-auth.js");
const { connectorOpArgsFromOffer } = await import("../agent/approvals/connector-op.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { CONNECTOR_OP_CARD_KIND, CONNECTOR_REPLAY_INPUT_KEY, CONNECTOR_INPUT_PREVIEW_CAP } = await import("../agent/approvals/connector-op-offer.js");
const { defineConnectorTool } = await import("../agent/connections/connector-tools.js");
const { fakeMcpServer } = await import("./_fake-mcp-server.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { deploymentOrg } = await import("../agent/identity/binding.js");
const { registerSettings, resetSettingsForTest } = await import("../agent/settings/settings.js");
type Offer = import("../agent/approvals/connector-op-offer.js").ConnectorOpCardOffer;

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed++;
}

resetSettingsForTest();
registerSettings({ connectors: { opTiering: true } });
const store = getOperationalStore();
const org = deploymentOrg();
const reasonOf = (d: unknown): string => String((d as { reason?: unknown } | undefined)?.reason ?? "");
const isDenied = (d: unknown): boolean => typeof d === "object" && d !== null && (d as { type?: unknown }).type === "denied";

// The vendor side: a fake MCP server behind the OE connector tool (connections/connector-tools.ts),
// the tool eve 1.x runs for a connector op. Each `tools/call` the server receives is one execute.
const server = fakeMcpServer({ toolResult: { content: [{ type: "text", text: "vendor-ok" }] } });
const executed: { input: unknown; callId: string }[] = [];
const appAuth = async () => ({ principalType: "app" as const, async getToken() { return { token: "t" }; } });
const executeTool = {
  async execute(call: { connection: string; tool: string; input: unknown }, o: { toolCallId: string }): Promise<unknown> {
    const tool = defineConnectorTool(
      { connection: call.connection, url: "https://mcp.example.test/mcp", auth: appAuth as never, client: { fetch: server.fetch } },
      { name: call.tool, description: call.tool, inputSchema: { type: "object" }, hasOutputSchema: false },
    ) as unknown as { execute(i: unknown, c: unknown): Promise<unknown> };
    const before = server.seen.length;
    try {
      return await tool.execute(call.input, { callId: o.toolCallId, session: { id: "replay-session", auth: undefined } });
    } finally {
      for (const r of server.seen.slice(before)) {
        if (r.body?.["method"] !== "tools/call") continue;
        const params = r.body["params"] as { name: string; arguments: unknown };
        executed.push({ input: { connection: call.connection, tool: params.name, input: params.arguments }, callId: o.toolCallId });
      }
    }
  },
};

async function driveCall(input: {
  readonly key: string;
  readonly op: string;
  readonly opInput: unknown;
  readonly callId: string;
  readonly policy?: Parameters<typeof withOeConnectorCard>[0];
  readonly offers?: Offer[];
}): Promise<{ decision: unknown; ran: boolean; error?: string }> {
  const offers = input.offers ?? [];
  const seam = withOeConnectorCard(input.policy ?? (() => "user-approval"), {
    store,
    grantScope: () => ({ key: input.key, reach: "call" }) as never,
    tainted: () => false,
    credentialOf: async () => "domain",
    offer: async (o) => {
      offers.push(o as Offer);
      return { outcome: "carded", pendingId: "pending-from-offer", where: "in this conversation" };
    },
  });
  const decision = await seam({ toolName: `notion__${input.op}`, callId: input.callId, toolInput: input.opInput } as never);
  if (decision !== "not-applicable") return { decision, ran: false };
  const before = executed.length;
  try {
    await executeTool.execute({ connection: "notion", tool: input.op, input: input.opInput }, { toolCallId: input.callId });
  } catch (err) {
    return { decision, ran: executed.length > before, error: err instanceof Error ? err.message : String(err) };
  }
  return { decision, ran: executed.length > before };
}

async function raiseCard(key: string, op: string, opInput: Record<string, unknown>): Promise<{ id: string; offer: Offer; deny: unknown }> {
  const offers: Offer[] = [];
  const raised = await driveCall({ key, op, opInput, callId: `raise-${randomUUID()}`, offers });
  assert.equal(offers.length, 1, "the seam posted exactly one card");
  const offer = offers[0]!;
  const id = randomUUID();
  const now = new Date();
  await store.addPendingAction({
    id,
    org,
    kind: CONNECTOR_OP_CARD_KIND,
    argsJson: JSON.stringify(connectorOpArgsFromOffer(offer, { scopeKey: "slack/T1/D1", requestedBy: "U1" })),
    scopeKey: "slack/T1/D1",
    domain: null,
    requestedBy: "U1",
    channelId: "D1",
    threadTs: null,
    messageTs: "1.2",
    postedTo: "slack/T1/D1",
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
    decidedBy: null,
    decidedAt: null,
  });
  return { id, offer, deny: raised.decision };
}

async function approve(id: string): Promise<void> {
  const row = await store.getPendingAction(org, id);
  assert.ok(row !== null);
  assert.ok(await store.decidePendingAction(org, id, "approved", "U2", new Date().toISOString()));
  const kind = actionKind(CONNECTOR_OP_CARD_KIND);
  assert.ok(kind !== undefined, "the op.connector kind is registered");
  await kind.execute(JSON.parse(row.argsJson), "U2");
}

const replayOf = (id: string) => ({ [CONNECTOR_REPLAY_INPUT_KEY]: id });

async function storedArgs(id: string): Promise<{ status: string; args: Record<string, unknown> }> {
  const row = await store.getPendingAction(org, id);
  assert.ok(row !== null, `card ${id} exists`);
  return { status: row.status, args: JSON.parse(row.argsJson) as Record<string, unknown> };
}
const DM_KEY = "oe-grant:slack/T1/D1:dm";
const THREAD_KEY = "oe-grant:slack/T1/C1/1700159720.000100:thread";

const APPROVED_INPUT = { pages: [{ title: "Handbook notes", body: "x".repeat(CONNECTOR_INPUT_PREVIEW_CAP + 400) }], creation_mode: "draft", allow_async: false };

for (const key of [DM_KEY, THREAD_KEY]) {
  const where = key === DM_KEY ? "DM" : "channel thread";
  executed.length = 0;

  const card = await raiseCard(key, "create_page", APPROVED_INPUT);
  ok(isDenied(card.deny), `§1 [${where}] an unapproved write is denied with a card`);
  assert.deepEqual(card.offer.input, APPROVED_INPUT, `§1 [${where}] the offer carries the WHOLE input, not the truncated preview`);
  passed++;
  ok(card.offer.inputPreview.endsWith("…"), `§1 [${where}] control: the card's preview IS truncated, so only the stored input can replay it`);
  ok(reasonOf(card.deny).includes(`"${CONNECTOR_REPLAY_INPUT_KEY}":"pending-from-offer"`), `§1 [${where}] the deny names the replay by card id`);
  ok(executed.length === 0, `§1 [${where}] nothing ran on the card`);

  const early = await driveCall({ key, op: "create_page", opInput: replayOf(card.id), callId: `early-${where}` });
  ok(isDenied(early.decision) && reasonOf(early.decision).includes("pending, not approved"), `§3 [${where}] a PENDING card replays nothing (${reasonOf(early.decision)})`);

  await approve(card.id);

  const otherRoom = await driveCall({ key: key === DM_KEY ? THREAD_KEY : DM_KEY, op: "create_page", opInput: replayOf(card.id), callId: `room-${where}` });
  ok(isDenied(otherRoom.decision) && reasonOf(otherRoom.decision).includes("another conversation"), `§3 [${where}] another conversation cannot replay the card`);
  const otherOp = await driveCall({ key, op: "update_page", opInput: replayOf(card.id), callId: `op-${where}` });
  ok(isDenied(otherOp.decision) && reasonOf(otherOp.decision).includes("another op"), `§3 [${where}] a replay naming another op is refused`);
  const extraKey = await driveCall({ key, op: "create_page", opInput: { ...replayOf(card.id), allow_async: true }, callId: `extra-${where}` });
  ok(isDenied(extraKey.decision) && reasonOf(extraKey.decision).includes("not a replay"), `§3 [${where}] a replay input with a changed field is refused, never run as a plain call`);
  const unknown = await driveCall({ key, op: "create_page", opInput: replayOf(randomUUID()), callId: `unknown-${where}` });
  ok(isDenied(unknown.decision) && reasonOf(unknown.decision).includes("no connector approval card"), `§3 [${where}] an unknown card id replays nothing`);
  ok(executed.length === 0, `§3 [${where}] none of the refused replays reached the vendor-side execute`);

  let policySaw: unknown;
  const denyStored = await driveCall({
    key,
    op: "create_page",
    opInput: replayOf(card.id),
    callId: `policy-${where}`,
    policy: (ctx) => {
      policySaw = (ctx as { toolInput?: unknown }).toolInput;
      return { type: "denied", reason: "the inner policy refused" };
    },
  });
  ok(isDenied(denyStored.decision) && reasonOf(denyStored.decision) === "the inner policy refused", `§5 [${where}] the wrapped policy's deny stands on a replay`);
  assert.deepEqual(policySaw, APPROVED_INPUT, `§5 [${where}] the wrapped policy decided the STORED input, not the replay input`);
  passed++;

  const replay = await driveCall({ key, op: "create_page", opInput: replayOf(card.id), callId: `replay-${where}` });
  ok(replay.decision === "not-applicable", `§2 [${where}] the replay of the approved card is admitted (${reasonOf(replay.decision)})`);
  ok(replay.ran && replay.error === undefined, `§2 [${where}] the replay reached the vendor-side execute (${replay.error ?? ""})`);
  assert.deepEqual(executed.at(-1)?.input, { connection: "notion", tool: "create_page", input: APPROVED_INPUT }, `§2 [${where}] the execute ran the card's STORED input`);
  passed++;
  ok(executed.length === 1, `§2 [${where}] the approved write ran exactly once`);
  const ranRow = await storedArgs(card.id);
  ok(!("input" in ranRow.args) && ranRow.args["inputCleared"] === true, `§6 [${where}] 🔴 the card no longer stores the whole input after its replay ran`);
  ok(ranRow.status === "approved" && typeof ranRow.args["inputPreview"] === "string" && typeof ranRow.args["memoKind"] === "string", `§6 [${where}] the decision, the preview and the memo kind stay for audit`);
  const rerun = await driveCall({ key, op: "create_page", opInput: replayOf(card.id), callId: `replay-${where}` });
  ok(isDenied(rerun.decision) && reasonOf(rerun.decision).includes("already used") && executed.length === 1, `§6 [${where}] a re-run of the call after its execute ran writes nothing again (${reasonOf(rerun.decision)})`);
  const second = await driveCall({ key, op: "create_page", opInput: replayOf(card.id), callId: `second-${where}` });
  ok(isDenied(second.decision) && reasonOf(second.decision).includes("already used"), `§2 [${where}] a SECOND replay of the consumed card runs nothing`);
  const rebuilt = await driveCall({ key, op: "create_page", opInput: APPROVED_INPUT, callId: `rebuilt-${where}` });
  ok(rebuilt.decision !== "not-applicable", `§2 [${where}] after the replay, the same input asks for a card again`);
}

{
  executed.length = 0;
  const rejected = await raiseCard(DM_KEY, "create_page", { title: "rejected" });
  assert.ok(await store.decidePendingAction(org, rejected.id, "rejected", "U2", new Date().toISOString()));
  const r = await driveCall({ key: DM_KEY, op: "create_page", opInput: replayOf(rejected.id), callId: "rejected-1" });
  ok(isDenied(r.decision) && reasonOf(r.decision).includes("rejected, not approved"), "§3 a REJECTED card replays nothing");

  const expired = await raiseCard(DM_KEY, "create_page", { title: "expired" });
  assert.ok(await store.decidePendingAction(org, expired.id, "approved", "U2", new Date().toISOString()));
  const x = await driveCall({ key: DM_KEY, op: "create_page", opInput: replayOf(expired.id), callId: "expired-1" });
  ok(isDenied(x.decision) && reasonOf(x.decision).includes("has expired or was revoked"), `§3 an approved card whose one-call approval is gone replays nothing (${reasonOf(x.decision)})`);
  ok(executed.length === 0, "§3 neither reached the vendor-side execute");
}

{
  executed.length = 0;
  const crashed = await raiseCard(DM_KEY, "create_page", { title: "crash before execute" });
  await approve(crashed.id);
  const seamOnly = withOeConnectorCard(() => "user-approval", { store, grantScope: () => ({ key: DM_KEY, reach: "call" }) as never, tainted: () => false });
  ok((await seamOnly({ toolName: "notion__create_page", callId: "crash-1", toolInput: replayOf(crashed.id) } as never)) === "not-applicable", "§6 fixture: the approval admits the replay, and then the step crashes");
  ok("input" in (await storedArgs(crashed.id)).args, "§6 the input stays on the card between the approval and the execute");
  const sameId = await driveCall({ key: DM_KEY, op: "create_page", opInput: replayOf(crashed.id), callId: "crash-1" });
  ok(sameId.decision === "not-applicable" && sameId.ran, `§6 eve's re-run of the SAME call id runs the stored input (${reasonOf(sameId.decision)} ${sameId.error ?? ""})`);
  assert.deepEqual(executed.at(-1)?.input, { connection: "notion", tool: "create_page", input: { title: "crash before execute" } });
  passed++;

  const lost = await raiseCard(DM_KEY, "create_page", { title: "lost to a restart" });
  await approve(lost.id);
  await seamOnly({ toolName: "notion__create_page", callId: "lost-1", toolInput: replayOf(lost.id) } as never);
  const before = executed.length;
  const reminted = await driveCall({ key: DM_KEY, op: "create_page", opInput: replayOf(lost.id), callId: "lost-2" });
  ok(isDenied(reminted.decision) && reasonOf(reminted.decision).includes("taken by another call") && reasonOf(reminted.decision).includes("may already have run"), `§6 🔴 a re-minted call id reads that another call took the approval (${reasonOf(reminted.decision)})`);
  ok(!reasonOf(reminted.decision).includes("expired"), "§6 the re-minted call is not told the approval expired");
  ok(executed.length === before, "§6 the re-minted call runs nothing");

  const again = await raiseCard(THREAD_KEY, "create_page", { title: "called again" });
  const sibling = await raiseCard(THREAD_KEY, "create_page", { title: "called again" });
  const otherKey = await raiseCard(DM_KEY, "create_page", { title: "called again" });
  const otherInput = await raiseCard(THREAD_KEY, "create_page", { title: "a different input" });
  const later = await raiseCard(THREAD_KEY, "create_page", { title: "called again" });
  for (const c of [again, sibling, otherKey, otherInput]) await approve(c.id);
  assert.ok(await store.decidePendingAction(org, later.id, "approved", "U2", new Date(Date.now() + 60_000).toISOString()));
  const plain = await driveCall({ key: THREAD_KEY, op: "create_page", opInput: { title: "called again" }, callId: "again-1" });
  ok(plain.decision === "not-applicable" && plain.ran, "§6 fixture: the identical call runs on the approval");
  const againRow = await storedArgs(again.id);
  ok(!("input" in againRow.args) && againRow.args["inputCleared"] === true, `§6 🔴 a card spent by an identical call no longer stores its input`);
  ok(!("input" in (await storedArgs(sibling.id)).args), "§6 🔴 a second approved card with the same key and input is covered by the spent approval, and drops its input");
  ok("input" in (await storedArgs(otherKey.id)).args, "§6 CONTROL (key): the same input approved in ANOTHER conversation keeps its input");
  ok("input" in (await storedArgs(otherInput.id)).args, "§6 CONTROL (input): a DIFFERENT input approved in the same conversation keeps its input");
  ok("input" in (await storedArgs(later.id)).args, "§6 CONTROL (time): a card decided AFTER the spend keeps its input");

  const kept = await raiseCard(THREAD_KEY, "create_page", { title: "still replayable" });
  await approve(kept.id);
  await driveCall({ key: DM_KEY, op: "create_page", opInput: replayOf(kept.id), callId: "kept-1" });
  ok("input" in (await storedArgs(kept.id)).args, "§6 NEGATIVE CONTROL: an approved card that has not run keeps its input");

  const { sweepConnectorCardInputs } = await import("../agent/connections/connector-card-retention.js");
  const LAPSE_MS = 25 * 3600_000;
  const rejectedRaw = await raiseCard(DM_KEY, "create_page", { title: "rejected outside the flow" });
  assert.ok(await store.decidePendingAction(org, rejectedRaw.id, "rejected", "U2", new Date().toISOString()));
  const lapsed = await raiseCard(DM_KEY, "create_page", { title: "approved, never used" });
  assert.ok(await store.decidePendingAction(org, lapsed.id, "approved", "U2", new Date(Date.now() - LAPSE_MS - 60_000).toISOString()));
  const swept = await sweepConnectorCardInputs(store, org, new Date(), LAPSE_MS);
  ok(swept >= 2, `§6 the backstop cleared the closed and the lapsed cards (${swept})`);
  ok(!("input" in (await storedArgs(rejectedRaw.id)).args), "§6 🔴 the backstop clears a rejected card's input");
  ok(!("input" in (await storedArgs(lapsed.id)).args), "§6 🔴 the backstop clears a lapsed approved card's input");
  ok("input" in (await storedArgs(kept.id)).args, "§6 NEGATIVE CONTROL: the backstop keeps a fresh approved card's input");

  const { sweepExpiredPendings } = await import("../agent/approvals/flow.js");
  const aging = await raiseCard(DM_KEY, "create_page", { title: "nobody clicked" });
  await sweepExpiredPendings(org, new Date(Date.now() + 2 * 3600_000), { post: (async () => ({ ok: true, ts: "9.9" })) as never, discordNotice: async () => undefined });
  const agedRow = await storedArgs(aging.id);
  ok(agedRow.status === "expired" && !("input" in agedRow.args) && agedRow.args["inputCleared"] === true, `§6 🔴 an expired card no longer stores its input (${agedRow.status})`);

  const pending = await raiseCard(DM_KEY, "create_page", { title: "still pending" });
  ok((await store.rewriteDecidedPendingActionArgs(org, pending.id, "{}")) === false && "input" in (await storedArgs(pending.id)).args, "§6 the store refuses to rewrite a PENDING row's args");
}

{
  executed.length = 0;
  const card = await raiseCard(DM_KEY, "create_page", { title: "not admitted" });
  await approve(card.id);
  let error = "";
  try {
    await executeTool.execute({ connection: "notion", tool: "create_page", input: replayOf(card.id) }, { toolCallId: "no-approval-1" });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  ok(error.includes("did not admit this call") && executed.length === 0, `§4 a replay the seam did not admit never reaches the vendor (${error})`);
  await executeTool.execute({ connection: "notion", tool: "search_pages", input: { query: "q" } }, { toolCallId: "plain-1" });
  assert.deepEqual(executed.at(-1)?.input, { connection: "notion", tool: "search_pages", input: { query: "q" } });
  passed++;
}

// §7 A card id BESIDE an argument, on an op whose schema allows extra keys. eve's check takes such
// an input (the op's own branch of the wrapper admits extra keys), so only OE's two replay checks
// stand between it and a run: the seam (`decideConnectorReplay`) and the execute's resolver
// (`resolveConnectorReplay`). Each must refuse it on its own, with an approved, unspent card.
{
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
  const { toInputSchema } = (await import(pathToFileURL(join(eveRoot, "dist/src/tools/schema.js")).href)) as {
    toInputSchema(s: unknown): { "~standard": { validate(v: unknown): Promise<{ issues?: unknown[] }> | { issues?: unknown[] } } };
  };
  executed.length = 0;
  const card = await raiseCard(DM_KEY, "append_note", { title: "approved note" });
  await approve(card.id);
  const mixed = { ...replayOf(card.id), title: "a different note" };

  const openTool = defineConnectorTool(
    { connection: "notion", url: "https://mcp.example.test/mcp", auth: appAuth as never, client: { fetch: server.fetch } },
    { name: "append_note", description: "append_note", inputSchema: { type: "object" }, hasOutputSchema: false },
  ) as unknown as { inputSchema: unknown };
  ok((await toInputSchema(openTool.inputSchema)["~standard"].validate(mixed)).issues === undefined, "§7 setup: eve's check takes a card id beside an argument on an open-schema op");

  const seamCall = await driveCall({ key: DM_KEY, op: "append_note", opInput: mixed, callId: "mixed-seam-1" });
  ok(isDenied(seamCall.decision) && reasonOf(seamCall.decision).includes("must be the only key"), `🔴 §7 the seam refuses a card id beside an argument (${reasonOf(seamCall.decision)})`);
  ok(executed.length === 0, "🔴 §7 …and nothing reached the vendor");

  // The seam admits the clean replay for this call id. The execute then receives the mixed input,
  // so the resolver alone stands between it and a run.
  const seamOnly = withOeConnectorCard(() => "user-approval", { store, grantScope: () => ({ key: DM_KEY, reach: "call" }) as never, tainted: () => false });
  ok((await seamOnly({ toolName: "notion__append_note", callId: "mixed-exec-1", toolInput: replayOf(card.id) } as never)) === "not-applicable", "§7 setup: the seam admits the clean replay for this call id");
  let error = "";
  try {
    await executeTool.execute({ connection: "notion", tool: "append_note", input: mixed }, { toolCallId: "mixed-exec-1" });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  ok(error.includes("not a well-formed replay"), `🔴 §7 the execute's resolver refuses a card id beside an argument, though the call id is admitted (${error})`);
  ok(executed.length === 0, "🔴 §7 …and nothing reached the vendor");
  await executeTool.execute({ connection: "notion", tool: "append_note", input: replayOf(card.id) }, { toolCallId: "mixed-exec-1" });
  assert.deepEqual(executed.at(-1)?.input, { connection: "notion", tool: "append_note", input: { title: "approved note" } }, "§7 control: the clean replay of the same admitted call runs the stored input");
  passed++;
}

resetSettingsForTest();
console.log(`connector-replay: ${passed} assertions passed`);
