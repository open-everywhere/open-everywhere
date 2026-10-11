import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-webhook-target-surface-test-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });

const { registerSlackTestBridge } = await import("./_slack-test-stubs.js");
const { assertWebhooksValid, defineWebhook } = await import("../agent/webhooks/config.js");
const { parseWebhookTarget } = await import("../agent/webhooks/target.js");
const { fireWebhook, WEBHOOK_TARGET_UNRESOLVED_REASON } = await import("../agent/webhooks/dispatch.js");
const { registerRoutineDispatch } = await import("../agent/schedules/routine-dispatch.js");
const { OE_GRAIN_ATTR } = await import("../agent/channels/unified-window.js");
const { registerSurfaces, defineSurface } = await import("../agent/identity/trust.js");

type FusedWebhookHook = import("../agent/webhooks/config.js").FusedWebhookHook;
type Captured = { readonly channel: unknown; readonly target: unknown; readonly message: unknown; readonly auth?: { attributes?: Record<string, string> } };

function captureReceive(): { calls: Captured[]; to: never } {
  const calls: Captured[] = [];
  const to = (channel: unknown, target: unknown) => ({
    send: (message: unknown, opts: unknown) => {
      calls.push({ channel, target, message, ...(opts as object) } as Captured);
      return Promise.resolve();
    },
  });
  return { calls, to: to as never };
}

function hookFor(target: string): FusedWebhookHook {
  return defineWebhook({
    id: "surface-proof",
    source: "oe-standard-webhook",
    secretRef: "SURFACE_PROOF_WEBHOOK_SECRET",
    broker: "env",
    target,
    readableBy: [{ level: "org" }],
    instruction: "Tell them the deploy finished.",
  });
}

{
  console.log("1. the target grammar:");
  const valid = [
    "slack/T1/C1",
    "slack/T1/D0DM",
    "discord/1300000000000000100/1300000000000000200",
    "teams/tenant-1/19-abc-thread.tacv2",
    "dm:slack/T1/U0PERSON",
    "dm:discord/300000000000000104",
    "dm:teams/29:1abcdef",
  ];
  for (const target of valid) {
    let threw: unknown;
    try {
      assertWebhooksValid([hookFor(target)]);
    } catch (err) {
      threw = err;
    }
    ok(threw === undefined, `valid: ${target} passes assertWebhooksValid (got ${String(threw)})`);
  }
  const invalid: readonly [string, string][] = [
    ["github/owner/repo", 'names platform "github", which has no webhook target resolver'],
    ["slack/T1", "is not a fully-qualified target"],
    ["slack/T1/C 1", "is not a fully-qualified target"],
    ["dm:slack/U0PERSON", "is not a person target"],
    ["dm:linear/abc", 'names platform "linear"'],
    ["dm:", "is not a person target"],
  ];
  for (const [target, expected] of invalid) {
    let message = "";
    try {
      assertWebhooksValid([hookFor(target)]);
    } catch (err) {
      message = String(err);
    }
    ok(message.includes(expected), `invalid: ${JSON.stringify(target)} fails loud at load with "${expected}" (got ${message || "no throw"})`);
  }
  const person = parseWebhookTarget("dm:slack/T1/U0PERSON");
  ok("spec" in person && person.spec.kind === "person" && person.spec.tenant === "T1" && person.spec.principalId === "U0PERSON", "parse: a Slack person target keeps its workspace and member id");
  const teamsPerson = parseWebhookTarget("dm:teams/29:1abcdef");
  ok("spec" in teamsPerson && teamsPerson.spec.kind === "person" && teamsPerson.spec.principalId === "29:1abcdef", "parse: a Teams person target keeps the raw 29: id");
}

const SLACK_CHANNEL = { name: "slack-test-channel" };
const opened: string[] = [];
registerSlackTestBridge({
  channel: SLACK_CHANNEL as never,
  confirmChannelInternal: async () => true,
  form: async (method: string, body: string) => {
    if (method === "users.info") {
      const user = new URLSearchParams(body).get("user") ?? "";
      if (user === "U0NOSCOPE") return { ok: false, error: "missing_scope" };
      if (user === "U0PARTNER") return { ok: true, user: { id: user, team_id: "T0PARTNER", is_stranger: true } };
      if (user === "U0GUEST") return { ok: true, user: { id: user, team_id: "T1", is_restricted: true } };
      return { ok: true, user: { id: user, team_id: "T1" } };
    }
    if (method !== "conversations.open") return { ok: true };
    const users = new URLSearchParams(body).get("users") ?? "";
    opened.push(users);
    if (users === "U0GONE") return { ok: false, error: "user_not_found" };
    return { ok: true, channel: { id: `D0${users}` } };
  },
});

