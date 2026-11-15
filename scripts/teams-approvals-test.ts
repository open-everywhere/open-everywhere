import assert from "node:assert/strict";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
registerTeamsProvider();
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import type { PendingActionRow } from "@open-everywhere/core/agent/approvals/types.js";

const dir = join(tmpdir(), `open-everywhere-teams-approvals-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
const APP_ID = "00000000-aaaa-bbbb-cccc-000000000001";

const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
const { defineDomain } = await import("@open-everywhere/core/agent/memory/domain.js");
const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
const { readAudit } = await import("@open-everywhere/core/agent/audit/audit.js");
const { requestApproval, sweepExpiredPendings, hasApprovalCardPath, judgeLiftNoticeRenderFor } = await import("@open-everywhere/core/agent/approvals/flow.js");
const { registerActionKind } = await import("@open-everywhere/core/agent/approvals/actions.js");
const { plainSummaryForRow } = await import("@open-everywhere/core/agent/approvals/plain-summary.js");
const { shortUtc } = await import("@open-everywhere/core/agent/approvals/session-grant.js");
const { cardPosterFor, judgeLiftNoticePosterFor, decisionFeedbackSurfaceFor, registerDecisionFeedbackSurface, clickerFloorRefusalNotice } = await import(
  "@open-everywhere/core/agent/adapter-api.js"
);
const {
  OE_TEAMS_APPROVAL_DATA_KEY,
  OE_TEAMS_APPROVAL_VERB,
  TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
  buildTeamsApprovalData,
  parseTeamsApprovalData,
  pendingTeamsCard,
  decidedTeamsCard,
  judgeLiftNoticeTeamsCard,
} = await import("@open-everywhere/provider-teams/agent/approvals/teams-card.js");
const { postTeamsApprovalCard, postTeamsJudgeLiftNotice, postTeamsRowDecisionNotice, parseTeamsApprovalInvoke, teamsClickSurfaceKey, teamsResponseFor, handleTeamsApprovalInvoke, teamsRowWakeTarget } =
  await import("@open-everywhere/provider-teams/agent/approvals/teams-flow.js");
const { buildTeamsFrontHandler } = await import("@open-everywhere/provider-teams/agent/channels/teams-front.js");
const { verifyTeamsRequest } = await import("eve/channels/teams");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const TENANT = "tenant-1";
const CHANNEL = "19:chan1@thread.tacv2";
const OTHER_CHANNEL = "19:other@thread.tacv2";
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "org", match: "org", admins: ["teams/29:org-admin"] })],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

let memberExecuted: string[] = [];
registerActionKind({
  kind: "test.member.teams",
  policy: "member",
  summarize: () => ["a member-policy test action"],
  plainSummary: () => "Do the test thing",
  async execute(_args: unknown, decidedBy: string) {
    memberExecuted.push(decidedBy);
    return `executed by ${decidedBy}`;
  },
});
let adminExecuted: string[] = [];
registerActionKind({
  kind: "test.admin.teams",
  policy: "admin",
  summarize: () => ["an admin-policy test action"],
  plainSummary: () => "Do the test thing",
  async execute(_args: unknown, decidedBy: string) {
    adminExecuted.push(decidedBy);
    return `admin executed by ${decidedBy}`;
  },
});

let seq = 0;
function row(over: Partial<PendingActionRow> = {}): PendingActionRow {
  seq += 1;
  return {
    id: `aaaaaaaa-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    org: "default",
    kind: "test.member.teams",
    argsJson: JSON.stringify({ n: seq }),
    scopeKey: `teams/${TENANT}/${CHANNEL}`,
    domain: null,
    requestedBy: "29:requester",
    channelId: CHANNEL,
    threadTs: null,
    messageTs: "1700000000001",
    postedTo: `teams/${TENANT}/${CHANNEL}`,
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    decidedBy: null,
    decidedAt: null,
    ...over,
  } as PendingActionRow;
}

ok(cardPosterFor("teams") !== undefined, "registerTeamsProvider registers a Teams CardPoster");
ok(hasApprovalCardPath("teams"), "hasApprovalCardPath('teams') is true — a Teams channel hosts its own card");
ok(judgeLiftNoticePosterFor("teams") !== undefined && judgeLiftNoticeRenderFor("teams") === "poster", "the judge-lift notice takes the Teams poster (with its button), not the text render");
ok(decisionFeedbackSurfaceFor("teams") !== undefined, "the Teams decision-feedback legs are registered with core");

{
  const r = row();
  for (const decision of ["approve", "reject", "approve_session", "contradict"] as const) {
    const parsed = parseTeamsApprovalData(buildTeamsApprovalData(r, decision));
    ok(parsed?.id === r.id && parsed.org === r.org && parsed.decision === decision, `codec round-trips the ${decision} verb`);
  }
  ok(parseTeamsApprovalData({ [OE_TEAMS_APPROVAL_DATA_KEY]: { id: r.id, decision: "delete", org: "default" } }) === null, "a decision outside the closed set is not ours");
  ok(parseTeamsApprovalData({ [OE_TEAMS_APPROVAL_DATA_KEY]: { id: r.id, decision: "approve" } }) === null, "a payload with no org is not ours");
  ok(parseTeamsApprovalData({ eve_input: { requestId: "r1" } }) === null, "eve's own HITL payload is not ours");
  ok(parseTeamsApprovalData(null) === null && parseTeamsApprovalData("x") === null, "garbage is not ours");
}

