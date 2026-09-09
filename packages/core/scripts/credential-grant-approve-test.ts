import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-grant-approve-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { setRegisteredConnectorCredentials, vercelConnectorHome } from "../agent/access/connector-credentials.js";
import { approveCredentialGrant, askForCredentialGrant, declineCredentialGrant } from "../agent/access/credential-grant-flow.js";
import { grantCardActions, grantCardText, GRANT_MODE_WORDS, approvedGrantCardText, declinedGrantCardText } from "../agent/access/credential-grant-card.js";
import { registerSlackTestBridge } from "./_slack-test-stubs.js";
import { grantResolutionText } from "../agent/access/credential-grant-resolution.js";
import { grantOwnerNoticeText } from "../agent/access/credential-grant-notice.js";
import { pinFrozenArgsIntoSchema } from "../agent/access/grant-schema-pin.js";
import { selectConnectorTransport } from "../agent/connections/connector-transport.js";
import { registerUserAuthFlow, resetUserAuthFlow, type UserAuthFlowProvider } from "../agent/connections/user-auth-flow.js";
import { registerPostArm, type DirectMessageRequest } from "../agent/channels/post-arms.js";
import { registerAccountDisplayName } from "../agent/identity/account-display-name.js";
import type { ReplyTarget } from "../agent/channels/reply-post.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import { readAudit } from "../agent/audit/audit.js";
import { fakeMcpServer, settleMcp, type FakeMcpServer } from "./_fake-mcp-server.js";
import {
  BORROW_APPROVE_READ_BUDGET_MS,
  borrowDeadline,
  readBorrowToolSchema,
  withinBorrowDeadline,
  type BorrowConnection,
} from "../agent/connections/grant-mcp-borrow.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const ORG = "org-approve";
const WS = "T1";
const OWNER = "slack/T1/U-owner";
const REQ = "slack/T1/U-req";
const NOW = Date.parse("2026-08-26T09:00:00.000Z");
const MCP_URL = "https://mcp.notion.com/mcp";
const VENDOR_TOOL = "notion-fetch";
const stamps = { org: ORG, platform: "slack", surface: "C1", workspace: WS };
const ROOM: ReplyTarget = { channelId: "C1", platform: "slack" } as unknown as ReplyTarget;

const VENDOR_SCHEMA = {
  additionalProperties: false,
  properties: {
    id: { default: "the-last-one", description: "the page id", enum: ["abc123", "zzz999"], type: "string" },
    page_size: { type: "number" },
  },
  required: ["page_size"],
  type: "object",
};

const dmed: DirectMessageRequest[] = [];
const posted: { target: ReplyTarget; text: string }[] = [];
registerPostArm({
  deliverDirectMessage: async (req: DirectMessageRequest) => {
    dmed.push(req);
    return { messageId: `m${dmed.length}`, surfaceId: `D${dmed.length}` };
  },
  dispatchReply: async (target: ReplyTarget, text: string) => {
    posted.push({ target, text });
    return `ts-${posted.length}`;
  },
  platform: "slack",
  resolveTarget: () => null,
});
registerAccountDisplayName("slack", async () => ({ handle: "rowan", name: "Rowan Hale" }));

const chatUpdates: { channel: string; ts: string; text: string }[] = [];
registerSlackTestBridge({
  form: async (method: string, body: string) => {
    if (method !== "chat.update") return { ok: true };
    const params = new URLSearchParams(body);
    chatUpdates.push({ channel: params.get("channel") ?? "", text: params.get("text") ?? "", ts: params.get("ts") ?? "" });
    return { ok: true };
  },
});

setRegisteredConnectorCredentials([
  {
    allows: ["user-oauth"],
    connector: "notion",
    credentials: [{ endpoints: { hosts: ["mcp.notion.com"] }, home: vercelConnectorHome("mcp.notion.com/notion-mcp"), id: "user-oauth", type: "user-oauth" }],
  },
]);
selectConnectorTransport({ connector: "notion", directUrl: MCP_URL, provider: "notion" });

const authFlow = (over: Partial<UserAuthFlowProvider> = {}): UserAuthFlowProvider => ({
  environmentClaim: async () => "test",
  isUserAuthRequired: () => false,
  mintServiceToken: async () => ({ token: "SERVICE" }),
  mintUserToken: async () => ({ token: "OWNER-TOKEN" }),
  startAuthorization: async () => ({ url: "https://connect.example/consent?c=CAP" }),
  ...over,
});
registerUserAuthFlow(authFlow());

