import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-teams-roster-")), "ops.sqlite3");
delete process.env.OE_ORG;
delete process.env.OE_TRUST;

import { parseTeamsActivity, type TeamsMessageActivity } from "eve/channels/teams";
import {
  resolveTeamsUserType,
  teamsRosterMemberPath,
  teamsServiceUrlRosterProbe,
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
import { resolvePartition, domainKeyOf } from "@open-everywhere/core/agent/memory/partition.js";
import { supervisorGrainFor } from "@open-everywhere/core/agent/channels/unified-supervisor.js";
import { OE_CHAT_NONMEMBER_ATTR } from "@open-everywhere/core/agent/access/taint-signal.js";
import { registerConfig, defineDomain } from "@open-everywhere/core/agent/adapter-api.js";
import type { UnifiedReceiveTarget } from "@open-everywhere/core/agent/channels/unified.js";
import type { RouteHandlerArgs } from "eve/channels";

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

function channelActivity(): TeamsMessageActivity {
  const parsed = parseTeamsActivity({
    type: "message",
    id: "act-r-1",
    serviceUrl: SERVICE_URL,
    from: { id: AUTHOR, name: "example-owner", aadObjectId: "a0d00000-0000-4000-8000-00000000a0d1" },
    recipient: { id: "28:bot" },
    conversation: { id: CONVERSATION, conversationType: "channel", tenantId: TENANT },
    channelData: { channel: { id: CHANNEL, membershipType: "standard" }, team: { id: TEAM } },
    text: "hello, what can you do?",
    isBotMentioned: true,
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

async function runChannel(probe: TeamsRosterProbe | undefined): Promise<Received> {
  _resetTeamsUserTypeCacheForTest();
  const a = channelActivity();
  const auth = captureFor(a);
  const partition = resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: auth } } });
  const surfaceKey = domainKeyOf(partition);
  const window = planTeamsSingleWindow(
    true,
    true,
    { scope: "channel", membershipType: "standard", tenantId: TENANT, vouched: true },
    { serviceUrl: SERVICE_URL, conversationId: CONVERSATION, tenantId: TENANT },
  );
  assert.ok(window, "the fixture must mint a window (an addressed mention on a vouched standard channel)");
  const plan: TeamsFrontPlan = { window, surfaceKey, partition, grain: supervisorGrainFor(surfaceKey, []), auth };
  const received: Received[] = [];
  await liveTeamsDispatch(a, plan, captureTo(received), () => probe);
  assert.equal(received.length, 1, "exactly one dispatch into the unified channel");
  return received[0]!;
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
    silent.message.includes('trust="peer"'),
    `🔴 …and the same author on the same channel is a PEER without the refutation — so the assertion above measures the ROSTER, not the fixture. Got: ${silent.message.slice(0, 400)}`,
  );
  eq(sa[OE_CHAT_NONMEMBER_ATTR], undefined, "…and the author leg contributes NO non-member mark (=== absent)");

  const none = await runChannel(undefined);
  eq((none.auth.attributes ?? {})["user_type"], undefined, "no probe at all (no serviceUrl) is the same fail-open outcome");

  const gKeys = Object.keys(guest.auth.attributes ?? {}).filter((k) => k !== "user_type" && k !== OE_CHAT_NONMEMBER_ATTR).sort();
  const sKeys = Object.keys(silent.auth.attributes ?? {}).sort();
  eq(gKeys, sKeys, "🔴 the probe adds user_type (and the taint mark it earns) and NOTHING else — no other attribute moves");
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
  const roomDomain = (override?: { authorGrain?: "taint" | "withhold" }) => [
    defineDomain({ name: "org", match: "org", channels: [], memory: "brain", ...(override ? { externalPolicy: override } : {}) }),
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
  useConfig(roomDomain());
  const shipped = scriptProbe({ ok: true, body: { userRole: "guest" } });
  const shippedSuppressed = await liveTeamsExternalGate(channelActivity(), () => shipped.probe);
  eq(shippedSuppressed, false, "on the SHIPPED grains the gate suppresses nothing — an upgrade changes no behaviour");
  eq(
    shipped.paths.length,
    0,
    "🔴 …and the ROSTER PROBE NEVER RAN (=== 0 connector calls) — this gate is pre-ack, so a deployment that has not opted in pays exactly what it paid before",
  );

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

console.log(`✓ teams roster probe: ${n} assertions passed (path + verdicts + TTL cache; the REAL liveTeamsDispatch and liveTeamsDmDivert over the real store, mapper and supervisor)`);