{
  const r = row({ kind: "spend.set" });
  const pending = pendingTeamsCard(r, ["line one", "line two"]);
  const actions = (pending.actions ?? []) as { type: string; verb?: string; title?: string; data?: unknown }[];
  ok(pending.type === "AdaptiveCard" && pending.version === "1.4", "the pending card is an Adaptive Card at schema 1.4 (Action.Execute needs 1.4)");
  ok(actions.length === 2 && actions.every((a) => a.type === "Action.Execute" && a.verb === OE_TEAMS_APPROVAL_VERB), "a conversation card carries exactly Approve and Reject as Action.Execute");
  ok(
    actions.map((a) => parseTeamsApprovalData(a.data)?.decision).join(",") === "approve,reject",
    "each button's data decodes to its own verb, bound to the row id",
  );
  const bodyText = JSON.stringify(pending.body);
  ok(!bodyText.includes("Approval requested") && !bodyText.includes("spend.set"), "the body shows no kind label");
  ok(!bodyText.includes("line one") && !bodyText.includes("line two"), "the body does not show the detail lines");
  ok(!bodyText.includes("29:requester"), "the body shows no raw requester id");
  const first = pending.body[0] as unknown as { type: string; text: string; weight?: string };
  ok(first.type === "TextBlock" && first.text === plainSummaryForRow(r) && first.weight === "Bolder", "OPE-2434: the Teams card's first block is the plain sentence");
  const last = pending.body.at(-1) as unknown as { text: string; isSubtle?: boolean };
  ok(last.text === `Expires ${shortUtc(r.expiresAt)}` && last.isSubtle === true, "the small footer shows the short expiry, capitalised");
  const legacyRow = { ...r, argsJson: JSON.stringify({ ...(JSON.parse(r.argsJson) as Record<string, unknown>), tainted: true }) };
  const legacy = JSON.stringify(pendingTeamsCard(legacyRow, ["line one", "⚠ proposed on a turn that had ingested external content — read the payload above on its own merits; nothing outside this room asked for it."]).body);
  ok(legacy === JSON.stringify(pendingTeamsCard(r, ["line one"]).body) && !legacy.includes("⚠"), "a legacy tainted card renders the clean card's visible text, with no warning");
  const decided = decidedTeamsCard({ ...r, status: "approved", decidedBy: "29:x" }, ["line one"], "done", "Ada");
  ok(decided.body.length === 1 && (decided.body[0] as unknown as { text: string }).text === "✅ Approved by Ada: done", "OPE-2481: the decided Teams card is one line that names the decider and the outcome");
  ok(decided.actions === undefined, "the decided card has no actions");
  const nameless = decidedTeamsCard({ ...r, status: "approved", decidedBy: "29:x" }, ["line one"], "done");
  ok((nameless.body[0] as unknown as { text: string }).text === "✅ Approved by someone: done", "with no display name the decider is 'someone', never the raw id");
  const bare = plainSummaryForRow(r).replace(/[.!?]$/u, "");
  const rejected = decidedTeamsCard({ ...r, status: "rejected", decidedBy: "29:x" }, ["line one"], "rejected", "Ada");
  ok((rejected.body[0] as unknown as { text: string }).text === `❌ Rejected by Ada: ${bare}`, "a rejected card names the thing that was not done");
  const notice = judgeLiftNoticeTeamsCard(r, ["line one"], "ran");
  const noticeActions = (notice.actions ?? []) as readonly { data?: unknown }[];
  ok(noticeActions.length === 1 && parseTeamsApprovalData(noticeActions[0]?.data)?.decision === "contradict", "the judge-lift notice carries exactly one button, the contradict verb");
  const noticeText = (notice.body as unknown as { text: string }[]).map((b) => b.text);
  ok(noticeText[0] === `Ran without asking: ${bare}` && noticeText[1] === "⚡ Auto-approved and already run · ran", "the judge-lift notice names the act in plain words and says it already ran");
  ok(!JSON.stringify(notice.body).includes("spend.set"), "the judge-lift notice shows no kind");
}