const store = getOperationalStore();
let scopeSeq = 0;

async function raise(over: { frozenArgs?: Record<string, unknown>; tool?: string; label?: string; mode?: "once" | "session" | "standing" } = {}): Promise<{ askId: string; scopeKey: string }> {
  const scopeKey = `sess-${String(++scopeSeq)}`;
  const outcome = await askForCredentialGrant({
    ...stamps,
    connector: "notion",
    domainGrantsConnector: true,
    frozenArgs: over.frozenArgs ?? { id: "abc123" },
    mcpTool: over.tool ?? VENDOR_TOOL,
    nowMs: NOW,
    ownerHandle: "Rowan Hale",
    ownerNativeId: "U-owner",
    ownerPlatform: "slack",
    ownerPrincipalId: OWNER,
    purpose: "draft the Q3 summary",
    requestedMode: over.mode ?? "session",
    requesterLabel: "Ada",
    requesterPrincipalId: REQ,
    requesterTarget: JSON.stringify(ROOM),
    scopeKey,
    targetLabel: over.label ?? "Launch page",
  });
  assert.ok(outcome.sent, `the fixture ask must be sent (got: ${outcome.sent ? "sent" : outcome.reason})`);
  return { askId: outcome.sent ? outcome.askId : "", scopeKey };
}

const server = (opts: Parameters<typeof fakeMcpServer>[0] = {}): FakeMcpServer => fakeMcpServer(opts);
const deps = (s: FakeMcpServer): { fetch: FakeMcpServer["fetch"]; mintOwnerToken: () => Promise<string> } => ({
  fetch: s.fetch,
  mintOwnerToken: async () => "OWNER-TOKEN",
});
const PUBLISHED = [{ inputSchema: VENDOR_SCHEMA, name: VENDOR_TOOL }];

const askRowFixture = {
  connector: "notion",
  createdAt: "2026-08-26T09:00:00.000Z",
  expiresAt: "2026-08-26T09:30:00.000Z",
  frozenArgs: { id: "abc123" },
  id: "ask-card-1",
  mcpTool: VENDOR_TOOL,
  ownerNativeId: "U-owner",
  ownerPlatform: "slack",
  ownerPrincipalId: OWNER,
  ownerSlug: "rowan_hale",
  purpose: "draft the Q3 summary",
  requestedMode: "once",
  requesterPrincipalId: REQ,
  resource: "Launch page — notion-fetch({id:abc123})",
  scopeKey: "sess-card",
  status: "pending",
  toolName: "grant__rowan_hale_notion__notion_fetch_launch_page",
  verb: "notion_fetch",
} as const;

const grantRowFixture = {
  askId: "ask-card-1",
  connector: "notion",
  expiresAt: "2026-08-26T21:00:00.000Z",
  frozenArgs: { id: "abc123" },
  id: "grant-card-1",
  mcpTool: VENDOR_TOOL,
  mode: "session",
  ownerPrincipalId: OWNER,
  ownerSlug: "rowan_hale",
  purpose: "draft the Q3 summary",
  requesterPrincipalId: REQ,
  resource: "Launch page — notion-fetch({id:abc123})",
  toolName: "grant__rowan_hale_notion__notion_fetch_launch_page",
  verb: "notion_fetch",
} as const;

