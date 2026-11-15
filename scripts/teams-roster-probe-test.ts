import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-teams-roster-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

import { parseTeamsActivity, type TeamsMessageActivity } from "eve/channels/teams";
import {
  resolveTeamsUserType,
  teamsRosterMemberPath,
  teamsServiceUrlRosterProbe,
  teamsHandleRosterProbe,
  teamsIsHomeTenant,
  _resetTeamsUserTypeCacheForTest,
  type TeamsRosterProbe,
} from "@open-everywhere/provider-teams/agent/channels/teams-roster.js";
import {
  liveTeamsDispatch,
  liveTeamsDmDivert,
  liveTeamsExternalGate,
  type TeamsFrontPlan,
} from "@open-everywhere/provider-teams/agent/channels/teams-front.js";
import { buildTeamsAuth, type OpenEverywhereTeamsAuth } from "@open-everywhere/provider-teams/agent/channels/teams-identity.js";
import { planTeamsSingleWindow } from "@open-everywhere/provider-teams/agent/channels/teams-supervisor.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
import { teamsSeatCatchUpFetch } from "@open-everywhere/provider-teams/agent/channels/teams-catch-up.js";
import { _resetTeamsGraphTeamIdCache, _seedTeamsGraphTeamIdForTest } from "@open-everywhere/provider-teams/agent/channels/teams-graph-team-id.js";
import { registerSeatCatchUp, _resetSeatCatchUp, type SeatCatchUpRequest } from "@open-everywhere/core/agent/channels/seat-catch-up.js";
import { resolvePartition, domainKeyOf } from "@open-everywhere/core/agent/memory/partition.js";
import { supervisorGrainFor, effectiveEveToken, UNIFIED_CHANNEL_NAME } from "@open-everywhere/core/agent/channels/unified-supervisor.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { seedTailWindow, tailWindowFor } from "@open-everywhere/core/agent/channels/session-tail-record.js";
import { recordLandedPost, type ReplyAudit } from "@open-everywhere/core/agent/channels/reply-post.js";
import { unifiedEditLocus } from "@open-everywhere/core/agent/channels/unified-reply.js";
import { refuseIfShouldFold, REPLY_FOLD_REFUSAL_REASON } from "@open-everywhere/core/agent/channels/reply-fold.js";
import { readAudit } from "@open-everywhere/core/agent/audit/audit.js";
import { OE_CHAT_NONMEMBER_ATTR } from "@open-everywhere/core/agent/identity/non-member.js";
import { registerConfig, defineDomain } from "@open-everywhere/core/agent/adapter-api.js";
import type { UnifiedReceiveTarget } from "@open-everywhere/core/agent/channels/unified.js";
import type { RouteHandlerArgs } from "eve/channels";
import { _setDeploymentIdentityForTest } from "@open-everywhere/core/agent/identity/deployment-identity.js";