const sent: { serviceUrl: string; conversationId: string; body: unknown }[] = [];
const send = async (input: { serviceUrl: string; conversationId: string; body: unknown }) => {
  sent.push(input);
  return { id: "teams-act-1" };
};
const resolveRef = async (channelId: string) => (channelId === CHANNEL ? { serviceUrl: SERVICE_URL, conversationId: CHANNEL, tenantId: TENANT } : undefined);
{
  const id = await postTeamsApprovalCard(row(), ["line"], { send, resolveRef });
  ok(id === "teams-act-1", "the poster resolves the posted activity id");
  const body = sent[0]?.body as { type: string; attachments: { contentType: string; content: { actions: unknown[] } }[] };
  ok(sent[0]?.serviceUrl === SERVICE_URL && sent[0]?.conversationId === CHANNEL, "the poster sends into the card's channel conversation, at the stored serviceUrl");
  ok(body.type === "message" && body.attachments[0]?.contentType === TEAMS_ADAPTIVE_CARD_CONTENT_TYPE, "the poster sends one Adaptive Card attachment");
  ok((await postTeamsApprovalCard(row({ channelId: OTHER_CHANNEL }), ["l"], { send, resolveRef })) === undefined, "no stored conversation reference → undefined, never a guessed target");
  const untrusted = async () => ({ serviceUrl: "https://attacker.example/", conversationId: CHANNEL, tenantId: TENANT });
  ok((await postTeamsApprovalCard(row(), ["l"], { send, resolveRef: untrusted })) === undefined, "a non-Bot-Framework serviceUrl is refused before any token-bearing call");
  const failing = async () => {
    throw new Error("HTTP 403");
  };
  ok((await postTeamsApprovalCard(row(), ["l"], { send: failing, resolveRef })) === undefined, "a Connector failure resolves undefined (CardPoster contract: never throws)");
  sent.length = 0;
  await postTeamsJudgeLiftNotice(row(), ["l"], "ran", { send, resolveRef });
  ok(sent.length === 1, "the judge-lift notice posts through the same transport");

  sent.length = 0;
  const { id: pid } = await requestApproval(
    {
      org: "default",
      kind: "test.member.teams",
      args: { n: "propose" },
      scopeKey: `teams/${TENANT}/${CHANNEL}`,
      requestedBy: "29:requester",
      channelId: CHANNEL,
      postedTo: `teams/${TENANT}/${CHANNEL}`,
      chain: { unattended: false },
    },
    { postCard: (r, lines) => postTeamsApprovalCard(r, lines, { send, resolveRef }) },
  );
  const stored = await getOperationalStore().getPendingAction("default", pid);
  ok(stored?.messageTs === "teams-act-1", "requestApproval stores the Teams activity id as the row's messageTs");
  const requested = await readAudit({ org: "default", action: "approval.requested" });
  ok(requested.some((e) => e.detail?.id === pid && e.platform === "teams"), "approval.requested audits with the teams platform");
}

function invokeBody(data: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "invoke",
    name: "adaptiveCard/action",
    channelId: "msteams",
    id: "inv-1",
    serviceUrl: SERVICE_URL,
    from: { id: "29:clicker", name: "Ada Clicker", aadObjectId: "aad-1" },
    recipient: { id: `28:${APP_ID}` },
    conversation: { id: `${CHANNEL};messageid=1700000000001`, conversationType: "channel", tenantId: TENANT },
    channelData: { tenant: { id: TENANT }, team: { id: "19:team@thread.tacv2" }, channel: { id: CHANNEL } },
    replyToId: "1700000000001",
    value: { action: { type: "Action.Execute", verb: OE_TEAMS_APPROVAL_VERB, data }, trigger: "manual" },
    ...over,
  };
}
{
  const { parseTeamsActivity } = await import("eve/channels/teams");
  const r = row();
  const tap = parseTeamsApprovalInvoke(parseTeamsActivity(invokeBody(buildTeamsApprovalData(r, "approve"))));
  ok(tap?.action.id === r.id && tap.clickerId === "29:clicker" && tap.tenantId === TENANT && tap.teamsChannelId === CHANNEL, "an OE tap parses, with the clicker, tenant and room off the activity");
  ok(parseTeamsApprovalInvoke(parseTeamsActivity(invokeBody({ eve_input: { requestId: "r1" } }))) === null, "an eve HITL invoke is not ours (it forwards)");
  ok(parseTeamsApprovalInvoke(parseTeamsActivity(invokeBody(buildTeamsApprovalData(r, "approve"), { name: "task/fetch" }))) === null, "a different invoke name is not ours");
  ok(
    parseTeamsApprovalInvoke(parseTeamsActivity(invokeBody(buildTeamsApprovalData(r, "approve"), { channelId: "webchat" }))) === null,
    "a tap from another Bot Framework channel (Web Chat) is not a Teams tap — the token does not bind the body",
  );
  ok(parseTeamsApprovalInvoke(parseTeamsActivity({ ...invokeBody(buildTeamsApprovalData(r, "approve")), type: "message", text: "hi" })) === null, "a message activity is not a tap");
  ok(teamsClickSurfaceKey(tap!, r) === `teams/${TENANT}/${CHANNEL}`, "the click room is the RAW channel id when the row carries the raw id (own-room card)");
  const spelled = row({ channelId: "19-chan1-thread.tacv2" });
  ok(teamsClickSurfaceKey(tap!, spelled) === `teams/${TENANT}/19-chan1-thread.tacv2`, "the click room takes the surface-key spelling when the row carries it (a redirected card)");
  ok(teamsClickSurfaceKey({ ...tap!, tenantId: undefined }, r) === undefined, "no tenant → no click context (the gate stays inert, never a guessed key)");
}