console.log("1. the granted argument is pinned INTO the vendor's schema, not subtracted from it:");
{
  const pinned = pinFrozenArgsIntoSchema(VENDOR_SCHEMA, { id: "abc123" });
  ok(pinned.ok, "a frozen key the vendor declares bakes");
  const schema = pinned.ok ? (pinned.schema as Record<string, unknown>) : {};
  const properties = schema["properties"] as Record<string, unknown>;
  eq(Object.keys(properties).sort(), ["id", "page_size"], "🔴 THE GRANTED KEY IS STILL THERE — the definition says which page it reads, rather than lying by omission");
  eq(
    properties["id"],
    { const: "abc123", description: "the page id", type: "string" },
    "…carrying a `const` of the granted value, the vendor's own type and description, and NOT the enum or the default a const supersedes",
  );
  eq(properties["page_size"], { type: "number" }, "…while an unfrozen property is passed through byte-identically");
  eq(schema["required"], ["page_size", "id"], "the frozen key is REQUIRED — the model must SUPPLY it, and the fence then validates what it sent");
  eq(schema["additionalProperties"], false, "…and everything else the vendor said about the schema survives");

  ok(VENDOR_SCHEMA.properties.id.enum.length === 2, "the INPUT still carries its enum — the bake copied rather than mutating the caller's object");
  eq((VENDOR_SCHEMA as unknown as Record<string, unknown>)["required"], ["page_size"], "…and the input's own `required` was not extended in place");

  const unknown = pinFrozenArgsIntoSchema(VENDOR_SCHEMA, { id: "abc123", nope: 1, zzz: 2 });
  ok(!unknown.ok, "a frozen key the vendor does NOT declare refuses the bake");
  eq(unknown.ok ? [] : unknown.unknownKeys, ["nope", "zzz"], "…naming every offending key, sorted, so the refusal can say which one was wrong");

  const none = pinFrozenArgsIntoSchema(VENDOR_SCHEMA, {});
  eq(none.ok ? none.schema : undefined, VENDOR_SCHEMA, "a borrow that freezes nothing snapshots the vendor's schema unchanged");

  const schemaless = pinFrozenArgsIntoSchema({ type: "object" }, { id: "x" });
  ok(!schemaless.ok, "a vendor tool declaring NO properties can hold no frozen key — it refuses rather than inventing one");
  const listRequired = pinFrozenArgsIntoSchema({ properties: { id: { type: "string" } }, required: "not-a-list", type: "object" }, { id: "x" });
  eq(listRequired.ok ? (listRequired.schema as Record<string, unknown>)["required"] : undefined, ["id"], "a malformed `required` is REPLACED, never carried into a schema the model is shown");
}

console.log("2. the catalogue is read from the owner's live connection, through the fence:");
let happyGrantId = "";
{
  const vendor = server({ tools: PUBLISHED });
  const { askId } = await raise();
  const approved = await approveCredentialGrant(stamps, askId, "session", OWNER, NOW + 500, undefined, deps(vendor));
  ok(approved.approved, "the approval mints a grant");
  happyGrantId = approved.approved ? approved.grant.id : "";

  const listed = vendor.seen.find((r) => (r.body?.["method"] as string | undefined) === "tools/list");
  ok(listed !== undefined, "the owner's connection was READ — the ask's tool name is not taken on trust");
  eq(listed?.authorization, "Bearer OWNER-TOKEN", "…under the OWNER's own token, because a server may publish a different list per account");
  ok(vendor.seen.every((r) => r.redirect === "error"), "…and every request carried the fence's redirect rule, so the read cannot have gone out on a bare SDK fetch");
  await settleMcp();
  eq(vendor.seen.filter((r) => r.method === "GET").length, 0, "…and no GET reached the vendor, though the server answered 202 to notifications/initialized");
  ok(
    vendor.seen.every((r) => (r.body?.["method"] as string | undefined) !== "tools/call"),
    "…and the approve-time read never CALLS the tool — proving a grant must not spend one",
  );

  {
    const control = server({ tools: PUBLISHED });
    const sdk = new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: control.fetch });
    const client = new Client({ name: "unfenced-control", version: "1.0.0" }, { capabilities: {} });
    await client.connect(sdk);
    await settleMcp();
    await client.close();
    ok(control.seen.some((r) => r.method === "GET"), "an UNFENCED SDK client DOES open the GET/SSE stream against this server — so the absence above is the fence's doing");
  }

  const grant = approved.approved ? approved.grant : undefined;
  eq(
    grant?.inputSchema,
    {
      additionalProperties: false,
      properties: { id: { const: "abc123", description: "the page id", type: "string" }, page_size: { type: "number" } },
      required: ["page_size", "id"],
      type: "object",
    },
    "the row's schema snapshot is the vendor's own schema with the granted argument pinned — the ruled shape, end to end",
  );
  eq(grant?.tier, "read", "…and the tier is the classifier's answer for this vendor tool, re-decided at the click");
}