registerTeamsProvider();

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, `${label}\n  actual:   ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
  n++;
};

{
  const path = teamsRosterMemberPath("19:conv@thread.v2", "29:guest/one");
  ok(
    path.startsWith("/v3/conversations/"),
    `🔴 the roster path LEADS WITH A SLASH — eve composes trimTrailingSlash(serviceUrl)+path, so a slashless path builds ".../emeav3/conversations/…" and the probe fails open on every call. Got: ${path}`,
  );
  eq(
    path,
    "/v3/conversations/19%3Aconv%40thread.v2/members/29%3Aguest%2Fone",
    "…and both segments are percent-encoded — a Teams id carries colons, and a user id can carry a slash",
  );
  eq(teamsServiceUrlRosterProbe(undefined), undefined, "no serviceUrl ⇒ NO probe (there is nothing to address), not a probe that throws later");
  ok(typeof teamsServiceUrlRosterProbe("https://smba.trafficmanager.net/emea/") === "function", "negative control: a serviceUrl DOES yield a probe (=== function)");
  eq(
    teamsServiceUrlRosterProbe("https://attacker.example/"),
    undefined,
    "🔴 an UNTRUSTED serviceUrl host gives NO probe (OPE-2446 review) — the GET carries the bot token, and a member answer can now verify a DM partner",
  );
  eq(teamsServiceUrlRosterProbe("http://smba.trafficmanager.net/emea/"), undefined, "…and so does a non-https Bot Connector URL");

  {
    const calls: { path: string; body: unknown; method: string | undefined }[] = [];
    const handle = {
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      request: async (path: string, body: unknown, options?: { method?: string }) => {
        calls.push({ path, body, method: options?.method });
        return { ok: true, status: 200, body: {} };
      },
    };
    const probe = teamsHandleRosterProbe(handle as Parameters<typeof teamsHandleRosterProbe>[0]);
    assert.ok(probe, "a handle on a trusted Bot Connector host yields a probe");
    void (await probe("/v3/conversations/c/members/u"));
    eq(calls.length, 1, "the handle probe issues exactly one request");
    eq(calls[0].method, "GET", "…as a GET");
    eq(calls[0].body, undefined, "🔴 …with NO body — a defined body (even {}) makes fetch throw on GET and the probe silently fails open");
    eq(
      teamsHandleRosterProbe({ ...handle, serviceUrl: "https://attacker.example/" } as Parameters<typeof teamsHandleRosterProbe>[0]),
      undefined,
      "🔴 a NATIVE handle on an UNTRUSTED serviceUrl host gives NO probe (OPE-2446 review) — eve sends the bot token to the body's host",
    );
    eq(
      await resolveTeamsUserType(
        teamsHandleRosterProbe({ ...handle, serviceUrl: "https://attacker.example/" } as Parameters<typeof teamsHandleRosterProbe>[0]),
        "19:untrusted-host@thread.v2",
        "29:untrusted-host-user",
      ),
      undefined,
      "…so the resolver gets no verdict for that handle",
    );
    eq(calls.length, 1, "…and the untrusted handle issued NO request (still the one call above)");
  }
}

function scriptProbe(answer: { ok: boolean; body: unknown } | (() => never)): { probe: TeamsRosterProbe; paths: string[] } {
  const paths: string[] = [];
  const probe: TeamsRosterProbe = async (path) => {
    paths.push(path);
    if (typeof answer === "function") answer();
    return answer as { ok: boolean; body: unknown };
  };
  return { probe, paths };
}

{
  _resetTeamsUserTypeCacheForTest();
  const guest = scriptProbe({ ok: true, body: { id: "29:g", userRole: "guest" } });
  eq(await resolveTeamsUserType(guest.probe, "19:c1", "29:g"), "guest", "a roster record with userRole 'guest' resolves GUEST — the measured B2B-guest answer");
  eq(guest.paths.length, 1, "…with exactly ONE connector call");

  _resetTeamsUserTypeCacheForTest();
  const member = scriptProbe({ ok: true, body: { id: "29:m", userRole: "user" } });
  eq(await resolveTeamsUserType(member.probe, "19:c1", "29:m"), "member", "negative control: userRole 'user' resolves MEMBER — the measured tenant-member answer, and NOT a guest");

  _resetTeamsUserTypeCacheForTest();
  const empty = scriptProbe({ ok: true, body: { id: "29:x" } });
  eq(await resolveTeamsUserType(empty.probe, "19:c1", "29:x"), undefined, "a record with NO role field is no verdict — absence of evidence is not evidence");

  _resetTeamsUserTypeCacheForTest();
  const http = scriptProbe({ ok: false, body: { error: "forbidden" } });
  eq(await resolveTeamsUserType(http.probe, "19:c1", "29:x"), undefined, "an HTTP error is no verdict (fail open) — a bot that cannot read the roster must not take the surface off the air");

  _resetTeamsUserTypeCacheForTest();
  const thrown = scriptProbe(() => {
    throw new Error("ECONNRESET");
  });
  eq(await resolveTeamsUserType(thrown.probe, "19:c1", "29:x"), undefined, "a transport THROW is no verdict (fail open)");

  _resetTeamsUserTypeCacheForTest();
  const unused = scriptProbe({ ok: true, body: { userRole: "guest" } });
  eq(await resolveTeamsUserType(undefined, "19:c1", "29:g"), undefined, "NO probe ⇒ no verdict");
  eq(await resolveTeamsUserType(unused.probe, undefined, "29:g"), undefined, "no conversation id ⇒ no verdict (nothing to key on)");
  eq(await resolveTeamsUserType(unused.probe, "19:c1", undefined), undefined, "no user id ⇒ no verdict");
  eq(unused.paths.length, 0, "…and none of those three reached the connector at all");
}

{
  _resetTeamsUserTypeCacheForTest();
  const first = scriptProbe({ ok: true, body: { userRole: "guest" } });
  const second = scriptProbe({ ok: true, body: { userRole: "user" } });
  eq(await resolveTeamsUserType(first.probe, "19:cache", "29:u"), "guest", "first lookup answers from the connector");
  eq(await resolveTeamsUserType(second.probe, "19:cache", "29:u"), "guest", "🔴 the SECOND lookup is served from the TTL cache — this is what keeps the probe off the per-message hot path");
  eq(second.paths.length, 0, "…and the second probe was never called (=== 0 connector calls)");
  eq(await resolveTeamsUserType(second.probe, "19:cache", "29:OTHER"), "member", "negative control: a DIFFERENT user is a different cache key and DOES call the connector");

  _resetTeamsUserTypeCacheForTest();
  eq(await resolveTeamsUserType(second.probe, "19:cache", "29:u"), "member", "the reset seam drops the cached verdicts — a fresh test never inherits another's");
}

{
  _resetTeamsUserTypeCacheForTest();
  const CHAN = "19:chan-x@thread.tacv2";
  const first = scriptProbe({ ok: true, body: { userRole: "guest" } });
  const second = scriptProbe({ ok: true, body: { userRole: "user" } });
  eq(await resolveTeamsUserType(first.probe, `${CHAN};messageid=100`, "29:u"), "guest", "(a) the first reply chain answers from the connector");
  eq(
    await resolveTeamsUserType(second.probe, `${CHAN};messageid=200`, "29:u"),
    "guest",
    "🔴 (b) OPE-572: a DIFFERENT reply chain in the SAME channel is served from the cache — keyed on the raw id this was a second connector call, and it would have answered 'member'",
  );
  eq(second.paths.length, 0, "(b) …the second probe never reached the connector (=== 0 calls)");
  eq(first.paths.length, 1, "(b) …so ONE connector call now covers both reply chains (=== 1 call in total)");

  eq(
    first.paths[0],
    teamsRosterMemberPath(`${CHAN};messageid=100`, "29:u"),
    "🔴 (c) NEGATIVE CONTROL: the connector call still carries the UNSTRIPPED reply-chain id — the wire shape did not change",
  );
  ok(
    first.paths[0]!.includes(encodeURIComponent(";messageid=100")),
    `(c) …and the suffix really is on the wire, so the equality above is not comparing two already-stripped ids. Got: ${first.paths[0]}`,
  );

  const other = scriptProbe({ ok: true, body: { userRole: "user" } });
  eq(await resolveTeamsUserType(other.probe, "19:chan-y@thread.tacv2;messageid=100", "29:u"), "member", "🔴 (d) NEGATIVE CONTROL: a DIFFERENT channel is a different cache key and DOES call the connector");
  eq(other.paths.length, 1, "(d) …(=== 1 call)");

  _resetTeamsUserTypeCacheForTest();
  const dm = scriptProbe({ ok: true, body: { userRole: "guest" } });
  eq(await resolveTeamsUserType(dm.probe, "19:1on1-x@thread.v2", "29:u"), "guest", "(e) a suffix-less DM conversation id still resolves");
  eq(dm.paths[0], teamsRosterMemberPath("19:1on1-x@thread.v2", "29:u"), "(e) …and reaches the connector unchanged");
}

{
  _resetTeamsUserTypeCacheForTest();
  const blip = scriptProbe({ ok: false, body: null });
  eq(await resolveTeamsUserType(blip.probe, "19:blip", "29:u"), undefined, "a failed lookup answers nothing");
  const recovered = scriptProbe({ ok: true, body: { userRole: "guest" } });
  eq(await resolveTeamsUserType(recovered.probe, "19:blip", "29:u"), "guest", "🔴 …and the NEXT call retries — only a positive verdict is cached");
  eq(recovered.paths.length, 1, "…so the retry really did reach the connector (=== 1 call)");
}

const SERVICE_URL = "https://smba.trafficmanager.net/emea/";
const TENANT = "TENANT-R";
const CONVERSATION = "19:chan-r@thread.tacv2;messageid=170001";
const CHANNEL = "19:chan-r@thread.tacv2";
const TEAM = "TEAM-R";
const AUTHOR = "29:example-owner";

function channelActivity(
  over: {
    readonly id?: string;
    readonly text?: string;
    readonly from?: { id: string; name: string; aadObjectId: string };
    readonly noChannelData?: true;
    readonly ambient?: true;
  } = {},
): TeamsMessageActivity {
  const parsed = parseTeamsActivity({
    type: "message",
    id: over.id ?? "act-r-1",
    serviceUrl: SERVICE_URL,
    from: over.from ?? { id: AUTHOR, name: "example-owner", aadObjectId: "a0d00000-0000-4000-8000-00000000a0d1" },
    recipient: { id: "28:bot" },
    conversation: { id: CONVERSATION, conversationType: "channel", tenantId: TENANT },
    channelData: over.noChannelData ? { team: { id: TEAM } } : { channel: { id: CHANNEL, membershipType: "standard" }, team: { id: TEAM } },
    text: over.text ?? "hello, what can you do?",
    isBotMentioned: over.ambient !== true,
  });
  assert.ok(parsed && parsed.type === "message", "fixture must parse as a message activity");
  return parsed as TeamsMessageActivity;
}

function captureFor(a: TeamsMessageActivity): OpenEverywhereTeamsAuth {
  return buildTeamsAuth({
    userId: a.from.id,
    ...(a.from.aadObjectId ? { aadObjectId: a.from.aadObjectId } : {}),
    ...(a.from.name ? { userName: a.from.name } : {}),
    tenantId: a.tenantId ?? a.conversation.tenantId,
    conversationId: a.conversation.id,
    ...(a.teamsChannelId ? { channelId: a.teamsChannelId } : {}),
    ...(a.teamId ? { teamId: a.teamId } : {}),
    ...(a.serviceUrl ? { serviceUrl: a.serviceUrl } : {}),
    ...(a.scope ? { scope: a.scope } : {}),
    membershipType: "standard",
  });
}

interface Received {
  message: string;
  target: UnifiedReceiveTarget;
  auth: { attributes?: Record<string, unknown> };
}

function captureTo(received: Received[]): RouteHandlerArgs["to"] {
  return ((_ch: unknown, target: unknown) => ({
    async send(message: string, options: { auth: unknown }) {
      received.push({ message, target: target as UnifiedReceiveTarget, auth: options.auth as Received["auth"] });
      return {} as never;
    },
  })) as unknown as RouteHandlerArgs["to"];
}

async function driveWake(input: {
  readonly id?: string;
  readonly text?: string;
  readonly from?: { id: string; name: string; aadObjectId: string };
  readonly noChannelData?: true;
  readonly probe?: TeamsRosterProbe | undefined;
  readonly ambient?: true;
  readonly threadEngaged?: true;
}): Promise<{ readonly received: Received; readonly partition: ReturnType<typeof resolvePartition>; readonly wakeId: string }> {
  _resetTeamsUserTypeCacheForTest();
  const a = channelActivity(input);
  const auth = captureFor(a);
  const partition = resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
  const surfaceKey = domainKeyOf(partition);
  const window = planTeamsSingleWindow(
    true,
    input.ambient !== true,
    { scope: "channel", membershipType: "standard", tenantId: TENANT, vouched: true },
    { serviceUrl: SERVICE_URL, conversationId: CONVERSATION, tenantId: TENANT },
  );
  assert.ok(window, "the fixture must mint a window (a mention or a plain message on a vouched standard channel)");
  const plan: TeamsFrontPlan = {
    window,
    surfaceKey,
    partition,
    grain: supervisorGrainFor(surfaceKey, []),
    auth,
    ...(input.threadEngaged ? { threadEngaged: true } : {}),
  };
  const received: Received[] = [];
  await liveTeamsDispatch(a, plan, captureTo(received), () => input.probe, async () => false);
  assert.equal(received.length, 1, "exactly one dispatch into the unified channel");
  return { received: received[0]!, partition, wakeId: window.wakeId };
}

async function runChannel(probe: TeamsRosterProbe | undefined): Promise<Received> {
  return (await driveWake({ probe })).received;
}

{
  const guest = await runChannel(scriptProbe({ ok: true, body: { userRole: "guest" } }).probe);
  const ga = guest.auth.attributes ?? {};
  eq(
    ga["user_type"],
    "guest",
    "🔴 THE FIX: the shared-window path resolves the roster verdict and the auth the SESSION binds with carries user_type='guest'",
  );
  ok(
    guest.message.includes('trust="unauth"'),
    `🔴 …so the wake renders the guest BELOW peer — the live-proof defect was a real B2B guest rendering trust="peer". Got: ${guest.message.slice(0, 400)}`,
  );
  eq(ga[OE_CHAT_NONMEMBER_ATTR], "true", "…and the OPE-489 author leg answers: the refuted author marks the wake non-member, with no change of its own");

  const silent = await runChannel(scriptProbe({ ok: false, body: null }).probe);
  const sa = silent.auth.attributes ?? {};
  eq(sa["user_type"], undefined, "🔴 NEGATIVE CONTROL: a probe that cannot answer leaves user_type ABSENT — fail-open, byte-identical to a deployment with no probe");
  ok(
    silent.message.includes('trust="principal"') && !silent.message.includes('trust="unauth"'),
    `🔴 …and the same author on the same channel is VOUCHED without the refutation — so the assertion above measures the ROSTER, not the fixture. Got: ${silent.message.slice(0, 400)}`,
  );
  eq(sa[OE_CHAT_NONMEMBER_ATTR], undefined, "…and the author leg contributes NO non-member mark (=== absent)");

  const none = await runChannel(undefined);
  eq((none.auth.attributes ?? {})["user_type"], undefined, "no probe at all (no serviceUrl) is the same fail-open outcome");

  const gKeys = Object.keys(guest.auth.attributes ?? {}).filter((k) => k !== "user_type" && k !== OE_CHAT_NONMEMBER_ATTR).sort();
  const sKeys = Object.keys(silent.auth.attributes ?? {}).sort();
  eq(gKeys, sKeys, "🔴 the probe adds user_type (and the taint mark it earns) and NOTHING else — no other attribute moves");
}

{
  const auth = captureFor(channelActivity());
  const partition = resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
  const grain = supervisorGrainFor(domainKeyOf(partition), []);
  const store = getOperationalStore();
  const session = await store.getChannelSession(partition.org, grain.registryKey);
  ok(session !== undefined && session !== null, "2b precondition: the dispatches above created the generation row this ring hangs off");
  const ring = await store.readSessionTail(partition.org, grain.registryKey, session!.token);
  const wakes = ring.filter((e) => e.kind === "wake");
  ok(wakes.length > 0, "2b precondition: the REAL front recorded its delivered wakes on that generation's ring");
  eq(
    [...new Set(wakes.map((e) => e.container))],
    [partition.surfaceKey],
    "🔴 2b: every wake row the REAL liveTeamsDispatch filed carries partition.surfaceKey — the same container a POST files under, so the fold policy can see the room's own messages",
  );
  ok(
    domainKeyOf(partition) !== partition.surfaceKey,
    "🔴 2b/CONTROL: the domain key and the surface key really are different strings on this Teams fixture — so the assertion above is a measurement, not a tautology",
  );
}

const nodeRequire = createRequire(import.meta.url);
const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
const eveAbs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(eveAbs("dist/src/context/container.js"));
const { SessionKey } = await import(eveAbs("dist/src/context/keys.js"));
function newTurn(turnId: string): <T>(fn: () => Promise<T>) => Promise<T> {
  const c = new ContextContainer();
  c.set(SessionKey, { sessionId: `teams-roster-probe-${turnId}`, auth: null, turn: 1, parent: undefined });
  return <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(c, fn);
}

{
  const store = getOperationalStore();
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
  const POST_ID = "1772534450913";

  const first = await driveWake({ id: "act-2c-1", text: "what is the status of the migration?" });
  const partition = first.partition;
  const grain = supervisorGrainFor(domainKeyOf(partition), []);
  const session = await store.getChannelSession(partition.org, grain.registryKey);
  ok(session !== undefined && session !== null, "2c precondition: the front's dispatch has a generation row to hang a ring off");

  const turnPartition = resolvePartition({
    channel: { kind: "channel:unified" },
    session: { auth: { current: first.received.auth } },
  } as unknown as Parameters<typeof resolvePartition>[0]);
  ok(
    turnPartition.surfaceKey === partition.surfaceKey && domainKeyOf(turnPartition) === domainKeyOf(partition),
    `🔴 2c: the auth eve hands the TURN resolves the same conversation the ingress dispatch resolved — both grains. Got ${turnPartition.surfaceKey} / ${domainKeyOf(turnPartition)} vs ${partition.surfaceKey} / ${domainKeyOf(partition)}`,
  );
  const window = tailWindowFor({
    org: turnPartition.org,
    domainKey: domainKeyOf(turnPartition),
    surfaceKey: turnPartition.surfaceKey,
    rawToken: effectiveEveToken(UNIFIED_CHANNEL_NAME, first.received.target.token),
    platform: "teams",
  });
  ok(window !== null, "2c precondition: the generation token classifies as a STANDING seat, so this turn files its posts on a ring");
  ok(window!.registryKey === grain.registryKey, "2c precondition: the turn's window reads the SAME ring the front wrote to");
  ok(
    window!.token === session!.token,
    `🔴 2c: the generation the TURN derives from eve's continuation token IS the one the front recorded under — the other half of the ingress/turn join. Got ${String(window!.token)} vs ${String(session!.token)}`,
  );

  const locus = unifiedEditLocus(first.received.target.origin as unknown as Parameters<typeof unifiedEditLocus>[0]);
  ok(locus !== null, "2c precondition: a Teams conversation has an editable address, so the policy has somewhere to steer an edit");

  const auditFor = (turnId: string): ReplyAudit => ({
    org: partition.org,
    platform: partition.platform,
    workspace: partition.workspace,
    surface: partition.surface,
    wakeId: first.wakeId,
    turnId,
    route: "tool",
  });
  const foldRefusals = async (): Promise<number> =>
    (await readAudit({ org: partition.org, action: "reply.refused" })).filter(
      (r) => ((r.detail ?? {}) as Record<string, unknown>)["reason"] === REPLY_FOLD_REFUSAL_REASON,
    ).length;
  const forcedRows = async (): Promise<number> => (await readAudit({ org: partition.org, action: "reply.forced" })).length;
  const attemptSecondPost = async (turnId: string): Promise<string | undefined> =>
    newTurn(turnId)(async () => {
      try {
        await refuseIfShouldFold({
          store,
          window,
          platform: "teams",
          locus,
          turnId,
          audit: auditFor(turnId),
          answeringWake: first.wakeId,
          force: false,
        });
        return undefined;
      } catch (e) {
        return String(e);
      }
    });

  await tick();
  await newTurn("post")(async () => {
    seedTailWindow(window);
    await recordLandedPost({
      org: partition.org,
      editLocus: locus,
      messageId: POST_ID,
      body: "the migration finished at 19:20.",
      platform: "teams",
      wake: first.wakeId,
    });
  });

  await tick();
  const beforeControl = await foldRefusals();
  const control = await attemptSecondPost("teams-2c-control");
  ok(
    control !== undefined && control.includes("edit_reply"),
    `🔴 2c/CONTROL: with nothing said since, the policy DOES refuse a second post on this REAL ring — so the leg below measures the human message, not an inert policy. Got: ${String(control)}`,
  );
  ok((await foldRefusals()) === beforeControl + 1, "2c/CONTROL: …and the refusal wrote its `should-be-edit` row");

  await tick();
  const human = await driveWake({
    id: "act-2c-2",
    text: "just a note for the humans in this thread",
    from: { id: "29:someone-else", name: "someone else", aadObjectId: "0f1d4b6a-2c3e-4a5b-8c7d-9e0f1a2b3c4d" },
  });
  ok(human.partition.surfaceKey === partition.surfaceKey, "2c: the second activity is the SAME conversation — one chain, one room");
  const ring = await store.readSessionTail(partition.org, window!.registryKey, window!.token);
  ok(
    ring.some((e) => e.kind === "post" && e.id === POST_ID),
    "2c precondition: the seat's post is STILL on the ring the next attempt reads — the human message did not rotate the generation out from under it",
  );

  await tick();
  const beforeSecond = await foldRefusals();
  const forcedBefore = await forcedRows();
  const second = await attemptSecondPost("teams-2c-second");
  ok(
    second === undefined,
    `🔴 2c: post → human message in the same chain → second post is NOT refused. This is a live run's shape, driven through the REAL Teams front. Got: ${String(second)}`,
  );
  ok((await foldRefusals()) === beforeSecond, "🔴 2c/AUDIT: and NO new `should-be-edit` row — the refusal did not happen quietly");
  ok(
    (await forcedRows()) === forcedBefore,
    "🔴 2c/AUDIT: and NO `reply.forced` row — nothing pushed the seat to force past a verdict, which is what the 15-minute a live run runaway did",
  );
}