{
  const r = row();
  const msg = (res: Parameters<typeof teamsResponseFor>[0]) => teamsResponseFor(res).type === "application/vnd.microsoft.activity.message";
  ok(msg({ outcome: "unknown" }), "unknown → a note");
  ok(msg({ outcome: "not-pending" }) && msg({ outcome: "lost-race" }) && msg({ outcome: "expired-race" }), "stale re-taps → a note, never a card from a stale row");
  ok(msg({ outcome: "denied", row: r }), "denied → a note to the clicker; the card stays live");
  ok(teamsResponseFor({ outcome: "clicker-denied", row: r, reason: "foreign-room" }).value === clickerFloorRefusalNotice("foreign-room"), "clicker-denied → core's ONE refusal copy");
  const decided = teamsResponseFor({ outcome: "decided", row: { ...r, status: "approved", decidedBy: "29:x" }, summaryLines: ["s"], outcomeLine: "ok", executed: "ok" });
  ok(decided.type === TEAMS_ADAPTIVE_CARD_CONTENT_TYPE, "decided → the decided card replaces the pending one");
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}
function mintJwt(privateKey: KeyObject, kid: string, claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = b64url(JSON.stringify(claims));
  const sig = cryptoSign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(sig)}`;
}
const trusted = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rogue = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(trusted.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "bf-key-1", use: "sig", alg: "RS256" };
const fakeFetch = (async (url: string) => {
  if (url.includes("openidconfiguration")) return new Response(JSON.stringify({ jwks_uri: "https://login.botframework.test/keys" }));
  if (url.includes("/keys")) return new Response(JSON.stringify({ keys: [jwk] }));
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;
const now = Math.floor(Date.now() / 1000);
const goodClaims = { iss: "https://api.botframework.com", aud: APP_ID, iat: now, nbf: now - 10, exp: now + 600 };
const goodToken = mintJwt(trusted.privateKey, "bf-key-1", goodClaims);

let innerCalls = 0;
let tapCalls = 0;
const notices: { conversationId: string; text: string }[] = [];
const updates: { activityId: string }[] = [];
let userTypeAnswer: "guest" | "member" | undefined;
const handler = buildTeamsFrontHandler(
  async () => {
    innerCalls += 1;
    return new Response("native");
  },
  {
    verify: (req) => verifyTeamsRequest(req, { appId: APP_ID, fetch: fakeFetch as never }),
    approvalInvoke: (tap, waitUntil) => {
      tapCalls += 1;
      return handleTeamsApprovalInvoke(tap, {
        waitUntil,
        userType: async () => userTypeAnswer,
        send: async (input) => {
          notices.push({ conversationId: input.conversationId, text: String((input.body as { text?: unknown }).text) });
          return { id: "notice-1" };
        },
        update: async (input) => {
          if (updateFails) throw new Error("HTTP 404");
          updates.push({ activityId: input.activityId });
          return { id: input.activityId };
        },
        ...(teamsWake ? { decisionWake: teamsWake } : {}),
      });
    },
  },
);
let teamsWake: { readonly dispatch: () => Promise<boolean> } | undefined;
let updateFails = false;
const pendingWaits: Promise<unknown>[] = [];
const routeArgs = { waitUntil: (p: Promise<unknown>) => void pendingWaits.push(p), to: {} as never, attachSession: (() => undefined) as never } as never;
async function postTap(body: unknown, auth: string | undefined): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== undefined) headers.authorization = auth;
  const res = await handler(new Request("https://oe.test/eve/v1/teams", { method: "POST", headers, body: JSON.stringify(body) }), routeArgs);
  await Promise.all(pendingWaits.splice(0));
  return res;
}
async function seed(over: Partial<PendingActionRow> = {}): Promise<PendingActionRow> {
  const r = row(over);
  await getOperationalStore().addPendingAction(r);
  return r;
}
async function status(r: PendingActionRow): Promise<string | undefined> {
  return (await getOperationalStore().getPendingAction("default", r.id))?.status;
}
async function auditFor(action: string, id: string) {
  return (await readAudit({ org: "default", action })).filter((e) => e.detail?.id === id);
}

{
  const r = await seed();
  const forged = invokeBody(buildTeamsApprovalData(r, "approve"));
  const cases: [string, string | undefined][] = [
    ["no Authorization header", undefined],
    ["a token signed by a key not in the Bot Framework key set", `Bearer ${mintJwt(rogue.privateKey, "bf-key-1", goodClaims)}`],
    ["a token with the right key and a non-Bot-Framework issuer", `Bearer ${mintJwt(trusted.privateKey, "bf-key-1", { ...goodClaims, iss: "https://evil.example" })}`],
    ["a token for another bot (wrong audience)", `Bearer ${mintJwt(trusted.privateKey, "bf-key-1", { ...goodClaims, aud: "another-app" })}`],
    ["an expired token", `Bearer ${mintJwt(trusted.privateKey, "bf-key-1", { ...goodClaims, exp: now - 3600, nbf: now - 7200, iat: now - 7200 })}`],
    ["a garbage bearer", "Bearer not.a.jwt"],
  ];
  for (const [label, auth] of cases) {
    const res = await postTap(forged, auth);
    ok(res.status === 401, `forged invoke (${label}) → 401`);
  }
  ok(tapCalls === 0 && innerCalls === 0, "no forged invoke reached the tap handler or the native channel");
  ok((await status(r)) === "pending", "after every forgery the row is STILL pending");
  ok((await auditFor("approval.approved", r.id)).length === 0 && memberExecuted.length === 0, "no forgery wrote an approval row or ran the frozen act");
}

{
  const r = await seed();
  const innerBefore = innerCalls;
  const res = await postTap(invokeBody(buildTeamsApprovalData(r, "approve")), `Bearer ${goodToken}`);
  ok(innerCalls === innerBefore && tapCalls === 1, "a verified OE tap is answered by the tap handler, not forwarded to the native channel");
  const body = (await res.json()) as { statusCode: number; type: string; value: { actions?: unknown } };
  ok(res.status === 200 && body.statusCode === 200 && body.type === TEAMS_ADAPTIVE_CARD_CONTENT_TYPE && body.value.actions === undefined, "a verified tap → 200 with the decided card (no buttons left)");
  ok((await status(r)) === "approved", "the row is approved");
  ok(memberExecuted.length === 1 && memberExecuted[0] === "29:clicker", "the frozen act ran exactly once, decided by the tapping principal");
  const approved = await auditFor("approval.approved", r.id);
  ok(approved.length === 1 && approved[0]?.principalId === "29:clicker" && approved[0]?.detail?.venueChannel === CHANNEL, "approval.approved names the clicker and the venue channel");
  const tapNotice = notices.find((x) => x.conversationId === `${CHANNEL};messageid=1700000000001`);
  ok(tapNotice !== undefined && tapNotice.text.startsWith("✅ Approved by an admin: "), `the decision notice posts into the card's own reply chain and states the outcome (got ${JSON.stringify(tapNotice?.text)})`);
  ok(!notices.some((x) => x.text.includes("<@")), "🔴 OPE-2490: no Teams notice spells a raw <@29:…> id");
  ok(updates.some((u) => u.activityId === r.messageTs), "the card message itself is updated to the decided render");
  ok(innerCalls === 0, "an OE tap is never forwarded to the native channel");

  const again = await postTap(invokeBody(buildTeamsApprovalData(r, "approve")), `Bearer ${goodToken}`);
  const againBody = (await again.json()) as { type: string };
  ok(againBody.type === "application/vnd.microsoft.activity.message" && memberExecuted.length === 1, "a re-tap of a decided card changes nothing and runs nothing again");
}