console.log("3. the pre-CAS reads: a failure costs a retry, never the owner's decision:");
{
  const vendor = server({ failWithStatus: 503, tools: PUBLISHED });
  const { askId } = await raise();
  const approved = await approveCredentialGrant(stamps, askId, "session", OWNER, NOW + 500, undefined, deps(vendor));
  eq(approved.approved ? "APPROVED" : approved.reason, "catalogue_unreachable", "a connection that cannot be read refuses `catalogue_unreachable`");
  const row = await store.getCredentialGrantAsk(ORG, askId);
  eq(row?.status, "pending", "🔴 THE ASK IS STILL PENDING — the owner's yes was not spent on a blip, and pressing again works");
  eq(row?.grantId, undefined, "…and it names no grant");

  const retry = await approveCredentialGrant(stamps, askId, "session", OWNER, NOW + 600, undefined, deps(server({ tools: PUBLISHED })));
  ok(retry.approved, "…and a second press, once the connection answers, mints the grant");
  eq((await store.getCredentialGrantAsk(ORG, askId))?.status, "approved", "…moving the ask to approved only then");
}

console.log("4. an owner who has not connected their own account is sent a link, not a failure:");
{
  registerUserAuthFlow(authFlow({ hasFreshGrant: async () => false }));
  const vendor = server({ tools: PUBLISHED });
  const { askId } = await raise();
  const dmsBefore = dmed.length;
  const approved = await approveCredentialGrant(stamps, askId, "session", OWNER, NOW + 500, undefined, deps(vendor));
  eq(approved.approved ? "APPROVED" : approved.reason, "consent_required", "an unconnected owner refuses `consent_required`");
  eq(approved.approved ? undefined : approved.prompted, true, "…and the outcome reports that the link actually reached them");
  eq(dmed.length, dmsBefore + 1, "exactly one DM went out");
  ok(dmed[dmed.length - 1]?.text.includes("https://connect.example/consent?c=CAP"), "…carrying the connect link");
  eq(dmed[dmed.length - 1]?.actions, undefined, "…with no buttons — it is a link, not a second decision");
  eq(dmed[dmed.length - 1]?.principalId, "U-owner", "…to the OWNER, never to the requesting room");
  eq((await store.getCredentialGrantAsk(ORG, askId))?.status, "pending", "🔴 THE ASK STAYS PENDING — connecting is a step, not a refusal");
  eq(vendor.seen.length, 0, "…and the vendor was never dialled: the probe runs BEFORE the mint");
  ok(!posted.some((p) => p.text.includes("could not be minted")), "…and the requester's room was told nothing — nobody has answered yet");

  registerUserAuthFlow(authFlow({ hasFreshGrant: async () => true }));
  const after = await approveCredentialGrant(stamps, askId, "session", OWNER, NOW + 600, undefined, deps(server({ tools: PUBLISHED })));
  ok(after.approved, "once connected, the same card mints the grant");

  registerUserAuthFlow(authFlow());
  const noProbe = await raise();
  const unprobed = await approveCredentialGrant(stamps, noProbe.askId, "session", OWNER, NOW + 500, undefined, deps(server({ tools: PUBLISHED })));
  ok(unprobed.approved, "a flow with no consent probe proceeds to the catalogue read rather than assuming the worst");
}

console.log("5. a tool the connection does not publish closes the ask and tells both sides:");
{
  registerUserAuthFlow(authFlow());
  posted.length = 0;
  const { askId } = await raise({ tool: "notion-search" });
  const approved = await approveCredentialGrant(stamps, askId, "session", OWNER, NOW + 500, undefined, deps(server({ tools: PUBLISHED })));
  eq(approved.approved ? "APPROVED" : approved.reason, "tool_absent", "a tool the connection does not publish refuses `tool_absent`");
  const row = await store.getCredentialGrantAsk(ORG, askId);
  eq(row?.status, "expired", "🔴 THIS ONE CLOSES THE ASK — the owner answered, and the answer cannot be honoured; pressing again cannot help");
  eq(row?.grantId, undefined, "…and no grant was minted");

  const notice = posted[posted.length - 1]?.text ?? "";
  ok(notice.includes("approved the credential grant"), "the requester's room is told the owner APPROVED…");
  ok(notice.includes("could not be minted"), "…and that it could not be minted");
  ok(!notice.includes("declined") && !notice.includes("expired with no answer"), "…and NEVER that they declined or that it lapsed — the owner made a decision and it was yes");

  const refusal = (await readAudit({ org: ORG })).filter((r) => r.action === "grant.refused").at(-1);
  eq((refusal?.detail as Record<string, unknown>)?.gate, "tool_absent", "the audit row names the gate");
  eq(
    (refusal?.detail as Record<string, unknown>)?.resource,
    "notion-search keys:id",
    "…and its resource field carries the tool name and the frozen KEYS only — never the frozen values",
  );
}