{
  const GRAPH_TEAM = "11111111-2222-3333-4444-555555555555";
  const seen: SeatCatchUpRequest[] = [];
  _seedTeamsGraphTeamIdForTest(TEAM, GRAPH_TEAM);
  registerSeatCatchUp("teams", async (req) => {
    seen.push(req);
    return [];
  });
  try {
    const woken = await driveWake({ id: "act-2d-1", text: "anything new while I was away?" });
    ok(seen.length === 1, `🔴 2d: the REAL front's wake ran the seat catch-up exactly once (an ongoing generation, a resolved Graph team). Got ${seen.length}`);
    const req = seen[0]!;
    eq(
      req.threadRoot,
      "170001",
      "🔴 2d/OPE-1817: the read NAMES the reply chain this wake sits in — the `;messageid=` root of the conversation, on an activity that carries NO replyToId. Without it the read is the channel alone, whose Graph endpoint holds no replies at all, and the seat reads an empty room that spoke",
    );
    eq(req.container, `${GRAPH_TEAM}/${CHANNEL}`, "🔴 2d: …and the container is the GRAPH team id plus the CHANNEL grain — never the reply-chain id, which Graph has no channel by that name for");
    eq(req.channelKey, domainKeyOf(woken.partition), "2d: the read carries the domain-grain channel key, so the row it writes is attributable to this surface");

    seen.length = 0;
    await driveWake({ id: "act-2d-2", text: "first, to open the generation", noChannelData: true });
    await driveWake({ id: "act-2d-3", text: "second, the one that reads", noChannelData: true });
    ok(seen.length === 1, `🔴 2d/fallback: the first wake opened the generation and the second read a catch-up. Got ${seen.length}`);
    eq(
      seen[0]!.container,
      `${GRAPH_TEAM}/${CHANNEL}`,
      "🔴 2d/OPE-1817: an activity with NO `channelData.channel` still addresses Graph at the CHANNEL grain — the conversation id's reply-chain suffix is stripped, never handed to a `/channels/{id}` url",
    );
    ok(!seen[0]!.container.includes(";messageid="), "🔴 2d/fallback CONTROL: …and the container carries no reply-chain suffix — the half that used to make the URL a 404");
  } finally {
    _resetSeatCatchUp("teams");
    registerSeatCatchUp("teams", teamsSeatCatchUpFetch);
    _resetTeamsGraphTeamIdCache();
  }
}