{
  const { overrideSettingsForTest } = await import("@open-everywhere/core/agent/settings/settings.js");
  const { getConfig } = await import("@open-everywhere/core/agent/access/config.js");
  const { supervisorGrainFor } = await import("@open-everywhere/core/agent/channels/unified-supervisor.js");
  const base = getConfig();
  registerConfig({
    ...base,
    loadDomains: () => [
      defineDomain({ name: "org", match: "org", admins: ["teams/29:org-admin"] }),
      defineDomain({ name: "twin", reach: [`teams/${TENANT}/${CHANNEL}`], admins: ["teams/29:org-admin"], ambientSupervisor: true, mode: "solo" }),
    ],
  });
  const executedBefore = memberExecuted.length;
  const { getSettings } = await import("@open-everywhere/core/agent/settings/settings.js");
  const topologyBefore = getSettings().window.topology;
  overrideSettingsForTest({ window: { topology: true } });
  try {
    const grain = supervisorGrainFor(`teams/${TENANT}/${CHANNEL}`, getConfig().loadDomains());
    ok(grain.unified === true && grain.domainName === "twin", "decide once (Teams) setup: the fixture channel resolves a window grain");
    await getOperationalStore().rotateChannelSession("default", grain.registryKey, `oe-dom:twin:win:teams/${TENANT}/${CHANNEL}:oe-sup:g1`, new Date().toISOString());
    let woke = 0;
    teamsWake = {
      dispatch: async () => {
        woke += 1;
        return true;
      },
    };

    const r = await seed();
    notices.length = 0;
    updates.length = 0;
    await postTap(invokeBody(buildTeamsApprovalData(r, "approve")), `Bearer ${goodToken}`);
    ok((await status(r)) === "approved" && woke === 1, "decide once (Teams): the tap decides, and the standing seat takes the wake");
    ok(updates.some((u) => u.activityId === r.messageTs), "decide once (Teams): the card message is replaced by the decided render");
    ok(notices.length === 0, `🔴 decide once (Teams): the decided card shows the outcome and the seat took the wake, so no notice repeats it (got ${notices.length})`);

    const r2 = await seed();
    notices.length = 0;
    updateFails = true;
    await postTap(invokeBody(buildTeamsApprovalData(r2, "approve")), `Bearer ${goodToken}`);
    updateFails = false;
    ok((await status(r2)) === "approved", "decide once (Teams): the second tap decides");
    ok(notices.length === 1, `decide once (Teams): a card update that FAILED still posts the notice (got ${notices.length})`);

    const { unifiedThreadRef } = await import("@open-everywhere/core/agent/channels/unified-window.js");
    const r3 = await seed();
    const ref = unifiedThreadRef({ platform: "teams", serviceUrl: SERVICE_URL, conversationId: `${CHANNEL};messageid=${r3.messageTs}`, tenantId: TENANT, replyToActivityId: r3.messageTs! });
    await getOperationalStore().putThreadOwner("default", ref.channelKey, ref.threadKey, "oe-dom:twin:t/owner:oe-sup:g1", new Date().toISOString(), 60_000);
    notices.length = 0;
    await postTap(invokeBody(buildTeamsApprovalData(r3, "approve")), `Bearer ${goodToken}`);
    await getOperationalStore().clearThreadOwner("default", ref.channelKey, ref.threadKey);
    ok((await status(r3)) === "approved" && woke === 3, "decide once (Teams): the third tap decides, and the standing seat takes its wake too");
    ok(notices.length === 1, `decide once (Teams): a reply chain that a thread seat or a worker owns still gets the notice (got ${notices.length})`);
  } finally {
    teamsWake = undefined;
    updateFails = false;
    memberExecuted = memberExecuted.slice(0, executedBefore);
    overrideSettingsForTest({ window: { topology: topologyBefore } });
    registerConfig(base);
  }
}