{
  posted.length = 0;
  const { askId } = await raise({ frozenArgs: { not_a_key: "x" } });
  const approved = await approveCredentialGrant(stamps, askId, "session", OWNER, NOW + 500, undefined, deps(server({ tools: PUBLISHED })));
  eq(approved.approved ? "APPROVED" : approved.reason, "frozen_args_unknown", "a grant that fixes an argument the tool does not take refuses under its OWN name");
  eq((await store.getCredentialGrantAsk(ORG, askId))?.status, "expired", "…and closes the ask, because the grant could never have been spent");
  const notice = posted[posted.length - 1]?.text ?? "";
  ok(notice.includes("does not take the arguments"), "…with copy distinct from the missing-tool one, so the room can act on the difference");
}

console.log("6. the pre-CAS reads did not weaken the CAS:");
{
  const { askId } = await raise();
  const first = await approveCredentialGrant(stamps, askId, "once", OWNER, NOW + 500, undefined, deps(server({ tools: PUBLISHED })));
  ok(first.approved, "the first press mints");
  const second = await approveCredentialGrant(stamps, askId, "session", OWNER, NOW + 600, undefined, deps(server({ tools: PUBLISHED })));
  eq(second.approved ? "APPROVED" : second.reason, "not_pending_or_expired", "a SECOND press on an answered ask loses — the CAS is still the decider");

  const stale = await raise();
  const staleVendor = server({ tools: PUBLISHED });
  const late = await approveCredentialGrant(stamps, stale.askId, "session", OWNER, NOW + 40 * 60 * 1000, undefined, deps(staleVendor));
  eq(late.approved ? "APPROVED" : late.reason, "not_pending_or_expired", "…and a press past the ask's own TTL loses too");
  eq((await store.getCredentialGrantAsk(ORG, stale.askId))?.status, "pending", "…leaving the row for the TTL sweep to close, not for this press");
  eq(staleVendor.seen.length, 0, "…and the owner's connection was not dialled at all: a dead card is answered before anything is read");
}

