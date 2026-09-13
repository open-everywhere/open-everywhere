
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-unified-window-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

import { registerConfig } from "@open-everywhere/core/agent/access/config.js";
import {
  defineDomain,
  windowedSupervisorEnabled,
  windowModeFor,
  assertUnifiedDomainTrust,
  type Domain,
} from "@open-everywhere/core/agent/memory/domain.js";
import {
  supervisorGrainFor,
  supervisorTokenForGrain,
  unifiedSupervisorToken,
  unifiedDomainSessionKey,
  effectiveEveToken,
  UNIFIED_CHANNEL_NAME,
} from "@open-everywhere/core/agent/channels/unified-supervisor.js";
import {
  mintWakeId,
  registerUnifiedWakeTarget,
  resolveUnifiedWakeTarget,
  sameUnifiedConversation,
  resolveAnswerableReplyTarget,
  isUnifiedWakeOrigin,
  stampUnifiedWindowAuth,
  shouldBridgeAddressedProse,
  bridgeBlockingRefusal,
  BRIDGE_BLOCKING_REFUSALS,
  singleWindowMentionPolicy,
  WAKE_TARGET_TTL_MS,
  OE_PLATFORM_ATTR,
  OE_WAKE_ID_ATTR,
  OE_ADDRESSING_ATTR,
  OE_SOURCES_ATTR,
  type UnifiedWakeOrigin,
} from "@open-everywhere/core/agent/channels/unified-window.js";
import { decodeSources } from "@open-everywhere/core/agent/channels/window-sources.js";
import { REPLY_STALE_REFUSAL_REASON } from "@open-everywhere/core/agent/channels/reply-freshness.js";
import { REPLY_FOLD_REFUSAL_REASON } from "@open-everywhere/core/agent/channels/reply-fold.js";
import { WAKE_DECLINED_REFUSAL_REASON, WAKE_DONE_REFUSAL_REASON } from "@open-everywhere/core/agent/channels/reply-signal.js";
import { TASK_WAKE_UNREAD_REFUSAL_REASON } from "@open-everywhere/core/agent/channels/task-wake.js";
import { DELEGATION_PENDING_REFUSAL_REASON } from "@open-everywhere/core/agent/access/pending-delegation-signal.js";
import unifiedChannel, { divertToUnifiedWindow, answeredSameContainerThisTurn, answeredContainerVia, type UnifiedReceiveTarget } from "@open-everywhere/core/agent/channels/unified.js";
import { markWakeRepliedThisTurn } from "@open-everywhere/core/agent/channels/reply-signal.js";
import { postUnifiedReply, completeUnifiedSessionSilently } from "@open-everywhere/core/agent/channels/unified-reply.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { claimRuntimeRotation } from "@open-everywhere/core/agent/channels/runtime-rotation.js";
import {
  parseMessageEvent,
  routeSupervisorEvent,
  supervisorToken,
  liveSupervisorDeps,
  type SupervisorRouteDeps,
} from "@open-everywhere/provider-slack/agent/channels/slack-events.js";
import { withSingleWindowDiversion } from "@open-everywhere/provider-slack/agent/channels/slack-front.js";
import { slackThreadTarget } from "@open-everywhere/provider-slack/agent/channels/slack-post-arm.js";
import { handleGitHubSupervisorDispatch, githubSupervisorToken, type GitHubSupervisorDeps } from "@open-everywhere/provider-github/agent/channels/github-supervisor.js";
import { buildGitHubAuth } from "@open-everywhere/provider-github/agent/channels/github-identity.js";
import { admissionFunction } from "@open-everywhere/core/agent/adapter-api.js";
import { handleLinearSupervisorDispatch, linearSupervisorToken, type LinearSupervisorDeps } from "@open-everywhere/provider-linear/agent/channels/linear-supervisor.js";
import { buildLinearAuth } from "@open-everywhere/provider-linear/agent/channels/linear-identity.js";
import { registerLinearProvider } from "@open-everywhere/provider-linear/agent/register.js";
import { handleNotionSupervisorDispatch, notionSupervisorToken, planNotionSingleWindow, type NotionSupervisorDeps } from "@open-everywhere/provider-notion/agent/channels/notion-supervisor.js";
import { buildNotionAuth } from "@open-everywhere/provider-notion/agent/channels/notion-identity.js";
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";
import { registerNotionProvider } from "@open-everywhere/provider-notion/agent/register.js";
import { registerGithubProvider } from "@open-everywhere/provider-github/agent/register.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { wakeOriginCodec, registerWakeOriginCodec } from "@open-everywhere/core/agent/channels/wake-origin-codec.js";
import { unifiedThreadRef, isThreadScopedWakeOrigin } from "@open-everywhere/core/agent/channels/unified-window.js";
import {
  dispatchTurn,
  authForRelayMessage,
  discordSingleWindowMentionPolicy,
  discordSingleWindowPrivacyOk,
  type DiscordRelayMessage,
  type DiscordGatewaySend,
} from "@open-everywhere/provider-discord/agent/channels/discord-gateway.js";
import { isVouchedInternal, isVouchedSurface, registerSurfaces, defineSurface, _resetSurfacesForTest } from "@open-everywhere/core/agent/identity/trust.js";
const vouch = (...keys: string[]) => registerSurfaces(keys.map((key) => defineSurface({ key, trust: "internal" as const })));
import {
  handleTeamsSingleWindowDispatch,
  teamsSingleWindowPrivacyOk,
  planTeamsSingleWindow,
  type TeamsSupervisorDeps,
  type TeamsSingleWindowFacts,
} from "@open-everywhere/provider-teams/agent/channels/teams-supervisor.js";
import { buildTeamsAuth } from "@open-everywhere/provider-teams/agent/channels/teams-identity.js";
import { isTrustedTeamsServiceUrl } from "@open-everywhere/provider-teams/agent/channels/teams-origin-codec.js";
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";
import { channelPlatform, isUnifiedWindowContext, turnOriginPlatform, currentWakeId, currentTurnAddressing, assertTurnSurface, bindFrom, deploymentOrg, windowSourcesOf, resolveWindowSources, type BindableContext } from "@open-everywhere/core/agent/identity/binding.js";
import { registerPostArm, postArm, type PostArm } from "@open-everywhere/core/agent/channels/post-arms.js";
import { resolvePartition, domainKeyOf } from "@open-everywhere/core/agent/memory/partition.js";
import { tailWindowFor } from "@open-everywhere/core/agent/channels/session-tail-record.js";
import type { SessionTailEntry } from "@open-everywhere/core/agent/channels/session-tail.js";
import { recordSpend } from "@open-everywhere/core/agent/spend/store.js";
import { periodOf } from "@open-everywhere/core/agent/spend/spend.js";
import { readAudit } from "@open-everywhere/core/agent/audit/audit.js";
import replyTool from "@open-everywhere/core/agent/tools/reply.js";
import type { RouteHandlerArgs } from "eve/channels";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/settings/settings.js";
import { _setDeploymentIdentityForTest } from "@open-everywhere/core/agent/identity/deployment-identity.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const throws = (fn: () => unknown, label: string) => {
  assert.throws(fn, label);
  n++;
};
const noThrow = (fn: () => unknown, label: string) => {
  assert.doesNotThrow(fn, label);
  n++;
};

registerNotionProvider();
registerSlackProvider();
registerGithubProvider();
registerTeamsProvider();
registerLinearProvider();
registerDiscordProvider();
{
  const ALL_ORIGIN_PLATFORMS: Record<UnifiedWakeOrigin["platform"], true> = {
    slack: true,
    github: true,
    linear: true,
    notion: true,
    discord: true,
    teams: true,
  };
  for (const platform of Object.keys(ALL_ORIGIN_PLATFORMS)) {
    ok(wakeOriginCodec(platform) !== undefined, `wake-origin codec completeness: "${platform}" has a registered codec once boot wiring runs`);
  }
  ok(isThreadScopedWakeOrigin({ platform: "notion", discussionId: "d1" }), "notion: a discussion IS its own thread (registered codec)");
  assert.deepStrictEqual(
    unifiedThreadRef({ platform: "notion", discussionId: "d1", pageId: "p1" }),
    { channelKey: "notion/p1", threadKey: "d1" },
    "notion: channel is the page, thread is the discussion (registered codec)",
  );
  ok(isThreadScopedWakeOrigin({ platform: "github", owner: "o", repo: "r", issueNumber: 7 }), "github: an issue IS its own thread (registered codec)");
  assert.deepStrictEqual(
    unifiedThreadRef({ platform: "github", owner: "acme", repo: "web", issueNumber: 7 }),
    { channelKey: "github/acme/web", threadKey: "7" },
    "github: the issue IS the thread (registered codec)",
  );
  n += 3;
  n++;
  ok(
    isThreadScopedWakeOrigin({ platform: "teams", serviceUrl: "https://smba.trafficmanager.net/uk/", conversationId: "19_x", replyToActivityId: "act1" }),
    "teams: replyToActivityId present ⇒ the reply chain is the thread (registered codec)",
  );
  ok(
    !isThreadScopedWakeOrigin({ platform: "teams", serviceUrl: "https://smba.trafficmanager.net/uk/", conversationId: "19_x" }),
    "teams: no reply-chain root ⇒ a plain conversation send, top-level (registered codec)",
  );
  {
    const teamsRef = unifiedThreadRef({ platform: "teams", serviceUrl: "https://smba.trafficmanager.net/uk/", conversationId: "19:abc@thread.v2", replyToActivityId: "act:1" });
    ok(!teamsRef.channelKey.includes(":") && !teamsRef.threadKey.includes(":"), "teams: colons in the conversation/activity ids are folded (task windowId is [^:]+) (registered codec)");
  }
  n++;
  ok(isThreadScopedWakeOrigin({ platform: "linear", issueId: "iss1", agentSessionId: "as1" }), "linear: an issue IS its own thread (registered codec)");
  assert.deepStrictEqual(
    unifiedThreadRef({ platform: "linear", issueId: "iss_1", ambient: true }),
    { channelKey: "linear/iss_1", threadKey: "iss_1" },
    "linear ambient: threadKey falls back to the issue id (registered codec)",
  );
  n++;
}

const withGate = async <T>(on: boolean, fn: () => T | Promise<T>): Promise<T> => {
  overrideSettingsForTest({ window: { topology: on } });
  try {
    return await fn();
  } finally {
    overrideSettingsForTest({ window: { topology: false } });
  }
};

const SLACK_KEY = "slack/T_WIN/C_WINA";
const GH_KEY = "github/acme/payments-api";
const LINEAR_KEY = "linear/O_WIN/T_WINX";
const NOTION_KEY = "notion/W_WIN/P_WINPAGE";
const DISCORD_KEY = "discord/G_WIN/CH_WIN";
const TEAMS_KEY = "teams/TEN_WIN/19-winchan.tacv2";
const TEAMS_WS_KEY = "teams/TEN_WIN";
const winDomain = defineDomain({
  name: "payments",
  reach: [SLACK_KEY, GH_KEY, LINEAR_KEY, NOTION_KEY, DISCORD_KEY, TEAMS_KEY],
  ambientSupervisor: true,
  mode: "unified",
});
const soloTwin = defineDomain({ name: "payments", reach: [SLACK_KEY, GH_KEY, LINEAR_KEY, NOTION_KEY, DISCORD_KEY, TEAMS_KEY], ambientSupervisor: true, mode: "solo" });
const ambientTwin = defineDomain({ name: "payments", reach: [SLACK_KEY, GH_KEY, LINEAR_KEY, NOTION_KEY, DISCORD_KEY, TEAMS_KEY], ambientSupervisor: true });
const org = defineDomain({ name: "org", match: "org" });

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [winDomain, org],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (["C_WINA", "payments-api", "T_WINX", "P_WINPAGE", "CH_WIN", "19-winchan.tacv2"].includes(surface) ? ["payments"] : []),
});

const crossSurfaceOn = (key: string, ds: readonly Domain[]): boolean =>
  windowedSupervisorEnabled(key, ds) && windowModeFor(key, ds) === "unified";

await withGate(false, () => {
  ok(!windowedSupervisorEnabled(SLACK_KEY, [winDomain, org]), "code gate OFF: a mode:unified domain does NOT window (the capability is the hard master)");
  ok(!crossSurfaceOn(SLACK_KEY, [winDomain, org]), "code gate OFF: no cross-surface window (INERT until the capability is flipped ON)");
});
await withGate(true, () => {
  ok(windowedSupervisorEnabled(SLACK_KEY, [winDomain, org]) && windowedSupervisorEnabled(GH_KEY, [winDomain, org]), "code gate ON: the domain windows for the Slack AND GitHub containers");
  ok(crossSurfaceOn(SLACK_KEY, [winDomain, org]) && crossSurfaceOn(GH_KEY, [winDomain, org]), "code gate ON + mode:unified → cross-surface window ON for both containers");
  ok(windowedSupervisorEnabled(SLACK_KEY, [soloTwin, org]) && !crossSurfaceOn(SLACK_KEY, [soloTwin, org]), "mode:solo → windows per-channel, not cross-surface");
  ok(windowedSupervisorEnabled(SLACK_KEY, [ambientTwin, org]) && !crossSurfaceOn(SLACK_KEY, [ambientTwin, org]), "no mode ⇒ windows solo by default (gate ON)");
  const noAmbient = defineDomain({ name: "payments", reach: [SLACK_KEY], mode: "unified" });
  ok(windowedSupervisorEnabled(SLACK_KEY, [noAmbient, org]), "a domain without ambientSupervisor still seats its channels (chattiness ⊥ session shape)");
  ok(crossSurfaceOn(SLACK_KEY, [noAmbient, org]), "…and its declared cross-surface topology still holds");
});

ok((() => { assertUnifiedDomainTrust([winDomain, org]); return true; })(), "the documented single-window fixture passes assertUnifiedDomainTrust");
ok(
  (() => {
    assertUnifiedDomainTrust([defineDomain({ name: "payments", reach: [SLACK_KEY], mode: "unified" })]);
    return true;
  })(),
  "mode WITHOUT ambientSupervisor LOADS — topology and chattiness are independent",
);
throws(
  () => assertUnifiedDomainTrust([defineDomain({ name: "org", match: "org", ambientSupervisor: true, mode: "unified" })]),
  "mode on a pseudo-domain → load fails loud (the 'window everything' footgun)",
);

await withGate(true, () => {
  const gSlack = supervisorGrainFor(SLACK_KEY, [winDomain, org]);
  const gGh = supervisorGrainFor(GH_KEY, [winDomain, org]);
  ok(gSlack.unified && gSlack.singleWindow === true && gGh.unified && gGh.singleWindow === true, "gate ON + mode unified: both surfaces' grains are unified + singleWindow");
  ok(gSlack.registryKey === gGh.registryKey && gSlack.registryKey === unifiedDomainSessionKey("payments"), "one domain registry row for both surfaces");
  const gLin = supervisorGrainFor(LINEAR_KEY, [winDomain, org]);
  ok(gLin.unified && gLin.singleWindow === true, "gate ON: the Linear surface's grain is unified + singleWindow too");
  ok(gLin.registryKey === gSlack.registryKey, "the Linear surface shares the one domain registry row");
  const gNot = supervisorGrainFor(NOTION_KEY, [winDomain, org]);
  ok(gNot.unified && gNot.singleWindow === true && gNot.registryKey === gSlack.registryKey, "gate ON: the Notion page's grain is unified + singleWindow and shares the one domain registry row");
  const gDis = supervisorGrainFor(DISCORD_KEY, [winDomain, org]);
  ok(gDis.unified && gDis.singleWindow === true && gDis.registryKey === gSlack.registryKey, "gate ON: the Discord channel's grain is unified + singleWindow and shares the one domain registry row");
  const rawSlack = supervisorTokenForGrain(gSlack, 3, () => supervisorToken("C_WINA", 3));
  const rawGh = supervisorTokenForGrain(gGh, 3, () => githubSupervisorToken("acme", "payments-api", 3));
  const rawLin = supervisorTokenForGrain(gLin, 3, () => linearSupervisorToken("T_WINX", 3));
  const rawNot = supervisorTokenForGrain(gNot, 3, () => notionSupervisorToken("P_WINPAGE", 3));
  ok(rawSlack === rawGh && rawSlack === rawLin && rawSlack === rawNot && rawSlack === unifiedSupervisorToken("payments", 3), "IDENTICAL raw token from the Slack, GitHub, Linear AND Notion dispatch paths");
  ok(
    effectiveEveToken(UNIFIED_CHANNEL_NAME, rawSlack) === effectiveEveToken(UNIFIED_CHANNEL_NAME, rawGh) &&
      effectiveEveToken(UNIFIED_CHANNEL_NAME, rawSlack) === "unified:oe-dom:payments:oe-sup:g3",
    "ONE effective eve token across providers (unified:oe-dom:payments:oe-sup:g3) — the single context window",
  );
  ok(
    effectiveEveToken("slack", rawSlack) !== effectiveEveToken("github", rawGh),
    "per-platform delivery of the same raw token yields DIFFERENT effective tokens (the sibling-session split single-window removes)",
  );
});