{
  const r = await seed();
  await postTap(invokeBody(buildTeamsApprovalData(r, "reject")), `Bearer ${goodToken}`);
  ok((await status(r)) === "rejected" && (await auditFor("approval.rejected", r.id)).length === 1, "a verified Reject tap rejects the row and audits approval.rejected");
}

{
  const r = await seed();
  const body = invokeBody(buildTeamsApprovalData(r, "approve"), {
    conversation: { id: `${OTHER_CHANNEL};messageid=1`, conversationType: "channel", tenantId: TENANT },
    channelData: { tenant: { id: TENANT }, channel: { id: OTHER_CHANNEL } },
  });
  const res = (await (await postTap(body, `Bearer ${goodToken}`)).json()) as { value: unknown };
  ok(res.value === clickerFloorRefusalNotice("foreign-room"), "a tap from another channel gets the foreign-room refusal");
  ok((await status(r)) === "pending", "the foreign-room tap leaves the row pending");
  ok((await auditFor("approval.denied", r.id)).some((e) => e.detail?.reason === "foreign-room"), "approval.denied records reason foreign-room");
}

{
  const r = await seed();
  userTypeAnswer = "guest";
  const res = (await (await postTap(invokeBody(buildTeamsApprovalData(r, "approve")), `Bearer ${goodToken}`)).json()) as { value: unknown };
  userTypeAnswer = undefined;
  ok(res.value === clickerFloorRefusalNotice("guest-clicker") && (await status(r)) === "pending", "a guest clicker is refused and the row stays pending");
}

{
  const r = await seed({ kind: "test.admin.teams" });
  const denied = (await (await postTap(invokeBody(buildTeamsApprovalData(r, "approve")), `Bearer ${goodToken}`)).json()) as { type: string };
  ok(denied.type === "application/vnd.microsoft.activity.message" && (await status(r)) === "pending" && adminExecuted.length === 0, "a non-admin tap on an admin-tier card is denied and runs nothing");
  ok((await auditFor("approval.denied", r.id)).some((e) => e.detail?.reason === "not-admin"), "approval.denied records reason not-admin");
  const adminTap = invokeBody(buildTeamsApprovalData(r, "approve"), { from: { id: "29:org-admin", name: "Org Admin" } });
  await postTap(adminTap, `Bearer ${goodToken}`);
  ok((await status(r)) === "approved" && adminExecuted[0] === "29:org-admin", "the roster admin (teams/29:org-admin) decides the admin-tier card");
}

{
  const r = await seed();
  const body = invokeBody(buildTeamsApprovalData(r, "approve"), {
    conversation: { id: `${OTHER_CHANNEL};messageid=1`, conversationType: "channel" },
    channelData: { channel: { id: OTHER_CHANNEL } },
  });
  const res = (await (await postTap(body, `Bearer ${goodToken}`)).json()) as { value: unknown };
  ok(typeof res.value === "string" && /Nothing changed/.test(res.value) && (await status(r)) === "pending" && memberExecuted.length === 1, "a tenant-less tap from another room is refused and the row stays pending");
}

{
  const r = await seed({ kind: "test.admin.teams" });
  const before = innerCalls;
  const res = await postTap(invokeBody(buildTeamsApprovalData(r, "approve"), { channelId: "webchat", from: { id: "29:org-admin", name: "x" } }), `Bearer ${goodToken}`);
  ok(res.status === 403, "a Web Chat invoke is refused (403) by the front's Teams-channel check (OPE-2455)");
  ok((await status(r)) === "pending" && innerCalls === before, "a Web Chat invoke impersonating the admin is not a tap: the row stays pending, and it is NOT forwarded to the native channel");
}

{
  const before = innerCalls;
  const res = await postTap(invokeBody({ eve_input: { requestId: "r-1" } }), `Bearer ${goodToken}`);
  ok(innerCalls === before + 1 && (await res.text()) === "native", "a verified eve HITL invoke forwards to the native channel untouched");
}