{
  console.log("2. a Slack room fires where it always did:");
  const { calls, to } = captureReceive();
  const result = await fireWebhook(hookFor("slack/T1/C1"), "{}", { to });
  ok(result.fired === true && result.surfaceKey === "slack/T1/C1", `slack room: fired on slack/T1/C1 (got ${JSON.stringify(result)})`);
  ok(calls.length === 1 && calls[0]!.channel === SLACK_CHANNEL, "slack room: posted through the Slack channel");
  ok((calls[0]!.target as { channelId?: string }).channelId === "C1", "slack room: the receive target is the channel id");
  const attrs = calls[0]!.auth?.attributes ?? {};
  ok(attrs["team_id"] === "T1" && attrs["channel_id"] === "C1" && attrs["channel_type"] === "channel", "slack room: the identity attributes are the Slack triple");
  ok(attrs["trust_checked"] === "true", "slack room: a confirmed-internal CHANNEL still stamps internal trust");
}

{
  console.log("3. a Slack PERSON target fires into that person's DM:");
  const { calls, to } = captureReceive();
  const result = await fireWebhook(hookFor("dm:slack/T1/U0PERSON"), "{}", { to });
  ok(opened.includes("U0PERSON"), "slack person: the fire opened the DM with conversations.open");
  ok(result.fired === true && result.surfaceKey === "slack/T1/D0U0PERSON", `slack person: fired on the DM's surface key (got ${JSON.stringify(result)})`);
  ok(calls.length === 1 && (calls[0]!.target as { channelId?: string }).channelId === "D0U0PERSON", "slack person: posted into the D… channel conversations.open returned");
  const attrs = calls[0]!.auth?.attributes ?? {};
  ok(attrs["channel_type"] === "im", "slack person: the fire binds as a DM (channel_type im)");
  ok(attrs[OE_GRAIN_ATTR] === "standing", "slack person: the DM-family STANDING grain is stamped — an unattended DM fire gets no live turn's hands");
  ok(attrs["trust_checked"] === undefined && attrs["is_ext_shared"] === undefined, "🔴 slack person: NO internal-trust stamp, although the channel recheck says internal — a DM partner is unverified on this leg");

  const gone = await fireWebhook(hookFor("dm:slack/T1/U0GONE"), "{}", { to });
  ok(gone.fired === false && (gone.reason ?? "").startsWith(WEBHOOK_TARGET_UNRESOLVED_REASON), `slack person: a DM Slack refuses declines as "target unresolved" (got ${gone.reason})`);
  ok((gone.reason ?? "").includes("user_not_found") && (gone.reason ?? "").includes("im:write"), "slack person: the reason names Slack's error and the fix");

  const opensBefore = opened.length;
  const partner = await fireWebhook(hookFor("dm:slack/T1/U0PARTNER"), "{}", { to });
  ok(partner.fired === false && (partner.reason ?? "").includes('member of workspace "T0PARTNER", not "T1"'), `🔴 slack person: a Slack Connect partner's user named under OUR workspace is refused (got ${partner.reason})`);
  const guest = await fireWebhook(hookFor("dm:slack/T1/U0GUEST"), "{}", { to });
  ok(guest.fired === false && (guest.reason ?? "").includes("is a guest"), `🔴 slack person: a guest of our workspace is refused (got ${guest.reason})`);
  const noScope = await fireWebhook(hookFor("dm:slack/T1/U0NOSCOPE"), "{}", { to });
  ok(noScope.fired === false && (noScope.reason ?? "").includes("users:read"), `slack person: an unconfirmable user is refused, naming the scope (got ${noScope.reason})`);
  ok(opened.length === opensBefore, "🔴 slack person: no DM was opened for any refused person — users.info runs BEFORE conversations.open");
}

