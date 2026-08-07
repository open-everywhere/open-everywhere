import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "oe-propose-venue-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_EGRESS_SPOOF = "1";
delete process.env.OE_PLATFORM;
delete process.env.OE_MEMORY_FLOAT;

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  n++;
}
async function refuses(fn: () => unknown, needle: RegExp, label: string): Promise<void> {
  let msg: string | null = null;
  try {
    await fn();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  ok(msg !== null && needle.test(msg), `${label} (got: ${msg ?? "no throw"})`);
}

const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();

const { registerIdentityMapper } = await import("../agent/identity/binding.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
await import("../agent/approvals/flow.js");
await import("../agent/approvals/memory-forget.js");
await import("../agent/approvals/access-request.js");

registerIdentityMapper("teams", (ctx) => {
  const a = ((ctx as { session?: { auth?: { current?: { attributes?: Record<string, string> } } } }).session?.auth?.current?.attributes ?? {}) as Record<string, string>;
  return {
    workspace: a["workspace_id"],
    surface: a["conversation_id"],
    mode: "channel" as const,
    visibility: "private" as const,
    trust: "internal" as const,
    principalId: a["user_id"],
    ...(a["conversation_id"] ? { target: { channelId: a["conversation_id"] } } : {}),
  };
});

const DOMAINS = [
  defineDomain({ name: "eng", channels: ["teams/W1/CONV1", "slack/T1/C_OPS"], memory: "eng-brain" }),
  defineDomain({ name: "lonely", channels: ["teams/W1/CONV_LONE"], memory: "eng-brain" }),
  defineDomain({ name: "slackside", channels: ["slack/T1/C1"], memory: "eng-brain" }),
];

const CONNECTIONS = [{ id: "notion-rest", credentialType: "bearer" as const, secretRef: "NOTION_API_KEY", allowedWebsites: ["api.notion.com"], methods: ["GET" as const] }];
const BUNDLES = [
  { name: "notion", connections: CONNECTIONS },
  { name: "linear-basket", connectors: ["linear"] },
];
const BINDINGS = [{ bundle: "linear-basket", scope: { level: "surface" as const, surface: "slack/T1/C9" } }];

registerConfig({
  loadBundles: () => BUNDLES,
  loadBindings: () => BINDINGS,
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => DOMAINS,
  loadSilos: () => [{ name: "eng-brain", provider: "sqlite" }],
  domainsForSurface: () => [],
  loadAccessRequests: () => ({
    adminChannel: "C_ADMIN",
    configRepo: "acme/agent-config",
    baseBundles: () => BUNDLES,
    baseBindings: () => BINDINGS,
    dryRun: true,
  }),
});

const forgetTool = (await import("../agent/tools/forget.js")).default;
const requestAccessTool = (await import("../agent/tools/request_access.js")).default;
const revokeTool = (await import("../agent/tools/revoke_connector.js")).default;
const clearTool = (await import("../agent/tools/clear_connector_override.js")).default;

type Entry = { execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>> };
async function armed(def: unknown, ctx: unknown, name: string): Promise<Entry> {
  const handler = (def as { events?: Record<string, (e: unknown, c: unknown) => unknown> }).events?.["session.started"];
  const entry = handler ? await handler({}, ctx) : def;
  ok(entry !== null && typeof (entry as Entry).execute === "function", `${name} is MOUNTED on this surface (a null resolver would make every assertion below vacuous)`);
  return entry as Entry;
}

const BULLET = "- 2026-07-01: Ada owns billing";
const MEMORY_MD = `# Memory\n\n## People / ownership\n${BULLET}\n`;
const sandbox = {
  readTextFile: async ({ path }: { path: string }) => (path.endsWith("/MEMORY.md") ? MEMORY_MD : null),
};

const teamsCtx = (conversationId: string) =>
  ({
    channel: { kind: "teams" },
    session: { auth: { current: { attributes: { workspace_id: "W1", conversation_id: conversationId, user_id: "U_ASK" }, principalId: "U_ASK" } } },
    getSandbox: async () => sandbox,
  }) as never;

const slackCtx = (channelId: string) =>
  ({
    channel: { kind: "slack" },
    session: {
      auth: { current: { attributes: { team_id: "T1", channel_id: channelId, channel_type: "channel", trust_checked: "true", user_id: "U_ASK" }, principalId: "U_ASK" } },
    },
    getSandbox: async () => sandbox,
  }) as never;

async function rowOf(pendingId: string): Promise<Record<string, unknown>> {
  const row = await getOperationalStore().getPendingAction("default", pendingId);
  ok(row !== null, `a pending row exists for ${pendingId}`);
  return row as unknown as Record<string, unknown>;
}
async function pendingCount(): Promise<number> {
  return (await getOperationalStore().listPendingActions("default")).length;
}

{
  const out = (await (await armed(forgetTool, teamsCtx("CONV1"), "forget")).execute({ match: "Ada owns billing" }, teamsCtx("CONV1"))) as {
    requested: boolean;
    pendingId: string;
    note: string;
  };
  ok(out.requested === true, "redirect: 🔴 `forget` WORKS from a card-less room — this is the leg OPE-295 item 3 declined to land, because before its prerequisites it would have been unreachable");
  const row = await rowOf(out.pendingId);
  ok(row["channelId"] === "C_OPS", "redirect: the card is posted into the domain's card-capable channel, not the asking room");
  ok(row["postedTo"] === "slack/T1/C_OPS", "redirect: …and `postedTo` is the VENUE's key — the TTL sweep and the decision wake both go looking there, so a stale asking-room key would strand the row");
  ok(row["threadTs"] === null, "redirect: a cross-venue card posts TOP-LEVEL — a thread ts belongs to a different workspace's channel and anchors nothing there");
  ok(row["scopeKey"] === "teams/W1/CONV1", "redirect: the SCOPE stays the asking surface — the card moved, the subject of the decision did not");
  ok(out.note.includes("card posted in slack/T1/C_OPS"), "redirect: the tool result NAMES where the card went");
  ok(
    out.note.includes("tell the user where it is, by name"),
    "redirect: …and instructs the model to relay it — a user who sees no confirmation reads it as 'the agent ignored me', and the card is by construction invisible from here",
  );

  const ra = (await (await armed(requestAccessTool, teamsCtx("CONV1"), "request_access")).execute(
    { kind: "grant-connector", connector: "linear", reason: "triage needs Linear" },
    teamsCtx("CONV1"),
  )) as { requested: boolean; pendingId: string; note: string };
  ok(ra.requested === true, "redirect: 🔴 `request_access` works from a card-less room too");
  const raRow = await rowOf(ra.pendingId);
  ok(raRow["channelId"] === "C_OPS" && raRow["postedTo"] === "slack/T1/C_OPS", "redirect: …with the card in the venue");
  ok(ra.note.includes("card posted in slack/T1/C_OPS") && ra.note.includes("tap it to send the request"), "redirect: …and a relay instruction naming what the person there must DO (not merely that they must do something)");

  const frozen = JSON.parse(raRow["argsJson"] as string) as Record<string, unknown>;
  ok(
    frozen["channelId"] === "CONV1",
    "args-vs-card: 🔴 the frozen args keep the ASKING channel — the bot-PR cites it as 'where this was asked' and the outcome note goes back there, so conflating it with the venue would put the wrong room in a diff an admin reads",
  );
  ok(frozen["scopeKey"] === "teams/W1/CONV1", "args-vs-card: …and the scope being widened is still the asking surface's");

  const rv = (await revokeTool.execute({ connector: "notion", reason: "leaked token" } as never, teamsCtx("CONV1"))) as { pendingId: string; note: string };
  const rvRow = await rowOf(rv.pendingId);
  ok(rvRow["postedTo"] === "slack/T1/C_OPS", "redirect: break-glass `revoke_connector` routes too — an incident does not wait for the responder to move to a chat app they may not be in");
  ok(rv.note.includes("card posted in slack/T1/C_OPS") && rv.note.includes("approve it"), "redirect: …and says where and what next");
  ok(JSON.parse(rvRow["argsJson"] as string).scopeKey === "teams/W1/CONV1", "redirect: …while still revoking the ASKING surface's connector, not the venue's");

  const cl = (await (await armed(clearTool, teamsCtx("CONV1"), "clear_connector_override")).execute({ connector: "notion" }, teamsCtx("CONV1"))) as {
    pendingId: string;
    note: string;
  };
  ok((await rowOf(cl.pendingId))["postedTo"] === "slack/T1/C_OPS", "redirect: …and its clear moves with it — revoke-without-clear is a one-way door");
}

{
  const before = await pendingCount();

  await refuses(
    () => (armed(forgetTool, teamsCtx("CONV_LONE"), "forget") as Promise<Entry>).then((e) => e.execute({ match: "Ada owns billing" }, teamsCtx("CONV_LONE"))),
    /I can't forget that from here.*domain "lonely" has no Slack or Discord channel.*domains\.ts/s,
    "refuse: no card-capable channel in the domain ⇒ refusal naming the DOMAIN and the FILE — an action, never a description of the blockage",
  );
  await refuses(
    () => revokeTool.execute({ connector: "notion", reason: "x" } as never, teamsCtx("CONV_LONE")),
    /I can't revoke that connector from here/,
    "refuse: …and each tool names ITS OWN verb in the refusal",
  );

  await refuses(
    () => (armed(requestAccessTool, teamsCtx("CONV_ORPHAN"), "request_access") as Promise<Entry>).then((e) => e.execute({ kind: "grant-connector", connector: "linear" }, teamsCtx("CONV_ORPHAN"))),
    /I can't request that access from here.*isn't in an explicit domain.*domains\.ts/s,
    "refuse: a channel in NO domain refuses with the other reason — the config change is a different one, and naming the wrong one is how a refusal becomes useless",
  );

  ok(await pendingCount().then((after) => after === before), "refuse: 🔴 NOTHING is minted on any refusal — a card nobody can see is worse than a clear no");
}

{
  const out = (await (await armed(forgetTool, slackCtx("C1"), "forget")).execute({ match: "Ada owns billing" }, slackCtx("C1"))) as {
    pendingId: string;
    note: string;
  };
  const row = await rowOf(out.pendingId);
  ok(row["channelId"] === "C1" && row["postedTo"] === "slack/T1/C1", "unchanged: a card-capable own room hosts its own card — the overwhelmingly common path must not move");
  ok(!out.note.includes("card posted in"), "unchanged: …the note says plain 'card posted', with no venue named");
  ok(
    !out.note.includes("This surface can't host an approval card"),
    "unchanged: 🔴 …and NO redirect sentence is appended — the relay instruction exists for a card the user cannot see, and telling them to go elsewhere for one that is right there is worse than saying nothing",
  );
  ok(/^card posted — forget [0-9a-f]{12}… \(pending [0-9a-f-]{36}\)\.$/.test(out.note), "unchanged: …byte-for-byte the pre-OPE-303 note shape, digest-only (the fact never enters the durable transcript)");
}

rmSync(tmp, { recursive: true, force: true });
console.log(`✓ propose-venue: ${n} assertions passed (card-less redirect for all four propose tools, args-vs-card split, fail-closed refusals, own-room unchanged)`);