{
  sent.length = 0;
  await postTeamsRowDecisionNotice(row(), "expired notice", { send, resolveRef });
  ok(sent[0]?.conversationId === CHANNEL && (sent[0]?.body as { text?: string }).text === "expired notice", "the row-addressed notice posts into the card's channel conversation");
  await assert.rejects(postTeamsRowDecisionNotice(row({ channelId: OTHER_CHANNEL }), "x", { send, resolveRef }), /no Teams conversation reference/);
  n++;
  const wakeTarget = await teamsRowWakeTarget(row(), { resolveRef });
  ok(wakeTarget?.surfaceKey === `teams/${TENANT}/${CHANNEL}` && wakeTarget.origin.platform === "teams", "the row wake target is the card's postedTo, with a Teams origin off the stored reference");
  const sweptNotices: string[] = [];
  registerDecisionFeedbackSurface("teams", {
    postNotice: async (r, text) => {
      sweptNotices.push(`${r.id}:${text}`);
    },
    wakeTarget: async () => null,
  });
  const r = await seed({ expiresAt: new Date(Date.now() - 1000).toISOString() });
  await sweepExpiredPendings("default");
  ok((await status(r)) === "expired", "the sweep expires the Teams row");
  ok(sweptNotices.some((s) => s.startsWith(`${r.id}:`)), "the sweep posts the expiry notice through the registered Teams decision-feedback legs");
}

{
  const { teamsApprovalCardActions } = await import("../packages/core/scripts/e2e/teams-driver.js");
  const r = row();
  const graphMessage = { attachments: [{ contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE, content: JSON.stringify(pendingTeamsCard(r, ["l"])) }] };
  const decoded = teamsApprovalCardActions(graphMessage);
  ok(
    decoded.length === 2 && decoded.every((a) => a.pendingId === r.id && a.org === r.org) && decoded.map((a) => a.decision).join(",") === "approve,reject",
    "the e2e driver decodes the posted card's Approve and Reject actions (S-CARD-teams leg 1)",
  );
  ok(teamsApprovalCardActions({ attachments: [{ contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE, content: "{not json" }] }).length === 0, "an unparseable attachment decodes to nothing");
}