{
  console.log("4. a target on a registered provider resolves through its resolver:");
  const CHAT_CHANNEL = { name: "chat-test-channel" };
  registerRoutineDispatch("discord", {
    resolveTarget: (r) => {
      const channelId = typeof r.target?.["channelId"] === "string" ? (r.target["channelId"] as string) : undefined;
      if (!channelId) return null;
      const dm = r.target?.["channelType"] === "1";
      const groupDm = r.target?.["channelType"] === "3";
      return {
        channel: CHAT_CHANNEL as never,
        target: { channelId },
        mode: dm ? "dm" : groupDm ? "mpim" : "channel",
        attributes: { channel_id: channelId, guild_id: r.surfaceKey.split("/")[1] ?? "", ...(dm ? { channel_type: "1" } : {}) },
      };
    },
    resolveDeclaredTarget: async (spec) =>
      spec.kind === "room"
        ? {
            ok: true,
            facts: {
              surfaceKey: `discord/${spec.workspace}/${spec.surface}`,
              target: { channelId: spec.surface, guildId: spec.workspace, ...(spec.surface.startsWith("GDM") ? { channelType: "3" } : {}) },
            },
          }
        : { ok: true, facts: { surfaceKey: `discord/${spec.principalId}/DM-${spec.principalId}`, target: { channelId: `DM-${spec.principalId}`, channelType: "1" } } },
  });

  const undeclared = captureReceive();
  const undeclaredResult = await fireWebhook(hookFor("discord/G1/CH1"), "{}", { to: undeclared.to });
  ok(undeclaredResult.fired === false && (undeclaredResult.reason ?? "").includes("stranger-room floor") && (undeclaredResult.reason ?? "").includes("defineSurface"), `🔴 provider room: an UNDECLARED channel on a roster-less surface is refused, naming the fix (got ${undeclaredResult.reason})`);
  ok(undeclared.calls.length === 0, "…and nothing was sent");
  registerSurfaces([defineSurface({ key: "discord/G1/CH1", trust: "internal" }), defineSurface({ key: "discord/G1/GDM1", trust: "internal" })]);
  const groupDm = captureReceive();
  const groupDmResult = await fireWebhook(hookFor("discord/G1/GDM1"), "{}", { to: groupDm.to });
  ok(groupDmResult.fired === false && (groupDmResult.reason ?? "").includes("group chat"), `🔴 provider room: a group DM is refused EVEN WHEN declared — its members are an ad-hoc set (got ${groupDmResult.reason})`);

  const room = captureReceive();
  const roomResult = await fireWebhook(hookFor("discord/G1/CH1"), "{}", { to: room.to });
  ok(roomResult.fired === true && roomResult.surfaceKey === "discord/G1/CH1", `provider room: fired on discord/G1/CH1 (got ${JSON.stringify(roomResult)})`);
  ok(room.calls.length === 1 && room.calls[0]!.channel === CHAT_CHANNEL, "provider room: posted through the PROVIDER's channel, not Slack's");
  const roomAttrs = room.calls[0]!.auth?.attributes ?? {};
  ok(roomAttrs["guild_id"] === "G1" && roomAttrs["channel_id"] === "CH1" && roomAttrs["team_id"] === undefined, "provider room: the attributes are the provider's own identity bag, not a Slack triple");
  ok(roomAttrs["trust_checked"] === undefined, "provider room: no internal-trust stamp — only a Slack channel can be confirmed");
  ok(roomAttrs[OE_GRAIN_ATTR] === undefined, "provider room: a channel fire stamps no DM grain");

  const dm = captureReceive();
  const dmResult = await fireWebhook(hookFor("dm:discord/300000000000000104"), "{}", { to: dm.to });
  ok(dmResult.fired === true && dmResult.surfaceKey === "discord/300000000000000104/DM-300000000000000104", `provider person: fired on the DM (got ${JSON.stringify(dmResult)})`);
  ok((dm.calls[0]!.target as { channelId?: string }).channelId === "DM-300000000000000104", "provider person: posted into the DM channel the resolver opened");
  ok((dm.calls[0]!.auth?.attributes ?? {})[OE_GRAIN_ATTR] === "standing", "provider person: the resolver's DM mode stamps the standing grain");
}