const DM_CONVERSATION = "19:1on1-r@thread.v2";

function dmActivity(): TeamsMessageActivity {
  const parsed = parseTeamsActivity({
    type: "message",
    id: "act-r-dm",
    serviceUrl: SERVICE_URL,
    from: { id: AUTHOR, name: "example-owner" },
    recipient: { id: "28:bot" },
    conversation: { id: DM_CONVERSATION, conversationType: "personal", tenantId: TENANT },
    text: "hello!!",
  });
  assert.ok(parsed && parsed.type === "message", "fixture must parse as a message activity");
  return parsed as TeamsMessageActivity;
}

async function runDm(probe: TeamsRosterProbe | undefined): Promise<Received> {
  _resetTeamsUserTypeCacheForTest();
  const a = dmActivity();
  const auth = buildTeamsAuth({
    userId: a.from.id,
    ...(a.from.name ? { userName: a.from.name } : {}),
    tenantId: a.tenantId ?? a.conversation.tenantId,
    conversationId: a.conversation.id,
    ...(a.serviceUrl ? { serviceUrl: a.serviceUrl } : {}),
    ...(a.scope ? { scope: a.scope } : {}),
  });
  const partition = resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
  const received: Received[] = [];
  await liveTeamsDmDivert(a, auth, partition, captureTo(received), () => probe);
  assert.equal(received.length, 1, "exactly one dispatch into the DM window");
  return received[0]!;
}