await withGate(false, () => {
  const perContainer = supervisorGrainFor(SLACK_KEY, [ambientTwin, org]);
  ok(!("singleWindow" in perContainer) && !("windowId" in perContainer) && perContainer.unified === false, "gate OFF: the grain is the per-container shape (no singleWindow / windowId field, unified false)");
  ok(
    JSON.stringify(supervisorGrainFor(SLACK_KEY, [winDomain, org])) === JSON.stringify(perContainer),
    "gate OFF: a mode:unified domain's grain is IDENTICAL to the plain-ambient per-container grain",
  );
  ok(
    JSON.stringify(supervisorGrainFor(SLACK_KEY, [soloTwin, org])) === JSON.stringify(perContainer),
    "gate OFF: a mode:solo domain's grain is IDENTICAL to the plain-ambient per-container grain",
  );
});

overrideSettingsForTest({ window: { topology: true } });

interface ReceivedWake {
  channel: unknown;
  message: string;
  target: UnifiedReceiveTarget;
  auth: { attributes?: Record<string, unknown> };
}
const received: ReceivedWake[] = [];
const captureReceive = ((ch: unknown, target: unknown) => ({
  async send(message: string, options: { auth: unknown }) {
    received.push({ channel: ch, message, target: target as UnifiedReceiveTarget, auth: options.auth as ReceivedWake["auth"] });
    return {} as never;
  },
})) as unknown as RouteHandlerArgs["to"];

const RAW_TOKEN = unifiedSupervisorToken("payments", 1);

const slackEv = parseMessageEvent({
  type: "event_callback",
  team_id: "T_WIN",
  event: { type: "message", channel: "C_WINA", ts: "100.1", user: "U1", channel_type: "channel", text: "decision: the deploy window token is DW-42" },
})!;
const baseWakes: Array<{ token: string; window?: unknown }> = [];
const slackBaseDeps: SupervisorRouteDeps = {
  confirmInternalWithMeta: async () => ({ internal: true, memberCount: 7 }),
  getOrCreateSession: async () => ({ token: RAW_TOKEN, generation: 1, freshGeneration: false, tail: [] }),
  touchSession: async () => {},
  wake: async (input) => {
    baseWakes.push({ token: input.token, window: input.window });
  },
  unifiedMeta: () => ({ unified: true, singleWindow: true }),
  now: () => "2026-01-14T02:00:00Z",
};
{
  const out = await routeSupervisorEvent(slackEv, withSingleWindowDiversion(slackBaseDeps as ReturnType<typeof liveSupervisorDeps>, captureReceive, SLACK_KEY));
  ok(out.woke === true, "slack: the supervisor wake fires under the single-window grain");
  ok(baseWakes.length === 0, "slack: the base send path was NOT used — the wake was DIVERTED");
  ok(received.length === 1 && received[0].channel === unifiedChannel, "slack: the diversion targets the unified channel BY MODULE IDENTITY (eve's resolution key)");
  ok(received[0].target.token === RAW_TOKEN, "slack: the diverted wake carries the raw domain token");
  ok(received[0].target.origin.platform === "slack" && (received[0].target.origin as { channelId?: string }).channelId === "C_WINA", "slack: the origin names the triggering channel");
  ok((received[0].target.origin as { threadTs?: string }).threadTs === undefined, "slack: a top-level trigger has NO threadTs (reply posts top-level — planSupervisorReply semantics)");
  ok(received[0].message.includes(`wake-id="${received[0].target.wakeId}"`), "slack: the envelope carries the wake-id the model echoes to reply");
  const a = received[0].auth.attributes ?? {};
  ok(a[OE_PLATFORM_ATTR] === "slack" && a[OE_WAKE_ID_ATTR] === received[0].target.wakeId, "slack: the forwarded auth is stamped with oe_platform + oe_wake_id");
  ok(typeof a.channel_id === "string" && a.channel_id === "C_WINA", "slack: the surface's own auth attributes ride verbatim (identity binding unchanged)");
  ok(
    JSON.stringify([...decodeSources(a[OE_SOURCES_ATTR])].sort()) === JSON.stringify(["discord", "github", "linear", "notion", "slack", "teams"]),
    "slack: the diverted wake is stamped with oe_sources = the domain's distinct channel platforms (multi-source window)",
  );
}

const ghAuth = buildGitHubAuth({
  owner: "acme",
  repo: "payments-api",
  repositoryFullName: "acme/payments-api",
  isPrivate: true,
  conversationKind: "issue",
  issueNumber: 55,
  installationId: 987,
  actorLogin: "sam",
});
const ghWindow = {
  wakeId: mintWakeId(),
  origin: { platform: "github", owner: "acme", repo: "payments-api", issueNumber: 55, installationId: 987 } satisfies UnifiedWakeOrigin,
};
const ghDeps: GitHubSupervisorDeps = {
  getOrCreateSession: async () => ({ token: RAW_TOKEN, generation: 1, freshGeneration: false, tail: [] }),
  wake: async ({ token, auth, message, context, window }) => {
    ok(window !== undefined, "github: the dispatch core threads the window through to the wake dep");
    await divertToUnifiedWindow(captureReceive, {
      message,
      context: [...context],
      token,
      window: window!,
      surfaceKey: GH_KEY,
      auth: auth as unknown as { attributes?: Record<string, unknown> },
    });
  },
  now: () => "2026-01-14T02:00:05Z",
};
await handleGitHubSupervisorDispatch(
  {
    surfaceKey: GH_KEY,
    admit: admissionFunction("wide"),
    owner: "acme",
    repo: "payments-api",
    issueNumber: 55,
    issueTitle: "Deploy window",
    auth: ghAuth,
    ingested: [],
    trigger: { id: "9001", authorLogin: "sam", sentAt: "2026-01-14T02:00:04Z", text: "what was the deploy window token we agreed?", trust: "peer" as const },
    unified: true,
    window: ghWindow,
  },
  ghDeps,
);
{
  ok(received.length === 2 && received[1].channel === unifiedChannel, "github: the diversion targets the SAME unified channel value");
  ok(received[1].target.token === RAW_TOKEN, "github: the diverted wake carries the SAME raw domain token");
  ok(
    effectiveEveToken(UNIFIED_CHANNEL_NAME, received[0].target.token) === effectiveEveToken(UNIFIED_CHANNEL_NAME, received[1].target.token),
    "💥 SINGLE CONTEXT: the Slack wake and the GitHub wake resolve ONE identical effective eve token — one hook, one run, one window",
  );
  ok(received[1].message.includes(`wake-id="${ghWindow.wakeId}"`), "github: the envelope carries the wake-id");
  const a = received[1].auth.attributes ?? {};
  ok(a[OE_PLATFORM_ATTR] === "github" && a[OE_WAKE_ID_ATTR] === ghWindow.wakeId, "github: the forwarded auth is stamped with oe_platform + oe_wake_id");
  ok(received[1].target.context !== undefined && received[1].target.context!.length > 0, "github: side-channel context (the issue-title line) rides the receive target");
}

const linAuth = buildLinearAuth({
  organizationId: "O_WIN",
  teamId: "T_WINX",
  issueId: "issue-uuid-77",
  issueIdentifier: "ENG-77",
  principalId: "sam",
  isPrivate: true,
  commentId: "comment-uuid-1",
});
const linWindow = {
  wakeId: mintWakeId(),
  origin: { platform: "linear", agentSessionId: "as-lin-77", issueId: "issue-uuid-77", parentId: "comment-uuid-1" } satisfies UnifiedWakeOrigin,
};
const linDeps: LinearSupervisorDeps = {
  getOrCreateSession: async () => ({ token: RAW_TOKEN, generation: 1, freshGeneration: false, tail: [] }),
  wake: async ({ token, auth, message, context, window }) => {
    ok(window !== undefined, "linear: the dispatch core threads the window through to the wake dep");
    await divertToUnifiedWindow(captureReceive, {
      message,
      context: [...context],
      token,
      window: window!,
      surfaceKey: LINEAR_KEY,
      auth: auth as unknown as { attributes?: Record<string, unknown> },
    });
  },
  now: () => "2026-01-14T02:00:07Z",
};
await handleLinearSupervisorDispatch(
  {
    surfaceKey: LINEAR_KEY,
    admit: admissionFunction("wide"),
    teamId: "T_WINX",
    issueId: "issue-uuid-77",
    issueIdentifier: "ENG-77",
    issueTitle: "Deploy window",
    auth: linAuth,
    ingested: [],
    trigger: { id: "comment-uuid-1", authorId: "sam", authorName: "Sam", sentAt: "2026-01-14T02:00:06Z", text: "what was the deploy window token we agreed?", trust: "peer" as const },
    unified: true,
    window: linWindow,
  },
  linDeps,
);
{
  ok(received.length === 3 && received[2].channel === unifiedChannel, "linear: the diversion targets the SAME unified channel value");
  ok(received[2].target.token === RAW_TOKEN, "linear: the diverted wake carries the SAME raw domain token");
  ok(
    effectiveEveToken(UNIFIED_CHANNEL_NAME, received[0].target.token) === effectiveEveToken(UNIFIED_CHANNEL_NAME, received[2].target.token),
    "💥 SINGLE CONTEXT: the Slack wake and the Linear wake resolve ONE identical effective eve token — the second-surface proof",
  );
  ok(received[2].message.includes(`wake-id="${linWindow.wakeId}"`), "linear: the envelope carries the wake-id");
  const a = received[2].auth.attributes ?? {};
  ok(a[OE_PLATFORM_ATTR] === "linear" && a[OE_WAKE_ID_ATTR] === linWindow.wakeId, "linear: the forwarded auth is stamped with oe_platform + oe_wake_id");
  ok(
    received[2].target.origin.platform === "linear" &&
      (received[2].target.origin as { agentSessionId?: string }).agentSessionId === "as-lin-77" &&
      (received[2].target.origin as { issueId?: string }).issueId === "issue-uuid-77" &&
      (received[2].target.origin as { parentId?: string }).parentId === "comment-uuid-1",
    "linear: the frozen origin names the OPEN agent session (the reply target) + issue + thread-root",
  );
  ok(typeof a.team_id === "string" && a.team_id === "T_WINX", "linear: the surface's own auth attributes ride verbatim (identity binding unchanged)");
}

const notAuth = buildNotionAuth({
  workspaceId: "W_WIN",
  pageId: "P_WINPAGE",
  discussionId: "disc-win-1",
  commentId: "nc-1",
  principalId: "sam-notion",
});
const notWindow = planNotionSingleWindow(true, true, true, { discussionId: "disc-win-1", pageId: "P_WINPAGE", workspaceId: "W_WIN" })!;
ok(notWindow !== undefined && notWindow.addressing === "direct-mention", "notion: the REAL plan mints an ADDRESSED window for a mention on a singleWindow VOUCHED page");
ok(planNotionSingleWindow(true, true, false, { discussionId: "disc-win-1" }) === undefined, "notion: an UN-VOUCHED page plans NO window (fail-closed — never routed to the shared window)");
const notDeps: NotionSupervisorDeps = {
  getOrCreateSession: async () => ({ token: RAW_TOKEN, generation: 1, freshGeneration: false, tail: [] }),
  wake: async ({ token, auth, message, context, window }) => {
    ok(window !== undefined, "notion: the dispatch core threads the window through to the wake dep");
    await divertToUnifiedWindow(captureReceive, {
      message,
      context: [...context],
      token,
      window: window!,
      surfaceKey: NOTION_KEY,
      auth: auth as unknown as { attributes?: Record<string, unknown> },
    });
  },
  now: () => "2026-01-14T02:00:09Z",
};
await handleNotionSupervisorDispatch(
  {
    surfaceKey: NOTION_KEY,
    credentialId: "channel-key",
    addressing: "direct",
    pageId: "P_WINPAGE",
    discussionId: "disc-win-1",
    workspaceId: "W_WIN",
    auth: notAuth,
    trigger: { from: "human", id: "nc-1", authorId: "sam-notion", sentAt: "2026-01-14T02:00:08Z", text: "@OE what was the deploy window token we agreed?", trust: "peer" as const },
    threadComments: [],
    unified: true,
    window: notWindow,
    directMention: true,
  },
  notDeps,
);
{
  ok(received.length === 4 && received[3].channel === unifiedChannel, "notion: the diversion targets the SAME unified channel value");
  ok(received[3].target.token === RAW_TOKEN, "notion: the diverted wake carries the SAME raw domain token");
  ok(
    effectiveEveToken(UNIFIED_CHANNEL_NAME, received[0].target.token) === effectiveEveToken(UNIFIED_CHANNEL_NAME, received[3].target.token),
    "💥 SINGLE CONTEXT: the Slack wake and the Notion wake resolve ONE identical effective eve token — the fourth-surface proof",
  );
  ok(received[3].message.includes('addressing="direct-mention"') && received[3].message.includes(`wake-id="${notWindow.wakeId}"`), "notion: the delivered wake is the ADDRESSED direct-mention render with the wake-id envelope");
  const a = received[3].auth.attributes ?? {};
  ok(a[OE_PLATFORM_ATTR] === "notion" && a[OE_WAKE_ID_ATTR] === notWindow.wakeId, "notion: the forwarded auth is stamped with oe_platform + oe_wake_id");
  ok(a[OE_ADDRESSING_ATTR] === "direct-mention", "notion: the forwarded auth carries oe_addressing='direct-mention' (the terminal-prose delivery bridge's arm)");
  ok(
    received[3].target.origin.platform === "notion" &&
      (received[3].target.origin as { discussionId?: string }).discussionId === "disc-win-1" &&
      (received[3].target.origin as { pageId?: string }).pageId === "P_WINPAGE",
    "notion: the frozen origin names the triggering discussion (the reply target) + page",
  );
  ok(typeof a.discussion_id === "string" && a.discussion_id === "disc-win-1", "notion: the surface's own auth attributes ride verbatim (identity binding unchanged)");
}

