
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
  WAKE_TARGET_TTL_MS,
  OE_PLATFORM_ATTR,
  OE_WAKE_ID_ATTR,
  type UnifiedWakeOrigin,
} from "../agent/channels/unified-window.js";
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
import { channelPlatform, isUnifiedWindowContext, currentWakeId, assertTurnSurface, bindFrom, type BindableContext } from "../agent/identity/binding.js";
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
const winDomain = defineDomain({
  name: "payments",
  channels: [SLACK_KEY, GH_KEY, LINEAR_KEY],
  ambientSupervisor: true,
  unifiedSupervisor: true,
  crossSurfaceWindow: true,
});
const unifiedTwin = defineDomain({ name: "payments", channels: [SLACK_KEY, GH_KEY, LINEAR_KEY], ambientSupervisor: true, unifiedSupervisor: true });
const ambientTwin = defineDomain({ name: "payments", channels: [SLACK_KEY, GH_KEY, LINEAR_KEY], ambientSupervisor: true });
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
  domainsForSurface: ({ surface }) => (["C_WINA", "payments-api", "T_WINX"].includes(surface) ? ["payments"] : []),
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
  const rawSlack = supervisorTokenForGrain(gSlack, 3, () => supervisorToken("C_WINA", 3));
  const rawGh = supervisorTokenForGrain(gGh, 3, () => githubSupervisorToken("acme", "payments-api", 3));
  const rawLin = supervisorTokenForGrain(gLin, 3, () => linearSupervisorToken("T_WINX", 3));
  ok(rawSlack === rawGh && rawSlack === rawLin && rawSlack === unifiedSupervisorToken("payments", 3), "IDENTICAL raw token from the Slack, GitHub AND Linear dispatch paths");
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
  };
  const slackOrigin = await resolveUnifiedWakeTarget(store, "default", received[0].target.wakeId);
  const ghOrigin = await resolveUnifiedWakeTarget(store, "default", ghWindow.wakeId);
  const linOrigin = await resolveUnifiedWakeTarget(store, "default", linWindow.wakeId);
  ok(slackOrigin !== null && ghOrigin !== null && linOrigin !== null, "coalesced turn: ALL THREE pending wakeIds resolve from the map");
  ok((await postUnifiedReply(slackOrigin!, "answer for slack", deps)) === "ts-1", "reply(slack wakeId) returns the Slack post id");
  ok((await postUnifiedReply(ghOrigin!, "answer for github", deps)) === "c-1", "reply(github wakeId) returns the GitHub comment id");
  ok((await postUnifiedReply(linOrigin!, "answer for linear", deps)) === "lc-1", "reply(linear wakeId) returns the Linear comment id");
  ok(slackPosts.length === 1 && slackPosts[0].channelId === "C_WINA" && slackPosts[0].threadTs === undefined, "Slack reply landed in the Slack channel (top-level, matching the trigger)");
  ok(ghPosts.length === 1 && ghPosts[0].owner === "acme" && ghPosts[0].repo === "payments-api" && ghPosts[0].issueNumber === 55, "GitHub reply landed on the GitHub issue that woke it");
  ok(linPosts.length === 1 && linPosts[0].issueId === "issue-uuid-77" && linPosts[0].parentId === "comment-uuid-1", "Linear reply landed on the issue + thread-root that woke it (commentCreate issueId + parentId)");
  ok(slackPosts[0].text === "answer for slack" && ghPosts[0].text === "answer for github" && linPosts[0].text === "answer for linear", "each reply carried ITS OWN text — no cross-surface swap in the coalesced turn");

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
      isUnifiedWakeOrigin({ platform: "linear", issueId: "i1", parentId: "p1" }),
    "all three origin variants validate (linear with and without parentId)",
  );
  ok(
    !isUnifiedWakeOrigin({ platform: "slack" }) &&
      !isUnifiedWakeOrigin({ platform: "github", owner: "o", repo: "r", issueNumber: 0 }) &&
      !isUnifiedWakeOrigin({ platform: "linear" }) &&
      !isUnifiedWakeOrigin({ platform: "linear", issueId: "" }) &&
      !isUnifiedWakeOrigin({ platform: "linear", issueId: "i1", parentId: 5 }) &&
      !isUnifiedWakeOrigin(null) &&
      !isUnifiedWakeOrigin("slack"),
    "missing/invalid fields fail validation (incl. linear without issueId / non-string parentId)",
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
  ok(
    offToken === "C_WINA:oe-sup:g1" && offGhToken === "github:acme/payments-api:oe-sup:g1" && offLinToken === "linear:T_WINX:oe-sup:g1",
    "gates OFF: the three surfaces resolve DIFFERENT per-container tokens exactly as today",
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
  ok(channelPlatform(mk("unified", {})) === "unified", "unified hop: NO stamp → stays 'unified' (no mapper → env-stand-in binding, never a guessed platform)");
  ok(channelPlatform(mk("slack", { oe_platform: "github" })) === "slack", "a NORMAL surface session ignores the stamp entirely (hop is unified-kind-gated)");
  ok(isUnifiedWindowContext(mk("channel:unified", {})) && isUnifiedWindowContext(mk("unified", {})), "isUnifiedWindowContext: true for both unified kind forms");
  ok(!isUnifiedWindowContext(mk("slack", {})), "isUnifiedWindowContext: false for a real surface");
  const b = bindFrom(mk("channel:unified", { oe_platform: "slack", team_id: "T_WIN", channel_id: "C_WINA", channel_type: "channel", is_private: "false", is_ext_shared: "false", trust_checked: "true" }));
  ok(b.platform === "slack" && b.workspace === "T_WIN" && b.surface === "C_WINA" && b.trust === "internal", "bindFrom on a stamped unified delivery resolves the REAL Slack partition (memory/spend/audit unchanged)");
  const stamped = stampUnifiedWindowAuth({ attributes: { team_id: "T1" } as Record<string, unknown> }, "slack", "w-1");
  ok(stamped.attributes?.team_id === "T1" && stamped.attributes?.[OE_PLATFORM_ATTR] === "slack" && stamped.attributes?.[OE_WAKE_ID_ATTR] === "w-1", "stampUnifiedWindowAuth adds the two stamps and preserves existing attributes");
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