{
  const guest = await runDm(scriptProbe({ ok: true, body: { userRole: "guest" } }).probe);
  eq(
    (guest.auth.attributes ?? {})["user_type"],
    "guest",
    "🔴 THE FIX, SECOND PATH: the OPE-357 DM divert resolves the roster verdict too — a guest DM no longer binds internal by default",
  );
  eq((guest.auth.attributes ?? {})[OE_CHAT_NONMEMBER_ATTR], "true", "🔴 …and the DM's author leg marks the wake non-member — a DM carries NO room leg, so this IS the author leg answering");

  const silent = await runDm(scriptProbe({ ok: false, body: null }).probe);
  eq((silent.auth.attributes ?? {})["user_type"], undefined, "🔴 NEGATIVE CONTROL: an unanswerable probe leaves the DM capture byte-identical");
  eq((silent.auth.attributes ?? {})[OE_CHAT_NONMEMBER_ATTR], undefined, "🔴 …and contributes NO non-member mark (=== absent) — so the mark above measures the ROSTER, not the fixture");

  ok(guest.message.includes('trust="unauth"'), `a guest DM renders unauth. Got: ${guest.message.slice(0, 300)}`);
  ok(silent.message.includes('trust="unauth"'), `…and so does an unrefuted DM partner — the DM tier is NOT the signal here. Got: ${silent.message.slice(0, 300)}`);

  eq((await runDm(undefined)).auth.attributes?.["user_type"], undefined, "no probe at all is the same fail-open outcome on the DM path");
}