{
  console.log("5. an unresolvable target declines loudly, through the real route:");
  const { calls, to } = captureReceive();
  const noProvider = await fireWebhook(hookFor("teams/tenant-1/19-abc-thread.tacv2"), "{}", { to });
  ok(noProvider.fired === false && calls.length === 0, "no provider: nothing is sent");
  ok((noProvider.reason ?? "").includes('no provider on this deployment resolves a declared target on "teams"'), `no provider: the reason says which platform has no resolver (got ${noProvider.reason})`);
  ok((noProvider.reason ?? "").includes("register the teams provider bundle"), "no provider: the reason names the fix");

  const FIX = "the bot must receive one message in that conversation first";
  registerRoutineDispatch("teams", {
    resolveTarget: () => null,
    resolveDeclaredTarget: async () => ({ ok: false, reason: FIX }),
  });

  const { registerConfig } = await import("../agent/access/config.js");
  const { readAudit } = await import("../agent/audit/audit.js");
  const sw = await import("../agent/webhooks/oe-standard-webhook.js");
  const secret = `wh-${Math.random().toString(36).slice(2)}`;
  process.env["SURFACE_PROOF_WEBHOOK_SECRET"] = secret;
  const hook = hookFor("teams/tenant-1/19-abc-thread.tacv2");
  registerConfig({
    loadWebhooks: () => [hook],
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });
  const { default: webhooksChannel } = await import("../agent/channels/webhooks.js");
  const route = webhooksChannel.routes[0] as { handler: (req: Request, args: unknown) => Promise<Response> };
  const body = JSON.stringify({ note: "unresolvable" });
  const ts = String(Math.floor(Date.now() / 1000));
  const req = new Request("http://localhost/webhooks/surface-proof", {
    method: "POST",
    headers: { "webhook-id": "msg_unresolved", "webhook-timestamp": ts, "webhook-signature": sw.standardWebhookSignature(secret, "msg_unresolved", ts, body), "content-type": "application/json" },
    body,
  });
  const pending: Promise<unknown>[] = [];
  const res = await route.handler(req, { to: captureReceive().to, waitUntil: (p: Promise<unknown>) => void pending.push(p), params: { id: "surface-proof" } } as never);
  ok(res.status === 200, `route: the signed delivery is accepted (got ${res.status})`);
  await Promise.all(pending);
  const rows = await readAudit({ org: "acme", action: "webhook.declined", limit: 50 });
  const row = rows.find((r) => (r.detail as { hookId?: string } | undefined)?.hookId === "surface-proof");
  ok(row !== undefined, "🔴 route: an unresolvable target writes a webhook.declined audit row — never a silent drop");
  const reason = String((row?.detail as { reason?: unknown } | undefined)?.reason ?? "");
  ok(reason.startsWith(WEBHOOK_TARGET_UNRESOLVED_REASON) && reason.includes(FIX), `route: the row carries the resolver's fix (got ${reason})`);
  ok(row?.platform === "teams", `route: the row names the target's platform (got ${row?.platform})`);
}

{
  console.log("6. a Slack target in a workspace other than the one config names is refused before any call:");
  const { registerConfig } = await import("../agent/access/config.js");
  const { defineDomain } = await import("../agent/memory/domain.js");
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "eng", reach: ["slack/T1/C1"] })],
    loadSilos: () => [],
    domainsForSurface: () => [],
  });
  const { calls, to } = captureReceive();
  const opensBefore = opened.length;
  const room = await fireWebhook(hookFor("slack/T9/C9"), "{}", { to });
  ok(room.fired === false && (room.reason ?? "").includes('this deployment\'s Slack app serves "T1"'), `slack room in T9: refused, naming the served workspace (got ${room.reason})`);
  const person = await fireWebhook(hookFor("dm:slack/T9/U0ELSEWHERE"), "{}", { to });
  ok(person.fired === false && (person.reason ?? "").includes('"T9"'), `slack person in T9: refused (got ${person.reason})`);
  ok(calls.length === 0 && opened.length === opensBefore, "nothing was sent, and no DM was opened");
  const home = await fireWebhook(hookFor("slack/T1/C1"), "{}", { to });
  ok(home.fired === true, "control: a target in T1 still fires");
}

await removeTempDir(dir);
console.log(`✓ webhook-target-surface: ${passed} assertions passed`);