const discordMsg = (over: Partial<DiscordRelayMessage>): DiscordRelayMessage => ({
  id: "5001",
  content: "<@BOT9> what was the deploy window token we agreed?",
  channelId: "CH_WIN",
  channelType: "0",
  guildId: "G_WIN",
  author: { id: "U_D1", username: "dana", bot: false },
  mentionsBot: true,
  botName: "OE",
  botId: "BOT9",
  ...over,
});
const discordBaseSends: unknown[] = [];
const discordSend = (async (...args: unknown[]) => void discordBaseSends.push(args)) as unknown as DiscordGatewaySend;
let discordThreadAttempts = 0;
const stubCreateThread = async (): Promise<string | null> => {
  discordThreadAttempts++;
  return null;
};
const stubResolveParent = async (): Promise<string | undefined> => undefined;
{
  _resetSurfacesForTest();
  delete process.env.OE_TRUST;
  const m1 = discordMsg({});
  await dispatchTurn(m1, authForRelayMessage(m1)!, discordSend, stubCreateThread, stubResolveParent, captureReceive);
  ok(
    received.length === 4 && discordBaseSends.length === 1 && discordThreadAttempts === 1,
    "discord: an UN-VOUCHED guild channel takes the NATIVE path (auto-thread attempted, base send used, NOTHING diverted) — the privacy floor fails closed",
  );

  await claimRuntimeRotation({ org: "default", registryKey: unifiedDomainSessionKey("payments"), surfaceKey: "discord/G_WIN/CH_WIN", atIso: new Date().toISOString() });
  await getOperationalStore().rotateChannelSession("default", unifiedDomainSessionKey("payments"), RAW_TOKEN, new Date().toISOString());

  vouch("discord/G_WIN");
  discordBaseSends.length = 0;
  discordThreadAttempts = 0;
  const m2 = discordMsg({ id: "5002" });
  await dispatchTurn(m2, authForRelayMessage(m2)!, discordSend, stubCreateThread, stubResolveParent, captureReceive);
  ok(discordBaseSends.length === 0 && discordThreadAttempts === 0, "discord: a vouched mention SUPPRESSES the native dispatch — no base send, no auto-thread (the divert owns it)");
  ok(received.length === 5 && received[4].channel === unifiedChannel, "discord: the diversion targets the SAME unified channel value (module identity)");
  ok(received[4].target.token === unifiedSupervisorToken("payments", 1), "discord: the diverted wake carries the raw domain token (generation 1, minted in the REAL registry row)");
  ok(
    effectiveEveToken(UNIFIED_CHANNEL_NAME, received[0].target.token) === effectiveEveToken(UNIFIED_CHANNEL_NAME, received[4].target.token),
    "💥 SINGLE CONTEXT: the Slack wake and the Discord wake resolve ONE identical effective eve token — the fifth-surface proof",
  );
  const dOrigin = received[4].target.origin as { platform: string; channelId?: string; guildId?: string; messageId?: string };
  ok(
    dOrigin.platform === "discord" && dOrigin.channelId === "CH_WIN" && dOrigin.guildId === "G_WIN" && dOrigin.messageId === "5002",
    "discord: the frozen origin names the triggering channel + guild + message (the reply target + its message_reference anchor)",
  );
  ok(received[4].message.includes('addressing="direct-mention"') && received[4].message.includes(`wake-id="${received[4].target.wakeId}"`), "discord: the delivered wake is the ADDRESSED direct-mention render with the wake-id envelope");
  const da = received[4].auth.attributes ?? {};
  ok(da[OE_PLATFORM_ATTR] === "discord" && da[OE_WAKE_ID_ATTR] === received[4].target.wakeId, "discord: the forwarded auth is stamped with oe_platform + oe_wake_id");
  ok(da[OE_ADDRESSING_ATTR] === "direct-mention", "discord: the forwarded auth carries oe_addressing='direct-mention' (the terminal-prose delivery bridge's arm)");
  ok(da.channel_id === "CH_WIN" && da.guild_id === "G_WIN", "discord: the surface's own auth attributes ride verbatim (identity binding unchanged)");

  const m3 = discordMsg({ id: "5003", mentionsBot: false, content: "and the fallback window as well please" });
  await dispatchTurn(m3, authForRelayMessage(m3)!, discordSend, stubCreateThread, stubResolveParent, captureReceive);
  ok(discordBaseSends.length === 0 && received.length === 6, "discord: an ENGAGED non-mention follow-up ALSO diverts (Leg A ambient — one shared brain, not just mentions)");
  ok(received[5].auth.attributes?.[OE_ADDRESSING_ATTR] === undefined, "discord: the ambient wake carries NO oe_addressing — every watch turn's terminal prose stays hard-dropped");
  ok(received[5].message.includes('addressing="channel-watch"') && received[5].message.includes(`wake-id="${received[5].target.wakeId}"`), "discord: the ambient wake is the judged watch render, wake-id kept for the reply tool");
  const dOrigin3 = received[5].target.origin as { platform: string; guildId?: string };
  ok(dOrigin3.platform === "discord" && dOrigin3.guildId === "G_WIN", "discord: the ambient wake's origin is discord-shaped too (guild carried)");

  const m4 = discordMsg({ id: "5004", guildId: undefined, channelType: "1", content: "psst, what was that token?" });
  await dispatchTurn(m4, authForRelayMessage(m4)!, discordSend, stubCreateThread, stubResolveParent, captureReceive);
  ok(received.length === 7 && discordBaseSends.length === 0, "discord: a DM diverts to a window of its OWN (OPE-356 — it no longer runs on the native per-channel session)");
  const dmTarget = received[6].target;
  ok(dmTarget.token !== RAW_TOKEN && !dmTarget.token.includes(":payments:"), "🔴 discord: …and it is NOT the shared domain's token — a personal surface never enters a team-shared window");
  ok(dmTarget.token.startsWith("oe-dom:oe-dm/discord/"), "discord: the DM's token is on the reserved `oe-dm/` pseudo-domain (which matches no config domain, by construction)");
  ok(dmTarget.surfaceKey === "discord/U_D1/CH_WIN", "discord: …carrying the DM's OWN surface key (workspace = the caller's user id — a DM has no guild), the byte-exact fence both admission gates match on");
  ok((dmTarget.origin as { dm?: boolean; guildId?: string }).dm === true && (dmTarget.origin as { guildId?: string }).guildId === undefined, "discord: the DM origin is the OPE-315 `dm:true` variant with NO guildId — no path from a DM to guild authority");

  const m5 = discordMsg({ id: "5005", channelId: "TH_WIN", channelType: "11" });
  await dispatchTurn(m5, authForRelayMessage(m5)!, discordSend, stubCreateThread, async () => "CH_WIN", captureReceive);
  ok(
    received.length === 8 && discordBaseSends.length === 0,
    "discord: a mention INSIDE a thread DIVERTS (domain-grain key resolves the parent; the receive gate does NOT refuse) — no orphaned silence, forum channels work",
  );
  const dOrigin5 = received[7].target.origin as { platform: string; channelId?: string; messageId?: string };
  ok(
    dOrigin5.platform === "discord" && dOrigin5.channelId === "TH_WIN" && dOrigin5.messageId === "5005",
    "discord: the thread wake's reply targets the thread's OWN channel + message (not the parent) — the answer lands where the human asked",
  );
  ok(
    effectiveEveToken(UNIFIED_CHANNEL_NAME, received[4].target.token) === effectiveEveToken(UNIFIED_CHANNEL_NAME, received[7].target.token),
    "discord: the thread wake shares the SAME effective unified token as the base-channel wake (one context window across channel + thread)",
  );
  discordBaseSends.length = 0;
}

{
  const vouch = (keys: string[]) => (w: string, s: string) => keys.includes(w) || keys.includes(s);
  const G = { workspaceKey: "discord/G1", surfaceKey: "discord/G1/C1" };
  ok(
    !discordSingleWindowPrivacyOk({ guildId: undefined, ...G }, { vouched: vouch(["discord/G1", "discord/G1/C1"]), trustEnv: "internal" }),
    "floor: a guildless (DM/group-DM) surface NEVER passes — even vouched AND OE_TRUST=internal (unconditional)",
  );
  ok(!discordSingleWindowPrivacyOk({ guildId: "G1", ...G }, { vouched: vouch([]), trustEnv: undefined }), "floor: an un-vouched guild channel fails CLOSED (no positive internal signal exists in the payload — never inferred)");
  ok(discordSingleWindowPrivacyOk({ guildId: "G1", ...G }, { vouched: vouch(["discord/G1"]), trustEnv: undefined }), "floor: a workspace-level vouch admits the guild's channels");
  ok(discordSingleWindowPrivacyOk({ guildId: "G1", ...G }, { vouched: vouch(["discord/G1/C1"]), trustEnv: undefined }), "floor: a surface-level vouch admits exactly that channel");
  ok(!discordSingleWindowPrivacyOk({ guildId: "G1", workspaceKey: "discord/G1", surfaceKey: "discord/G1/C2" }, { vouched: vouch(["discord/G1/C1"]), trustEnv: undefined }), "floor: a surface-level vouch does NOT leak to a sibling channel");
  ok(
    discordSingleWindowPrivacyOk({ guildId: "G1", workspaceKey: "discord/G1", surfaceKey: "discord/G1/TH9", domainKey: "discord/G1/C1" }, { vouched: vouch(["discord/G1/C1"]), trustEnv: undefined }),
    "floor: a THREAD inherits its parent channel's vouch (the domain-grain key)",
  );
  ok(discordSingleWindowPrivacyOk({ guildId: "G1", ...G }, { vouched: vouch([]), trustEnv: "internal" }), "floor: OE_TRUST=internal (the internal-only-deploy blanket) admits guild surfaces");
  for (const sw of [true, false])
    for (const m of [true, false])
      for (const priv of [true, false]) {
        const p = discordSingleWindowMentionPolicy(sw, m, priv);
        const q = singleWindowMentionPolicy(sw, m, priv);
        ok(p.suppressNative === q.suppressNative && p.addressing === q.addressing, `discord mention policy ≡ the shared seam (sw=${sw},m=${m},priv=${priv})`);
      }
}

{
  const { notionSingleWindowPrivacyOk } = await import("@open-everywhere/provider-notion/agent/channels/notion.js");
  const decl = (table: Record<string, "internal" | "public">) => (w: string, s: string) => table[s] ?? table[w];
  const N = { workspaceKey: "notion/W1", surfaceKey: "notion/W1/P1" };
  const none = { declared: decl({}), trustEnv: undefined };
  ok(!notionSingleWindowPrivacyOk({ ...N }, none), "notion floor: an un-vouched page with NO resolved verdict fails CLOSED");
  ok(notionSingleWindowPrivacyOk({ ...N }, { declared: decl({ "notion/W1": "internal" }), trustEnv: undefined }), "notion floor: a workspace-level vouch admits the workspace's pages");
  ok(notionSingleWindowPrivacyOk({ ...N }, { declared: decl({ "notion/W1/P1": "internal" }), trustEnv: undefined }), "notion floor: a page-level vouch admits exactly that page");
  ok(
    !notionSingleWindowPrivacyOk({ workspaceKey: "notion/W1", surfaceKey: "notion/W1/P2" }, { declared: decl({ "notion/W1/P1": "internal" }), trustEnv: undefined }),
    "notion floor: a page-level vouch does NOT leak to a sibling page",
  );
  ok(notionSingleWindowPrivacyOk({ ...N }, { declared: decl({}), trustEnv: "internal" }), "notion floor: OE_TRUST=internal (the internal-only-deploy blanket) admits Notion pages");
  ok(!notionSingleWindowPrivacyOk({ ...N }, { declared: decl({}), trustEnv: "external" }), "notion floor: any OE_TRUST value other than 'internal' grants nothing");

  ok(
    notionSingleWindowPrivacyOk({ ...N, trust: { trusted: true } }, none),
    "🔴 notion floor: a resolved INTERNAL trust-root verdict admits the page — the same fact that already binds its memory (OPE-540)",
  );
  ok(
    !notionSingleWindowPrivacyOk({ ...N, trust: { trusted: true } }, { declared: decl({ "notion/W1/P1": "public" }), trustEnv: undefined }),
    "🔴 notion floor: a `public` page declaration REFUSES a trust-root page — the demotion sits above the walk's verdict, as it does on the memory plane",
  );
  ok(
    !notionSingleWindowPrivacyOk({ ...N, trust: { trusted: true } }, { declared: decl({ "notion/W1": "public" }), trustEnv: undefined }),
    "notion floor: a workspace-level `public` declaration refuses the trust-root page too",
  );
  ok(
    notionSingleWindowPrivacyOk({ ...N, trust: { trusted: true } }, { declared: decl({ "notion/W1": "public", "notion/W1/P1": "internal" }), trustEnv: undefined }),
    "notion floor: most-specific-wins — a page vouched `internal` under a `public` workspace is admitted",
  );
  ok(notionSingleWindowPrivacyOk({ ...N, trust: { trusted: false } }, none) === false, "notion floor: a REFUSED walk (trusted:false) fails closed — a resolved verdict is not a pass");
  ok(notionSingleWindowPrivacyOk({ ...N, trust: undefined }, none) === false, "notion floor: an explicitly undefined verdict fails closed");
  ok(notionSingleWindowPrivacyOk({ ...N }, none) === false, "notion floor: the ABSENT `trust` field (the OPE-492 `no-roots` dispatch) fails closed — never a throw");
  ok(typeof notionSingleWindowPrivacyOk({ ...N, trust: { trusted: true } }, none) === "boolean", "notion floor: the verdict is a synchronous boolean (no async widening of the gate)");

  const trustRootTarget = { discussionId: "disc-tr-1", pageId: "P1", workspaceId: "W1" };
  ok(
    planNotionSingleWindow(true, true, notionSingleWindowPrivacyOk({ ...N, trust: { trusted: true } }, none), trustRootTarget)?.addressing === "direct-mention",
    "🔴 notion floor → seam: a trust-root page's @mention now mints the ADDRESSED unified window (it planned NO window before OPE-540)",
  );
  ok(
    planNotionSingleWindow(true, true, notionSingleWindowPrivacyOk({ ...N, trust: { trusted: false } }, none), trustRootTarget) === undefined,
    "notion floor → seam: a REFUSED walk still plans NO window (the native path, fail-closed)",
  );
}

const teamsAuth = buildTeamsAuth({
  userId: "29:sam-teams",
  userName: "Sam",
  tenantId: "TEN_WIN",
  conversationId: "19:winchan.tacv2;messageid=170001",
  channelId: "19:winchan@thread.tacv2",
  teamId: "team-win",
  serviceUrl: "https://smba.trafficmanager.net/emea/",
  scope: "channel",
});
const vouchedFacts: TeamsSingleWindowFacts = { scope: "channel", membershipType: undefined, tenantId: "TEN_WIN", vouched: true };
const teamsWindow = planTeamsSingleWindow(true, true, vouchedFacts, {
  serviceUrl: "https://smba.trafficmanager.net/emea/",
  conversationId: "19:winchan.tacv2;messageid=170001",
  replyToActivityId: "170001",
  tenantId: "TEN_WIN",
})!;
ok(teamsWindow !== undefined && teamsWindow.addressing === "direct-mention", "teams: the REAL plan mints an ADDRESSED window for a mention on a singleWindow VOUCHED channel");
const teamsWakeRows: SessionTailEntry[] = [];
const teamsDeps: TeamsSupervisorDeps = {
  getOrCreateSession: async () => ({ token: RAW_TOKEN, generation: 1, freshGeneration: false, tail: [] }),
  recordWake: async (entry) => {
    teamsWakeRows.push(entry);
  },
  wake: async ({ token, auth, message, context, window }) => {
    await divertToUnifiedWindow(captureReceive, {
      message,
      context: [...context],
      token,
      window,
      surfaceKey: TEAMS_KEY,
      auth: auth as unknown as { attributes?: Record<string, unknown> },
    });
  },
  now: () => "2026-01-14T02:00:11Z",
};
const teamsIdx = received.length;
const teamsPartition = resolvePartition({ channel: { kind: "teams" }, session: { auth: { current: teamsAuth } } } as never);
await handleTeamsSingleWindowDispatch(
  {
    surfaceKey: TEAMS_KEY,
    containerKey: teamsPartition.surfaceKey,
    channelId: "19:winchan@thread.tacv2",
    auth: teamsAuth,
    trigger: { id: "170002", authorId: "29:sam-teams", authorName: "Sam", sentAt: "2026-01-14T02:00:10Z", text: "@OE what was the deploy window token we agreed?", trust: "peer" },
    threadRootId: "170001",
    window: teamsWindow,
  },
  teamsDeps,
);
{
  ok(received.length === teamsIdx + 1 && received[teamsIdx].channel === unifiedChannel, "teams: the diversion targets the SAME unified channel value");
  ok(received[teamsIdx].target.token === RAW_TOKEN, "teams: the diverted wake carries the SAME raw domain token");
  ok(
    effectiveEveToken(UNIFIED_CHANNEL_NAME, received[0].target.token) === effectiveEveToken(UNIFIED_CHANNEL_NAME, received[teamsIdx].target.token),
    "💥 SINGLE CONTEXT: the Slack wake and the Teams wake resolve ONE identical effective eve token — the sixth-surface proof",
  );
  ok(received[teamsIdx].message.includes('addressing="direct-mention"') && received[teamsIdx].message.includes(`wake-id="${teamsWindow.wakeId}"`), "teams: the delivered wake is the ADDRESSED direct-mention render with the wake-id envelope");
  const a = received[teamsIdx].auth.attributes ?? {};
  ok(a[OE_PLATFORM_ATTR] === "teams" && a[OE_WAKE_ID_ATTR] === teamsWindow.wakeId, "teams: the forwarded auth is stamped with oe_platform + oe_wake_id");
  ok(a[OE_ADDRESSING_ATTR] === "direct-mention", "teams: the forwarded auth carries oe_addressing='direct-mention' (the terminal-prose delivery bridge's arm)");
  ok(
    received[teamsIdx].target.origin.platform === "teams" &&
      (received[teamsIdx].target.origin as { conversationId?: string }).conversationId === "19:winchan.tacv2;messageid=170001" &&
      (received[teamsIdx].target.origin as { replyToActivityId?: string }).replyToActivityId === "170001" &&
      (received[teamsIdx].target.origin as { serviceUrl?: string }).serviceUrl === "https://smba.trafficmanager.net/emea/",
    "teams: the frozen origin names the conversation + reply-chain root + connector host (the reply target)",
  );
  ok(typeof a.conversation_id === "string" && a.conversation_id === "19:winchan.tacv2;messageid=170001", "teams: the surface's own auth attributes ride verbatim (identity binding unchanged)");
}

{
  ok(teamsWakeRows.length === 1, "teams container: the dispatch recorded exactly one wake row (the trigger, never the backscroll)");
  const postWindow = tailWindowFor({
    org: teamsPartition.org,
    domainKey: domainKeyOf(teamsPartition),
    surfaceKey: teamsPartition.surfaceKey,
    rawToken: RAW_TOKEN,
    platform: "teams",
  });
  ok(postWindow !== null, "teams container: a standing Teams seat files a tail window, so its posts DO reach the ring");
  ok(
    teamsWakeRows[0].container === postWindow!.container,
    `💥 TEAMS CONTAINER CONTRACT: the wake row and the post that answers it carry ONE container — wake ${String(teamsWakeRows[0].container)} vs post ${String(postWindow!.container)}`,
  );
  ok(
    domainKeyOf(teamsPartition) !== teamsPartition.surfaceKey,
    "🔴 teams container/CONTROL: the domain key and the surface key really are different strings on Teams — recording the wrong one is a reachable mistake",
  );
  ok(
    teamsWakeRows[0].container !== domainKeyOf(teamsPartition),
    "🔴 teams container: the wake row does NOT carry the domain key — that spelling is the gate/registry/audit key, never the ring's",
  );
}

