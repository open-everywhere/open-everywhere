
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-unified-window-")), "ops.sqlite3");
delete process.env.OE_ORG;

import { registerConfig } from "../agent/access/config.js";
import {
  defineDomain,
  crossSurfaceWindowOrgGateEnabled,
  crossSurfaceWindowEnabled,
  unifiedSupervisorEnabled,
  assertUnifiedDomainTrust,
  type Domain,
} from "../agent/memory/domain.js";
import {
  supervisorGrainFor,
  supervisorTokenForGrain,
  unifiedSupervisorToken,
  unifiedDomainSessionKey,
  effectiveEveToken,
  UNIFIED_CHANNEL_NAME,
} from "../agent/channels/unified-supervisor.js";
import {
  mintWakeId,
  registerUnifiedWakeTarget,
  resolveUnifiedWakeTarget,
  isUnifiedWakeOrigin,
  stampUnifiedWindowAuth,
  shouldBridgeAddressedProse,
  singleWindowMentionPolicy,
  isTrustedTeamsServiceUrl,
  WAKE_TARGET_TTL_MS,
  OE_PLATFORM_ATTR,
  OE_WAKE_ID_ATTR,
  OE_ADDRESSING_ATTR,
  type UnifiedWakeOrigin,
} from "../agent/channels/unified-window.js";
import { isVouchedInternal, isVouchedSurface, registerTrustedSurfaces, _resetTrustedSurfacesForTest } from "../agent/identity/trust.js";
import unifiedChannel, { divertToUnifiedWindow, type UnifiedReceiveTarget } from "../agent/channels/unified.js";
import { postUnifiedReply } from "../agent/channels/unified-reply.js";
import { getOperationalStore } from "../agent/operational/provider.js";
import {
  parseMessageEvent,
  routeSupervisorEvent,
  supervisorToken,
  liveSupervisorDeps,
  type SupervisorRouteDeps,
} from "../agent/channels/slack-events.js";
import { withSingleWindowDiversion } from "../agent/channels/slack-front.js";
import { handleGitHubSupervisorDispatch, githubSupervisorToken, type GitHubSupervisorDeps } from "../agent/channels/github-supervisor.js";
import { buildGitHubAuth } from "../agent/channels/github-identity.js";
import { handleLinearSupervisorDispatch, linearSupervisorToken, type LinearSupervisorDeps } from "../agent/channels/linear-supervisor.js";
import { buildLinearAuth } from "../agent/channels/linear-identity.js";
import { handleNotionSupervisorDispatch, notionSupervisorToken, planNotionSingleWindow, type NotionSupervisorDeps } from "../agent/channels/notion-supervisor.js";
import { buildNotionAuth } from "../agent/channels/notion-identity.js";
import {
  handleTeamsSingleWindowDispatch,
  teamsSupervisorToken,
  teamsSingleWindowPrivacyOk,
  teamsSingleWindowMentionPolicy,
  planTeamsSingleWindow,
  type TeamsSupervisorDeps,
  type TeamsSingleWindowFacts,
} from "../agent/channels/teams-supervisor.js";
import { buildTeamsAuth } from "../agent/channels/teams-identity.js";
import { channelPlatform, isUnifiedWindowContext, currentWakeId, currentTurnAddressing, assertTurnSurface, bindFrom, type BindableContext } from "../agent/identity/binding.js";
import replyTool from "../agent/tools/reply.js";
import readSlackChannel from "../agent/tools/read_slack_channel.js";
import type { RouteHandlerArgs } from "eve/channels";

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

const GATES = ["OE_UNIFIED_SUPERVISOR", "OE_CROSS_SURFACE_WINDOW"] as const;
const withGates = async <T>(vals: Partial<Record<(typeof GATES)[number], string>>, fn: () => T | Promise<T>): Promise<T> => {
  const prev = GATES.map((g) => process.env[g]);
  for (const g of GATES) {
    if (vals[g] === undefined) delete process.env[g];
    else process.env[g] = vals[g];
  }
  try {
    return await fn();
  } finally {
    GATES.forEach((g, i) => {
      if (prev[i] === undefined) delete process.env[g];
      else process.env[g] = prev[i]!;
    });
  }
};

const SLACK_KEY = "slack/T_WIN/C_WINA";
const GH_KEY = "github/acme/payments-api";
const LINEAR_KEY = "linear/O_WIN/T_WINX";
const NOTION_KEY = "notion/W_WIN/P_WINPAGE";
const TEAMS_KEY = "teams/TEN_WIN/19-winchan.tacv2";
const TEAMS_WS_KEY = "teams/TEN_WIN";
const ALL_KEYS = [SLACK_KEY, GH_KEY, LINEAR_KEY, NOTION_KEY, TEAMS_KEY];
const winDomain = defineDomain({
  name: "payments",
  channels: ALL_KEYS,
  ambientSupervisor: true,
  unifiedSupervisor: true,
  crossSurfaceWindow: true,
});
const unifiedTwin = defineDomain({ name: "payments", channels: ALL_KEYS, ambientSupervisor: true, unifiedSupervisor: true });
const ambientTwin = defineDomain({ name: "payments", channels: ALL_KEYS, ambientSupervisor: true });
const orgBoth = defineDomain({ name: "org", match: "org", unifiedSupervisorGate: true, crossSurfaceWindowGate: true });
const orgUnifiedOnly = defineDomain({ name: "org", match: "org", unifiedSupervisorGate: true });
const orgPlain = defineDomain({ name: "org", match: "org" });

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [winDomain, orgBoth],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (["C_WINA", "payments-api", "T_WINX", "P_WINPAGE", "19-winchan.tacv2"].includes(surface) ? ["payments"] : []),
});