{
  const saved = { ms: process.env.MICROSOFT_TENANT_ID, teams: process.env.TEAMS_TENANT_ID };
  const setHome = (v: string | undefined): void => {
    delete process.env.TEAMS_TENANT_ID;
    if (v === undefined) delete process.env.MICROSOFT_TENANT_ID;
    else process.env.MICROSOFT_TENANT_ID = v;
  };
  const member = () => scriptProbe({ ok: true, body: { userRole: "user" } }).probe;
  try {
    setHome(TENANT.toLowerCase());
    const home = await runDm(member());
    eq((home.auth.attributes ?? {})["user_type"], "member", "3b: the DM partner's roster verdict is `member`");
    eq((home.auth.attributes ?? {})["tenant_home"], "true", "🔴 3b: the live DM divert stamps `tenant_home` beside a member verdict in the HOME tenant");
    ok(
      !home.message.includes('trust="unauth"'),
      `🔴 3b: a roster-verified MEMBER of the home tenant is a VERIFIED DM partner — the DM no longer fails closed to unauth. Got: ${home.message.slice(0, 300)}`,
    );

    setHome("TENANT-SOMEONE-ELSE");
    const foreign = await runDm(member());
    eq((foreign.auth.attributes ?? {})["user_type"], "member", "3b negative control: the roster still says `member`…");
    eq((foreign.auth.attributes ?? {})["tenant_home"], undefined, "…but no `tenant_home` stamp — this is not the deployment's tenant");
    ok(foreign.message.includes('trust="unauth"'), `🔴 3b: a member of a FOREIGN tenant is NOT a verified DM partner — it stays unauth. Got: ${foreign.message.slice(0, 300)}`);

    setHome(undefined);
    const unset = await runDm(member());
    eq((unset.auth.attributes ?? {})["tenant_home"], undefined, "3b: with no home tenant configured there is no `tenant_home` stamp");
    ok(unset.message.includes('trust="unauth"'), `🔴 3b: …and the DM fails closed to unauth, exactly as before OPE-2446. Got: ${unset.message.slice(0, 300)}`);

    setHome(TENANT);
    const homeGuest = await runDm(scriptProbe({ ok: true, body: { userRole: "guest" } }).probe);
    eq((homeGuest.auth.attributes ?? {})["tenant_home"], undefined, "3b: a guest verdict carries no `tenant_home` stamp, even in the home tenant");
    ok(homeGuest.message.includes('trust="unauth"'), `🔴 3b: a GUEST of the home tenant stays unauth. Got: ${homeGuest.message.slice(0, 300)}`);
  } finally {
    setHome(saved.ms);
    if (saved.teams !== undefined) process.env.TEAMS_TENANT_ID = saved.teams;
  }
}