{
  const { teamsCardShape, teamsDmApprovalCard } = await import("../packages/core/scripts/e2e/teams-driver.js");
  const { UnrecognisedShape } = await import("../packages/core/scripts/e2e/poll.js");
  const r = row();
  const wire = (c: unknown) => ({ attachments: [{ contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE, content: JSON.stringify(c) }] });
  ok(teamsCardShape(wire(pendingTeamsCard(r, ["l"]))).kind === "approval", "the real pending card is an approval card");
  ok(teamsCardShape(wire(decidedTeamsCard(r, ["l"], "Approved"))).kind === "none", "the real decided card (no buttons) is not a card to wait on, and not a shape error");
  ok(teamsCardShape(wire(judgeLiftNoticeTeamsCard(r, ["l"], "ran"))).kind === "none", "the real judge-lift notice (a contradict button only) is not an approval card, and not a shape error");
  ok(teamsCardShape({ attachments: [{ contentType: "text/html", content: "<p>hi</p>" }] }).kind === "none", "a message with no Adaptive Card is no card");
  const oldCard = { type: "AdaptiveCard", version: "1.4", body: [], actions: [{ type: "Action.Submit", title: "Approve", data: { oe_approval: { id: r.id, decision: "approve" } } }] };
  const oldShape = teamsCardShape(wire(oldCard));
  ok(oldShape.kind === "unrecognised" && oldShape.saw.includes("Action.Submit{oe_approval}"), `a card with buttons but no readable approval payload is UNRECOGNISED and names its buttons (got ${JSON.stringify(oldShape)})`);
  const { renderInputRequestAttachment } = await import("eve/channels/teams");
  const eveInput = renderInputRequestAttachment({ requestId: "q1", prompt: "Which one?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } as never);
  ok(teamsCardShape({ attachments: [{ contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE, content: JSON.stringify(eveInput.content) }] }).kind === "none", "eve's real input-request card (eve_input buttons) is a known shape, not an approval card and not a shape error");
  const eveSignIn = { type: "AdaptiveCard", version: "1.5", body: [{ type: "TextBlock", text: "Authorization required for GitHub" }], actions: [{ type: "Action.OpenUrl", title: "Sign in with GitHub", url: "https://example.test/auth" }] };
  ok(teamsCardShape(wire(eveSignIn)).kind === "none", "eve's sign-in card (one Action.OpenUrl button, the authorization.required shape) is a known shape, not a shape error");
  const mixed = teamsCardShape(wire({ ...oldCard, actions: [(eveInput.content as { actions: unknown[] }).actions[0], oldCard.actions[0]] }));
  ok(mixed.kind === "unrecognised" && mixed.saw.includes("Action.Submit{oe_approval}"), `a card with one eve button and one unknown button is still UNRECOGNISED (got ${JSON.stringify(mixed)})`);
  const garbled = teamsCardShape({ attachments: [{ contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE, content: "{not json" }] });
  ok(garbled.kind === "unrecognised" && garbled.saw.includes("not JSON"), "an Adaptive Card whose content does not parse is UNRECOGNISED");

  const askedAt = "2026-10-18T10:00:00.000Z";
  const bot = { id: "b", text: "", fromApplicationId: "app" };
  const isBot = (m: { fromApplicationId?: string }) => m.fromApplicationId === "app";
  const what = "S-CARD-teams-dm: the approval card in the 1:1 chat";
  await import("@open-everywhere/core/agent/approvals/routine-create.js");
  const routineRow = (prompt: string) =>
    row({ kind: "routine.create", argsJson: JSON.stringify({ prompt, trigger: { kind: "at", at: "2026-10-18T10:05:00.000Z" }, channelId: CHANNEL }) });
  const note = "teamsdmcard-q7z";
  const card = { ...bot, id: "card", createdDateTime: "2026-10-18T10:00:05.000Z", ...wire(pendingTeamsCard(routineRow(`Post exactly the word ${note} here.`), [])) };
  ok(card.attachments[0]!.content.includes(note), "the real routine card quotes the routine's prompt, so it carries the ask's note");
  const throwsShape = (f: () => unknown): string => {
    try {
      f();
    } catch (err) {
      return err instanceof UnrecognisedShape ? err.message : `not a shape error: ${String(err)}`;
    }
    return "no throw";
  };
  ok(teamsDmApprovalCard({ dm: [card], channel: [], askedAt, isBot, note, what })?.id === "card", "the real card in the 1:1 chat is found (the correct shape passes)");
  ok(teamsDmApprovalCard({ dm: [], channel: [], askedAt, isBot, note, what }) === undefined, "no card yet anywhere is a wait, not a red");
  ok(teamsDmApprovalCard({ dm: [], askedAt, isBot, note, what }) === undefined, "a failed channel read (no channel list) is a wait, not a red");
  ok(teamsDmApprovalCard({ dm: [], channel: [{ ...card, createdDateTime: "2026-10-18T09:59:00.000Z" }], askedAt, isBot, note, what }) === undefined, "a channel card from BEFORE the ask is not this ask's card");
  ok(teamsDmApprovalCard({ dm: [], channel: [{ ...card, fromApplicationId: "someone-else" }], askedAt, isBot, note, what }) === undefined, "a channel card by another app is not the bot's card");
  const lateOtherLeg = { ...card, id: "late", ...wire(pendingTeamsCard(routineRow("Post exactly the word teamscard-other here."), [])) };
  ok(teamsDmApprovalCard({ dm: [], channel: [lateOtherLeg], askedAt, isBot, note, what }) === undefined, "a fresh channel card that does NOT quote this ask's note (a late card from an earlier leg) is a wait, not a red");
  const longerToken = { ...card, id: "longer", ...wire(pendingTeamsCard(routineRow(`Post exactly the word ${note}9 here.`), [])) };
  ok(teamsDmApprovalCard({ dm: [], channel: [longerToken], askedAt, isBot, note, what }) === undefined, "a channel card quoting a LONGER token that starts with this note is another ask's card — a wait, not a red");
  const redirected = throwsShape(() => teamsDmApprovalCard({ dm: [], channel: [card], askedAt, isBot, note, what }));
  ok(redirected.startsWith(what) && redirected.includes("pre-OPE-2447") && redirected.includes("message card"), `🔴 the pre-OPE-2447 shape (the card in the team channel, none in the chat) throws at once and names it (got: ${redirected})`);
  ok(teamsDmApprovalCard({ dm: [card], channel: [card], askedAt, isBot, note, what })?.id === "card", "a card in the chat wins over a card in the channel");
  const unreadable = throwsShape(() => teamsDmApprovalCard({ dm: [{ ...card, id: "old", ...wire(oldCard) }], channel: [], askedAt, isBot, note, what }));
  ok(unreadable.includes("message old") && unreadable.includes("Action.Submit{oe_approval}"), `🔴 an unreadable bot card in the chat throws at once and names its buttons (got: ${unreadable})`);

  const { isTeamsPendingApprovalCard } = await import("../packages/core/scripts/e2e/teams-driver.js");
  const at = { askedAt, isBot };
  const fresh = { ...bot, createdDateTime: "2026-10-18T10:00:05.000Z" };
  ok(isTeamsPendingApprovalCard({ ...fresh, id: "p", ...wire(pendingTeamsCard(r, ["l"])) }, at), "S-CARD-teams: the real pending card is the card (the correct shape passes)");
  ok(!isTeamsPendingApprovalCard({ ...fresh, id: "n", ...wire(judgeLiftNoticeTeamsCard(r, ["l"], "ran")) }, at), "🔴 S-CARD-teams: the real judge-lift notice (a contradict button only) is NOT the card");
  ok(!isTeamsPendingApprovalCard({ ...fresh, id: "d", ...wire(decidedTeamsCard(r, ["l"], "Approved")) }, at), "S-CARD-teams: the real decided card is not a pending card");
  ok(!isTeamsPendingApprovalCard({ ...fresh, id: "e", createdDateTime: "2026-10-18T09:59:00.000Z", ...wire(pendingTeamsCard(r, ["l"])) }, at), "S-CARD-teams: a card from BEFORE the ask is not this ask's card");
  ok(!isTeamsPendingApprovalCard({ ...fresh, id: "o", fromApplicationId: "someone-else", ...wire(pendingTeamsCard(r, ["l"])) }, at), "S-CARD-teams: a card by another app is not the bot's card");
  const rejectOnly = pendingTeamsCard(r, ["l"]) as unknown as { actions: unknown[] };
  ok(isTeamsPendingApprovalCard({ ...fresh, id: "h", ...wire({ ...rejectOnly, actions: rejectOnly.actions.slice(1) }) }, at), "S-CARD-teams: a card with only one decision button still matches, so the leg's Approve-and-Reject gate reds on it");
}

console.log(`teams-approvals-test: ${n} assertions passed`);