{
  const f = (over: Partial<TeamsSingleWindowFacts>): TeamsSingleWindowFacts => ({ ...vouchedFacts, ...over });
  ok(teamsSingleWindowPrivacyOk(f({})), "teams floor: vouched + channel scope + tenant → ADMIT");
  ok(teamsSingleWindowPrivacyOk(f({ membershipType: "standard" })) && teamsSingleWindowPrivacyOk(f({ membershipType: "private" })), "teams floor: a positively standard/private channel still needs (and has) the vouch — membershipType alone never admits");
  ok(!teamsSingleWindowPrivacyOk(f({ vouched: false })), "teams floor: UN-VOUCHED → refuse (guest visibility is not knowable in-band — the operator vouches, code enforces)");
  ok(!teamsSingleWindowPrivacyOk(f({ vouched: false, membershipType: "standard" })), "teams floor: membershipType 'standard' does NOT substitute for the vouch (standard channels are guest-visible)");
  ok(!teamsSingleWindowPrivacyOk(f({ membershipType: "shared" })), "teams floor: a SHARED (cross-tenant Teams Connect) channel refuses EVEN WHEN VOUCHED — a positive external fact beats a standing assertion");
  ok(!teamsSingleWindowPrivacyOk(f({ scope: "personal" })) && !teamsSingleWindowPrivacyOk(f({ scope: "groupChat" })) && !teamsSingleWindowPrivacyOk(f({ scope: "unknown" })) && !teamsSingleWindowPrivacyOk(f({ scope: undefined })), "teams floor: personal/groupChat/unknown scopes never join the shared window (channels only)");
  ok(!teamsSingleWindowPrivacyOk(f({ tenantId: undefined })), "teams floor: no tenant anchor → refuse (the org boundary can't be established)");

  _resetSurfacesForTest();
  vouch(TEAMS_WS_KEY);
  ok(isVouchedInternal(TEAMS_WS_KEY, TEAMS_KEY), "teams vouch: a tenant-wide vouch satisfies isVouchedInternal (the any-grain check)");
  ok(isVouchedSurface(TEAMS_KEY), "🔴 teams vouch: a TENANT-wide vouch now satisfies isVouchedSurface too — so teams-front ADMITS the channel on the tenant line alone (OPE-1521)");
  ok(!isVouchedSurface("teams/TEN_OTHER/19-winchan.tacv2"), "🔴 teams vouch NEGATIVE CONTROL: the same channel id under an UNDECLARED tenant is still refused — the walk never reaches across tenants");
  ok(teamsSingleWindowPrivacyOk(f({ vouched: isVouchedSurface(TEAMS_KEY) })), "teams floor: the tenant-line vouch carries through the floor the front reads");
  ok(!teamsSingleWindowPrivacyOk(f({ vouched: isVouchedSurface(TEAMS_KEY), membershipType: "shared" })), "🔴 teams floor: a positively SHARED channel is refused even on the tenant line — the platform signal still demotes");
  _resetSurfacesForTest();
  vouch(TEAMS_KEY);
  ok(isVouchedSurface(TEAMS_KEY), "teams vouch: a CHANNEL-grain vouch admits — an exact declaration still wins its own key");
  ok(!isVouchedSurface("teams/TEN_WIN/19-other.tacv2"), "teams vouch: a channel line narrows to the one channel (a sibling in the same tenant stays refused)");
  _resetSurfacesForTest();

  ok(isTrustedTeamsServiceUrl("https://smba.trafficmanager.net/amer/"), "serviceUrl: the canonical regional Bot Connector host is trusted");
  ok(isTrustedTeamsServiceUrl("https://smba.trafficmanager.net"), "serviceUrl: the bare smba.trafficmanager.net host is trusted");
  ok(isTrustedTeamsServiceUrl("https://sub.botframework.com/v3/"), "serviceUrl: a *.botframework.com host is trusted");
  ok(!isTrustedTeamsServiceUrl("https://evil.example/v3/conversations"), "serviceUrl: an arbitrary https host is REJECTED (no token exfil)");
  ok(!isTrustedTeamsServiceUrl("https://smba.trafficmanager.net.evil.com/"), "serviceUrl: a look-alike suffix host is REJECTED (endsWith is dot-anchored)");
  ok(!isTrustedTeamsServiceUrl("http://smba.trafficmanager.net/"), "serviceUrl: a non-https Bot Framework host is REJECTED");
  ok(!isTrustedTeamsServiceUrl("not a url") && !isTrustedTeamsServiceUrl("") && !isTrustedTeamsServiceUrl(undefined), "serviceUrl: unparseable / empty / non-string → REJECTED (fail-closed)");
  ok(!isTrustedTeamsServiceUrl("https://smba.infra.gov.teams.microsoft.us/v3/"), "serviceUrl: a GCC-High host is REJECTED by default (global cloud only)");
  process.env.OE_TEAMS_SERVICE_HOSTS = "smba.infra.gov.teams.microsoft.us, .infra.dod.teams.microsoft.us";
  ok(isTrustedTeamsServiceUrl("https://smba.infra.gov.teams.microsoft.us/v3/"), "serviceUrl: OE_TEAMS_SERVICE_HOSTS admits an exact sovereign host");
  ok(isTrustedTeamsServiceUrl("https://smba.infra.dod.teams.microsoft.us/v3/"), "serviceUrl: OE_TEAMS_SERVICE_HOSTS admits a .suffix sovereign host");
  ok(isTrustedTeamsServiceUrl("https://smba.trafficmanager.net/amer/"), "serviceUrl: the global default still admits alongside the env additions");
  ok(!isTrustedTeamsServiceUrl("https://evil.example/"), "serviceUrl: the env seam does NOT widen to arbitrary hosts");
  delete process.env.OE_TEAMS_SERVICE_HOSTS;
}

const store = getOperationalStore();

const ope922Require = createRequire(import.meta.url);
const ope922EveRoot = dirname(ope922Require.resolve("eve/package.json"));
const ope922Abs = (rel: string): string => pathToFileURL(join(ope922EveRoot, rel)).href;
const { ContextContainer: Ope922Container, contextStorage: ope922Storage } = await import(ope922Abs("dist/src/context/container.js"));
const { SessionKey: Ope922SessionKey } = await import(ope922Abs("dist/src/context/keys.js"));
function inOpe922Turn<T>(fn: () => Promise<T>): Promise<T> {
  const c = new Ope922Container();
  c.set(Ope922SessionKey, { sessionId: "unified-window-test-ope922", auth: null, turn: 1, parent: undefined });
  return ope922Storage.run(c, fn) as Promise<T>;
}
{
  const sent: Array<{ payload: { message?: string; context?: readonly string[] }; opts: { continuationToken: string; auth: unknown } }> = [];
  let mapVisibleAtSend = false;
  const fakeFrom = ((continuationToken: string) => ({
    async send(message: string, opts: { auth: unknown; context?: readonly string[] }) {
      mapVisibleAtSend = (await resolveUnifiedWakeTarget(store, "default", received[0].target.wakeId)) !== null;
      sent.push({ payload: { message, ...(opts.context ? { context: opts.context } : {}) }, opts: { continuationToken, auth: opts.auth } });
      return {} as never;
    },
  })) as never;
  await withGate(true, async () => {
    await unifiedChannel.receive!({ message: received[0].message, target: received[0].target, auth: received[0].auth as never }, { from: fakeFrom, resolveSession: (async () => undefined) as never });
  });
  ok(sent.length === 1 && sent[0].opts.continuationToken === RAW_TOKEN, "receive: delivers under the RAW domain token (eve prefixes `unified:` — the shared window)");
  ok(mapVisibleAtSend, "receive: the wakeId→origin map entry is durably registered BEFORE the send");
  const origin = await resolveUnifiedWakeTarget(store, "default", received[0].target.wakeId);
  ok(origin !== null && origin.platform === "slack", "receive: the registered origin round-trips from the real store");
  await withGate(true, async () => {
    await unifiedChannel.receive!({ message: received[1].message, target: received[1].target, auth: received[1].auth as never }, { from: fakeFrom, resolveSession: (async () => undefined) as never });
  });
  ok(sent.length === 2 && sent[1].opts.continuationToken === RAW_TOKEN, "receive: the GitHub wake delivers under the SAME raw token (same session)");
  ok(sent[1].payload.context !== undefined, "receive: side-channel context passes through to the delivery");

  await withGate(true, async () => {
    await unifiedChannel.receive!({ message: received[2].message, target: received[2].target, auth: received[2].auth as never }, { from: fakeFrom, resolveSession: (async () => undefined) as never });
  });
  ok(sent.length === 3 && sent[2].opts.continuationToken === RAW_TOKEN, "receive: the Linear wake delivers under the SAME raw token (same session)");
  const linRegistered = await resolveUnifiedWakeTarget(store, "default", received[2].target.wakeId);
  ok(linRegistered !== null && linRegistered.platform === "linear", "receive: the Linear origin round-trips from the real store");

  await withGate(true, async () => {
    await unifiedChannel.receive!({ message: received[3].message, target: received[3].target, auth: received[3].auth as never }, { from: fakeFrom, resolveSession: (async () => undefined) as never });
  });
  ok(sent.length === 4 && sent[3].opts.continuationToken === RAW_TOKEN, "receive: the Notion wake delivers under the SAME raw token (same session)");
  const notRegistered = await resolveUnifiedWakeTarget(store, "default", received[3].target.wakeId);
  ok(notRegistered !== null && notRegistered.platform === "notion", "receive: the Notion origin round-trips from the real store");

  await withGate(true, async () => {
    await unifiedChannel.receive!({ message: received[4].message, target: received[4].target, auth: received[4].auth as never }, { from: fakeFrom, resolveSession: (async () => undefined) as never });
  });
  ok(sent.length === 5 && sent[4].opts.continuationToken === RAW_TOKEN, "receive: the Discord wake delivers under the SAME raw token (same session)");
  const disRegistered = await resolveUnifiedWakeTarget(store, "default", received[4].target.wakeId);
  ok(disRegistered !== null && disRegistered.platform === "discord", "receive: the Discord origin round-trips from the real store");

  {
    const since = new Date(Date.now() - 60_000).toISOString();
    const listed = await store.listPendingUnifiedWakes("default", RAW_TOKEN, since, 50);
    ok(
      listed.some((r) => r.wakeId === received[0].target.wakeId),
      "🔴 receive: an ATTENDED wake is listed as INBOUND from the real store — the freshness gate can see a message from the room",
    );

    const internalWake = mintWakeId();
    await withGate(true, async () => {
      await unifiedChannel.receive!(
        { message: "an internal dispatch", target: { ...received[0].target, wakeId: internalWake, inbound: false }, auth: received[0].auth as never },
        { from: fakeFrom, resolveSession: (async () => undefined) as never },
      );
    });
    ok(
      (await resolveUnifiedWakeTarget(store, "default", internalWake)) !== null,
      "receive/CONTROL: the internal wake IS registered — so the assertion below is about `inbound`, not about a missing row",
    );
    ok(
      !(await store.listPendingUnifiedWakes("default", RAW_TOKEN, since, 50)).some((r) => r.wakeId === internalWake),
      "🔴 receive: an INTERNAL wake is NOT listed — counting one would refuse the hand-off note of every delegating turn",
    );
  }

  await assert.rejects(
    unifiedChannel.receive!(
      { message: "m", target: { ...received[0].target, surfaceKey: "slack/T_OTHER/C_NOPE" }, auth: received[0].auth as never },
      { from: fakeFrom, resolveSession: (async () => undefined) as never },
    ),
    /no standing window is enabled/,
    "receive: an un-flagged surface is REFUSED (fail-closed re-check, defense-in-depth)",
  );
  n++;
  await assert.rejects(
    unifiedChannel.receive!({ message: "m", target: { token: "not-a-supervisor-token", wakeId: "w", surfaceKey: SLACK_KEY, origin: { platform: "slack", channelId: "C" } } as never, auth: null }, { from: fakeFrom, resolveSession: (async () => undefined) as never }),
    /malformed target/,
    "receive: a non-supervisor token is refused (never a mis-keyed session)",
  );
  n++;
  await assert.rejects(
    unifiedChannel.receive!({ message: "m", target: { token: RAW_TOKEN, wakeId: "w", surfaceKey: SLACK_KEY, origin: { platform: "smoke-signal", id: "x" } } as never, auth: null }, { from: fakeFrom, resolveSession: (async () => undefined) as never }),
    /malformed target/,
    "receive: an unknown origin variant is refused",
  );
  n++;
}