console.log("6a. one shared deadline across the probe, the mint and the catalogue read:");
{
  const budget = borrowDeadline(120);
  ok(budget.remainingMs() > 0 && budget.remainingMs() <= 120, "a fresh deadline reports its whole budget");
  const slow = withinBorrowDeadline(budget, "a slow leg", async () => await new Promise((r) => setTimeout(r, 400)));
  await assert.rejects(slow, /did not answer within the approve-time budget/u, "a leg that outruns the shared budget is refused BY NAME");
  n++;
  eq(budget.remainingMs(), 0, "🔴 THE REFUSAL MARKS THE BUDGET SPENT — the reading is the recorded fact, not a race against Node's timer");
  let spentRefusal: unknown;
  await withinBorrowDeadline(budget, "the next leg", async () => "never runs").then(
    () => {
      spentRefusal = undefined;
    },
    (err: unknown) => {
      spentRefusal = err;
    },
  );
  ok(
    spentRefusal instanceof Error && /budget was spent before the next leg could run/u.test(spentRefusal.message),
    "🔴 A SECOND LEG ON A SPENT BUDGET DOES NOT RUN — this is what makes the bound end-to-end rather than per-request, and it is the same fact the old wall-clock row asserted",
  );

  const unspent = borrowDeadline(2_000);
  eq(await withinBorrowDeadline(unspent, "a quick leg", async () => "answered"), "answered", "a leg inside the budget returns normally");
  ok(unspent.remainingMs() > 0, "…and a budget no refusal touched is still spendable: the mark is set by the TIMEOUT, never by a leg that answered");

  const hung = { fetch: (async () => await new Promise<Response>(() => undefined)) as FakeMcpServer["fetch"], mintOwnerToken: async () => "OWNER-TOKEN" };
  const { askId } = await raise({ label: 'Hung page' });
  const operatorLines: string[] = [];
  const realConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    operatorLines.push(args.map((a) => String(a)).join(" "));
  };
  let stalled: Awaited<ReturnType<typeof approveCredentialGrant>>;
  try {
    stalled = await approveCredentialGrant(stamps, askId, "session", OWNER, NOW + 500, undefined, hung);
  } finally {
    console.log = realConsoleLog;
  }
  eq(stalled.approved ? "APPROVED" : stalled.reason, "catalogue_unreachable", "a connection that never answers refuses `catalogue_unreachable`");
  ok(operatorLines.length > 0, "the capture saw the flow's operator log at all");
  ok(
    operatorLines.some((line) => /tool catalogue could not be read/u.test(line) && /(timed out|approve-time budget)/u.test(line)),
    `…and the read ended on a TIMEOUT, not on some other error that happened to be quick: ${JSON.stringify(operatorLines)}`,
  );
  eq((await store.getCredentialGrantAsk(ORG, askId))?.status, "pending", "…leaving the ask pending, so the owner's press is not spent on a hang");

  const CONN: BorrowConnection = { connector: "notion", directUrl: MCP_URL, provider: "notion", providerRef: "notion-ref", url: new URL(MCP_URL) };
  const healthy = server({ tools: PUBLISHED });
  const answered = await readBorrowToolSchema(CONN, VENDOR_TOOL, { id: "abc123" }, "OWNER-TOKEN", deps(healthy), borrowDeadline(2_000));
  ok(answered.found, "THE CONTROL: a healthy budget reads this fixture's catalogue, so the refusal below is the budget's doing");
  let refusal: unknown;
  await readBorrowToolSchema(CONN, VENDOR_TOOL, { id: "abc123" }, "OWNER-TOKEN", hung, borrowDeadline(50)).then(
    () => {
      refusal = undefined;
    },
    (err: unknown) => {
      refusal = err;
    },
  );
  ok(refusal instanceof Error && /timed out/u.test(refusal.message), `a server that never answers refuses on the timeout: ${String(refusal)}`);
  const enforced = (refusal as { data?: { timeout?: unknown } } | undefined)?.data?.timeout;
  ok(
    typeof enforced === "number" && enforced >= 0 && enforced <= 50,
    `🔴 …and the bound it enforced is the DEADLINE'S remaining budget, not the SDK's 60000ms default (it enforced ${String(enforced)})`,
  );
  ok(
    BORROW_APPROVE_READ_BUDGET_MS > 0 && BORROW_APPROVE_READ_BUDGET_MS <= 5_000,
    `…and the budget the flow itself starts is seconds, not that default (it is ${String(BORROW_APPROVE_READ_BUDGET_MS)}ms)`,
  );
}