{
  eq(await teamsIsHomeTenant("T-1", async () => "t-1"), true, "teamsIsHomeTenant: the same tenant id in another case is the home tenant");
  eq(await teamsIsHomeTenant("T-1", async () => "T-2"), false, "teamsIsHomeTenant: another tenant is not");
  eq(await teamsIsHomeTenant(undefined, async () => "T-1"), false, "teamsIsHomeTenant: an activity with no tenant is not");
  eq(await teamsIsHomeTenant("T-1", async () => undefined), false, "teamsIsHomeTenant: no configured home tenant answers false");
  eq(await teamsIsHomeTenant("T-1", async () => ""), false, "teamsIsHomeTenant: an empty home tenant answers false");
  eq(
    await teamsIsHomeTenant("T-1", async () => {
      throw new Error("resolver failed");
    }),
    false,
    "teamsIsHomeTenant: a resolver throw answers false, never a throw",
  );
}

{
  const roomDomain = (override?: { authorGrain?: "taint" | "withhold"; roomGrain?: "engage" | "silent" }) => [
    defineDomain({ name: "org", match: "org", reach: [], memory: "brain", ...(override ? { externalPolicy: override } : {}) }),
  ];
  const useConfig = (domains: ReturnType<typeof roomDomain>) =>
    registerConfig({
      loadBundles: () => [],
      loadBindings: () => [],
      pluginRegistry: {},
      skillContent: {},
      loadDomains: () => domains,
      loadSilos: () => [{ name: "brain", provider: "sqlite" }],
      domainsForSurface: () => [],
    });

  _resetTeamsUserTypeCacheForTest();
  useConfig(roomDomain({ authorGrain: "taint", roomGrain: "engage" }));
  const optOut = scriptProbe({ ok: true, body: { userRole: "guest" } });
  const optOutSuppressed = await liveTeamsExternalGate(channelActivity(), () => optOut.probe);
  eq(optOutSuppressed, false, "on the `taint` / `engage` OPT-OUT the gate suppresses nothing");
  eq(
    optOut.paths.length,
    0,
    "🔴 …and the ROSTER PROBE NEVER RAN (=== 0 connector calls) — this gate is pre-ack, so an opted-out deployment pays exactly what it paid before",
  );

  _resetTeamsUserTypeCacheForTest();
  useConfig(roomDomain());
  const shipped = scriptProbe({ ok: true, body: { userRole: "guest" } });
  eq(await liveTeamsExternalGate(channelActivity(), () => shipped.probe), true, "🔴 on the SHIPPED grains a roster-refuted GUEST is suppressed with no declaration at all");
  eq(shipped.paths.length, 1, "…having bought the roster answer (=== 1 call) — the shipped policy can use it");

  _resetTeamsUserTypeCacheForTest();
  useConfig(roomDomain({ authorGrain: "withhold" }));
  const armed = scriptProbe({ ok: true, body: { userRole: "guest" } });
  const armedSuppressed = await liveTeamsExternalGate(channelActivity(), () => armed.probe);
  eq(armed.paths.length, 1, "🔴 an ARMED policy DOES run the probe (=== 1 connector call) — the evidence is bought only when a grain can use it");
  eq(
    armedSuppressed,
    true,
    "🔴 …and a roster-refuted GUEST is suppressed on `withhold` with NO operator register armed — the surface leg answers on its own, which is what OPE-493 restored",
  );

  _resetTeamsUserTypeCacheForTest();
  const memberProbe = scriptProbe({ ok: true, body: { userRole: "user" } });
  eq(
    await liveTeamsExternalGate(channelActivity(), () => memberProbe.probe),
    false,
    "🔴 NEGATIVE CONTROL: the same armed policy passes a tenant MEMBER (=== false) — the suppression measures the ROSTER VERDICT, not the policy",
  );
  eq(memberProbe.paths.length, 1, "…having asked the roster (=== 1 call)");

  _resetTeamsUserTypeCacheForTest();
  eq(
    await liveTeamsExternalGate(channelActivity(), () => scriptProbe({ ok: false, body: null }).probe),
    false,
    "🔴 FAIL-OPEN: an unanswerable probe suppresses nothing — a bot that cannot read the roster must never take the surface off the air",
  );
}

{
  const engaged = await driveWake({ id: "act-r-2610a", ambient: true, threadEngaged: true });
  ok(engaged.received.message.includes('addressing="channel-watch"'), "OPE-2610: the fixture is Leg A's ambient wake, not an addressed one");
  ok(
    engaged.received.message.includes('follow-up="thread-engaged"'),
    "🔴 OPE-2610: an enrolled chain's plain follow-up reaches the seat with `follow-up=\"thread-engaged\"` through the REAL dispatch",
  );
  const plain = await driveWake({ id: "act-r-2610b", ambient: true });
  ok(!plain.received.message.includes("follow-up="), "OPE-2610: NEGATIVE CONTROL — the same plain message on an un-enrolled chain states no follow-up");
}

console.log(`✓ teams roster probe: ${n} assertions passed (path + verdicts + TTL cache; the REAL liveTeamsDispatch and liveTeamsDmDivert over the real store, mapper and supervisor)`);