{
  const slackPosts: Array<{ channelId: string; threadTs?: string; text: string }> = [];
  const ghPosts: Array<{ owner: string; repo: string; issueNumber: number; text: string }> = [];
  const linPosts: Array<{ agentSessionId?: string; ambient?: true; issueId: string; parentId?: string; text: string }> = [];
  const notPosts: Array<{ discussionId: string; pageId?: string; text: string }> = [];
  const disPosts: Array<{ channelId: string; guildId?: string; messageId?: string; text: string }> = [];
  const deps = {
    postDiscord: async (o: { channelId: string; guildId?: string; messageId?: string }, text: string) => {
      disPosts.push({ channelId: o.channelId, guildId: o.guildId, messageId: o.messageId, text });
      return "dmsg-1";
    },
    postSlack: async (o: { channelId: string; threadTs?: string }, text: string) => {
      slackPosts.push({ channelId: o.channelId, threadTs: o.threadTs, text });
      return "ts-1";
    },
    postGitHub: async (o: { owner: string; repo: string; issueNumber: number }, text: string) => {
      ghPosts.push({ owner: o.owner, repo: o.repo, issueNumber: o.issueNumber, text });
      return "c-1";
    },
    postLinear: async (o: { agentSessionId?: string; ambient?: true; issueId: string; parentId?: string }, text: string) => {
      linPosts.push({ agentSessionId: o.agentSessionId, ambient: o.ambient, issueId: o.issueId, parentId: o.parentId, text });
      return o.ambient ? "lc-ambient" : "lc-1";
    },
    postNotion: async (o: { discussionId: string; pageId?: string }, text: string) => {
      notPosts.push({ discussionId: o.discussionId, pageId: o.pageId, text });
      return "nc-reply-1";
    },
  };
  const TURN_WAKE = received[4].target.wakeId;
  const TURN_ID = "turn-coalesced-1";
  const answerable = (wake: string) => resolveAnswerableReplyTarget(store, "default", TURN_WAKE, RAW_TOKEN, TURN_ID, wake);
  const slackRes = await answerable(received[0].target.wakeId);
  const ghRes = await answerable(ghWindow.wakeId);
  const linRes = await answerable(linWindow.wakeId);
  const notRes = await answerable(notWindow.wakeId);
  const disRes = await answerable(TURN_WAKE);
  ok(disRes.ok && disRes.via === "turn", "coalesced turn: the LAST-delivered (discord) wake resolves via the this-turn arm");
  ok(
    slackRes.ok && slackRes.via === "pending" && ghRes.ok && ghRes.via === "pending" && linRes.ok && linRes.via === "pending" && notRes.ok && notRes.via === "pending",
    "coalesced turn: the FOUR sibling wakes the turn's auth does NOT name all resolve via the PENDING arm — the OPE-161 fix (each was `mismatch` before)",
  );
  const slackOrigin = slackRes.ok ? slackRes.origin : null;
  const ghOrigin = ghRes.ok ? ghRes.origin : null;
  const linOrigin = linRes.ok ? linRes.origin : null;
  const notOrigin = notRes.ok ? notRes.origin : null;
  const disOrigin = disRes.ok ? disRes.origin : null;
  ok(slackOrigin !== null && ghOrigin !== null && linOrigin !== null && notOrigin !== null && disOrigin !== null, "coalesced turn: ALL FIVE pending wakeIds resolve from the map");
  ok(
    slackOrigin!.platform === "slack" && ghOrigin!.platform === "github" && linOrigin!.platform === "linear" && notOrigin!.platform === "notion" && disOrigin!.platform === "discord",
    "coalesced turn: each wakeId resolved to ITS OWN surface's origin through the fence (no cross-surface swap)",
  );
  ok((await postUnifiedReply(slackOrigin!, "answer for slack", deps)) === "ts-1", "reply(slack wakeId) returns the Slack post id");
  ok((await postUnifiedReply(ghOrigin!, "answer for github", deps)) === "c-1", "reply(github wakeId) returns the GitHub comment id");
  ok((await postUnifiedReply(linOrigin!, "answer for linear", deps)) === "lc-1", "reply(linear wakeId) returns the Linear comment id");
  ok((await postUnifiedReply(notOrigin!, "answer for notion", deps)) === "nc-reply-1", "reply(notion wakeId) returns the Notion comment id");
  ok((await postUnifiedReply(disOrigin!, "answer for discord", deps)) === "dmsg-1", "reply(discord wakeId) returns the Discord message id");
  ok(slackPosts.length === 1 && slackPosts[0].channelId === "C_WINA" && slackPosts[0].threadTs === undefined, "Slack reply landed in the Slack channel (top-level, matching the trigger)");
  ok(ghPosts.length === 1 && ghPosts[0].owner === "acme" && ghPosts[0].repo === "payments-api" && ghPosts[0].issueNumber === 55, "GitHub reply landed on the GitHub issue that woke it");
  ok(
    linPosts.length === 1 && linPosts[0].agentSessionId === "as-lin-77" && linPosts[0].issueId === "issue-uuid-77" && linPosts[0].parentId === "comment-uuid-1",
    "Linear reply reached the OPEN agent session that woke it (response Agent Activity — agentSessionId threaded, not commentCreate)",
  );
  ok(notPosts.length === 1 && notPosts[0].discussionId === "disc-win-1", "Notion reply landed in the discussion thread that woke it (createCommentReply discussion_id)");
  ok(
    disPosts.length === 1 && disPosts[0].channelId === "CH_WIN" && disPosts[0].guildId === "G_WIN" && disPosts[0].messageId === "5002",
    "Discord reply landed in the channel that woke it (message_reference anchor carried on the origin)",
  );
  ok(
    slackPosts[0].text === "answer for slack" && ghPosts[0].text === "answer for github" && linPosts[0].text === "answer for linear" && notPosts[0].text === "answer for notion" && disPosts[0].text === "answer for discord",
    "each reply carried ITS OWN text — no cross-surface swap in the coalesced turn",
  );

  {
    const org = "default";
    const iso = () => new Date().toISOString();
    const OTHER_WINDOW = unifiedSupervisorToken("treasury", 1);
    const slackC: UnifiedWakeOrigin = { platform: "slack", channelId: "C_ANS" };

    const wAns = mintWakeId();
    await registerUnifiedWakeTarget(store, org, wAns, slackC, iso(), RAW_TOKEN);
    const before = await resolveAnswerableReplyTarget(store, org, TURN_WAKE, RAW_TOKEN, "turn-1", wAns);
    ok(before.ok && before.via === "pending", "answered lifecycle: an unanswered sibling wake resolves via the pending arm");
    await store.markUnifiedWakeAnswered(org, wAns, iso(), "turn-1");
    const sameTurn = await resolveAnswerableReplyTarget(store, org, TURN_WAKE, RAW_TOKEN, "turn-1", wAns);
    ok(sameTurn.ok && sameTurn.via === "pending", "answered lifecycle: the turn that ANSWERED it may keep replying to it (same-turn re-accept)");
    const laterTurn = await resolveAnswerableReplyTarget(store, org, TURN_WAKE, RAW_TOKEN, "turn-2", wAns);
    ok(!laterTurn.ok && laterTurn.reason === "answered", "answered lifecycle: a LATER turn gets the instructive `answered` refusal");
    const noTurnId = await resolveAnswerableReplyTarget(store, org, TURN_WAKE, RAW_TOKEN, undefined, wAns);
    ok(!noTurnId.ok && noTurnId.reason === "answered", "answered lifecycle: an UNKNOWN turn id compares unequal ⇒ fail-closed `answered` (never a free pass)");

    const wOpen = mintWakeId();
    await registerUnifiedWakeTarget(store, org, wOpen, slackC, iso(), RAW_TOKEN);
    const nextTurn = await resolveAnswerableReplyTarget(store, org, TURN_WAKE, RAW_TOKEN, "turn-9", wOpen);
    ok(nextTurn.ok && nextTurn.via === "pending", "done:false flow: a wake nobody marked stays answerable on a later turn (the F1 recovery handle)");

    const wOther = mintWakeId();
    await registerUnifiedWakeTarget(store, org, wOther, slackC, iso(), OTHER_WINDOW);
    const foreign = await resolveAnswerableReplyTarget(store, org, TURN_WAKE, RAW_TOKEN, TURN_ID, wOther);
    ok(!foreign.ok && foreign.reason === "mismatch", "window fence: a pending wake on ANOTHER window token is REFUSED (cross-domain + task-worker isolation)");
    const wLegacy = mintWakeId();
    await registerUnifiedWakeTarget(store, org, wLegacy, slackC, iso());
    const legacy = await resolveAnswerableReplyTarget(store, org, TURN_WAKE, RAW_TOKEN, TURN_ID, wLegacy);
    ok(!legacy.ok && legacy.reason === "mismatch", "window fence: a LEGACY (pre-migration, NULL window_token) row never qualifies for the pending arm — fail-closed");
    const legacyAsTurn = await resolveAnswerableReplyTarget(store, org, wLegacy, RAW_TOKEN, TURN_ID, wLegacy);
    ok(legacyAsTurn.ok && legacyAsTurn.via === "turn", "window fence: a legacy row is STILL answerable as THIS turn's own wake (arm 2 byte-compatible)");
    const noWindow = await resolveAnswerableReplyTarget(store, org, TURN_WAKE, undefined, TURN_ID, wOpen);
    ok(!noWindow.ok && noWindow.reason === "mismatch", "window fence: no resolvable window token ⇒ arm 4 silently unavailable (honest degrade, no new refusal class)");

    await store.markUnifiedWakeAnswered(org, TURN_WAKE, iso(), "turn-earlier");
    const ownWake = await resolveAnswerableReplyTarget(store, org, TURN_WAKE, RAW_TOKEN, "turn-2", TURN_WAKE);
    ok(ownWake.ok && ownWake.via === "turn", "arm 2 never consults the answered mark — this turn may always re-answer its own wake (multi-reply + redrive preserved)");

    const wStale = mintWakeId();
    const staleAt = new Date(Date.now() - WAKE_TARGET_TTL_MS - 60_000).toISOString();
    await registerUnifiedWakeTarget(store, org, wStale, slackC, staleAt, RAW_TOKEN);
    ok((await resolveUnifiedWakeTarget(store, org, wStale)) !== null, "read-time TTL: the stale row is STILL readable from the store (no prune ran) — the store has no read-time bound");
    const stale = await resolveAnswerableReplyTarget(store, org, TURN_WAKE, RAW_TOKEN, TURN_ID, wStale);
    ok(!stale.ok && stale.reason === "expired", "read-time TTL: the FENCE refuses a past-TTL row as `expired` (arm 4 must not inherit prune-only eviction)");
    const inTtl = await resolveAnswerableReplyTarget(store, org, TURN_WAKE, RAW_TOKEN, TURN_ID, wStale, Date.parse(staleAt) + 60_000);
    ok(inTtl.ok && inTtl.via === "pending", "read-time TTL: the SAME row resolves when `now` sits inside the window (the bound is the clock, not the row)");

    const wRedrive = mintWakeId();
    await registerUnifiedWakeTarget(store, org, wRedrive, slackC, iso(), RAW_TOKEN);
    await store.markUnifiedWakeAnswered(org, wRedrive, iso(), "turn-1");
    await registerUnifiedWakeTarget(store, org, wRedrive, slackC, iso(), RAW_TOKEN);
    const rearmed = await resolveAnswerableReplyTarget(store, org, TURN_WAKE, RAW_TOKEN, "turn-2", wRedrive);
    ok(!rearmed.ok && rearmed.reason === "answered", "redrive/retry: RE-REGISTERING an answered wake does NOT resurrect it (the ON CONFLICT clause never touches the answered columns)");
    const redriven = await resolveAnswerableReplyTarget(store, org, wRedrive, RAW_TOKEN, "turn-2", wRedrive);
    ok(redriven.ok && redriven.via === "turn", "redrive: the corrective wake re-stamps the ORIGINAL id, so the redriven reply still passes on arm 2 (zero redrive code change)");
  }

  {
    const closed: Array<{ agentSessionId?: string; issueId: string }> = [];
    const closeDeps = { closeLinear: async (o: { agentSessionId?: string; issueId: string }) => void closed.push({ agentSessionId: o.agentSessionId, issueId: o.issueId }) };
    const didClose = await completeUnifiedSessionSilently(linOrigin as Extract<UnifiedWakeOrigin, { platform: "linear" }>, closeDeps);
    ok(didClose === true && closed.length === 1 && closed[0].agentSessionId === "as-lin-77" && closed[0].issueId === "issue-uuid-77", "silent turn: completeUnifiedSessionSilently routes the wake's OPEN agent session to the arm (no model prose posted)");
  }

  {
    const ANS_TURN = "turn-ope922";
    const linSession = linOrigin as Extract<UnifiedWakeOrigin, { platform: "linear" }>;
    const sibSameIssue = mintWakeId();
    await registerUnifiedWakeTarget(store, "default", sibSameIssue, { platform: "linear", agentSessionId: "as-lin-78", issueId: "issue-uuid-77", parentId: "comment-uuid-2" }, new Date().toISOString());
    const otherIssue = mintWakeId();
    await registerUnifiedWakeTarget(store, "default", otherIssue, { platform: "linear", agentSessionId: "as-lin-99", issueId: "issue-uuid-99", parentId: "comment-uuid-9" }, new Date().toISOString());
    const slackSibling = mintWakeId();
    await registerUnifiedWakeTarget(store, "default", slackSibling, { platform: "slack", channelId: "C_WINA" }, new Date().toISOString());

    ok(
      (await inOpe922Turn(async () => answeredSameContainerThisTurn("default", ANS_TURN, TURN_WAKE, linSession))) === false,
      "🔴 OPE-922 negative control: a turn that replied to NOTHING answers false — a genuinely silent turn still gets OPE-884's silence ack",
    );

    ok(
      (await inOpe922Turn(async () => {
        markWakeRepliedThisTurn(ANS_TURN, otherIssue);
        return answeredSameContainerThisTurn("default", ANS_TURN, TURN_WAKE, linSession);
      })) === false,
      "🔴 OPE-922 negative control: a reply on ANOTHER Linear issue answers false — the wake here really did get nothing",
    );

    ok(
      (await inOpe922Turn(async () => {
        markWakeRepliedThisTurn(ANS_TURN, slackSibling);
        return answeredSameContainerThisTurn("default", ANS_TURN, TURN_WAKE, linSession);
      })) === false,
      "🔴 OPE-922 negative control: a reply on a SLACK sibling answers false — a cross-surface answer never speaks for this Linear session",
    );

    ok(
      (await inOpe922Turn(async () => {
        markWakeRepliedThisTurn(ANS_TURN, sibSameIssue);
        return answeredSameContainerThisTurn("default", ANS_TURN, TURN_WAKE, linSession);
      })) === true,
      "🔴 OPE-922: a reply on a SIBLING wake of the SAME issue answers TRUE — the room was answered, so the close may not deny it",
    );

    ok(
      (await inOpe922Turn(async () => answeredSameContainerThisTurn("default", ANS_TURN, TURN_WAKE, linSession))) === false,
      "🔴 OPE-922: the gate reads the per-turn REPLY RECORD — an unmarked sibling answers false however much the turn said",
    );

    ok(
      (await inOpe922Turn(async () => {
        markWakeRepliedThisTurn(ANS_TURN, TURN_WAKE);
        return answeredSameContainerThisTurn("default", ANS_TURN, TURN_WAKE, linSession);
      })) === false,
      "OPE-922: the wake being closed is excluded from its own evidence — only a SIBLING can answer for it",
    );

    const flags: boolean[] = [];
    const flagDeps = { closeLinear: async (_o: { issueId: string }, answered?: boolean) => void flags.push(answered === true) };
    await completeUnifiedSessionSilently(linSession, flagDeps, true);
    await completeUnifiedSessionSilently(linSession, flagDeps, false);
    await completeUnifiedSessionSilently(linSession, flagDeps);
    ok(JSON.stringify(flags) === "[true,false,false]", "🔴 OPE-922: completeUnifiedSessionSilently hands the verdict to the arm, and an OMITTED flag stays false (pre-fix behaviour)");
  }

  {
    const TURN_ANSWER = "turn-ope922-answer";
    const TURN_SIBLING = "turn-ope922-sibling";
    const ISSUE_2 = "issue-uuid-88";
    const arrivedAt = new Date(Date.now() - 20_000).toISOString();
    const answerWake = mintWakeId();
    const siblingWake = mintWakeId();
    await registerUnifiedWakeTarget(store, "default", answerWake, { platform: "linear", agentSessionId: "as-lin-88a", issueId: ISSUE_2, parentId: "c-88-1" }, arrivedAt);
    await registerUnifiedWakeTarget(store, "default", siblingWake, { platform: "linear", agentSessionId: "as-lin-88b", issueId: ISSUE_2, parentId: "c-88-2" }, arrivedAt);
    const answerOrigin = await resolveUnifiedWakeTarget(store, "default", answerWake);
    const siblingOrigin = await resolveUnifiedWakeTarget(store, "default", siblingWake);
    ok(answerOrigin !== null && siblingOrigin !== null, "OPE-922 stage 2 fixture: both wakes on the one issue resolve from the map");
    const siblingLinear = siblingOrigin as Extract<UnifiedWakeOrigin, { platform: "linear" }>;

    ok(
      (await inOpe922Turn(async () => answeredContainerVia("default", TURN_SIBLING, siblingWake, siblingLinear))) === undefined,
      "🔴 OPE-922 stage 2 pre-state: with no answer on record the arm answers UNDEFINED — a genuinely silent turn still gets OPE-884's silence ack",
    );

    const postedId = await inOpe922Turn(async () => {
      markWakeRepliedThisTurn(TURN_ANSWER, answerWake);
      return postUnifiedReply(answerOrigin!, "harbor-KX52 is the current codename.", deps, { org: "default", platform: "unified", workspace: "soak", surface: "oe-domain::soak", wakeId: answerWake, route: "tool" });
    });
    ok(typeof postedId === "string" && postedId.length > 0 && postedId !== "deduped:reply", "OPE-922 stage 2: the answer really posted through the REAL unified reply choke point");

    ok(
      (await inOpe922Turn(async () => answeredSameContainerThisTurn("default", TURN_SIBLING, siblingWake, siblingLinear))) === false,
      "🔴 OPE-922 stage 2: the PER-TURN arm answers FALSE from the sibling turn — this is the shipped defect, reproduced",
    );
    ok(
      (await inOpe922Turn(async () => answeredContainerVia("default", TURN_SIBLING, siblingWake, siblingLinear))) === "container",
      "🔴 OPE-922 stage 2 THE FIX: the DURABLE arm answers `container` from the sibling turn — the run-2 sequence cannot render 'Noted — no response needed.' any more",
    );
    ok(
      (await inOpe922Turn(async () => {
        markWakeRepliedThisTurn(TURN_ANSWER, answerWake);
        return answeredContainerVia("default", TURN_ANSWER, siblingWake, siblingLinear);
      })) === "turn",
      "OPE-922 stage 2: a SAME-TURN answer still reports `turn` — the exact arm is preferred and the audit row can tell the two apart",
    );

    const laterWake = mintWakeId();
    await registerUnifiedWakeTarget(store, "default", laterWake, { platform: "linear", agentSessionId: "as-lin-88c", issueId: ISSUE_2, parentId: "c-88-3" }, new Date(Date.now() + 60_000).toISOString());
    ok(
      (await inOpe922Turn(async () => answeredContainerVia("default", TURN_SIBLING, laterWake, siblingLinear))) === undefined,
      "🔴 OPE-922 stage 2 NEGATIVE CONTROL: a wake that arrived AFTER the answer reads UNDEFINED — a stale answer never speaks for a new ask",
    );

    const otherIssueWake = mintWakeId();
    await registerUnifiedWakeTarget(store, "default", otherIssueWake, { platform: "linear", agentSessionId: "as-lin-89", issueId: "issue-uuid-89", parentId: "c-89-1" }, arrivedAt);
    const otherIssueOrigin = (await resolveUnifiedWakeTarget(store, "default", otherIssueWake)) as Extract<UnifiedWakeOrigin, { platform: "linear" }>;
    ok(
      (await inOpe922Turn(async () => answeredContainerVia("default", TURN_SIBLING, otherIssueWake, otherIssueOrigin))) === undefined,
      "🔴 OPE-922 stage 2 NEGATIVE CONTROL: another Linear ISSUE reads UNDEFINED across turns too — the ledger is per-container",
    );

    ok(
      (await inOpe922Turn(async () => answeredContainerVia("default", TURN_SIBLING, "no-such-wake-id", siblingLinear))) === undefined,
      "🔴 OPE-922 stage 2 fail-soft: an unresolvable wake row reads UNDEFINED — no arrival stamp, no claim",
    );
  }

  {
    const ambWakeId = mintWakeId();
    await registerUnifiedWakeTarget(store, "default", ambWakeId, { platform: "linear", ambient: true, issueId: "issue-amb-9", parentId: "c-amb-1" }, new Date().toISOString());
    const ambOrigin = await resolveUnifiedWakeTarget(store, "default", ambWakeId);
    ok(ambOrigin !== null && ambOrigin.platform === "linear" && ambOrigin.ambient === true, "ambient linear origin round-trips + validates (isUnifiedWakeOrigin accepts the ambient variant)");
    ok((await postUnifiedReply(ambOrigin!, "ambient answer", deps)) === "lc-ambient", "reply(ambient linear wakeId) routes to the ambient commentCreate arm");
    const last = linPosts[linPosts.length - 1];
    ok(last.ambient === true && last.agentSessionId === undefined && last.issueId === "issue-amb-9" && last.parentId === "c-amb-1", "ambient linear reply carries issueId+parentId (commentCreate target), NO agentSessionId");
    const closedAmb: Array<{ issueId: string }> = [];
    const didCloseAmb = await completeUnifiedSessionSilently(ambOrigin as Extract<UnifiedWakeOrigin, { platform: "linear" }>, { closeLinear: async (o: { issueId: string }) => void closedAmb.push({ issueId: o.issueId }) });
    ok(didCloseAmb === false && closedAmb.length === 0, "silent turn on an AMBIENT linear origin reaches no arm (no agent session to complete, so no host ack either)");
  }

  ok(isUnifiedWakeOrigin({ platform: "linear", ambient: true, issueId: "i1" }) === true, "validator: ambient linear origin (ambient+issueId, no session) is VALID");
  ok(isUnifiedWakeOrigin({ platform: "linear", agentSessionId: "s1", issueId: "i1" }) === true, "validator: mention linear origin (session+issueId) is VALID");
  ok(isUnifiedWakeOrigin({ platform: "linear", ambient: true, agentSessionId: "s1", issueId: "i1" }) === false, "validator: ambient+session together is INVALID (XOR)");
  ok(isUnifiedWakeOrigin({ platform: "linear", issueId: "i1" }) === false, "validator: neither ambient nor session is INVALID");
  ok(isUnifiedWakeOrigin({ platform: "linear", ambient: true }) === false, "validator: ambient WITHOUT issueId is INVALID (no commentCreate target)");

  const threadedId = mintWakeId();
  await registerUnifiedWakeTarget(store, "default", threadedId, { platform: "slack", channelId: "C_WINA", threadTs: "99.5" }, new Date().toISOString());
  await postUnifiedReply((await resolveUnifiedWakeTarget(store, "default", threadedId))!, "threaded answer", deps);
  ok(slackPosts.length === 2 && slackPosts[1].threadTs === "99.5", "a threaded trigger's reply posts into ITS thread");

  {
    await postUnifiedReply(slackOrigin!, "audited answer", deps, {
      org: "default", platform: "unified", workspace: "dom-win", surface: "oe-dom:dom-win",
      sessionId: "sess-choke", wakeId: received[0].target.wakeId, route: "tool",
    });
    const rows = await store.readAudit({ org: "default", action: "reply.post" });
    const row = rows.find((r) => r.detail?.wakeId === received[0].target.wakeId && r.detail?.sessionId === "sess-choke");
    ok(!!row, "choke point: postUnifiedReply(audit) writes a reply.post row joined by wakeId + sessionId");
    ok(row?.detail?.route === "tool" && row?.detail?.platform === "slack" && row?.detail?.id === "ts-1" && row?.detail?.chars === 14, "choke point: reply.post detail carries route/platform/id/chars (taint-clean)");
    await postUnifiedReply(slackOrigin!, "bridged prose", deps, {
      org: "default", platform: "unified", workspace: "dom-win", surface: "oe-dom:dom-win",
      sessionId: "sess-bridge", wakeId: received[0].target.wakeId, route: "bridge",
    });
    const bridgeRow = (await store.readAudit({ org: "default", action: "reply.post" })).find((r) => r.detail?.sessionId === "sess-bridge");
    ok(bridgeRow?.detail?.route === "bridge", "choke point: the addressed-mention bridge writes reply.post with route:\"bridge\" (no separate prose_delivered row)");
  }

  ok((await resolveUnifiedWakeTarget(store, "default", "no-such-wake")) === null, "an unknown wakeId resolves null (never guessed)");
  await store.putUnifiedWakeTarget("default", "corrupt", "{not json", new Date().toISOString(), WAKE_TARGET_TTL_MS);
  ok((await resolveUnifiedWakeTarget(store, "default", "corrupt")) === null, "a corrupt map row resolves null");
  await store.putUnifiedWakeTarget("default", "wrong-shape", JSON.stringify({ platform: "github", owner: "acme" }), new Date().toISOString(), WAKE_TARGET_TTL_MS);
  ok((await resolveUnifiedWakeTarget(store, "default", "wrong-shape")) === null, "a wrong-shape row resolves null (structural re-validation)");
  ok((await resolveUnifiedWakeTarget(store, "other-org", received[0].target.wakeId)) === null, "the map is org-isolated");

  const oldAt = new Date(Date.now() - WAKE_TARGET_TTL_MS - 60_000).toISOString();
  await store.putUnifiedWakeTarget("default", "stale", JSON.stringify({ platform: "slack", channelId: "C_OLD" }), oldAt, WAKE_TARGET_TTL_MS);
  await store.putUnifiedWakeTarget("default", "fresh", JSON.stringify({ platform: "slack", channelId: "C_NEW" }), new Date().toISOString(), WAKE_TARGET_TTL_MS);
  ok((await resolveUnifiedWakeTarget(store, "default", "stale")) === null, "an expired map row is pruned (the TTL bound)");

  ok(
    isUnifiedWakeOrigin({ platform: "slack", channelId: "C1" }) &&
      isUnifiedWakeOrigin({ platform: "github", owner: "o", repo: "r", issueNumber: 1 }) &&
      isUnifiedWakeOrigin({ platform: "linear", agentSessionId: "as1", issueId: "i1" }) &&
      isUnifiedWakeOrigin({ platform: "linear", agentSessionId: "as1", issueId: "i1", parentId: "p1" }) &&
      isUnifiedWakeOrigin({ platform: "notion", discussionId: "d1" }) &&
      isUnifiedWakeOrigin({ platform: "notion", discussionId: "d1", pageId: "p1", workspaceId: "w1" }) &&
      isUnifiedWakeOrigin({ platform: "discord", channelId: "C1", guildId: "G1" }) &&
      isUnifiedWakeOrigin({ platform: "discord", channelId: "C1", guildId: "G1", messageId: "M1" }),
    "all five origin variants validate (linear needs agentSessionId, ± parentId; notion ± page/workspace; discord ± messageId)",
  );
  ok(
    !isUnifiedWakeOrigin({ platform: "slack" }) &&
      !isUnifiedWakeOrigin({ platform: "github", owner: "o", repo: "r", issueNumber: 0 }) &&
      !isUnifiedWakeOrigin({ platform: "linear" }) &&
      !isUnifiedWakeOrigin({ platform: "linear", issueId: "i1" }) &&
      !isUnifiedWakeOrigin({ platform: "linear", agentSessionId: "", issueId: "i1" }) &&
      !isUnifiedWakeOrigin({ platform: "linear", agentSessionId: "as1", issueId: "" }) &&
      !isUnifiedWakeOrigin({ platform: "linear", agentSessionId: "as1", issueId: "i1", parentId: 5 }) &&
      !isUnifiedWakeOrigin({ platform: "notion" }) &&
      !isUnifiedWakeOrigin({ platform: "notion", discussionId: "" }) &&
      !isUnifiedWakeOrigin({ platform: "notion", discussionId: "d1", pageId: 7 }) &&
      !isUnifiedWakeOrigin({ platform: "discord", channelId: "C1" }) &&
      !isUnifiedWakeOrigin({ platform: "discord", channelId: "C1", guildId: "" }) &&
      !isUnifiedWakeOrigin({ platform: "discord", guildId: "G1" }) &&
      !isUnifiedWakeOrigin({ platform: "discord", channelId: "C1", guildId: "G1", messageId: 5 }) &&
      !isUnifiedWakeOrigin(null) &&
      !isUnifiedWakeOrigin("slack"),
    "missing/invalid fields fail validation (incl. a GUILDLESS discord origin — the DM fence holds on the reply path too)",
  );
}