console.log("6b. the card cannot hide a fixed argument behind a padded one:");
{
  const padded = {
    ...askRowFixture,
    frozenArgs: { aaa_note: "x".repeat(400), page_id: "THE-REAL-TARGET" },
  };
  const card = grantCardText(padded, "Ada");
  ok(card.includes("page_id"), "🔴 A PADDED FIRST VALUE CANNOT PUSH A LATER KEY OFF THE CARD");
  ok(card.includes("THE-REAL-TARGET"), "…nor its value: every key gets its own line");
  ok(card.includes("It is pinned to these 2 values"), "…and the count is derived from the object, not from what fitted");
  ok(card.includes("value truncated"), "the padded value IS cut, and the card SAYS so rather than cutting silently");

  const plain = grantCardText({ ...askRowFixture, frozenArgs: { page_id: "abc123" } }, "Ada");
  ok(plain.includes("`page_id` = `abc123`"), "an ordinary value renders in full…");
  ok(!plain.includes("value truncated"), "…with no marker, so the marker means something when it appears");

  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${String(i).padStart(2, "0")}`, i]));
  const wide = grantCardText({ ...askRowFixture, frozenArgs: many }, "Ada");
  ok(wide.includes("It is pinned to these 40 values"), "a 40-key freeze reports 40…");
  ok(wide.includes("more pinned value(s) are NOT shown"), "…and says out loud that the list is cut…");
  ok(wide.includes("Decline unless"), "…steering the owner to DECLINE, which is the safe answer to what they cannot see");
}

console.log("7. the minted row is the one the mount will read:");
{
  const grant = await store.getCredentialGrant(ORG, happyGrantId);
  ok(grant !== null, "the grant row exists");
  eq(grant?.mcpTool, VENDOR_TOOL, "it names the vendor tool in the vendor's own bytes");
  eq(grant?.frozenArgs, { id: "abc123" }, "…the arguments the owner approved");
  eq(grant?.toolName, "grant__rowan_hale_notion__notion_fetch_launch_page", "…the mounted name the ASK pinned, target label and all");
  eq(grant?.verb, "notion_fetch", "…the tool slug in the verb column");
  eq(grant?.resource, "Launch page — notion-fetch({id:abc123})", "…and the host-composed display label the card and the disclosure line read");
}

console.log("8. one reader-facing word per mode, on every surface that names one:");
{
  const MODES = ["once", "session", "standing"] as const;

  eq(new Set(MODES.map((m) => GRANT_MODE_WORDS[m])).size, 3, "the three modes carry three DIFFERENT reader-facing words");
  ok(
    MODES.every((m) => GRANT_MODE_WORDS[m].trim().length > 0),
    "…and none of them is blank, which would make every `includes` assertion below vacuously true",
  );

  for (const mode of MODES) {
    const word = GRANT_MODE_WORDS[mode];
    const ask = { ...askRowFixture, requestedMode: mode } as never;
    const grant = { ...grantRowFixture, mode } as never;

    const card = grantCardText(ask, "Ada");
    ok(card.includes(`They asked for: ${word}`), `the card's ask line spells \`${mode}\` as "${word}"`);
    const labels = grantCardActions(ask).map((a) => a.label);
    ok(
      labels.filter((l) => l.includes(word)).length === 1,
      `…exactly one BUTTON carries that same word for \`${mode}\` — the word a person carries to every later surface`,
    );

    const room = grantResolutionText(ask, { askedMode: mode, grant, kind: "approved" }, NOW);
    ok(room.includes(`The grant is ${mode === "once" ? word : `for ${word}`}, `), `the room confirmation spells \`${mode}\` as "${word}"`);

    ok(grantOwnerNoticeText(grant, undefined, NOW).includes(`• The grant: ${word}`), `the owner's first-use DM spells \`${mode}\` as "${word}"`);

    const phrase = mode === "once" ? word : `for ${word}`;
    ok(
      approvedGrantCardText(ask, grant, NOW).includes(`You approved ${phrase}, `),
      `the terminal card spells \`${mode}\` as "${phrase}" — the button's own phrasing, preposition included`,
    );
    ok(labels.includes(`Approve ${phrase}`), `…and that phrase IS a real button label for \`${mode}\`, never a second spelling of it`);
  }

  for (const mode of ["session", "standing"] as const) {
    const grant = { ...grantRowFixture, mode } as never;
    const ask = { ...askRowFixture, requestedMode: mode } as never;
    ok(!grantResolutionText(ask, { askedMode: mode, grant, kind: "approved" }, NOW).includes(mode), `the room never prints the raw \`${mode}\` column value`);
    ok(!grantOwnerNoticeText(grant, undefined, NOW).includes(mode), `…nor does the owner's DM`);
    ok(!grantCardActions(ask).some((a) => a.label.includes(mode)), `…nor does any button label`);
  }
}