await withGates({}, () => {
  ok(!crossSurfaceWindowOrgGateEnabled([orgPlain]), "no env, no org switch → org gate OFF");
  ok(crossSurfaceWindowOrgGateEnabled([orgBoth]), "org-domain crossSurfaceWindowGate → org gate ON (config-as-code arm)");
  ok(!crossSurfaceWindowEnabled(SLACK_KEY, [winDomain, orgPlain]), "org gate OFF: the domain's crossSurfaceWindow is INERT (cannot be on at the domain)");
  ok(!crossSurfaceWindowEnabled(SLACK_KEY, [winDomain, orgUnifiedOnly]), "unified org gate alone does NOT arm the window (each pair has its own master)");
  ok(crossSurfaceWindowEnabled(SLACK_KEY, [winDomain, orgBoth]) && crossSurfaceWindowEnabled(GH_KEY, [winDomain, orgBoth]), "both org gates + both domain flags → window ON for the Slack AND GitHub containers");
  ok(!crossSurfaceWindowEnabled(SLACK_KEY, [unifiedTwin, orgBoth]) || crossSurfaceWindowEnabled(SLACK_KEY, [unifiedTwin, orgBoth]) === false, "domain without crossSurfaceWindow → window OFF (per-domain flag required)");
  const windowNoUnified = defineDomain({ name: "payments", channels: [SLACK_KEY], ambientSupervisor: true, crossSurfaceWindow: true });
  ok(!crossSurfaceWindowEnabled(SLACK_KEY, [windowNoUnified, orgBoth]), "window without the unified per-domain flag → OFF (single-window is a mode OF the unified supervisor)");
  ok(!unifiedSupervisorEnabled(SLACK_KEY, [windowNoUnified, orgBoth]) === true, "…because the unified pair itself doesn't hold");
});
await withGates({ OE_UNIFIED_SUPERVISOR: "1", OE_CROSS_SURFACE_WINDOW: "1" }, () => {
  ok(crossSurfaceWindowEnabled(SLACK_KEY, [winDomain, orgPlain]), "env master switches arm both pairs without org-domain config");
});
await withGates({ OE_UNIFIED_SUPERVISOR: "1" }, () => {
  ok(!crossSurfaceWindowEnabled(SLACK_KEY, [winDomain, orgPlain]), "OE_UNIFIED_SUPERVISOR alone leaves the window OFF (its own env master required)");
});

ok((() => { assertUnifiedDomainTrust([winDomain, orgBoth]); return true; })(), "the documented single-window fixture passes assertUnifiedDomainTrust");
throws(
  () => assertUnifiedDomainTrust([defineDomain({ name: "payments", channels: [SLACK_KEY], ambientSupervisor: true, crossSurfaceWindow: true })]),
  "crossSurfaceWindow WITHOUT unifiedSupervisor → load fails loud",
);
throws(
  () => assertUnifiedDomainTrust([defineDomain({ name: "org", match: "org", ambientSupervisor: true, unifiedSupervisor: true, crossSurfaceWindow: true })]),
  "crossSurfaceWindow on a pseudo-domain → load fails loud (the 'window everything' footgun)",
);
throws(
  () => assertUnifiedDomainTrust([defineDomain({ name: "payments", channels: [SLACK_KEY], ambientSupervisor: true, unifiedSupervisor: true, crossSurfaceWindow: true, crossSurfaceWindowGate: true })]),
  "crossSurfaceWindowGate anywhere but the org pseudo-domain → load fails loud",
);