overrideSettingsForTest({ window: { topology: false } });
{
  received.length = 0;
  baseWakes.length = 0;
  const offDeps: SupervisorRouteDeps = { ...slackBaseDeps, unifiedMeta: () => ({ unified: true }) };
  const out = await routeSupervisorEvent(slackEv, withSingleWindowDiversion(offDeps as ReturnType<typeof liveSupervisorDeps>, captureReceive, SLACK_KEY));
  ok(out.woke === true && baseWakes.length === 1 && received.length === 0, "window OFF: the wake takes the base send path (no diversion), byte-identical");
  ok(baseWakes[0].window === undefined, "window OFF: no window is minted");
  const offGrain = supervisorGrainFor(SLACK_KEY, [ambientTwin, org]);
  const offToken: string = supervisorTokenForGrain(offGrain, 1, () => supervisorToken("C_WINA", 1));
  const offGhToken: string = supervisorTokenForGrain(supervisorGrainFor(GH_KEY, [ambientTwin, org]), 1, () => githubSupervisorToken("acme", "payments-api", 1));
  const offLinToken: string = supervisorTokenForGrain(supervisorGrainFor(LINEAR_KEY, [ambientTwin, org]), 1, () => linearSupervisorToken("T_WINX", 1));
  const offNotToken: string = supervisorTokenForGrain(supervisorGrainFor(NOTION_KEY, [ambientTwin, org]), 1, () => notionSupervisorToken("P_WINPAGE", 1));
  ok(
    offToken === "C_WINA:oe-sup:g1" && offGhToken === "github:acme/payments-api:oe-sup:g1" && offLinToken === "linear:T_WINX:oe-sup:g1" && offNotToken === "notion:P_WINPAGE:oe-sup:g1",
    "gates OFF: the four surfaces resolve DIFFERENT per-container tokens exactly as today",
  );
}
{
  let offWindow: unknown = "sentinel";
  let offMsg = "";
  await handleLinearSupervisorDispatch(
    {
      surfaceKey: LINEAR_KEY,
      admit: admissionFunction("wide"),
      teamId: "T_WINX",
      issueId: "issue-uuid-77",
      issueIdentifier: "ENG-77",
      auth: buildLinearAuth({ organizationId: "O_WIN", teamId: "T_WINX", issueId: "issue-uuid-77", principalId: "sam", commentId: "c2" }),
      ingested: [],
      trigger: { id: "c2", authorId: "sam", sentAt: "2026-01-14T02:00:08Z", text: "plain per-team wake", trust: "peer" as const },
    },
    {
      getOrCreateSession: async () => ({ token: RAW_TOKEN, generation: 1, freshGeneration: false, tail: [] }),
      wake: async ({ message, window }) => {
        offWindow = window;
        offMsg = message;
      },
      now: () => "2026-01-14T02:00:08Z",
    },
  );
  ok(offWindow === undefined, "linear window OFF: the dispatch threads NO window to the wake dep (base send path, byte-identical)");
  ok(!offMsg.includes("wake-id"), "linear window OFF: the wake envelope carries NO wake-id attribute (byte-identical render)");
}
{
  received.length = 0;
  const noIdDeps: SupervisorRouteDeps = { ...slackBaseDeps, wake: async (i) => void received.push({ channel: null, message: i.message, target: { token: i.token } as never, auth: {} }) , unifiedMeta: () => ({ unified: true }) };
  await routeSupervisorEvent(slackEv, noIdDeps);
  ok(!received[0].message.includes("wake-id"), "window OFF: the wake envelope carries NO wake-id attribute (byte-identical render)");
}

{
  const mk = (kind: string, attrs: Record<string, string>): BindableContext => ({
    channel: { kind },
    session: { auth: { current: { attributes: attrs, principalId: "U1", principalType: "slack-user" } } },
  });
  ok(channelPlatform(mk("channel:unified", { oe_platform: "slack", team_id: "T_WIN", channel_id: "C_WINA" })) === "slack", "unified hop: a stamped delivery binds as its ORIGIN platform (hook-context kind form)");
  ok(channelPlatform(mk("unified", { oe_platform: "github" })) === "github", "unified hop: bare kind form too");
  ok(channelPlatform(mk("unified", {})) === "unified", "unified hop: NO stamp → stays 'unified' (no mapper → env-stand-in binding, never a guessed platform)");
  ok(channelPlatform(mk("slack", { oe_platform: "github" })) === "slack", "a NORMAL surface session ignores the stamp entirely (hop is unified-kind-gated)");
  ok(isUnifiedWindowContext(mk("channel:unified", {})) && isUnifiedWindowContext(mk("unified", {})), "isUnifiedWindowContext: true for both unified kind forms");
  ok(!isUnifiedWindowContext(mk("slack", {})), "isUnifiedWindowContext: false for a real surface");
  const b = bindFrom(mk("channel:unified", { oe_platform: "slack", team_id: "T_WIN", channel_id: "C_WINA", channel_type: "channel", is_private: "false", is_ext_shared: "false", trust_checked: "true" }));
  ok(b.platform === "slack" && b.workspace === "T_WIN" && b.surface === "C_WINA" && b.trust === "internal", "bindFrom on a stamped unified delivery resolves the REAL Slack partition (memory/spend/audit unchanged)");
  const stamped = stampUnifiedWindowAuth({ attributes: { team_id: "T1" } as Record<string, unknown> }, "slack", "w-1");
  ok(stamped.attributes?.team_id === "T1" && stamped.attributes?.[OE_PLATFORM_ATTR] === "slack" && stamped.attributes?.[OE_WAKE_ID_ATTR] === "w-1", "stampUnifiedWindowAuth adds the two stamps and preserves existing attributes");
  ok(stamped.attributes?.[OE_SOURCES_ATTR] === undefined, "stampUnifiedWindowAuth stamps NO oe_sources when the arg is omitted (byte-identical to the pre-sources shape — every existing golden untouched)");
  ok(stampUnifiedWindowAuth({ attributes: {} as Record<string, unknown> }, "slack", "w-1", undefined, []).attributes?.[OE_SOURCES_ATTR] === undefined, "stampUnifiedWindowAuth stamps NO oe_sources for an EMPTY vector (spread-safe, still byte-identical-off)");
  const withSources = stampUnifiedWindowAuth({ attributes: { [OE_SOURCES_ATTR]: "stale" } as Record<string, unknown> }, "github", "w-9", undefined, ["github"]);
  ok(withSources.attributes?.[OE_SOURCES_ATTR] === "github", "stampUnifiedWindowAuth stamps oe_sources from the vector and OVERRIDES a forwarded value (single-source child re-derivation)");
  ok(stamped.attributes?.[OE_ADDRESSING_ATTR] === undefined, "stampUnifiedWindowAuth stamps NO oe_addressing for an ambient/watch wake (no addressing arg) — prose stays hard-dropped");
  const addressed = stampUnifiedWindowAuth({ attributes: { team_id: "T1" } as Record<string, unknown> }, "github", "w-2", "direct-mention");
  ok(addressed.attributes?.[OE_ADDRESSING_ATTR] === "direct-mention" && addressed.attributes?.[OE_WAKE_ID_ATTR] === "w-2", "stampUnifiedWindowAuth stamps oe_addressing='direct-mention' for an addressed mention (alongside the platform + wake id)");
  ok(stamped.attributes?.["oe_reply_anchor"] === undefined, "stampUnifiedWindowAuth stamps NO oe_reply_anchor when the arg is omitted (byte-identical — every existing golden untouched)");
  const anchored = stampUnifiedWindowAuth({ attributes: {} as Record<string, unknown> }, "slack", "w-3", "direct-mention", undefined, undefined, "1768504411.235000");
  ok(anchored.attributes?.["oe_reply_anchor"] === "1768504411.235000", "stampUnifiedWindowAuth stamps oe_reply_anchor when the divert passes the origin's replyAnchorTs");
  const bAnchor = bindFrom(mk("channel:unified", { oe_platform: "slack", team_id: "T_WIN", channel_id: "C_WINA", channel_type: "channel", is_private: "false", is_ext_shared: "false", trust_checked: "true", oe_reply_anchor: "1768504411.235000" }));
  ok(bAnchor.threadTs === "1768504411.235000", "bindSlack threadTs falls back to oe_reply_anchor on a top-level-mention divert (approval cards thread under the mention)");
  const bThreaded = bindFrom(mk("channel:unified", { oe_platform: "slack", team_id: "T_WIN", channel_id: "C_WINA", channel_type: "channel", is_private: "false", is_ext_shared: "false", trust_checked: "true", thread_ts: "111.222", oe_reply_anchor: "999.888" }));
  ok(bThreaded.threadTs === "111.222", "bindSlack threadTs prefers a REAL thread_ts over the anchor (a threaded trigger keeps its own thread)");
  ok(shouldBridgeAddressedProse("direct-mention", false, undefined) === true, "bridge gate: an addressed direct-mention that did NOT call reply IS bridged");
  ok(shouldBridgeAddressedProse("direct-mention", true, undefined) === false, "bridge gate: a direct-mention that ALREADY replied is NOT bridged (no double-post)");
  ok(shouldBridgeAddressedProse("channel-watch", false, undefined) === false, "bridge gate: an ambient channel-watch turn is NEVER bridged — prose stays hard-dropped (message-tool-only preserved)");
  ok(shouldBridgeAddressedProse(undefined, false, undefined) === false, "bridge gate: an unstamped (non-single-window / non-addressed) turn is NEVER bridged");
  ok(shouldBridgeAddressedProse("direct-mention", false, "stale-conversation") === false, "🔴 bridge gate: an addressed direct-mention whose reply the host REFUSED is NOT bridged — the bridge must not post what the refusal refused");
  ok(shouldBridgeAddressedProse("direct-mention", false, "should-be-edit") === false, "🔴 bridge gate: …and the same for a should-be-edit refusal, where a bridge post is the second message the policy refused");
  ok(shouldBridgeAddressedProse.length === 3, "OPE-842: the bridge gate takes exactly THREE parameters, none optional — addressing, already-replied, and the blocking refusal");
  ok(bridgeBlockingRefusal([]) === undefined, "bridge refusals: a turn that drew NO refusal blocks nothing — the ordinary bridge path is untouched");
  ok(bridgeBlockingRefusal([REPLY_STALE_REFUSAL_REASON]) === REPLY_STALE_REFUSAL_REASON, "bridge refusals: `stale-conversation` BLOCKS — the host said the room moved on");
  ok(bridgeBlockingRefusal([REPLY_FOLD_REFUSAL_REASON]) === REPLY_FOLD_REFUSAL_REASON, "bridge refusals: `should-be-edit` BLOCKS — the host said fold, not post a second message");
  ok(bridgeBlockingRefusal([WAKE_DECLINED_REFUSAL_REASON]) === WAKE_DECLINED_REFUSAL_REASON, "bridge refusals: `declined-this-turn` BLOCKS — the turn already chose silence for this wake");
  ok(bridgeBlockingRefusal([WAKE_DONE_REFUSAL_REASON]) === WAKE_DONE_REFUSAL_REASON, "bridge refusals: `answered-this-turn` BLOCKS — a bridge post would be the duplicate that guard exists to stop");
  ok(bridgeBlockingRefusal([DELEGATION_PENDING_REFUSAL_REASON]) === undefined, "🔴 bridge refusals: `delegation-pending` does NOT block — OPE-701 decided that case the other way (the prose posts, only the wake MARK is held)");
  ok(bridgeBlockingRefusal([TASK_WAKE_UNREAD_REFUSAL_REASON]) === undefined, "bridge refusals: `task-wake-unread` does NOT block — it objects to the address the model authored, and the bridge authors none");
  ok(bridgeBlockingRefusal(["mismatch"]) === undefined && bridgeBlockingRefusal(["expired"]) === undefined && bridgeBlockingRefusal(["answered"]) === undefined, "bridge refusals: the wake-fence verdicts do NOT block — same reason, the bridge posts to the host-resolved target of its own wake");
  ok(bridgeBlockingRefusal([DELEGATION_PENDING_REFUSAL_REASON, REPLY_FOLD_REFUSAL_REASON]) === REPLY_FOLD_REFUSAL_REASON, "bridge refusals: a mixed turn reports the BLOCKING reason, not the first one it drew");
  ok(BRIDGE_BLOCKING_REFUSALS.includes(REPLY_STALE_REFUSAL_REASON), "🔴 reason pin: the freshness gate's constant is in the blocking list — a rename must not silently unblock the bridge");
  ok(BRIDGE_BLOCKING_REFUSALS.includes(REPLY_FOLD_REFUSAL_REASON), "🔴 reason pin: the should-be-edit constant is in the blocking list");
  ok(BRIDGE_BLOCKING_REFUSALS.includes(WAKE_DECLINED_REFUSAL_REASON), "🔴 reason pin: the no_reply-declined constant is in the blocking list");
  ok(BRIDGE_BLOCKING_REFUSALS.includes(WAKE_DONE_REFUSAL_REASON), "🔴 reason pin: the answered-this-turn constant is in the blocking list");
  ok(!BRIDGE_BLOCKING_REFUSALS.includes(DELEGATION_PENDING_REFUSAL_REASON), "🔴 reason pin: the delegation-pending constant is NOT in the blocking list — OPE-701's ruling stands");
  const pol = (sw: boolean, m: boolean, priv: boolean) => singleWindowMentionPolicy(sw, m, priv);
  ok(pol(true, true, true).suppressNative === true && pol(true, true, true).addressing === "direct-mention", "mention seam (sw=1,m=1,priv=1): native SUPPRESSED and the wake is addressed 'direct-mention' — the unified window owns the mention");
  ok(pol(true, true, false).suppressNative === false && pol(true, true, false).addressing === undefined, "mention seam (sw=1,m=1,priv=0): public/unknown-privacy repo — native KEPT, no addressed stamp (fail-closed on privacy)");
  ok(pol(true, false, true).suppressNative === false && pol(true, false, true).addressing === undefined, "mention seam (sw=1,m=0,priv=1): a NON-mention never suppresses the native path and is never addressed (ambient/watch treatment)");
  ok(pol(true, false, false).suppressNative === false && pol(true, false, false).addressing === undefined, "mention seam (sw=1,m=0,priv=0): non-mention on a public repo — nothing");
  ok(pol(false, true, true).suppressNative === false && pol(false, true, true).addressing === undefined, "mention seam (sw=0,m=1,priv=1): single-window OFF — byte-identical split (native owns the mention, no stamp)");
  ok(pol(false, true, false).suppressNative === false && pol(false, true, false).addressing === undefined, "mention seam (sw=0,m=1,priv=0): single-window OFF, public — nothing");
  ok(pol(false, false, true).suppressNative === false && pol(false, false, true).addressing === undefined, "mention seam (sw=0,m=0,priv=1): single-window OFF, non-mention — nothing");
  ok(pol(false, false, false).suppressNative === false && pol(false, false, false).addressing === undefined, "mention seam (sw=0,m=0,priv=0): all off — nothing");
  for (const sw of [true, false]) for (const m of [true, false]) for (const priv of [true, false]) {
    const p = pol(sw, m, priv);
    ok((p.addressing === "direct-mention") === p.suppressNative, `mention seam complementarity: addressing ⟺ suppressNative (sw=${sw},m=${m},priv=${priv})`);
  }
  const addressedCtx: BindableContext = { channel: { kind: "channel:unified" }, session: { auth: { current: { attributes: { oe_addressing: "direct-mention", oe_wake_id: "w-2" }, principalId: "U", principalType: "github-user" } } } };
  ok(currentTurnAddressing(addressedCtx) === "direct-mention", "currentTurnAddressing reads the current delivery's oe_addressing stamp");
  ok(currentTurnAddressing({ channel: { kind: "channel:unified" }, session: { auth: { current: { attributes: { oe_wake_id: "w-3" }, principalId: "U", principalType: "slack-user" } } } }) === undefined, "currentTurnAddressing is undefined for an ambient wake (no oe_addressing) ⇒ never bridged");
}

