import { withPatchedFetch } from "../packages/core/scripts/_fetch-test-utils.js";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "@open-everywhere/core/agent/identity/deployment-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

_setDeploymentIdentityForTest({ org: "acme" });
const dir = join(tmpdir(), `open-everywhere-teams-directory-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.MICROSOFT_APP_ID = "fixture-app-id-not-a-secret";
process.env.MICROSOFT_APP_PASSWORD = "fixture-app-secret-not-a-secret";

const SERVICE_URL = "https://smba.trafficmanager.net/uk/";
const ROGUE_URL = "https://evil.example/";

const TENANT = "TENANT_ONE";
const PERSONAL_CONV = "19:1on1-hazel@thread.v2";
const TEAM_CONV = "19:team-chan@thread.tacv2";
const TEAM_ID = "TEAM_ALPHA";
const HAZEL = "29:hazel";

interface RosterPage {
  readonly members: unknown[];
  readonly continuationToken?: string;
}
const rosters = new Map<string, RosterPage[]>();
const forbiddenRosters = new Set<string>();

const createCalls: { members: string[]; tenant: string }[] = [];
const sendCalls: { conversationId: string; text: string }[] = [];
const rosterCalls: { conversationId: string; continuationToken: string | null }[] = [];
let createStatus = 200;

const res = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const fakeTeamsFetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = String(input);
  if (url.includes("login.microsoftonline.com")) {
    return res(200, { token_type: "Bearer", expires_in: 3600, access_token: "fixture-connector-token" });
  }
  const parsed = new URL(url);
  const at = parsed.pathname.indexOf("/v3/");
  if (at < 0) return res(404, {});
  const path = parsed.pathname.slice(at);
  const method = (init?.method ?? "GET").toUpperCase();

  if (path === "/v3/conversations" && method === "POST") {
    const body = JSON.parse(init?.body ?? "{}") as { members?: { id?: string }[]; channelData?: { tenant?: { id?: string } } };
    createCalls.push({ members: (body.members ?? []).map((m) => String(m.id ?? "")), tenant: String(body.channelData?.tenant?.id ?? "") });
    if (createStatus !== 200) return res(createStatus, { error: { code: "BotNotInConversationRoster" } });
    return res(200, { id: `a:opened-${createCalls.length}` });
  }

  const activities = /^\/v3\/conversations\/([^/]+)\/activities$/.exec(path);
  if (activities && method === "POST") {
    const body = JSON.parse(init?.body ?? "{}") as { text?: string };
    sendCalls.push({ conversationId: decodeURIComponent(activities[1]!), text: String(body.text ?? "") });
    return res(200, { id: `act-${sendCalls.length}` });
  }

  const paged = /^\/v3\/conversations\/([^/]+)\/pagedmembers$/.exec(path);
  if (paged && method === "GET") {
    const conversationId = decodeURIComponent(paged[1]!);
    const token = parsed.searchParams.get("continuationToken");
    rosterCalls.push({ conversationId, continuationToken: token });
    if (forbiddenRosters.has(conversationId)) return res(403, { error: { code: "Forbidden" } });
    const pages = rosters.get(conversationId) ?? [];
    const index = token === null ? 0 : Number(token);
    const page = pages[index];
    if (!page) return res(200, { members: [] });
    return res(200, { members: page.members, ...(page.continuationToken ? { continuationToken: page.continuationToken } : {}) });
  }

  return res(404, {});
}) as unknown as typeof fetch;

await withPatchedFetch(fakeTeamsFetch, async () => {

const { hasAccountDirectory, lookupAccountDirectory } = await import("@open-everywhere/core/agent/identity/account-directory.js");
const { canDeliverDirectMessage, dispatchDirectMessage, directMessageCapablePlatforms } = await import(
  "@open-everywhere/core/agent/channels/post-arms.js"
);
const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");

ok(hasAccountDirectory("teams") === false, "§1 negative control: no teams account directory is registered before the provider boots");
ok(canDeliverDirectMessage("teams") === false, "§1 negative control: no teams DM arm is registered before the provider boots");

const { registerTeamsProvider } = await import("@open-everywhere/provider-teams/agent/register.js");
registerTeamsProvider();

ok(hasAccountDirectory("teams") === true, "🔴 §1 REACHABILITY: registerTeamsProvider() registers the account-directory arm — a correct arm nobody registers is dead code");
ok(canDeliverDirectMessage("teams") === true, "🔴 §1 REACHABILITY: registerTeamsProvider() registers the DM-delivery arm — the directory transport needs BOTH");
ok(directMessageCapablePlatforms().includes("teams"), "§1 teams now appears in the DM-capable list core's refusal copy reads");

const { buildTeamsFrontHandler } = await import("@open-everywhere/provider-teams/agent/channels/teams-front.js");
const { teamsAddressRowsFor, teamsPersonalConversationRef, teamsTeamConversationRefs, TEAMS_ADDRESS_PLATFORM, TEAMS_PERSONAL_ADDRESS_KIND, TEAMS_TEAM_ADDRESS_KIND } =
  await import("@open-everywhere/provider-teams/agent/channels/teams-conversation-ref.js");

const store = getOperationalStore();
const personalRow = (userId: string) => store.proactiveAddress("acme", TEAMS_ADDRESS_PLATFORM, TEAMS_PERSONAL_ADDRESS_KIND, userId);
const teamRow = (teamId: string) => store.proactiveAddress("acme", TEAMS_ADDRESS_PLATFORM, TEAMS_TEAM_ADDRESS_KIND, teamId);

{
  const activityBody = (scope: "personal" | "groupChat" | "channel", over?: Record<string, unknown>): string => {
    const conversation: Record<string, unknown> = {
      id: scope === "personal" ? PERSONAL_CONV : `${TEAM_CONV};messageid=1755000000000`,
      conversationType: scope,
      tenantId: TENANT,
    };
    const base: Record<string, unknown> = {
      type: "message",
      id: `act-${scope}-${Math.random()}`,
      serviceUrl: SERVICE_URL,
      from: { id: HAZEL, name: "Hazel" },
      recipient: { id: "28:bot" },
      conversation,
      text: "hello there",
      ...over,
    };
    if (scope === "channel") base.channelData = { channel: { id: "19:team-chan" }, team: { id: TEAM_ID } };
    return JSON.stringify(base);
  };

  async function runFront(body: string, opts: { suppress?: boolean } = {}): Promise<void> {
    const waits: Promise<unknown>[] = [];
    const handler = buildTeamsFrontHandler(async () => new Response("native"), {
      verify: async () => body,
      markEventSeen: async () => true,
      externalGate: async () => opts.suppress === true,
      planFor: () => null,
      dmDivert: async () => undefined,
      dispatch: async () => undefined,
    });
    const args = { to: {} as never, waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as Parameters<typeof handler>[1];
    await handler(new Request("https://oe.test/eve/v1/teams", { method: "POST", body }), args);
    await Promise.all(waits);
  }

  await runFront(activityBody("personal"));
  const captured = await teamsPersonalConversationRef(HAZEL);
  ok(
    captured?.conversationId === PERSONAL_CONV && captured.serviceUrl === SERVICE_URL && captured.tenantId === TENANT,
    "🔴 §2 REACHABILITY: a real inbound PERSONAL activity through the real front handler lands a 1:1 conversation reference in the real store",
  );

  await runFront(activityBody("channel"));
  const teams = await teamsTeamConversationRefs();
  ok(
    teams.length === 1 && teams[0]!.conversationId === TEAM_CONV,
    "🔴 §2 REACHABILITY: a real inbound CHANNEL activity lands a TEAM reference, at the CHANNEL grain — the `;messageid=` reply-chain suffix names one thread, not the team",
  );

  const before = (await personalRow("29:suppressed")) === undefined;
  await runFront(activityBody("personal", { from: { id: "29:suppressed", name: "Sam" }, conversation: { id: "19:1on1-sam@thread.v2", conversationType: "personal", tenantId: TENANT } }), { suppress: true });
  ok(before && (await personalRow("29:suppressed")) === undefined, "🔴 §2 negative control: an activity the external-participant gate SUPPRESSED records NO address — the capture sits below the gate on purpose");
}

{
  const base = { tenantId: TENANT, serviceUrl: SERVICE_URL, userId: HAZEL, teamId: TEAM_ID };
  const addressRows = <T extends { readonly kind: string }>(rows: readonly T[]): readonly T[] =>
    rows.filter((r) => r.kind === "personal" || r.kind === "team" || r.kind === "conversation");

  const personal = addressRows(teamsAddressRowsFor({ ...base, scope: "personal", conversationId: PERSONAL_CONV }));
  ok(personal.length === 2, "§3 a PERSONAL activity writes TWO address rows — `personal` AND `conversation` (OPE-899)");
  ok(
    personal.some((r) => r.kind === "personal" && r.refKey === HAZEL),
    "§3 …one of them is the `personal` row, keyed on the Bot Framework user id",
  );
  ok(
    personal.every((r) => r.kind !== "team"),
    "🔴 §3 WRONG HAND: a personal chat writes NO team row — a 1:1 conversation is not a team, and a directory read addressed at it would return one person",
  );

  const channel = addressRows(teamsAddressRowsFor({ ...base, scope: "channel", conversationId: `${TEAM_CONV};messageid=99` }));
  ok(channel.length === 3, "§3 a CHANNEL activity writes THREE address rows — `team`, plus a `conversation` row at EACH grain (OPE-899, OPE-1093)");
  const channelTeamRow = channel.find((r) => r.kind === "team");
  ok(channelTeamRow?.refKey === TEAM_ID, "§3 …one of them is the `team` row, keyed on the team id");
  ok(
    (channelTeamRow!.address as { conversationId: string }).conversationId === TEAM_CONV,
    "§3 the team row stores the CHANNEL-grain conversation id — the roster is a property of the channel, never of one reply chain",
  );
  const channelConvKeys = channel.filter((r) => r.kind === "conversation").map((r) => r.refKey).sort();
  ok(
    JSON.stringify(channelConvKeys) === JSON.stringify([TEAM_CONV, `${TEAM_CONV};messageid=99`].sort()),
    "🔴 §3 …the other TWO are `conversation` rows, one per grain: the reply chain the activity arrived on, and the CHANNEL a roster entry names (OPE-1093)",
  );
  ok(
    channel.every((r) => r.kind !== "conversation" || (r.address as { conversationId: string }).conversationId === r.refKey),
    "§3 every `conversation` row addresses the id it is keyed on — a row keyed on one grain and addressing the other would deliver into the wrong place",
  );
  ok(
    channel.every((r) => r.kind !== "personal"),
    "🔴 §3 WRONG HAND: a CHANNEL activity writes NO personal row. A channel conversation id in a personal row would post an identity-link consent ask into a room where everybody can read it",
  );

  const group = addressRows(teamsAddressRowsFor({ ...base, scope: "groupChat", conversationId: "19:group@thread.v2" }));
  ok(
    group.length === 1 && group[0]!.kind === "conversation",
    "§3 a GROUP chat writes exactly the `conversation` row — never a `personal`/`team` row (neither reader has a use for a group chat), but OPE-899's row still stands",
  );
  const noScope = addressRows(teamsAddressRowsFor({ ...base, scope: undefined, conversationId: PERSONAL_CONV }));
  ok(
    noScope.length === 1 && noScope[0]!.kind === "conversation",
    "§3 an activity with no scope writes ONLY the `conversation` row — no `personal`/`team` row (refuse, never guess which species it is), but the exact id it arrived on is still recorded",
  );
  ok(teamsAddressRowsFor({ ...base, scope: "personal", conversationId: PERSONAL_CONV, serviceUrl: ROGUE_URL }).length === 0, "🔴 §3 an UNTRUSTED serviceUrl host is refused at WRITE time, for EVERY species including `conversation` — a stored address becomes the target of a Connector bearer token");
  ok(teamsAddressRowsFor({ ...base, scope: "personal", conversationId: PERSONAL_CONV, tenantId: undefined }).length === 0, "§3 no tenant ⇒ no row of any species (opening a cold 1:1 names a tenant, so a tenant-less address is only half an address)");
  ok(teamsAddressRowsFor({ ...base, scope: "personal", conversationId: undefined }).length === 0, "§3 no conversation ⇒ no row of any species");
  const blankAuthor = addressRows(teamsAddressRowsFor({ ...base, scope: "personal", conversationId: PERSONAL_CONV, userId: "  " }));
  ok(
    blankAuthor.length === 1 && blankAuthor[0]!.kind === "conversation",
    "§3 a blank author costs the `personal` row (no key to store it under) but NOT the `conversation` row",
  );
  const noTeamId = addressRows(teamsAddressRowsFor({ ...base, scope: "channel", conversationId: TEAM_CONV, teamId: undefined }));
  ok(
    noTeamId.length === 1 && noTeamId[0]!.kind === "conversation",
    "§3 a channel activity with NO team id costs the `team` row (no key to store it under) but NOT the `conversation` row",
  );
}

{
  const first = await teamRow(TEAM_ID);
  await store.recordProactiveAddress("acme", {
    platform: "teams",
    kind: "team",
    refKey: TEAM_ID,
    tenant: TENANT,
    address: { serviceUrl: "https://smba.trafficmanager.net/emea/", conversationId: TEAM_CONV },
    updatedAt: "2030-01-01T00:00:00.000Z",
  });
  const refs = await teamsTeamConversationRefs();
  ok(refs.length === 1, "§4 a second write for the same key UPSERTS — Microsoft makes no promise a tenant keeps its serviceUrl region, so the newest activity wins rather than adding a row");
  ok(
    refs[0]!.serviceUrl === "https://smba.trafficmanager.net/emea/" && first?.address["serviceUrl"] === SERVICE_URL,
    "§4 …and the refreshed region is what a reader gets back",
  );

  await store.recordProactiveAddress("acme", { platform: "teams", kind: "team", refKey: "TEAM_BROKEN", tenant: TENANT, address: {}, updatedAt: "2029-01-01T00:00:00.000Z" });
  const afterBroken = await teamsTeamConversationRefs();
  ok(
    afterBroken.every((r) => r.conversationId.length > 0) && afterBroken.length === 1,
    "🔴 §4 a row whose address bag names no conversation is DROPPED on read — a half address must never reach a caller that would post into it",
  );
  await store.recordProactiveAddress("acme", { platform: "teams", kind: "team", refKey: TEAM_ID, tenant: TENANT, address: { serviceUrl: SERVICE_URL, conversationId: TEAM_CONV }, updatedAt: "2030-01-02T00:00:00.000Z" });
}

{
  sendCalls.length = 0;
  createCalls.length = 0;
  const delivered = await dispatchDirectMessage("teams", { principalId: HAZEL, text: "somebody asked to link your account" });
  ok(createCalls.length === 0, "§5 a stored 1:1 reference means NO conversation is opened — the whole point of persisting one");
  ok(sendCalls.length === 1 && sendCalls[0]!.conversationId === PERSONAL_CONV, "🔴 §5 the DM lands in the person's 1:1 conversation, NOT the team conversation this deployment also holds");
  ok(delivered.surfaceId === PERSONAL_CONV && delivered.messageId.startsWith("act-"), "§5 the delivery returns the conversation id and the activity id — public ids only");
  ok(sendCalls[0]!.text.includes("link your account"), "§5 …and the caller's own text is what was sent");
}

{
  const COLD = "29:cold-colleague";
  sendCalls.length = 0;
  createCalls.length = 0;
  ok((await personalRow(COLD)) === undefined, "§6 negative control: this deployment holds no 1:1 reference for that person before the delivery");

  const delivered = await dispatchDirectMessage("teams", { principalId: COLD, text: "hello" });
  ok(createCalls.length === 1, "🔴 §6 with no 1:1 reference the arm OPENS one — `POST /v3/conversations`, the only way to cold-address a Teams person");
  ok(createCalls[0]!.members.join(",") === COLD && createCalls[0]!.tenant === TENANT, "§6 …naming the member and the tenant, both read off the stored team reference");
  ok(sendCalls.length === 1 && sendCalls[0]!.conversationId === delivered.surfaceId, "§6 …and the message goes into the conversation the create returned");

  sendCalls.length = 0;
  createCalls.length = 0;
  await dispatchDirectMessage("teams", { principalId: COLD, text: "hello again" });
  ok(createCalls.length === 0 && sendCalls.length === 1, "🔴 §6 the opened conversation was REMEMBERED — the second delivery is one call, not two");
}

{
  createStatus = 403;
  sendCalls.length = 0;
  let refused = "";
  try {
    await dispatchDirectMessage("teams", { principalId: "29:no-app-install", text: "hello" });
  } catch (err) {
    refused = (err as Error).message;
  }
  ok(refused.includes("personal scope"), "🔴 §7 Microsoft's refusal for a person with no app install is reported with its REASON — a bare 'did not send' sends an operator looking in the wrong place");
  ok(!refused.includes("fixture-app-secret-not-a-secret") && !refused.includes("fixture-connector-token"), "§7 …and the error is token-free");
  ok(sendCalls.length === 0, "§7 …and nothing was posted");
  createStatus = 200;

  await store.recordProactiveAddress("acme", { platform: "teams", kind: "team", refKey: "TEAM_BETA", tenant: "TENANT_TWO", address: { serviceUrl: SERVICE_URL, conversationId: "19:beta@thread.tacv2" }, updatedAt: "2030-01-03T00:00:00.000Z" });
  createCalls.length = 0;
  sendCalls.length = 0;
  let ambiguous = "";
  try {
    await dispatchDirectMessage("teams", { principalId: "29:ambiguous", text: "hello" });
  } catch (err) {
    ambiguous = (err as Error).message;
  }
  ok(ambiguous.includes("no single Teams tenant"), "🔴 §7 two tenants ⇒ the arm REFUSES rather than guessing which organisation a bare `29:` id belongs to");
  ok(createCalls.length === 0 && sendCalls.length === 0, "§7 …and it refuses BEFORE any call leaves this host");
}

{
  rosters.set(TEAM_CONV, [
    {
      members: [
        { id: HAZEL, name: "Hazel Hunt", userPrincipalName: "hazel@acme.example" },
        { id: "28:bot", name: "Hazelbot" },
        { id: "29:bob", name: "Bob Best", userPrincipalName: "bob@acme.example" },
      ],
      continuationToken: "1",
    },
    { members: [{ id: "29:hazel-two", name: "Hazel Two", email: "hazel2@acme.example" }] },
  ]);
  rosters.set("19:beta@thread.tacv2", [{ members: [{ id: "29:hazel", name: "Hazel Hunt", userPrincipalName: "hazel@acme.example" }] }]);
  rosterCalls.length = 0;

  const found = await lookupAccountDirectory("teams", "hazel");

  const ids = found.candidates.map((c) => c.nativeId).sort();
  ok(ids.join(",") === "29:hazel,29:hazel-two", "🔴 §8 the directory answers with BOT FRAMEWORK `29:` ids — the id shape a Teams identity link keys on, which Microsoft Graph cannot produce at all");
  ok(found.candidates.every((c) => c.nativeId !== "28:bot"), "🔴 §8 negative control: a `28:` BOT that matches the query is dropped — a link is a statement about a human, and the consent DM would go to something that can never answer");
  ok(found.candidates.every((c) => c.nativeId !== "29:bob"), "§8 …and a member who does not match the query is absent");
  const hazel = found.candidates.find((c) => c.nativeId === HAZEL)!;
  ok(hazel.name === "Hazel Hunt" && hazel.handle === "hazel@acme.example", "§8 the display name lands as `name` and the UPN as `handle` — the unique string a person knows themselves by");
  ok(rosterCalls.some((c) => c.conversationId === TEAM_CONV && c.continuationToken === "1"), "🔴 §8 the roster is PAGED — the Bot Connector has no member search, so a person on page two is only found by following the continuation token");
  ok(
    found.candidates.some((c) => c.nativeId === "29:hazel-two"),
    "§8 …and the page-two member is in the answer",
  );
  ok(rosterCalls.some((c) => c.conversationId === "19:beta@thread.tacv2"), "§8 every stored team reference is walked, not just the newest");

  forbiddenRosters.add(TEAM_CONV);
  const partial = await lookupAccountDirectory("teams", "hazel");
  ok(partial.candidates.length === 1 && partial.candidates[0]!.nativeId === HAZEL, "🔴 §8 a team whose roster answers 403 contributes nothing and the OTHER team still answers — one refusal must not empty the whole directory");
  forbiddenRosters.delete(TEAM_CONV);

  ok((await lookupAccountDirectory("teams", "   ")).candidates.length === 0, "§8 an empty query answers nothing and makes no call");
}

});

rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ teams-directory: ${passed} assertions passed (arm + write reachability, the capture rules and the wrong-hand oracle, the store, the warm/cold DM arm, refusal honesty, the paged Connector roster)`);