await withGates({}, () => {
  const gSlack = supervisorGrainFor(SLACK_KEY, [winDomain, orgBoth]);
  const gGh = supervisorGrainFor(GH_KEY, [winDomain, orgBoth]);
  ok(gSlack.unified && gSlack.singleWindow === true && gGh.unified && gGh.singleWindow === true, "gates ON: both surfaces' grains are unified + singleWindow");
  ok(gSlack.registryKey === gGh.registryKey && gSlack.registryKey === unifiedDomainSessionKey("payments"), "one domain registry row for both surfaces");
  const gLin = supervisorGrainFor(LINEAR_KEY, [winDomain, orgBoth]);
  ok(gLin.unified && gLin.singleWindow === true, "gates ON: the Linear surface's grain is unified + singleWindow too");
  ok(gLin.registryKey === gSlack.registryKey, "the Linear surface shares the one domain registry row");
  const gNot = supervisorGrainFor(NOTION_KEY, [winDomain, orgBoth]);
  ok(gNot.unified && gNot.singleWindow === true && gNot.registryKey === gSlack.registryKey, "gates ON: the Notion page's grain is unified + singleWindow and shares the one domain registry row");
  const gTeams = supervisorGrainFor(TEAMS_KEY, [winDomain, orgBoth]);
  ok(gTeams.unified && gTeams.singleWindow === true && gTeams.registryKey === gSlack.registryKey, "gates ON: the Teams channel's grain is unified + singleWindow and shares the one domain registry row");
  const rawSlack = supervisorTokenForGrain(gSlack, 3, () => supervisorToken("C_WINA", 3));
  const rawGh = supervisorTokenForGrain(gGh, 3, () => githubSupervisorToken("acme", "payments-api", 3));
  const rawLin = supervisorTokenForGrain(gLin, 3, () => linearSupervisorToken("T_WINX", 3));
  const rawNot = supervisorTokenForGrain(gNot, 3, () => notionSupervisorToken("P_WINPAGE", 3));
  const rawTeams = supervisorTokenForGrain(gTeams, 3, () => teamsSupervisorToken("19-winchan.tacv2", 3));
  ok(
    rawSlack === rawGh && rawSlack === rawLin && rawSlack === rawNot && rawSlack === rawTeams && rawSlack === unifiedSupervisorToken("payments", 3),
    "IDENTICAL raw token from the Slack, GitHub, Linear, Notion AND Teams dispatch paths",
  );
  ok(
    effectiveEveToken(UNIFIED_CHANNEL_NAME, rawSlack) === effectiveEveToken(UNIFIED_CHANNEL_NAME, rawGh) &&
      effectiveEveToken(UNIFIED_CHANNEL_NAME, rawSlack) === "unified:oe-dom:payments:oe-sup:g3",
    "ONE effective eve token across providers (unified:oe-dom:payments:oe-sup:g3) — the single context window",
  );
  ok(
    effectiveEveToken("slack", rawSlack) !== effectiveEveToken("github", rawGh),
    "per-platform delivery of the same raw token yields DIFFERENT effective tokens (the sibling-session split single-window removes)",
  );

  const offWindow = supervisorGrainFor(SLACK_KEY, [unifiedTwin, orgUnifiedOnly]);
  ok(!("singleWindow" in offWindow), "window OFF: the unified grain carries NO singleWindow field (byte-identical to the pre-window shape)");
  ok(
    JSON.stringify(supervisorGrainFor(SLACK_KEY, [winDomain, orgUnifiedOnly])) === JSON.stringify(offWindow),
    "window org-gate OFF: the single-window fixture's grain is IDENTICAL to the plain-unified twin's",
  );
  ok(
    JSON.stringify(supervisorGrainFor(SLACK_KEY, [winDomain, orgPlain])) === JSON.stringify(supervisorGrainFor(SLACK_KEY, [ambientTwin, orgPlain])),
    "all gates OFF: the fixture's grain is IDENTICAL to the plain-ambient twin's (per-container, byte-identical-off)",
  );
});

interface ReceivedWake {
  channel: unknown;
  message: string;
  target: UnifiedReceiveTarget;
  auth: { attributes?: Record<string, unknown> };
}
const received: ReceivedWake[] = [];
const captureReceive = (async (ch: unknown, options: { message: string; target: unknown; auth: unknown }) => {
  received.push({ channel: ch, message: options.message, target: options.target as UnifiedReceiveTarget, auth: options.auth as ReceivedWake["auth"] });
  return {} as never;
}) as unknown as RouteHandlerArgs["receive"];

const RAW_TOKEN = unifiedSupervisorToken("payments", 1);