console.log("8b. a widened grant is reported to the room, and only a widened one:");
{
  registerUserAuthFlow(authFlow());

  posted.length = 0;
  const wide = await raise({ label: "Breadth wider page", mode: "once" });
  const wideOk = await approveCredentialGrant(stamps, wide.askId, "session", OWNER, NOW + 500, undefined, deps(server({ tools: PUBLISHED })));
  ok(wideOk.approved, "the owner answers the `once` ask with `this conversation`…");
  const widened = posted[posted.length - 1]?.text ?? "";
  ok(widened.includes("granted MORE than was asked"), "…and the ROOM is told the owner went wider than the request");
  ok(
    widened.includes(`the request was for ${GRANT_MODE_WORDS.once}`) && widened.includes(`the grant is for ${GRANT_MODE_WORDS.session}`),
    "…naming BOTH breadths, in the same words the card spelled them with",
  );

  posted.length = 0;
  const same = await raise({ label: "Breadth equal page", mode: "session" });
  const sameOk = await approveCredentialGrant(stamps, same.askId, "session", OWNER, NOW + 500, undefined, deps(server({ tools: PUBLISHED })));
  ok(sameOk.approved, "an ask answered at the breadth it requested still approves…");
  ok(!(posted[posted.length - 1]?.text ?? "").includes("granted MORE"), "…and carries NO widening line");

  posted.length = 0;
  const narrow = await raise({ label: "Breadth narrower page", mode: "standing" });
  const narrowOk = await approveCredentialGrant(stamps, narrow.askId, "once", OWNER, NOW + 500, undefined, deps(server({ tools: PUBLISHED })));
  ok(narrowOk.approved, "an ask answered NARROWER than it requested still approves…");
  ok(!(posted[posted.length - 1]?.text ?? "").includes("granted MORE"), "…and carries no widening line either");
}

console.log("8c. the card's answer list reads as options, and promises no reply:");
{
  const card = grantCardText(askRowFixture as never, "Ada");
  const options = card.split("\n").filter((l) => l.startsWith("• *Approve") || l.startsWith("• *Decline"));
  eq(options.length, 4, "each of the four answers reads as its OWN line — the old copy ran them together as `once`, `conversation`, `standing` or `no`");
  ok(
    options.every((l) => l.includes("—")),
    "…and each one says what it MEANS, which is the half a bare word list left to the reader to guess",
  );
  ok(
    !card.split("\n").some((l) => /^reply\b/iu.test(l.trim())),
    "🔴 the card NEVER invites a typed reply — copy offering a control this deployment does not have is the defect class this plane's headers exist to stop",
  );
  ok(card.includes("nothing has been granted"), "…and a card whose buttons are missing or dead says NOTHING was granted…");
  ok(card.includes("lapses on its own"), "…and that the request lapses by itself, which is true on every surface");
}

console.log("9. an approve or a decline rewrites the owner's card — it no longer says 'tap one button':");
{
  const approvedText = approvedGrantCardText(askRowFixture as never, grantRowFixture as never, NOW);
  ok(approvedText.includes("✅ APPROVED"), "the approved card says what was decided");
  ok(approvedText.includes("Tapping a button on this card now does nothing"), "…and states the buttons are dead");
  ok(!approvedText.includes("Tap one button to answer"), "NEGATIVE CONTROL: the live card's own call-to-action is gone from the decided one");

  const declinedText = declinedGrantCardText(askRowFixture as never);
  ok(declinedText.includes("🚫 DECLINED"), "the declined card says what was decided");
  ok(declinedText.includes("Nothing was granted and nothing was spent"), "…and that nothing was spent");
  ok(!declinedText.includes("Tap one button to answer"), "NEGATIVE CONTROL: same for the decline card");

  {
    const vendor = server({ tools: PUBLISHED });
    const { askId } = await raise({ label: "Card rewrite check — approve" });
    const before = chatUpdates.length;
    const approved = await approveCredentialGrant(stamps, askId, "session", OWNER, NOW + 500, undefined, deps(vendor));
    ok(approved.approved, "the approval mints a grant (fixture sanity)");
    eq(chatUpdates.length, before + 1, "the approve path rewrote the owner's card exactly once");
    ok(chatUpdates[chatUpdates.length - 1].text.includes("✅ APPROVED"), "…with the approved terminal copy");
    ok(!chatUpdates[chatUpdates.length - 1].text.includes("Tap one button to answer"), "…never the live card's buttons-are-open copy");
  }
  {
    const { askId } = await raise({ label: "Card rewrite check — decline" });
    const before = chatUpdates.length;
    const declined = await declineCredentialGrant(stamps, askId, OWNER, NOW + 500);
    ok(declined, "the decline is recorded (fixture sanity)");
    eq(chatUpdates.length, before + 1, "the decline path rewrote the owner's card exactly once");
    ok(chatUpdates[chatUpdates.length - 1].text.includes("🚫 DECLINED"), "…with the declined terminal copy");
  }
}

resetUserAuthFlow();
if (n === 0) throw new Error("no assertions ran");
console.log(`\n✅ credential-grant approve-time mint: ${String(n)} assertions passed`);