{
  type Handler = (event: unknown, ctx: unknown) => unknown;
  interface Armed {
    readonly execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
  }
  const arm = (def: unknown, ctx: unknown): Armed | null => (def as { events: Record<string, Handler> }).events["session.started"]({}, ctx) as Armed | null;

  const unifiedCtx = (platform: string, wakeId?: string): BindableContext => ({
    channel: { kind: "channel:unified" },
    session: {
      auth: {
        current: {
          attributes: { oe_platform: platform, ...(wakeId ? { oe_wake_id: wakeId } : {}), channel_id: "C_WINA", team_id: "T_WIN" },
          principalId: "U1",
          principalType: "slack-user",
        },
      },
    },
  });

  ok(currentWakeId(unifiedCtx("slack", "wake-abc")) === "wake-abc", "currentWakeId reads the current delivery's oe_wake_id stamp");
  ok(currentWakeId(unifiedCtx("slack")) === undefined, "currentWakeId is undefined with no stamp (off the single-window path)");

  const turnWake = mintWakeId();
  const armedReply = arm(replyTool, unifiedCtx("github", turnWake));
  ok(armedReply !== null, "reply arms its unified (map-addressed) variant on a unified session");
  const strayWake = mintWakeId();
  await store.putUnifiedWakeTarget("default", strayWake, JSON.stringify({ platform: "slack", channelId: "C_OTHER" }), new Date().toISOString(), WAKE_TARGET_TTL_MS);
  await assert.rejects(
    () => armedReply!.execute({ text: "exfil", wake: strayWake }, unifiedCtx("github", turnWake)),
    /is not a wake you can answer/,
    "reply REFUSES a wakeId that isn't answerable by this session — even one live in the org-wide map (authority-bleed fence, finding 1a: the ctx carries no window token, so the pending arm can't admit it either)",
  );
  n++;
  await assert.rejects(
    () => armedReply!.execute({ text: "answer", wake: turnWake }, unifiedCtx("github", turnWake)),
    /no longer on record|expired/,
    "reply lets THIS turn's own wakeId PAST the fence (then fails at resolve, unregistered) — the demo's own-wake reply path is intact",
  );
  n++;
  {
    const windowedCtx = (wakeId: string, turnId: string): BindableContext => ({
      channel: { kind: "channel:unified", continuationToken: `unified:${RAW_TOKEN}` },
      session: {
        turn: { id: turnId },
        auth: { current: { attributes: { oe_platform: "slack", oe_wake_id: wakeId, oe_window_token: RAW_TOKEN, channel_id: "C_WINA", team_id: "T_WIN" }, principalId: "U1", principalType: "slack-user" } },
      },
    } as unknown as BindableContext);
    const wDone = mintWakeId();
    const wThisTurn = mintWakeId();
    await registerUnifiedWakeTarget(store, "default", wDone, { platform: "slack", channelId: "C_DONE" }, new Date().toISOString(), RAW_TOKEN);
    await registerUnifiedWakeTarget(store, "default", wThisTurn, { platform: "slack", channelId: "C_LIVE" }, new Date().toISOString(), RAW_TOKEN);
    await store.markUnifiedWakeAnswered("default", wDone, new Date().toISOString(), "turn-earlier");
    const armedWindowed = arm(replyTool, windowedCtx(wThisTurn, "turn-now"));
    await assert.rejects(
      () => armedWindowed!.execute({ text: "again", wake: wDone }, windowedCtx(wThisTurn, "turn-now")),
      /you already replied to wake-id/,
      "reply: an ALREADY-ANSWERED pending wake draws the instructive `answered` refusal through the real tool (raised at the fence — nothing is posted)",
    );
    n++;
  }

  {
    const slackThreadA: UnifiedWakeOrigin = { platform: "slack", channelId: "C_DA", threadTs: "1700.1" };
    const slackThreadAWithAnchor: UnifiedWakeOrigin = { platform: "slack", channelId: "C_DA", threadTs: "1700.1", replyAnchorTs: "1700.9" };
    const slackThreadB: UnifiedWakeOrigin = { platform: "slack", channelId: "C_DB", threadTs: "1700.1" };
    const githubIssue: UnifiedWakeOrigin = { platform: "github", owner: "o", repo: "r", issueNumber: 7 };
    ok(sameUnifiedConversation(slackThreadA, slackThreadAWithAnchor), "sameUnifiedConversation: same thread, differing only in a UX anchor ⇒ same");
    ok(!sameUnifiedConversation(slackThreadA, slackThreadB), "sameUnifiedConversation: different channel ⇒ different");
    ok(!sameUnifiedConversation(slackThreadA, githubIssue), "sameUnifiedConversation: different platform ⇒ different");

    const org = "default";
    const iso = () => new Date().toISOString();
    const wFast = mintWakeId();
    await registerUnifiedWakeTarget(store, org, wFast, slackThreadA, iso());
    const fast = await resolveAnswerableReplyTarget(store, org, wFast, undefined, undefined, wFast);
    ok(fast.ok && sameUnifiedConversation(fast.origin, slackThreadA) && fast.via === "turn", "resolveAnswerableReplyTarget: fast path (echo THIS turn's wake) resolves the origin via the turn arm");

    const wTurn = mintWakeId();
    const wOrig = mintWakeId();
    await registerUnifiedWakeTarget(store, org, wTurn, slackThreadA, iso());
    await registerUnifiedWakeTarget(store, org, wOrig, slackThreadAWithAnchor, iso());
    const delegated = await resolveAnswerableReplyTarget(store, org, wTurn, undefined, undefined, wOrig);
    ok(delegated.ok && sameUnifiedConversation(delegated.origin, slackThreadA) && delegated.via === "same-conversation", "resolveAnswerableReplyTarget: a delegated completion turn MAY answer the original ask's wake (same conversation) — the fix");

    const wTurnB = mintWakeId();
    const wCross = mintWakeId();
    await registerUnifiedWakeTarget(store, org, wTurnB, slackThreadA, iso());
    await registerUnifiedWakeTarget(store, org, wCross, slackThreadB, iso());
    const cross = await resolveAnswerableReplyTarget(store, org, wTurnB, undefined, undefined, wCross);
    ok(!cross.ok && cross.reason === "mismatch", "resolveAnswerableReplyTarget: a wake naming a DIFFERENT conversation is REFUSED (authority-bleed fence intact)");
    const crossWindowed = await resolveAnswerableReplyTarget(store, org, wTurnB, RAW_TOKEN, "turn-x", wCross);
    ok(!crossWindowed.ok && crossWindowed.reason === "mismatch", "resolveAnswerableReplyTarget: a DIFFERENT-conversation wake that is not pending on THIS window is refused even with a window token");

    const noTurn = await resolveAnswerableReplyTarget(store, org, undefined, undefined, undefined, wOrig);
    ok(!noTurn.ok && noTurn.reason === "mismatch", "resolveAnswerableReplyTarget: no current-turn wake ⇒ refused");
    const noTurnWindowed = await resolveAnswerableReplyTarget(store, org, undefined, RAW_TOKEN, "turn-x", wOrig);
    ok(!noTurnWindowed.ok && noTurnWindowed.reason === "mismatch", "resolveAnswerableReplyTarget: arm 1 wins over arm 4 — a session with no wake stamp is refused even holding a window token");

    const wGone = mintWakeId();
    const expired = await resolveAnswerableReplyTarget(store, org, wGone, undefined, undefined, wGone);
    ok(!expired.ok && expired.reason === "expired", "resolveAnswerableReplyTarget: this-turn wake with no live map row ⇒ expired");
  }
  n++;

  {
    const org = "default";
    const iso = () => new Date().toISOString();
    const CH = "C_1824";
    const trigger: UnifiedWakeOrigin = { platform: "slack", channelId: CH, replyAnchorTs: "1774431764.813000" };
    const anchorlessSibling: UnifiedWakeOrigin = { platform: "slack", channelId: CH };
    const olderTopLevel: UnifiedWakeOrigin = { platform: "slack", channelId: CH, replyAnchorTs: "1773391920.000100" };
    const otherThread: UnifiedWakeOrigin = { platform: "slack", channelId: CH, threadTs: "1772694120.000001" };
    ok(sameUnifiedConversation(trigger, anchorlessSibling), "OPE-1824: an ANCHORLESS top-level origin is the SAME conversation as the trigger (thread key is the channel id)");
    ok(sameUnifiedConversation(trigger, olderTopLevel), "OPE-1824: two DIFFERENT top-level messages in one channel are the same conversation too");
    ok(!sameUnifiedConversation(trigger, otherThread), "OPE-1824 negative control: a real THREAD in the same channel is a DIFFERENT conversation");

    const wTrigger = mintWakeId();
    const wAnchorless = mintWakeId();
    const wOlder = mintWakeId();
    const wThread = mintWakeId();
    await registerUnifiedWakeTarget(store, org, wTrigger, trigger, iso());
    await registerUnifiedWakeTarget(store, org, wAnchorless, anchorlessSibling, iso());
    await registerUnifiedWakeTarget(store, org, wOlder, olderTopLevel, iso());
    await registerUnifiedWakeTarget(store, org, wThread, otherThread, iso());

    const carried = await resolveAnswerableReplyTarget(store, org, wTrigger, undefined, undefined, wAnchorless);
    ok(carried.ok && carried.via === "same-conversation", "OPE-1824: an anchorless sibling wake is still ADMITTED (the fence is unchanged)");
    ok(
      carried.ok && (carried.origin as { replyAnchorTs?: string }).replyAnchorTs === "1774431764.813000",
      "🔴 OPE-1824: …and it carries THIS TURN's reply anchor, so the answer hangs under the message that woke the seat",
    );
    ok(
      carried.ok && slackThreadTarget(carried.origin as { threadTs?: string; replyAnchorTs?: string }) === "1774431764.813000",
      "🔴 OPE-1824: the Slack post arm reads that anchor as its thread_ts — the reply is NOT flat on the channel",
    );
    ok(
      carried.ok && (carried.origin as { channelId?: string }).channelId === CH && (carried.origin as { threadTs?: string }).threadTs === undefined,
      "OPE-1824: the carry places the post and never MOVES it — same channel, and no thread scope invented",
    );

    const kept = await resolveAnswerableReplyTarget(store, org, wTrigger, undefined, undefined, wOlder);
    ok(
      kept.ok && (kept.origin as { replyAnchorTs?: string }).replyAnchorTs === "1773391920.000100",
      "OPE-1824 negative control: an echoed wake that already names a message KEEPS its own anchor",
    );

    const fast = await resolveAnswerableReplyTarget(store, org, wAnchorless, undefined, undefined, wAnchorless);
    ok(
      fast.ok && fast.via === "turn" && (fast.origin as { replyAnchorTs?: string }).replyAnchorTs === undefined,
      "OPE-1824 negative control: arm 2 is untouched — a turn answering its OWN anchorless wake still posts flat (a routine fire answers no message)",
    );

    const refused = await resolveAnswerableReplyTarget(store, org, wTrigger, undefined, undefined, wThread);
    ok(!refused.ok && refused.reason === "mismatch", "OPE-1824 negative control: a DIFFERENT conversation in the same channel is still REFUSED");

    const threadTurn = mintWakeId();
    await registerUnifiedWakeTarget(store, org, threadTurn, { platform: "slack", channelId: CH, threadTs: "1772694120.000001", replyAnchorTs: "1772694120.000009" }, iso());
    const inThread = await resolveAnswerableReplyTarget(store, org, threadTurn, undefined, undefined, wThread);
    ok(
      inThread.ok && (inThread.origin as { replyAnchorTs?: string }).replyAnchorTs === undefined && slackThreadTarget(inThread.origin as { threadTs?: string; replyAnchorTs?: string }) === "1772694120.000001",
      "OPE-1824 negative control: a THREADED echoed origin gains no anchor — its own thread already places the answer",
    );

    const realCodec = wakeOriginCodec("slack")!;
    registerWakeOriginCodec("slack", { ...realCodec, carryPlacement: () => ({ platform: "slack", channelId: "C_ELSEWHERE", threadTs: "9999.9" }) } as never);
    try {
      const hostile = await resolveAnswerableReplyTarget(store, org, wTrigger, undefined, undefined, wAnchorless);
      ok(
        hostile.ok && (hostile.origin as { channelId?: string }).channelId === CH && (hostile.origin as { threadTs?: string }).threadTs === undefined,
        "🔴 OPE-1824: an arm that tries to MOVE the post is discarded — the fence re-tests the carried origin's conversation and hands back the target",
      );
    } finally {
      registerWakeOriginCodec("slack", realCodec as never);
    }
    const restored = await resolveAnswerableReplyTarget(store, org, wTrigger, undefined, undefined, wAnchorless);
    ok(
      restored.ok && (restored.origin as { replyAnchorTs?: string }).replyAnchorTs === "1774431764.813000",
      "OPE-1824: the shipped Slack arm is restored after the hostile-arm control",
    );
  }
  n++;

  noThrow(() => assertTurnSurface(unifiedCtx("slack"), "slack"), "assertTurnSurface: a slack-origin unified turn MAY read slack");
  throws(() => assertTurnSurface(unifiedCtx("github"), "slack"), "assertTurnSurface: a GITHUB-origin unified turn may NOT read slack (finding 1b)");
  noThrow(() => assertTurnSurface({ channel: { kind: "slack" }, session: { auth: { current: { attributes: {}, principalId: "U", principalType: "slack-user" } } } }, "slack"), "assertTurnSurface: a slack session reading slack passes (the mount gate's own case)");

  const toolCtx = (attrs: Record<string, string>): BindableContext => ({
    session: { auth: { current: { attributes: attrs, principalId: "U1", principalType: "slack-user" } } },
  });
  ok(turnOriginPlatform(toolCtx({ oe_platform: "github" })) === "github", "turnOriginPlatform: a channel-less (tool) context reads the delivery's own oe_platform stamp");
  ok(turnOriginPlatform(toolCtx({})) === undefined, "turnOriginPlatform: an unplaceable context names NO origin (never the `local` stand-in)");
  ok(!isUnifiedWindowContext(toolCtx({ oe_platform: "github", oe_window_token: "oe-dom:d:win:slack_T_C:oe-sup:g1" })), "isUnifiedWindowContext stays FALSE on a tool context — the reason the fence used to return early");
  throws(() => assertTurnSurface(toolCtx({ oe_platform: "github" }), "slack"), "assertTurnSurface FIRES on a tool-shaped GitHub-origin turn (OPE-729 — this silently passed before)");
  noThrow(() => assertTurnSurface(toolCtx({ oe_platform: "slack" }), "slack"), "assertTurnSurface: a tool-shaped slack-origin turn MAY read slack (the negative control)");
  throws(() => assertTurnSurface(toolCtx({}), "slack"), "assertTurnSurface FAILS CLOSED on a context whose origin it cannot name");
  throws(() => assertTurnSurface({ channel: { kind: "subagent" }, session: { auth: { current: { attributes: { oe_platform: "github" } } } } }, "slack"), "assertTurnSurface FIRES on a delegated worker of a github-origin turn (kind `subagent`, never `unified`)");

}