const slackEv = parseMessageEvent({
  type: "event_callback",
  team_id: "T_WIN",
  event: { type: "message", channel: "C_WINA", ts: "100.1", user: "U1", channel_type: "channel", text: "decision: the deploy window token is DW-42" },
})!;
const baseWakes: Array<{ token: string; window?: unknown }> = [];
const slackBaseDeps: SupervisorRouteDeps = {
  confirmInternalWithMeta: async () => ({ internal: true, memberCount: 7 }),
  getOrCreateSession: async () => ({ token: RAW_TOKEN, generation: 1, freshGeneration: false }),
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
  getOrCreateSession: async () => ({ token: RAW_TOKEN, generation: 1, freshGeneration: false }),
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
    owner: "acme",
    repo: "payments-api",
    issueNumber: 55,
    issueTitle: "Deploy window",
    auth: ghAuth,
    trigger: { id: "9001", authorLogin: "sam", sentAt: "2026-01-14T02:00:04Z", text: "what was the deploy window token we agreed?" },
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
  origin: { platform: "linear", issueId: "issue-uuid-77", parentId: "comment-uuid-1" } satisfies UnifiedWakeOrigin,
};
const linDeps: LinearSupervisorDeps = {
  getOrCreateSession: async () => ({ token: RAW_TOKEN, generation: 1, freshGeneration: false }),
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
    teamId: "T_WINX",
    issueId: "issue-uuid-77",
    issueIdentifier: "ENG-77",
    issueTitle: "Deploy window",
    auth: linAuth,
    trigger: { id: "comment-uuid-1", authorId: "sam", authorName: "Sam", sentAt: "2026-01-14T02:00:06Z", text: "what was the deploy window token we agreed?" },
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
      (received[2].target.origin as { issueId?: string }).issueId === "issue-uuid-77" &&
      (received[2].target.origin as { parentId?: string }).parentId === "comment-uuid-1",
    "linear: the frozen origin names the triggering issue + reply thread-root",
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
  getOrCreateSession: async () => ({ token: RAW_TOKEN, generation: 1, freshGeneration: false }),
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
    addressing: "direct",
    pageId: "P_WINPAGE",
    discussionId: "disc-win-1",
    workspaceId: "W_WIN",
    auth: notAuth,
    trigger: { from: "human", id: "nc-1", authorId: "sam-notion", sentAt: "2026-01-14T02:00:08Z", text: "@OE what was the deploy window token we agreed?" },
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
  ok(received[3].message.startsWith("[direct]") && received[3].message.includes(`wake-id="${notWindow.wakeId}"`), "notion: the delivered wake is the ADDRESSED direct-mention render with the wake-id envelope");
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
const teamsDeps: TeamsSupervisorDeps = {
  getOrCreateSession: async () => ({ token: RAW_TOKEN, generation: 1, freshGeneration: false }),
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
await handleTeamsSingleWindowDispatch(
  {
    surfaceKey: TEAMS_KEY,
    channelId: "19:winchan@thread.tacv2",
    auth: teamsAuth,
    trigger: { id: "170002", authorId: "29:sam-teams", authorName: "Sam", sentAt: "2026-01-14T02:00:10Z", text: "@OE what was the deploy window token we agreed?", trust: "peer" },
    threadRootId: "170001",
    window: teamsWindow,
  },
  teamsDeps,
);
{
  ok(received.length === 5 && received[4].channel === unifiedChannel, "teams: the diversion targets the SAME unified channel value");
  ok(received[4].target.token === RAW_TOKEN, "teams: the diverted wake carries the SAME raw domain token");
  ok(
    effectiveEveToken(UNIFIED_CHANNEL_NAME, received[0].target.token) === effectiveEveToken(UNIFIED_CHANNEL_NAME, received[4].target.token),
    "💥 SINGLE CONTEXT: the Slack wake and the Teams wake resolve ONE identical effective eve token — the fifth-surface proof",
  );
  ok(received[4].message.startsWith("[direct]") && received[4].message.includes(`wake-id="${teamsWindow.wakeId}"`), "teams: the delivered wake is the ADDRESSED direct-mention render with the wake-id envelope");
  const a = received[4].auth.attributes ?? {};
  ok(a[OE_PLATFORM_ATTR] === "teams" && a[OE_WAKE_ID_ATTR] === teamsWindow.wakeId, "teams: the forwarded auth is stamped with oe_platform + oe_wake_id");
  ok(a[OE_ADDRESSING_ATTR] === "direct-mention", "teams: the forwarded auth carries oe_addressing='direct-mention' (the terminal-prose delivery bridge's arm)");
  ok(
    received[4].target.origin.platform === "teams" &&
      (received[4].target.origin as { conversationId?: string }).conversationId === "19:winchan.tacv2;messageid=170001" &&
      (received[4].target.origin as { replyToActivityId?: string }).replyToActivityId === "170001" &&
      (received[4].target.origin as { serviceUrl?: string }).serviceUrl === "https://smba.trafficmanager.net/emea/",
    "teams: the frozen origin names the conversation + reply-chain root + connector host (the reply target)",
  );
  ok(typeof a.conversation_id === "string" && a.conversation_id === "19:winchan.tacv2;messageid=170001", "teams: the surface's own auth attributes ride verbatim (identity binding unchanged)");
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

  const p = (sw: boolean, m: boolean, facts: TeamsSingleWindowFacts) => teamsSingleWindowMentionPolicy(sw, m, facts);
  ok(p(true, true, f({})).suppressNative === true && p(true, true, f({})).addressing === "direct-mention", "teams policy (sw=1,m=1,floor=1): native forward SUPPRESSED and the wake is addressed 'direct-mention'");
  ok(p(true, true, f({ vouched: false })).suppressNative === false && p(true, true, f({ vouched: false })).addressing === undefined, "teams policy (sw=1,m=1,floor=0): un-vouched — native KEPT, no addressed stamp (fail-closed)");
  ok(p(true, false, f({})).suppressNative === false && p(true, false, f({})).addressing === undefined, "teams policy (sw=1,m=0,floor=1): a non-mention never suppresses and is never addressed (ambient treatment)");
  ok(p(false, true, f({})).suppressNative === false && p(false, true, f({})).addressing === undefined, "teams policy (sw=0,m=1,floor=1): single-window OFF — byte-identical split (native owns the mention)");
  for (const sw of [true, false]) for (const m of [true, false]) for (const vouched of [true, false]) {
    const pol = p(sw, m, f({ vouched }));
    ok((pol.addressing === "direct-mention") === pol.suppressNative, `teams policy complementarity: addressing ⟺ suppressNative (sw=${sw},m=${m},vouched=${vouched})`);
  }

  const target = { serviceUrl: "https://smba.trafficmanager.net/emea/", conversationId: "19:winchan.tacv2;messageid=170001", replyToActivityId: "170001" };
  const legA = planTeamsSingleWindow(true, false, f({}), target);
  ok(legA !== undefined && legA.addressing === undefined, "teams plan: Leg A — an ambient channel message on a vouched singleWindow channel diverts WITHOUT the addressed stamp");
  ok(planTeamsSingleWindow(false, true, f({}), target) === undefined, "teams plan: singleWindow OFF → NO window (byte-identical native path)");
  ok(planTeamsSingleWindow(true, true, f({ vouched: false }), target) === undefined, "teams plan: un-vouched → NO window (fail-closed — never routed to the shared window)");
  ok(planTeamsSingleWindow(true, true, f({ membershipType: "shared" }), target) === undefined, "teams plan: a shared channel plans NO window even when vouched");
  ok(planTeamsSingleWindow(true, false, f({ scope: "groupChat" }), target) === undefined, "teams plan: a group chat plans NO window (Leg A floor too)");
  ok(planTeamsSingleWindow(true, true, f({}), { ...target, serviceUrl: "" }) === undefined, "teams plan: no serviceUrl → NO window (no frozen reply target, fail closed)");

  _resetTrustedSurfacesForTest();
  registerTrustedSurfaces([TEAMS_WS_KEY]);
  ok(isVouchedInternal(TEAMS_WS_KEY, TEAMS_KEY), "teams vouch: a tenant-wide vouch satisfies isVouchedInternal (the any-grain check)");
  ok(!isVouchedSurface(TEAMS_KEY), "teams vouch: a tenant-wide vouch does NOT satisfy isVouchedSurface — so teams-front REFUSES the channel (a Connect channel can't be swept in by a coarse vouch)");
  registerTrustedSurfaces([TEAMS_KEY]);
  ok(isVouchedSurface(TEAMS_KEY), "teams vouch: a SURFACE-grain vouch admits — the operator asserted this specific channel is internal");
  _resetTrustedSurfacesForTest();

  ok(isTrustedTeamsServiceUrl("https://smba.trafficmanager.net/amer/"), "serviceUrl: the canonical regional Bot Connector host is trusted");
  ok(isTrustedTeamsServiceUrl("https://smba.trafficmanager.net"), "serviceUrl: the bare smba.trafficmanager.net host is trusted");
  ok(isTrustedTeamsServiceUrl("https://sub.botframework.com/v3/"), "serviceUrl: a *.botframework.com host is trusted");
  ok(!isTrustedTeamsServiceUrl("https://evil.example/v3/conversations"), "serviceUrl: an arbitrary https host is REJECTED (no token exfil)");
  ok(!isTrustedTeamsServiceUrl("https://smba.trafficmanager.net.evil.com/"), "serviceUrl: a look-alike suffix host is REJECTED (endsWith is dot-anchored)");
  ok(!isTrustedTeamsServiceUrl("http://smba.trafficmanager.net/"), "serviceUrl: a non-https Bot Framework host is REJECTED");
  ok(!isTrustedTeamsServiceUrl("not a url") && !isTrustedTeamsServiceUrl("") && !isTrustedTeamsServiceUrl(undefined), "serviceUrl: unparseable / empty / non-string → REJECTED (fail-closed)");
}

const store = getOperationalStore();
{
  const sent: Array<{ payload: { message?: string; context?: readonly string[] }; opts: { continuationToken: string; auth: unknown } }> = [];
  let mapVisibleAtSend = false;
  const fakeSend = (async (payload: unknown, opts: unknown) => {
    mapVisibleAtSend = (await resolveUnifiedWakeTarget(store, "default", received[0].target.wakeId)) !== null;
    sent.push({ payload: payload as { message?: string }, opts: opts as { continuationToken: string; auth: unknown } });
    return {} as never;
  }) as never;
  await withGates({ OE_UNIFIED_SUPERVISOR: "1", OE_CROSS_SURFACE_WINDOW: "1" }, async () => {
    await unifiedChannel.receive!({ message: received[0].message, target: received[0].target, auth: received[0].auth as never }, { send: fakeSend });
  });
  ok(sent.length === 1 && sent[0].opts.continuationToken === RAW_TOKEN, "receive: delivers under the RAW domain token (eve prefixes `unified:` — the shared window)");
  ok(mapVisibleAtSend, "receive: the wakeId→origin map entry is durably registered BEFORE the send");
  const origin = await resolveUnifiedWakeTarget(store, "default", received[0].target.wakeId);
  ok(origin !== null && origin.platform === "slack", "receive: the registered origin round-trips from the real store");

  await withGates({ OE_UNIFIED_SUPERVISOR: "1", OE_CROSS_SURFACE_WINDOW: "1" }, async () => {
    await unifiedChannel.receive!({ message: received[1].message, target: received[1].target, auth: received[1].auth as never }, { send: fakeSend });
  });
  ok(sent.length === 2 && sent[1].opts.continuationToken === RAW_TOKEN, "receive: the GitHub wake delivers under the SAME raw token (same session)");
  ok(sent[1].payload.context !== undefined, "receive: side-channel context passes through to the delivery");

  await withGates({ OE_UNIFIED_SUPERVISOR: "1", OE_CROSS_SURFACE_WINDOW: "1" }, async () => {
    await unifiedChannel.receive!({ message: received[2].message, target: received[2].target, auth: received[2].auth as never }, { send: fakeSend });
  });
  ok(sent.length === 3 && sent[2].opts.continuationToken === RAW_TOKEN, "receive: the Linear wake delivers under the SAME raw token (same session)");
  const linRegistered = await resolveUnifiedWakeTarget(store, "default", received[2].target.wakeId);
  ok(linRegistered !== null && linRegistered.platform === "linear", "receive: the Linear origin round-trips from the real store");

  await withGates({ OE_UNIFIED_SUPERVISOR: "1", OE_CROSS_SURFACE_WINDOW: "1" }, async () => {
    await unifiedChannel.receive!({ message: received[3].message, target: received[3].target, auth: received[3].auth as never }, { send: fakeSend });
  });
  ok(sent.length === 4 && sent[3].opts.continuationToken === RAW_TOKEN, "receive: the Notion wake delivers under the SAME raw token (same session)");
  const notRegistered = await resolveUnifiedWakeTarget(store, "default", received[3].target.wakeId);
  ok(notRegistered !== null && notRegistered.platform === "notion", "receive: the Notion origin round-trips from the real store");

  await withGates({ OE_UNIFIED_SUPERVISOR: "1", OE_CROSS_SURFACE_WINDOW: "1" }, async () => {
    await unifiedChannel.receive!({ message: received[4].message, target: received[4].target, auth: received[4].auth as never }, { send: fakeSend });
  });
  ok(sent.length === 5 && sent[4].opts.continuationToken === RAW_TOKEN, "receive: the Teams wake delivers under the SAME raw token (same session)");
  const teamsRegistered = await resolveUnifiedWakeTarget(store, "default", received[4].target.wakeId);
  ok(teamsRegistered !== null && teamsRegistered.platform === "teams", "receive: the Teams origin round-trips from the real store");

  await assert.rejects(
    unifiedChannel.receive!(
      { message: "m", target: { ...received[0].target, surfaceKey: "slack/T_OTHER/C_NOPE" }, auth: received[0].auth as never },
      { send: fakeSend },
    ),
    /crossSurfaceWindow is not enabled/,
    "receive: an un-flagged surface is REFUSED (fail-closed re-check, defense-in-depth)",
  );
  n++;
  await assert.rejects(
    unifiedChannel.receive!({ message: "m", target: { token: "not-a-supervisor-token", wakeId: "w", surfaceKey: SLACK_KEY, origin: { platform: "slack", channelId: "C" } } as never, auth: null }, { send: fakeSend }),
    /malformed target/,
    "receive: a non-supervisor token is refused (never a mis-keyed session)",
  );
  n++;
  await assert.rejects(
    unifiedChannel.receive!({ message: "m", target: { token: RAW_TOKEN, wakeId: "w", surfaceKey: SLACK_KEY, origin: { platform: "smoke-signal", id: "x" } } as never, auth: null }, { send: fakeSend }),
    /malformed target/,
    "receive: an unknown origin variant is refused",
  );
  n++;
}

{
  const slackPosts: Array<{ channelId: string; threadTs?: string; text: string }> = [];
  const ghPosts: Array<{ owner: string; repo: string; issueNumber: number; text: string }> = [];
  const linPosts: Array<{ issueId: string; parentId?: string; text: string }> = [];
  const notPosts: Array<{ discussionId: string; pageId?: string; text: string }> = [];
  const teamsPosts: Array<{ serviceUrl: string; conversationId: string; replyToActivityId?: string; text: string }> = [];
  const deps = {
    postSlack: async (o: { channelId: string; threadTs?: string }, text: string) => {
      slackPosts.push({ channelId: o.channelId, threadTs: o.threadTs, text });
      return "ts-1";
    },
    postGitHub: async (o: { owner: string; repo: string; issueNumber: number }, text: string) => {
      ghPosts.push({ owner: o.owner, repo: o.repo, issueNumber: o.issueNumber, text });
      return "c-1";
    },
    postLinear: async (o: { issueId: string; parentId?: string }, text: string) => {
      linPosts.push({ issueId: o.issueId, parentId: o.parentId, text });
      return "lc-1";
    },
    postNotion: async (o: { discussionId: string; pageId?: string }, text: string) => {
      notPosts.push({ discussionId: o.discussionId, pageId: o.pageId, text });
      return "nc-reply-1";
    },
    postTeams: async (o: { serviceUrl: string; conversationId: string; replyToActivityId?: string }, text: string) => {
      teamsPosts.push({ serviceUrl: o.serviceUrl, conversationId: o.conversationId, replyToActivityId: o.replyToActivityId, text });
      return "ta-reply-1";
    },
  };
  const slackOrigin = await resolveUnifiedWakeTarget(store, "default", received[0].target.wakeId);
  const ghOrigin = await resolveUnifiedWakeTarget(store, "default", ghWindow.wakeId);
  const linOrigin = await resolveUnifiedWakeTarget(store, "default", linWindow.wakeId);
  const notOrigin = await resolveUnifiedWakeTarget(store, "default", notWindow.wakeId);
  const teamsOrigin = await resolveUnifiedWakeTarget(store, "default", teamsWindow.wakeId);
  ok(slackOrigin !== null && ghOrigin !== null && linOrigin !== null && notOrigin !== null && teamsOrigin !== null, "coalesced turn: ALL FIVE pending wakeIds resolve from the map");
  ok((await postUnifiedReply(slackOrigin!, "answer for slack", deps)) === "ts-1", "reply(slack wakeId) returns the Slack post id");
  ok((await postUnifiedReply(ghOrigin!, "answer for github", deps)) === "c-1", "reply(github wakeId) returns the GitHub comment id");
  ok((await postUnifiedReply(linOrigin!, "answer for linear", deps)) === "lc-1", "reply(linear wakeId) returns the Linear comment id");
  ok((await postUnifiedReply(notOrigin!, "answer for notion", deps)) === "nc-reply-1", "reply(notion wakeId) returns the Notion comment id");
  ok((await postUnifiedReply(teamsOrigin!, "answer for teams", deps)) === "ta-reply-1", "reply(teams wakeId) returns the Teams activity id");
  ok(slackPosts.length === 1 && slackPosts[0].channelId === "C_WINA" && slackPosts[0].threadTs === undefined, "Slack reply landed in the Slack channel (top-level, matching the trigger)");
  ok(ghPosts.length === 1 && ghPosts[0].owner === "acme" && ghPosts[0].repo === "payments-api" && ghPosts[0].issueNumber === 55, "GitHub reply landed on the GitHub issue that woke it");
  ok(linPosts.length === 1 && linPosts[0].issueId === "issue-uuid-77" && linPosts[0].parentId === "comment-uuid-1", "Linear reply landed on the issue + thread-root that woke it (commentCreate issueId + parentId)");
  ok(notPosts.length === 1 && notPosts[0].discussionId === "disc-win-1", "Notion reply landed in the discussion thread that woke it (createCommentReply discussion_id)");
  ok(
    teamsPosts.length === 1 &&
      teamsPosts[0].conversationId === "19:winchan.tacv2;messageid=170001" &&
      teamsPosts[0].replyToActivityId === "170001" &&
      teamsPosts[0].serviceUrl === "https://smba.trafficmanager.net/emea/",
    "Teams reply landed in the reply chain that woke it (replyToTeamsActivity conversation + root activity)",
  );
  ok(
    slackPosts[0].text === "answer for slack" && ghPosts[0].text === "answer for github" && linPosts[0].text === "answer for linear" && notPosts[0].text === "answer for notion" && teamsPosts[0].text === "answer for teams",
    "each reply carried ITS OWN text — no cross-surface swap in the coalesced turn",
  );

  const threadedId = mintWakeId();
  await registerUnifiedWakeTarget(store, "default", threadedId, { platform: "slack", channelId: "C_WINA", threadTs: "99.5" }, new Date().toISOString());
  await postUnifiedReply((await resolveUnifiedWakeTarget(store, "default", threadedId))!, "threaded answer", deps);
  ok(slackPosts.length === 2 && slackPosts[1].threadTs === "99.5", "a threaded trigger's reply posts into ITS thread");

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
      isUnifiedWakeOrigin({ platform: "linear", issueId: "i1" }) &&
      isUnifiedWakeOrigin({ platform: "linear", issueId: "i1", parentId: "p1" }) &&
      isUnifiedWakeOrigin({ platform: "notion", discussionId: "d1" }) &&
      isUnifiedWakeOrigin({ platform: "notion", discussionId: "d1", pageId: "p1", workspaceId: "w1" }) &&
      isUnifiedWakeOrigin({ platform: "teams", serviceUrl: "https://smba.trafficmanager.net/emea/", conversationId: "19:c1" }) &&
      isUnifiedWakeOrigin({ platform: "teams", serviceUrl: "https://smba.trafficmanager.net/emea/", conversationId: "19:c1", replyToActivityId: "1", tenantId: "t1" }),
    "all five origin variants validate (linear ± parentId; notion ± page/workspace; teams ± root/tenant)",
  );
  ok(
    !isUnifiedWakeOrigin({ platform: "slack" }) &&
      !isUnifiedWakeOrigin({ platform: "github", owner: "o", repo: "r", issueNumber: 0 }) &&
      !isUnifiedWakeOrigin({ platform: "linear" }) &&
      !isUnifiedWakeOrigin({ platform: "linear", issueId: "" }) &&
      !isUnifiedWakeOrigin({ platform: "linear", issueId: "i1", parentId: 5 }) &&
      !isUnifiedWakeOrigin({ platform: "notion" }) &&
      !isUnifiedWakeOrigin({ platform: "notion", discussionId: "" }) &&
      !isUnifiedWakeOrigin({ platform: "notion", discussionId: "d1", pageId: 7 }) &&
      !isUnifiedWakeOrigin({ platform: "teams" }) &&
      !isUnifiedWakeOrigin({ platform: "teams", serviceUrl: "https://smba.trafficmanager.net/emea/", conversationId: "" }) &&
      !isUnifiedWakeOrigin({ platform: "teams", serviceUrl: "http://evil.example/", conversationId: "19:c1" }) &&
      !isUnifiedWakeOrigin({ platform: "teams", serviceUrl: "https://smba.trafficmanager.net/emea/", conversationId: "19:c1", replyToActivityId: 5 }) &&
      !isUnifiedWakeOrigin(null) &&
      !isUnifiedWakeOrigin("slack"),
    "missing/invalid fields fail validation (incl. a teams origin with an empty conversation or a NON-HTTPS serviceUrl — the Connector token must never leave over plaintext)",
  );
}

{
  received.length = 0;
  baseWakes.length = 0;
  const offDeps: SupervisorRouteDeps = { ...slackBaseDeps, unifiedMeta: () => ({ unified: true }) };
  const out = await routeSupervisorEvent(slackEv, withSingleWindowDiversion(offDeps as ReturnType<typeof liveSupervisorDeps>, captureReceive, SLACK_KEY));
  ok(out.woke === true && baseWakes.length === 1 && received.length === 0, "window OFF: the wake takes the base send path (no diversion), byte-identical");
  ok(baseWakes[0].window === undefined, "window OFF: no window is minted");
  const offGrain = supervisorGrainFor(SLACK_KEY, [ambientTwin, orgPlain]);
  const offToken: string = supervisorTokenForGrain(offGrain, 1, () => supervisorToken("C_WINA", 1));
  const offGhToken: string = supervisorTokenForGrain(supervisorGrainFor(GH_KEY, [ambientTwin, orgPlain]), 1, () => githubSupervisorToken("acme", "payments-api", 1));
  const offLinToken: string = supervisorTokenForGrain(supervisorGrainFor(LINEAR_KEY, [ambientTwin, orgPlain]), 1, () => linearSupervisorToken("T_WINX", 1));
  const offNotToken: string = supervisorTokenForGrain(supervisorGrainFor(NOTION_KEY, [ambientTwin, orgPlain]), 1, () => notionSupervisorToken("P_WINPAGE", 1));
  const offTeamsToken: string = supervisorTokenForGrain(supervisorGrainFor(TEAMS_KEY, [ambientTwin, orgPlain]), 1, () => teamsSupervisorToken("19-winchan.tacv2", 1));
  ok(
    offToken === "C_WINA:oe-sup:g1" &&
      offGhToken === "github:acme/payments-api:oe-sup:g1" &&
      offLinToken === "linear:T_WINX:oe-sup:g1" &&
      offNotToken === "notion:P_WINPAGE:oe-sup:g1" &&
      offTeamsToken === "teams:19-winchan.tacv2:oe-sup:g1",
    "gates OFF: the five surfaces resolve DIFFERENT per-container tokens exactly as today",
  );
}
{
  let offWindow: unknown = "sentinel";
  let offMsg = "";
  await handleLinearSupervisorDispatch(
    {
      surfaceKey: LINEAR_KEY,
      teamId: "T_WINX",
      issueId: "issue-uuid-77",
      issueIdentifier: "ENG-77",
      auth: buildLinearAuth({ organizationId: "O_WIN", teamId: "T_WINX", issueId: "issue-uuid-77", principalId: "sam", commentId: "c2" }),
      trigger: { id: "c2", authorId: "sam", sentAt: "2026-01-14T02:00:08Z", text: "plain per-team wake" },
    },
    {
      getOrCreateSession: async () => ({ token: RAW_TOKEN, generation: 1, freshGeneration: false }),
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
  ok(channelPlatform(mk("unified", { oe_platform: "teams" })) === "teams", "unified hop: a teams-stamped delivery binds as its ORIGIN platform (the Teams mapper runs)");
  ok(channelPlatform(mk("unified", {})) === "unified", "unified hop: NO stamp → stays 'unified' (no mapper → env-stand-in binding, never a guessed platform)");
  ok(channelPlatform(mk("slack", { oe_platform: "github" })) === "slack", "a NORMAL surface session ignores the stamp entirely (hop is unified-kind-gated)");
  ok(isUnifiedWindowContext(mk("channel:unified", {})) && isUnifiedWindowContext(mk("unified", {})), "isUnifiedWindowContext: true for both unified kind forms");
  ok(!isUnifiedWindowContext(mk("slack", {})), "isUnifiedWindowContext: false for a real surface");
  const b = bindFrom(mk("channel:unified", { oe_platform: "slack", team_id: "T_WIN", channel_id: "C_WINA", channel_type: "channel", is_private: "false", is_ext_shared: "false", trust_checked: "true" }));
  ok(b.platform === "slack" && b.workspace === "T_WIN" && b.surface === "C_WINA" && b.trust === "internal", "bindFrom on a stamped unified delivery resolves the REAL Slack partition (memory/spend/audit unchanged)");
  const stamped = stampUnifiedWindowAuth({ attributes: { team_id: "T1" } as Record<string, unknown> }, "slack", "w-1");
  ok(stamped.attributes?.team_id === "T1" && stamped.attributes?.[OE_PLATFORM_ATTR] === "slack" && stamped.attributes?.[OE_WAKE_ID_ATTR] === "w-1", "stampUnifiedWindowAuth adds the two stamps and preserves existing attributes");
  ok(stamped.attributes?.[OE_ADDRESSING_ATTR] === undefined, "stampUnifiedWindowAuth stamps NO oe_addressing for an ambient/watch wake (no addressing arg) — prose stays hard-dropped");
  const addressed = stampUnifiedWindowAuth({ attributes: { team_id: "T1" } as Record<string, unknown> }, "github", "w-2", "direct-mention");
  ok(addressed.attributes?.[OE_ADDRESSING_ATTR] === "direct-mention" && addressed.attributes?.[OE_WAKE_ID_ATTR] === "w-2", "stampUnifiedWindowAuth stamps oe_addressing='direct-mention' for an addressed mention (alongside the platform + wake id)");
  ok(shouldBridgeAddressedProse("direct-mention", false) === true, "bridge gate: an addressed direct-mention that did NOT call reply IS bridged");
  ok(shouldBridgeAddressedProse("direct-mention", true) === false, "bridge gate: a direct-mention that ALREADY replied is NOT bridged (no double-post)");
  ok(shouldBridgeAddressedProse("channel-watch", false) === false, "bridge gate: an ambient channel-watch turn is NEVER bridged — prose stays hard-dropped (message-tool-only preserved)");
  ok(shouldBridgeAddressedProse(undefined, false) === false, "bridge gate: an unstamped (non-single-window / non-addressed) turn is NEVER bridged");
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
    /is not the wake you are answering this turn/,
    "reply REFUSES a wakeId that isn't THIS turn's wake — even one live in the org-wide map (authority-bleed fence, finding 1a)",
  );
  n++;
  await assert.rejects(
    () => armedReply!.execute({ text: "answer", wake: turnWake }, unifiedCtx("github", turnWake)),
    /no longer on record|expired/,
    "reply lets THIS turn's own wakeId PAST the fence (then fails at resolve, unregistered) — the demo's own-wake reply path is intact",
  );
  n++;

  noThrow(() => assertTurnSurface(unifiedCtx("slack"), "slack"), "assertTurnSurface: a slack-origin unified turn MAY read slack");
  throws(() => assertTurnSurface(unifiedCtx("github"), "slack"), "assertTurnSurface: a GITHUB-origin unified turn may NOT read slack (finding 1b)");
  noThrow(() => assertTurnSurface({ channel: { kind: "slack" }, session: { auth: { current: { attributes: {}, principalId: "U", principalType: "slack-user" } } } }, "slack"), "assertTurnSurface: a NORMAL slack session is a no-op (session.started gate is authoritative)");

  ok(arm(readSlackChannel, unifiedCtx("slack")) !== null, "read_slack_channel arms on a unified session (regardless of the current origin)");
  ok(arm(readSlackChannel, { channel: { kind: "channel:github" }, session: { auth: { current: { attributes: {}, principalId: "U", principalType: "github-user" } } } }) === null, "read_slack_channel stays HIDDEN on a normal github session (byte-identical to today)");
  const armedRead = arm(readSlackChannel, unifiedCtx("slack"));
  await assert.rejects(
    () => armedRead!.execute({ channel: "C_WINA" }, unifiedCtx("github")),
    /reads slack, but the message that woke this turn came from github|per-surface read tool/,
    "read_slack_channel EXECUTE refuses a GitHub-origin turn on a unified session (finding 1b — before any Slack API call)",
  );
  n++;
}

console.log(`unified-window: ${n} assertions passed`);