{
  const withStamp: BindableContext = {
    channel: { kind: "channel:unified", continuationToken: "unified:oe-dom:payments:oe-sup:g1" },
    session: { auth: { current: { attributes: { oe_platform: "slack", oe_sources: "slack,github" }, principalId: "U", principalType: "slack-user" } } },
  };
  ok(JSON.stringify(windowSourcesOf(withStamp)) === JSON.stringify(["slack", "github"]), "windowSourcesOf reads the oe_sources stamp back to a vector");
  ok(JSON.stringify(resolveWindowSources(withStamp, [winDomain, org])) === JSON.stringify(["slack", "github"]), "resolveWindowSources returns the stamp verbatim when present (PRIMARY)");

  const noStamp: BindableContext = { channel: { kind: "slack" }, session: { auth: { current: { attributes: { oe_platform: "slack" }, principalId: "U", principalType: "slack-user" } } } };
  ok(windowSourcesOf(noStamp) === undefined, "windowSourcesOf is undefined with no oe_sources stamp (a normal/pre-stamp session)");

  const stampless: BindableContext = {
    channel: { kind: "channel:unified", continuationToken: "unified:oe-dom:payments:oe-sup:g1" },
    session: { auth: { current: { attributes: { oe_platform: "slack" }, principalId: "U", principalType: "slack-user" } } },
  };
  ok(
    JSON.stringify([...resolveWindowSources(stampless, [winDomain, org])].sort()) === JSON.stringify(["discord", "github", "linear", "notion", "slack", "teams"]),
    "resolveWindowSources recomputes the domain's platforms from the token when the stamp is absent",
  );

  const unresolvable: BindableContext = {
    channel: { kind: "channel:unified", continuationToken: "C_PAY:oe-sup:g1" },
    session: { auth: { current: { attributes: { oe_platform: "github" }, principalId: "U", principalType: "github-user" } } },
  };
  ok(JSON.stringify(resolveWindowSources(unresolvable, [winDomain, org])) === JSON.stringify(["github"]), "resolveWindowSources fails closed to the SINGLE origin platform when neither stamp nor token resolves");

  const toolStampless: BindableContext = {
    session: { auth: { current: { attributes: { oe_platform: "slack", oe_window_token: "oe-dom:payments:oe-sup:g1" }, principalId: "U", principalType: "slack-user" } } },
  };
  ok(
    JSON.stringify([...resolveWindowSources(toolStampless, [winDomain, org])].sort()) === JSON.stringify(["discord", "github", "linear", "notion", "slack", "teams"]),
    "resolveWindowSources recomputes from the oe_window_token stamp when there is no channel (the tool-execute shape)",
  );
  const toolNative: BindableContext = {
    session: { auth: { current: { attributes: { oe_platform: "slack" }, principalId: "U", principalType: "slack-user" } } },
  };
  ok(JSON.stringify(resolveWindowSources(toolNative, [winDomain, org])) === JSON.stringify(["slack"]), "resolveWindowSources fails closed to the turn's ORIGIN on a channel-less context (was: the empty vector)");
  ok(JSON.stringify(resolveWindowSources({ session: {} }, [winDomain, org])) === JSON.stringify([]), "resolveWindowSources still answers EMPTY for a context that names nothing at all (fail-closed, unchanged)");
}

{
  const ORG = deploymentOrg();
  const slackAuth = { attributes: { team_id: "T_WIN", channel_id: "C_WINA", channel_type: "channel" } };
  const dcAuth = authForRelayMessage(discordMsg({}))!;
  const surfaces = [
    { platform: "slack", key: SLACK_KEY, auth: slackAuth as unknown as { attributes?: Record<string, unknown> }, origin: { platform: "slack", channelId: "C_WINA" } as UnifiedWakeOrigin },
    { platform: "github", key: GH_KEY, auth: ghAuth as unknown as { attributes?: Record<string, unknown> }, origin: { platform: "github", owner: "acme", repo: "payments-api", issueNumber: 55 } as UnifiedWakeOrigin },
    { platform: "linear", key: LINEAR_KEY, auth: linAuth as unknown as { attributes?: Record<string, unknown> }, origin: { platform: "linear", agentSessionId: "as-1", issueId: "issue-uuid-77" } as UnifiedWakeOrigin },
    { platform: "notion", key: NOTION_KEY, auth: notAuth as unknown as { attributes?: Record<string, unknown> }, origin: { platform: "notion", discussionId: "disc-win-1", pageId: "P_WINPAGE" } as UnifiedWakeOrigin },
    { platform: "discord", key: DISCORD_KEY, auth: dcAuth as unknown as { attributes?: Record<string, unknown> }, origin: { platform: "discord", channelId: "CH_WIN", guildId: "G_WIN" } as UnifiedWakeOrigin },
    { platform: "teams", key: TEAMS_KEY, auth: teamsAuth as unknown as { attributes?: Record<string, unknown> }, origin: { platform: "teams", serviceUrl: "https://smba.trafficmanager.net/emea/", conversationId: "19:winchan.tacv2;messageid=170001", replyToActivityId: "170001" } as UnifiedWakeOrigin },
  ] as const;

  const partitionFor = (s: { platform: string; auth: { attributes?: Record<string, unknown> } }) =>
    resolvePartition({ channel: { kind: s.platform }, session: { auth: { current: s.auth } } } as unknown as BindableContext);
  const capKeyFor = (s: (typeof surfaces)[number]): string => domainKeyOf(partitionFor(s));
  for (const s of surfaces) {
    if (s.platform === "teams") {
      ok(capKeyFor(s) !== partitionFor(s).surfaceKey, "spend gate: the teams divert caps the CHANNEL grain (domainKeyOf), NOT the per-reply-chain surface key — the grain a cap is declared on");
      continue;
    }
    ok(capKeyFor(s) === s.key, `spend gate: the ${s.platform} divert caps the fixture's domain-grain key (${s.key}) — the key a cap is declared on`);
  }

  const refusals: Array<{ platform: string; text: string }> = [];
  const liveArms = surfaces.map((s) => postArm(s.platform)!);
  for (const s of surfaces) {
    registerPostArm({
      ...(postArm(s.platform) as PostArm),
      platform: s.platform,
      dispatchUnified: async (_origin, text) => {
        refusals.push({ platform: s.platform, text });
        return `captured-${s.platform}`;
      },
    });
  }

  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [winDomain, org],
    loadSilos: () => [],
    domainsForSurface: ({ surface }) => (["C_WINA", "payments-api", "T_WINX", "P_WINPAGE", "CH_WIN", "19-winchan.tacv2"].includes(surface) ? ["payments"] : []),
    loadSpendBudgets: () => ({ perSurface: Object.fromEntries(surfaces.map((s) => [capKeyFor(s), { surfaceMonthlyTokens: 1 }])) }),
  });
  const nowIso = new Date().toISOString();
  for (const s of surfaces) {
    await recordSpend(partitionFor(s), { period: periodOf(nowIso), usage: { inputTokens: 100, outputTokens: 100 } });
  }

  const divert = (s: (typeof surfaces)[number], extra: Record<string, unknown> = {}) =>
    divertToUnifiedWindow(captureReceive, {
      message: `<wake>an attended mention on ${s.platform}</wake>`,
      token: RAW_TOKEN,
      window: { wakeId: mintWakeId(), origin: s.origin, addressing: "direct-mention" },
      surfaceKey: s.key,
      auth: s.auth,
      ...extra,
    });

  for (const s of surfaces) {
    const before = received.length;
    refusals.length = 0;
    await divert(s);
    ok(received.length === before, `spend gate: an over-budget ${s.platform} single-window mention is DECLINED at the divert — nothing reaches the unified channel (no model turn)`);
    ok(
      refusals.length === 1 && refusals[0]!.platform === s.platform && refusals[0]!.text.includes(capKeyFor(s)),
      `spend gate: the ${s.platform} decline posts a VISIBLE refusal through that surface's OWN post arm, naming the scope key an override must target`,
    );
    ok(refusals[0]!.text.includes("holding off"), `spend gate: the ${s.platform} refusal is the ONE shared copy (spend/ingress-gate.ts), not a per-surface fork`);
  }

  {
    const rows = (await readAudit({ org: ORG, action: "spend.gate" })).filter((r) => r.detail?.door === "window");
    ok(rows.length === surfaces.length, `spend gate: each declined divert writes exactly ONE spend.gate row (${surfaces.length} surfaces, ${rows.length} rows)`);
    ok(
      surfaces.every((s) => rows.some((r) => r.detail?.key === capKeyFor(s) && r.detail?.over === true)),
      "spend gate: every row names the SPEND-GRAIN key that tripped (domainKeyOf), over:true",
    );
  }

  {
    const before = received.length;
    refusals.length = 0;
    await divert(surfaces[0], { internalDispatch: true });
    ok(received.length === before + 1, "spend gate: an INTERNAL dispatch (completion/spawn/redrive/fire) on the SAME over-budget scope is DELIVERED — never starved of an admitted result");
    ok(refusals.length === 0, "spend gate: an internal dispatch posts NO refusal (the silent-routine carve-out is not reachable through this door)");
  }

  {
    registerConfig({
      loadBundles: () => [],
      loadBindings: () => [],
      pluginRegistry: {},
      skillContent: {},
      loadDomains: () => [winDomain, org],
      loadSilos: () => [],
      domainsForSurface: ({ surface }) => (["C_WINA", "payments-api", "T_WINX", "P_WINPAGE", "CH_WIN", "19-winchan.tacv2"].includes(surface) ? ["payments"] : []),
      loadSpendBudgets: () => ({}),
    });
    const before = received.length;
    refusals.length = 0;
    await divert(surfaces[1]);
    ok(received.length === before + 1 && refusals.length === 0, "spend gate: with the cap removed the SAME wake is delivered, un-refused (the gate admits under budget — it is not a one-way door)");
  }

  {
    await divert(surfaces[0]);
    ok(received[received.length - 1]!.target.inbound === true, "🔴 inbound decision: an ATTENDED divert marks the wake INBOUND — the freshness gate can see a message from the room");

    await divert(surfaces[0], { internalDispatch: true });
    ok(
      received[received.length - 1]!.target.inbound === false,
      "🔴 inbound decision: an INTERNAL dispatch (task spawn / completion wake / approval decision / redrive) is NOT inbound — counting one would refuse the hand-off note of every delegating turn",
    );
  }

  for (const arm of liveArms) registerPostArm(arm);
}

{
  _resetSurfacesForTest();
  await import("../agent/identity/surfaces.js");
  const { loadDomains } = await import("../agent/memory/config/domains.js");
  const unified = loadDomains().find((d) => d.name === "e2e-unified");
  ok(unified !== undefined, "real config: the e2e-unified domain exists — without it this block measures nothing");
  const teamsMembers = (unified?.reach ?? []).filter((c) => c.startsWith("teams/"));
  ok(teamsMembers.length === 1, `real config: e2e-unified names exactly one Teams member (found ${teamsMembers.length})`);

  const teamsKey = teamsMembers[0]!;
  const tenantKey = teamsKey.split("/").slice(0, 2).join("/");
  ok(
    isVouchedInternal(tenantKey, teamsKey),
    "real config: the Teams window member is internal at some grain — assertWindowSourcesVouched's own check",
  );
  ok(
    isVouchedSurface(teamsKey),
    "🔴 real config: the Teams window member passes the single-window floor from the REAL register — at whatever grain surfaces.ts declares (OPE-1521: tenant or channel)",
  );
  ok(
    !isVouchedSurface("teams/00000000-0000-0000-0000-000000000000/19-undeclared-thread.tacv2"),
    "real config NEGATIVE CONTROL: a Teams key this deployment declares nowhere fails the floor",
  );
  _resetSurfacesForTest();
}

{
  const asked: Array<{ threadRoot?: string; container: string }> = [];
  const catchUpDeps = (): TeamsSupervisorDeps => ({
    getOrCreateSession: async () => ({ token: RAW_TOKEN, generation: 2, freshGeneration: false, tail: [] }),
    catchUp: async (req) => {
      asked.push({ container: req.container, ...(req.threadRoot ? { threadRoot: req.threadRoot } : {}) });
      return { messages: [] };
    },
    wake: async () => undefined,
    now: () => "2026-01-14T02:00:11Z",
  });
  const base = {
    surfaceKey: TEAMS_KEY,
    containerKey: teamsPartition.surfaceKey,
    channelId: "19:winchan@thread.tacv2",
    teamId: "11111111-2222-3333-4444-555555555555",
    auth: teamsAuth,
    trigger: { id: "170002", authorId: "29:sam-teams", authorName: "Sam", sentAt: "2026-01-14T02:00:10Z", text: "@OE anything new?", trust: "peer" as const },
    window: teamsWindow,
  };
  await handleTeamsSingleWindowDispatch({ ...base, replyChainRootId: "170001" }, catchUpDeps());
  ok(asked.length === 1 && asked[0]!.threadRoot === "170001", `🔴 OPE-1817: the supervisor names the REPLY CHAIN this wake sits in to the catch-up. Got ${JSON.stringify(asked[0])}`);
  ok(asked[0]!.container === "11111111-2222-3333-4444-555555555555/19:winchan@thread.tacv2", "OPE-1817: …in the container Graph addresses — the group id and the channel grain");

  await handleTeamsSingleWindowDispatch({ ...base, threadRootId: "170007" }, catchUpDeps());
  ok(asked.length === 2 && asked[1]!.threadRoot === "170007", "OPE-1817: a dispatch that names only `threadRootId` still names that chain — the fallback, not a channel-only read");

  await handleTeamsSingleWindowDispatch({ ...base }, catchUpDeps());
  ok(asked.length === 3 && asked[2]!.threadRoot === undefined, "OPE-1817 NEGATIVE CONTROL: a dispatch naming NO chain asks for the container alone — so the two arms above measure the fields, not a constant");
}

console.log(`unified-window: ${n} assertions passed`);
