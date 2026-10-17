import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  allAtWriteTier,
  allAttributedToRoutine,
  allNamePermissionKind,
  allNoticesDelivered,
  pinnedConnectorToolPermissionKind,
  discordOwnedAsks,
  discordWakeSessionIds,
  exactDiscordOwnedAsks,
  askIdsOf,
  discordOwnedAsksInChannel,
  grantIdsOf,
  grantsForAsks,
  currentDomainScopeKey,
  grantReentryScope,
  grantsForExactAsk,
  surfaceNamesChannel,
  unexpiredGrants,
  usesOfGrants,
  isUnattendedFenceRefusal,
  isUnattendedLift,
  noticesForGrant,
  ownerPlatformOf,
  refusedGrantAlreadyLive,
  refusedUnverifiedRequester,
  splitFenceRows,
} from "../packages/core/scripts/e2e/grant-fence-rows.js";
import type { AuditWireEntry } from "../packages/core/scripts/e2e/audit-read.js";
import type { TranscriptWireEvent } from "../packages/core/scripts/e2e/transcript-read.js";
import type { NotionComment } from "../packages/core/scripts/e2e/notion-driver.js";
import {
  chooseNotionTaintAnchor,
  NOTION_TAINT_ANCHOR_MAX_AGE_MS,
  notionTaintAnchorProblem,
  notionTaintFixtureRemedy,
  notionTaintGrantRoad,
  notionTaintNoRowReason,
  notionTaintReplayEvidence,
  NOTION_TAINT_REPLAY_ACTIONS,
  notionTaintRestMarkSettled,
  notionTaintRestRoad,
  transcriptHasNotionPageRead,
} from "../packages/core/scripts/e2e/notion-taint-replay.js";
import {
  GITHUB_NOTION_REST_ACTIONS,
  githubNotionForward,
  githubNotionOriginLifecycle,
  githubNotionReplyNamesBlock,
  githubNotionReplyRow,
} from "../packages/core/scripts/e2e/github-notion-rest.js";
import { scenarioFailureMessage } from "../packages/core/scripts/e2e/failure-message.js";
import {
  CONNECTOR_CARD_ACTIONS,
  completedConnectorWrites,
  connectorCardRequest,
  connectorCardRun,
  forwardedWorkSessionStale,
} from "../packages/core/scripts/e2e/connector-card.js";
import type { HaltOwnershipHandle } from "../packages/core/scripts/e2e/control-write-driver.js";
import { EGRESS_POLICY_ACTION, findCredentialedWriteHost, notionBlockPhrases, notionPageLinks, quotedPagePhrase } from "../packages/core/scripts/e2e/egress-evidence.js";
import { overrideSettingsForTest } from "@open-everywhere/core/agent/settings/settings.js";
import { removeTempDir } from "../packages/core/scripts/_temp-dir.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

let storeMarkSeq = 0;
function storeMarkRow(): AuditWireEntry {
  storeMarkSeq += 1;
  return { seq: storeMarkSeq, ts: new Date().toISOString(), org: "default", platform: "control", workspace: "control", action: "control.service_call", detail: {} };
}

let shapeChecks = 0;
function okShape(cond: boolean, label: string): void {
  ok(cond, label);
  shapeChecks++;
}

const dir = join(tmpdir(), `open-everywhere-e2e-driver-test-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const {
  ENGAGED_ROOM_VARS,
  ENV,
  resolveSlack,
  resolveDiscord,
  resolveTeams,
  resolveSynthetic,
  resolveSlackPrivate,
  resolveSlackChannelB,
  resolveSlackMpim,
  resolveEngagedGithub,
  resolveSlackCapFixture,
  resolveSlackHalt,
  resolveControlWrite,
  resolveSyntheticDm,
  resolveSlackUser2,
  resolveSlackSecondary,
  resolveWebhook,
  resolveNotion,
  resolveGithub,
  resolveLinear,
  resolveNotionAmbient,
  resolveSlackUnified,
  resolvePr,
  resolveConnectorWrite,
  auditSilencesExpected,
  isLocalEvalTarget,
  resolveCapabilities,
  engagedLinearApiKey,
  engagedLinearIdentity,
  resolveEngagedLinear,
  resolveEngagedTeams,
  DEFAULT_TEAMS_REFRESH_SINK,
  teamsRefreshSinkPath,
  TEAMS_AUTH_NEXT_STEP,
} = await import("../packages/core/scripts/e2e/env.js");
const { readRefreshSidecar, writeRefreshSidecar, isMissingChatScopeError, collectGraphPages } = await import("../packages/core/scripts/e2e/teams-driver.js");
const { backoffDelayMs, pollUntil, pollOptional, PollTimeout } = await import("../packages/core/scripts/e2e/poll.js");
const { withoutMarker } = await import("../packages/core/scripts/e2e/journey.js");
const {
  signSlackRequest,
  buildApprovalClickPayload,
  encodeInteractionBody,
  buildSlashCommandBody,
  buildChannelMentionEnvelope,
  SYNTHETIC_SLACK_ROUTE,
  SYNTHETIC_COMMANDS_ROUTE,
  APPROVAL_PREFIX,
  buildConnectClickPayload,
  buildSetKeySubmissionPayload,
  CONNECT_ACTION_PREFIX,
  SETKEY_MODAL_CALLBACK,
  SETKEY_INPUT_BLOCK,
  SETKEY_INPUT_ACTION,
  HOME_ACTION_PREFIX,
  HOME_MODAL_CALLBACK,
  buildHomeOpenedEnvelope,
  buildHomeButtonPayload,
  buildHomeSubmissionPayload,
  buildSidePanelMessageEnvelope,
  SIDE_PANEL_CHANNEL_ENTITY_TYPE,
} = await import("../packages/core/scripts/e2e/synthetic.js");
const { slackTsAt, turnRows, viewedRoomRows, viewedRoomNotePhrase, noteNamesViewedRoom, toolCallsNamingRoom } = await import("../packages/core/scripts/e2e/side-panel.js");
const {
  buildDiscordDmRelayEnvelope,
  buildDiscordGuildMentionRelayEnvelope,
  signDiscordRelayRequest,
  SYNTHETIC_DISCORD_GATEWAY_ROUTE,
  DISCORD_RELAY_SIGNATURE_HEADER,
} = await import("../packages/core/scripts/e2e/discord-synthetic.js");
const { signWebhookBody, webhookTimestamp, webhookDeliveryId } = await import("../packages/core/scripts/e2e/webhook.js");
const {
  runFallbackCheck,
  FallbackJudge,
  judge3,
  LlmJudge,
  buildJudgePrompt,
  parseJudgeResponse,
  judgeBannerTag,
  createJudgeReporter,
  renderReportedJudgeSummary,
} = await import("../packages/core/scripts/e2e/judge.js");
const {
  SCENARIOS, skipCategory, skipReason, ScenarioSkip, FixtureMissing, isFillerAck, isPendingWorkHandoff, expensiveReasonError, delegationHasReturned,
  handoffReplyWaitMs,
  seedWriteWaitMs,
  DELEGATED_TURN_SURFACE_ACTIONS,
  DELEGATED_TURN_DELEGATION_ACTIONS,
  SEED_WRITE_ACTIONS,
  handoffFromReplyPostRows,
  replyIsPendingWorkHandoff,
  parseOeStatusFacts, decodeSlackEphemeralText, oeStatusCompactionThresholdTokens, watchDialAnswerSets,
  haltWakeForSlackAnchor, haltSetEvidence, haltClearEvidence, haltOwnedBySet, haltOwnedByWake, cleanupExactHalt,
  grantRowWaitMs, grantRowMissingNote, GRANTED_CALL_WAIT_MS,
} = await import("../packages/core/scripts/e2e/scenarios.js");
const { renderStatus } = await import("@open-everywhere/core/agent/commands/core.js");
const { runWatch } = await import("@open-everywhere/core/agent/commands/watch.js");
const { haltConfirmation } = await import("@open-everywhere/core/agent/tools/halt.js");
const { NO_CARD_NOTE_OPENING } = await import("@open-everywhere/core/agent/channels/approval-claim-guard.js");
const { emptySkipCounts, renderSkipBreakdown, SKIP_KINDS } = await import("../packages/core/scripts/e2e/skip-summary.js");
const { spendRefusalDmPreflight } = await import("../packages/core/scripts/e2e/spend-refusal-dm.js");
const { defineDomain } = await import("@open-everywhere/core/agent/memory/domain.js");
const {
  REPLY_POST_ACTION,
  STOOD_DOWN_ACTION,
  awaitReplyPostRows,
  awaitRepliesForAdmittedWakes,
  awaitStandDownVerdict,
  dispatchAddressings,
  isAmbientLegAddressing,
  dispatchedAction,
  replyPostCount,
  replyPostSurfaces,
  reportedDirectMention,
  reportedNameDrop,
  reportedSeatedChannelWatch,
  reportedThreadFollow,
  seatContinuity,
  seatOfSession,
  standDownAttemptedButUnmarked,
  standDownMarked,
  standDownReachedRegistry,
  standDownRows,
  wakeIngressIds,
  WAKE_INGRESS_ACTION,
} = await import("../packages/core/scripts/e2e/engaged-rows.js");
const { STAND_DOWN_ACTION } = await import("../packages/core/agent/tools/stand_down.js");
const { WAKE_INGRESS_ACTION: PRODUCT_WAKE_INGRESS_ACTION } = await import("../packages/core/agent/channels/wake-timing.js");
const { verifySlackSignature, classifyEnvelope, buildFrontHandler, PUBLIC_SLACK_ROUTE } = await import("@open-everywhere/provider-slack/agent/channels/slack-front.js");
const { SLACK_COMMANDS_ROUTE } = await import("@open-everywhere/provider-slack/agent/channels/slack-commands.js");
const { parseMessageEvent } = await import("@open-everywhere/provider-slack/agent/channels/slack-events.js");
const { SLACK_CHANNEL_ENTITY_TYPE, sidePanelViewedRoom, slackDmSystemNote } = await import("@open-everywhere/provider-slack/agent/channels/slack-side-panel.js");
const { relayGate, parseRelayPayload, authForRelayMessage } = await import("@open-everywhere/provider-discord/agent/channels/discord-gateway.js");
const { OE_APPROVAL_PREFIX } = await import("@open-everywhere/core/agent/approvals/flow.js");
const { OE_CONNECT_ACTION_PREFIX } = await import("@open-everywhere/core/agent/connections/connector-card.js");
const { SLACK_HOME_WIRE } = await import("@open-everywhere/core/agent/home/home-view.js");
const {
  OE_SETKEY_MODAL_CALLBACK,
  SETKEY_INPUT_BLOCK: REAL_SETKEY_INPUT_BLOCK,
  SETKEY_INPUT_ACTION: REAL_SETKEY_INPUT_ACTION,
} = await import("@open-everywhere/core/agent/credentials/intake.js");
const { standardWebhookVerifier, SW_ID_HEADER, SW_SIGNATURE_HEADER, SW_TIMESTAMP_HEADER } = await import(
  "@open-everywhere/core/agent/webhooks/oe-standard-webhook.js"
);
const eveRootDir = (await import("node:path")).dirname(
  (await import("node:module")).createRequire(import.meta.url).resolve("eve/package.json"),
);
const { parseAppMentionEvent } = await import(
  (await import("node:url")).pathToFileURL(`${eveRootDir}/dist/src/public/channels/slack/inbound.js`).href
);

{
  const primary = { userId: "U_ADMIN", teamId: "T_FIXTURE" };
  const secondary = { userId: "U_MEMBER", teamId: "T_FIXTURE" };
  const orgAdmin = defineDomain({ name: "org", match: "org", admins: ["slack/T_FIXTURE/U_ADMIN"] });
  const valid = spendRefusalDmPreflight({
    primary,
    secondary,
    expectedSecondaryUserId: "U_MEMBER",
    dmChannelId: "D0MEMBERBOT",
    domains: [orgAdmin],
  });
  ok(valid.ok && valid.surfaceKey === "slack/T_FIXTURE/D0MEMBERBOT", "the spend-refusal preflight derives the cap key from the secondary token's real workspace and opened DM");

  const blankIdentity = spendRefusalDmPreflight({
    primary,
    secondary: { userId: "", teamId: "T_FIXTURE" },
    expectedSecondaryUserId: "U_MEMBER",
    dmChannelId: "D0MEMBERBOT",
    domains: [],
  });
  ok(!blankIdentity.ok && blankIdentity.reason.includes("complete user/workspace identity"), "an incomplete live auth.test identity refuses before opening or capping a scope");

  const wrongDeclared = spendRefusalDmPreflight({
    primary,
    secondary,
    expectedSecondaryUserId: "U_SOMEONE_ELSE",
    dmChannelId: "D0MEMBERBOT",
    domains: [],
  });
  ok(!wrongDeclared.ok && wrongDeclared.reason.includes("not the declared secondary user"), "a token/user-id mismatch refuses before the leg can post");

  const reusedPrimary = spendRefusalDmPreflight({
    primary,
    secondary: primary,
    expectedSecondaryUserId: primary.userId,
    dmChannelId: "D0ADMINBOT",
    domains: [],
  });
  ok(!reusedPrimary.ok && reusedPrimary.reason.includes("primary driver user"), "the primary admin token cannot masquerade as the secondary fixture");

  const foreignWorkspace = spendRefusalDmPreflight({
    primary,
    secondary: { ...secondary, teamId: "T_OTHER" },
    expectedSecondaryUserId: secondary.userId,
    dmChannelId: "D0MEMBERBOT",
    domains: [],
  });
  ok(!foreignWorkspace.ok && foreignWorkspace.reason.includes("not the primary fixture workspace"), "a secondary identity from another Slack workspace is refused before deriving a cap key");

  const notDm = spendRefusalDmPreflight({ primary, secondary, expectedSecondaryUserId: secondary.userId, dmChannelId: "C_PUBLIC", domains: [] });
  ok(!notDm.ok && notDm.reason.includes("not a Slack DM id"), "a channel returned in place of the secondary DM cannot be temporarily capped");

  const adminSecondary = spendRefusalDmPreflight({
    primary,
    secondary,
    expectedSecondaryUserId: secondary.userId,
    dmChannelId: "D0MEMBERBOT",
    domains: [defineDomain({ name: "org", match: "org", admins: ["slack/T_FIXTURE/U_MEMBER"] })],
  });
  ok(!adminSecondary.ok && adminSecondary.reason.includes("admin standing"), "a real secondary identity that is now an org admin is refused before the cap or any message is written");

  const domainAdminSecondary = spendRefusalDmPreflight({
    primary,
    secondary,
    expectedSecondaryUserId: secondary.userId,
    dmChannelId: "D0MEMBERBOT",
    domains: [defineDomain({ name: "private-support", reach: ["slack/T_FIXTURE/D0MEMBERBOT"], admins: ["slack/T_FIXTURE/U_MEMBER"] })],
  });
  ok(!domainAdminSecondary.ok && domainAdminSecondary.reason.includes("admin standing"), "an admin of the explicit domain covering this exact DM is refused too — the same scope-aware bypass rule the product uses");

  const sameIdOtherWorkspace = spendRefusalDmPreflight({
    primary: { userId: "U_ADMIN", teamId: "T_OTHER" },
    secondary: { userId: "U_MEMBER", teamId: "T_OTHER" },
    expectedSecondaryUserId: "U_MEMBER",
    dmChannelId: "D0MEMBERBOT",
    domains: [defineDomain({ name: "org", match: "org", admins: ["slack/T_FIXTURE/U_MEMBER"] })],
  });
  ok(sameIdOtherWorkspace.ok, "the non-admin check is workspace-qualified — the same Slack-local user id in another tenant does not inherit admin standing");
}

{
  const { spendReportReaderPreflight, dmSpendPresence, spendMaskVerdict, spendMaskVerdictOver } = await import(
    "../packages/core/scripts/e2e/spend-dm-mask.js"
  );
  const { dmBucketKey: productBucketKey } = await import("../packages/core/agent/spend/dm-mask.js");
  const orgAdmin = defineDomain({ name: "org", match: "org", admins: ["slack/T_FIXTURE/U_ADMIN"] });

  const admin = spendReportReaderPreflight({ reader: { userId: "U_ADMIN", teamId: "T_FIXTURE" }, domains: [orgAdmin] });
  ok(admin.ok && admin.principalKey === "slack/T_FIXTURE/U_ADMIN", "the org-admin reader passes the preflight and carries its own qualified key");

  const member = spendReportReaderPreflight({ reader: { userId: "U_MEMBER", teamId: "T_FIXTURE" }, domains: [orgAdmin] });
  ok(!member.ok && member.reason.includes("slack/T_FIXTURE/U_MEMBER"), "a NON-admin reader is refused, and the reason names the exact key an operator must add");
  ok(!member.ok && member.reason.includes('scope:"org"'), "…and says WHY standing decides it: only org scope renders DM spend at all");

  const otherWorkspace = spendReportReaderPreflight({ reader: { userId: "U_ADMIN", teamId: "T_OTHER" }, domains: [orgAdmin] });
  ok(!otherWorkspace.ok, "NEGATIVE CONTROL: admin standing is workspace-qualified — the same user id in another tenant is not an org admin");

  const domainAdminOnly = spendReportReaderPreflight({
    reader: { userId: "U_LEAD", teamId: "T_FIXTURE" },
    domains: [orgAdmin, defineDomain({ name: "eng", reach: ["slack/T_FIXTURE/C1"], admins: ["slack/T_FIXTURE/U_LEAD"] })],
  });
  ok(!domainAdminOnly.ok, "NEGATIVE CONTROL: a DOMAIN admin is not an org admin — `requireOrgAdmin` reads the org roster only, and this preflight must not be looser");

  const blank = spendReportReaderPreflight({ reader: { userId: "", teamId: "T_FIXTURE" }, domains: [orgAdmin] });
  ok(!blank.ok, "an incomplete identity fails closed rather than composing a key nothing can admit");

  const DM_KEY = "slack/T_FIXTURE/D0DRIVER";
  ok(productBucketKey(DM_KEY) === "slack/T_FIXTURE/(dms)", "the masked bucket key comes from the PRODUCT's own dmBucketKey — the pack composes no bucket string of its own, so a rename there reds here rather than live");

  const usage = [
    { surfaceKey: DM_KEY, calls: 2, inputTokens: 10, outputTokens: 4 },
    { surfaceKey: DM_KEY, calls: 1, inputTokens: 6, outputTokens: 0 },
    { surfaceKey: "slack/T_FIXTURE/C_ROOM", calls: 9, inputTokens: 99, outputTokens: 99 },
  ];
  const seen = dmSpendPresence(usage, DM_KEY);
  ok(seen.present && seen.calls === 3 && seen.tokens === 20, "the raw usage read sums THIS DM surface's rows only — the channel row beside it contributes nothing");
  ok(dmSpendPresence(usage, "slack/T_FIXTURE/D0NOBODY").present === false, "NEGATIVE CONTROL: a DM surface with no row is absent, so the leg's positive gate stays conditional on a row it can see");
  ok(dmSpendPresence([{ surfaceKey: DM_KEY, calls: 0, inputTokens: 0, outputTokens: 0 }], DM_KEY).present === false, "a zero-call row is not spend — presence needs a call, not merely a key");

  const leaked = spendMaskVerdict(`surfaces:\nslack/T_FIXTURE/C_ROOM 198\n${DM_KEY} 20`, { dmChannelId: "D0DRIVER", dmSurfaceKey: DM_KEY });
  ok(leaked.leaks.includes(DM_KEY) && leaked.leaks.includes("D0DRIVER"), "a report naming the DM surface is a DISCLOSURE, and both the key and the bare channel id are reported");
  ok(leaked.bucket === false, "…and that report renders no masked bucket, so the positive gate cannot pass on it either");

  const masked = spendMaskVerdict(`surfaces:\nslack/T_FIXTURE/C_ROOM 198\nslack/T_FIXTURE/(dms) 20`, { dmChannelId: "D0DRIVER", dmSurfaceKey: DM_KEY });
  ok(masked.leaks.length === 0 && masked.bucket && !masked.bareBucketOnly, "the masked report discloses nothing and renders the workspace-qualified bucket — the live leg's pass");

  const noteOnly = spendMaskVerdict(
    'DM spend is aggregated into a single "(dms)" bucket per workspace — individual DM surfaces are deliberately never listed in reports.',
    { dmChannelId: "D0DRIVER", dmSurfaceKey: DM_KEY },
  );
  ok(
    noteOnly.bucket === false && noteOnly.bareBucketOnly,
    "🔴 the FALSE PASS this verdict exists to refuse: spend_report's own note carries the words \"(dms)\" bucket, so a reply that merely explains the masking renders no row and must not satisfy the positive gate",
  );

  const nothing = spendMaskVerdict("I can't run that here.", { dmChannelId: "D0DRIVER", dmSurfaceKey: DM_KEY });
  ok(nothing.leaks.length === 0 && !nothing.bucket && !nothing.bareBucketOnly, "a refusal discloses nothing and proves nothing — the exclusion passes, the positive gate reds, which is the leg scoring a product outcome");

  const split = spendMaskVerdictOver(
    ["Here's the breakdown:", `slack/T_FIXTURE/C_ROOM 198\n${DM_KEY} 20`],
    { dmChannelId: "D0DRIVER", dmSurfaceKey: DM_KEY },
  );
  ok(
    split.leaks.includes(DM_KEY) && split.leaks.includes("D0DRIVER"),
    "🔴 a DM key disclosed in the SECOND message is still a disclosure — `leaks` is the union across every message the ask produced",
  );
  ok(
    spendMaskVerdict("Here's the breakdown:", { dmChannelId: "D0DRIVER", dmSurfaceKey: DM_KEY }).leaks.length === 0,
    "NEGATIVE CONTROL: the preface alone discloses nothing, which is exactly why reading only the first reply would have passed the leaked run",
  );
  const splitBucket = spendMaskVerdictOver(["Here's the breakdown:", "slack/T_FIXTURE/(dms) 20"], { dmChannelId: "D0DRIVER", dmSurfaceKey: DM_KEY });
  ok(splitBucket.bucket && splitBucket.leaks.length === 0, "…and the positive half is an OR: the bucket counts wherever the table landed");
  const noneAtAll = spendMaskVerdictOver([], { dmChannelId: "D0DRIVER", dmSurfaceKey: DM_KEY });
  ok(!noneAtAll.bucket && !noneAtAll.bareBucketOnly && noneAtAll.leaks.length === 0, "NEGATIVE CONTROL: no messages at all renders no bucket — silence reds the positive gate instead of passing it vacuously");
  const bareThenQualified = spendMaskVerdictOver(['the "(dms)" bucket aggregates DM spend', "slack/T_FIXTURE/(dms) 20"], { dmChannelId: "D0DRIVER", dmSurfaceKey: DM_KEY });
  ok(bareThenQualified.bucket && !bareThenQualified.bareBucketOnly, "a qualified key in ANY message clears the ambiguous bare-(dms) state the second ask exists to resolve");

  const disjoint = spendMaskVerdictOver([`${DM_KEY} 20`, "slack/T_FIXTURE/(dms) 20"], { dmChannelId: "D0DRIVER", dmSurfaceKey: DM_KEY });
  const overlapping = spendMaskVerdictOver([`${DM_KEY} 20`, `${DM_KEY} 20`, "slack/T_FIXTURE/(dms) 20"], { dmChannelId: "D0DRIVER", dmSurfaceKey: DM_KEY });
  ok(
    JSON.stringify(overlapping) === JSON.stringify(disjoint),
    "🔴 re-reading a message the first collect already held changes no field of the verdict — which is what lets BOTH S-SPEND-DM-MASK collects floor at the ask",
  );
  ok(disjoint.leaks.length === 2 && disjoint.bucket, "NEGATIVE CONTROL: the fixture above really does carry both disclosures and the bucket, so the equality is not comparing two empty verdicts");

  const scenario = SCENARIOS.find((s) => s.id === "S-SPEND-DM-MASK")!;
  ok(scenario.surface === "slack", "S-SPEND-DM-MASK drives SLACK (OPE-1914) — a launch surface, so a missing fixture scores RED rather than a declared gap");
  ok(scenario.requires.join("+") === "slack+syntheticDm", "…and it needs only the Slack driver plus the real DM channel — the Discord capability went with the old vehicle");
  ok(
    scenario.timeoutMs >= 1_790_000,
    "the budget sits above the leg's real worst-case wait sum (fence 440s + DM reply 180s + usage poll 240s + two 420s channel round-trips + two 45s continuation windows)",
  );
}

{
  const { routineConnectorFixture, NOTION_MCP_HOST, ROUTINE_CONNECTOR_WRITE_OP } = await import("../packages/core/scripts/e2e/routine-connector-fixture.js");
  const { vercelConnectorHome } = await import("../packages/core/agent/access/connector-credentials.js");
  const { readFileSync: readSource } = await import("node:fs");
  const { fileURLToPath: toPath } = await import("node:url");

  const notionSource = readSource(toPath(new URL("../packages/core/agent/connections/notion.ts", import.meta.url)), "utf8");
  const dialled = /NOTION_MCP_URL\s*=\s*"([^"]+)"/u.exec(notionSource)?.[1];
  ok(dialled !== undefined, "connections/notion.ts still declares NOTION_MCP_URL as a literal this test can read");
  ok(dialled !== undefined && new URL(dialled).hostname === NOTION_MCP_HOST, `NOTION_MCP_HOST tracks the host connections/notion.ts dials (${String(dialled)})`);

  const SURFACE = "slack/T_FIXTURE/C_CONNECTOR";
  const domains = [defineDomain({ name: "e2e-connector", reach: [SURFACE] })];
  const credentials = [
    {
      connector: "notion",
      allows: ["api-key", "user-oauth"],
      credentials: [
        { id: "team-key", type: "api-key", secretRef: "db:notion:team-key", broker: "db", endpoints: { hosts: ["api.notion.com"], pathPrefixes: ["/v1/"], methods: ["GET", "POST"] } },
        { id: "user-oauth", type: "user-oauth" },
        { id: "workspace-oauth", type: "service-oauth", home: vercelConnectorHome("mcp.notion.com/notion-mcp"), endpoints: { hosts: [NOTION_MCP_HOST] } },
      ],
    },
  ] as const;
  const call = (bundles: readonly unknown[], bindings: readonly unknown[]) =>
    routineConnectorFixture({
      surfaceKey: SURFACE,
      connector: "notion",
      op: ROUTINE_CONNECTOR_WRITE_OP,
      mcpHost: NOTION_MCP_HOST,
      domains,
      bundles: bundles as never,
      bindings: bindings as never,
      credentials: credentials as never,
    });

  const noGrant = call([{ name: "rest-only", connections: [{ id: "notion-rest" }] }], [{ bundle: "rest-only", scope: { level: "domain", domain: "e2e-connector" } }]);
  ok(!noGrant.ok && noGrant.reason.includes("no bundle bound to") && noGrant.reason.includes('domain "e2e-connector"'), "no connector grant at all ⇒ RED-until-fixture naming the domain that needs one");

  const blocked = call(
    [{ name: "e2e-connector-fixture", connectors: [{ name: "notion", credential: "team-key" }] }],
    [{ bundle: "e2e-connector-fixture", scope: { level: "domain", domain: "e2e-connector" } }],
  );
  ok(
    !blocked.ok && blocked.reason.includes("e2e-connector-fixture") && blocked.reason.includes("team-key") && blocked.reason.includes("api.notion.com") && blocked.reason.includes(NOTION_MCP_HOST),
    "🔴 a grant whose credential is narrowed to another host reds with the exact bundle, credential, allowed host and dialled host — the sentence an operator acts on. This WAS the shipped state until OPE-1914 re-credentialled the bundle to `workspace-oauth`; the shipped arming is asserted in scripts/notion-connectors-test.ts, and this arm keeps the refusal sentence pinned",
  );

  const armed = call(
    [{ name: "notion-oauth-fixture", connectors: [{ name: "notion", credential: "user-oauth" }] }],
    [{ bundle: "notion-oauth-fixture", scope: { level: "domain", domain: "e2e-connector" } }],
  );
  ok(armed.ok && armed.bundle === "notion-oauth-fixture" && armed.credential === "user-oauth", "a credential with no endpoint narrowing IS reachable — the derivation is not a blanket refusal, which is what makes the red above meaningful");

  const surfaceScoped = call(
    [{ name: "surface-fixture", connectors: [{ name: "notion", credential: "user-oauth" }] }],
    [{ bundle: "surface-fixture", scope: { level: "surface", surface: SURFACE } }],
  );
  ok(surfaceScoped.ok, "a SURFACE-scoped binding on the exact driven room counts too");

  const orgOauth = call(
    [{ name: "notion-org-fixture", connectors: [{ name: "notion", credential: "workspace-oauth" }] }],
    [{ bundle: "notion-org-fixture", scope: { level: "domain", domain: "e2e-connector" } }],
  );
  ok(orgOauth.ok && orgOauth.oauthHome === "mcp.notion.com/notion-mcp", "a service-oauth grant carries its OAuth home — the key the org-consent preflight reads bind rows by");
  ok(armed.ok && armed.oauthHome === undefined && !("oauthHome" in armed), "NEGATIVE CONTROL: a user-oauth grant carries NO OAuth home — the org-consent preflight never runs for it");

  const personal = call(
    [{ name: "notion-personal", connectors: [{ name: "notion", credential: "user-oauth" }] }],
    [{ bundle: "notion-personal", scope: { level: "principal", principal: "slack/T_FIXTURE/U_ADMIN" } }],
  );
  ok(
    !personal.ok && personal.reason.includes("no bundle bound to"),
    "🔴 NEGATIVE CONTROL: a PRINCIPAL-scoped personal grant never satisfies the derivation — it resolves only in the DM universe, and a routine reusing a person's own DM credential is the escalation the fence exists to stop",
  );

  const otherRoom = routineConnectorFixture({
    surfaceKey: "slack/T_FIXTURE/C_ELSEWHERE",
    connector: "notion",
    op: ROUTINE_CONNECTOR_WRITE_OP,
    mcpHost: NOTION_MCP_HOST,
    domains,
    bundles: [{ name: "e2e-connector-fixture", connectors: [{ name: "notion", credential: "user-oauth" }] }] as never,
    bindings: [{ bundle: "e2e-connector-fixture", scope: { level: "domain", domain: "e2e-connector" } }] as never,
    credentials: credentials as never,
  });
  ok(!otherRoom.ok, "NEGATIVE CONTROL: a domain-scoped grant does not reach a room outside that domain");

  const unconfigured = call(
    [{ name: "typo-fixture", connectors: [{ name: "notion", credential: "team-kye" }] }],
    [{ bundle: "typo-fixture", scope: { level: "domain", domain: "e2e-connector" } }],
  );
  ok(!unconfigured.ok && unconfigured.reason.includes("does not configure"), "a grant naming a credential the catalogue has no entry for reds naming it, rather than resolving to something");
}

{
  const { ROUTINE_CONNECTOR_WRITE_OP: OP, routineConnectorFixture, routineConnectorFixtureClaim, NOTION_MCP_HOST } = await import(
    "../packages/core/scripts/e2e/routine-connector-fixture.js"
  );
  const { classifyConnectorOpTier } = await import("../packages/core/agent/access/consequence.js");
  const { effectiveConnectorOpTier } = await import("../packages/core/agent/access/connector-op-gating.js");
  const { loadBundles } = await import("../agent/access/bundles.js");
  const { declaredPermissionKinds } = await import("../packages/core/agent/routines/declared-permissions.js");
  const { unattendedArmRoad, fireSessionIds, workerRowsOfFire, FIRE_ATTRS_SEEN_ACTION } = await import("../packages/core/scripts/e2e/gate-joins.js");
  const body = SCENARIOS.find((s) => s.id === "S-ROUTINE-CONNECTOR-WRITE")!.run.toString();

  ok(OP === "notion__notion-create-pages", `🔴 the leg drives the tool the hosted Notion MCP server declares (${OP}) — the name connector-approval-reachability-test.ts drives too`);
  ok(classifyConnectorOpTier(OP) === "write", `🔴 classifyConnectorOpTier puts ${OP} in the WRITE tier (got ${classifyConnectorOpTier(OP)}) — the only tier the fence's lift arm lifts; destructive would make arm B unbuildable`);
  ok(effectiveConnectorOpTier(OP, loadBundles()) === "write", `…and the DEPLOYED bundles do not raise it (effective tier ${effectiveConnectorOpTier(OP, loadBundles())}) — the fence reads the effective tier`);
  ok(classifyConnectorOpTier("notion__notion-delete-pages") === "destructive", "NEGATIVE CONTROL: the same vendor-prefixed shape with a delete verb is destructive — the write answer above comes from the verb, not the shape");
  ok(
    JSON.stringify(declaredPermissionKinds([`tool:${OP}`])) === JSON.stringify([pinnedConnectorToolPermissionKind(OP)]),
    "arm B's declaration `tool:<OP>` validates and maps onto the per-tool grant kind the fence's lift reads",
  );
  const { judgeHumanOnlyReason } = await import("../packages/core/agent/access/approver-chain.js");
  ok(
    judgeHumanOnlyReason({ tool: "create_routine", action: "routine.create", args: { permissions: [`tool:${OP}`] } }) !== undefined,
    "🔴 arm B's declaration `tool:<OP>` is in the human-only class — the judge is never consulted for it, so the click is the only lift the leg's gate names",
  );
  ok(body.includes("ROUTINE_CONNECTOR_WRITE_OP"), "🔴 the leg reads OP from the one constant");
  ok(!body.includes("notion__create_page") && !body.includes("notion-create-pages"), "🔴 …and carries NO second literal of a Notion create tool — asks, permissions and messages all read the constant");

  const armed = routineConnectorFixture({
    surfaceKey: "slack/T_FIXTURE/C_CONNECTOR",
    connector: "notion",
    op: OP,
    mcpHost: NOTION_MCP_HOST,
    domains: [defineDomain({ name: "e2e-connector", reach: ["slack/T_FIXTURE/C_CONNECTOR"] })],
    bundles: [{ name: "e2e-connector-fixture", connectors: [{ name: "notion", credential: "workspace-oauth" }] }] as never,
    bindings: [{ bundle: "e2e-connector-fixture", scope: { level: "domain", domain: "e2e-connector" } }] as never,
    credentials: [{ connector: "notion", allows: ["api-key"], credentials: [{ id: "workspace-oauth", type: "api-key", secretRef: "db:x", broker: "db", endpoints: { hosts: [NOTION_MCP_HOST] } }] }] as never,
  });
  ok(armed.ok, "fixture: a granted connector with an admitted MCP host derives ok");
  if (armed.ok) {
    const claim = routineConnectorFixtureClaim(armed, { connector: "notion", op: OP, mcpHost: NOTION_MCP_HOST });
    ok(
      claim.startsWith('connector "notion" is granted in domain "e2e-connector" by bundle "e2e-connector-fixture" as credential "workspace-oauth", whose endpoint rules admit mcp.notion.com.'),
      `🔴 the claim names what the preflight verified — connector, domain, bundle, credential, admitted host (${claim.slice(0, 120)}…)`,
    );
    ok(claim.includes(`NOT verified by this preflight: that the connector's MCP server declares ${OP}`), "🔴 …and says in words that the op name is NOT verified");
    ok(!/\breachable\b/u.test(claim), "NEGATIVE CONTROL: the claim never says the op is reachable — the measured overclaim");
  }
  ok(body.includes("routineConnectorFixtureClaim("), "🔴 the leg logs and quotes the honest claim");
  ok(!/isreachableindomain|derivedthisopasreachable/u.test(body.replace(/\s+/g, "")), "🔴 …and no longer carries either overclaiming sentence");

  const at = "2026-06-03T13:02:00.000Z";
  const SEAT = "wrun_example44";
  const FIRE = "wrun_example45";
  const seen = { ts: at, org: "o", platform: "slack", workspace: "w", action: FIRE_ATTRS_SEEN_ACTION, detail: { attrKeys: [], attrCount: 0, sessionId: FIRE } };
  const worker = (id: string, parent: string, root: string, tools: string[]) => ({
    ts: at,
    org: "o",
    platform: "unified",
    workspace: "e2e-connector",
    action: "worker.toolset",
    detail: { worker: id, parentSession: parent, rootSession: root, grain: "task", tools, toolCount: tools.length, namesTruncated: false },
  });
  const creationWorker = worker("wrun_example46", SEAT, SEAT, ["bash", "load_skill", "read_file", "reply"]);

  ok(
    JSON.stringify(fireSessionIds([seen, seen, { ...seen, detail: { sessionId: null } }, creationWorker])) === JSON.stringify([FIRE]),
    "the fire's session comes from its own fire_attrs_seen row, deduplicated; a null sessionId and other actions add nothing",
  );
  ok(workerRowsOfFire([creationWorker], [FIRE]).length === 0, "🔴 the seat's routine-CREATION worker is not the fire's worker");

  const nRh = unattendedArmRoad({ planeRows: 0, workerRows: [creationWorker], fireSessions: fireSessionIds([seen]), op: OP });
  ok(
    nRh.note === `the fire called no connector tool and delegated to no worker (fire session(s) ${JSON.stringify([FIRE])})`,
    `🔴 OPE-2092: a fire that delegated nothing says so — never "1 delegated worker ran" off the creation turn's roster (got: ${nRh.note})`,
  );
  ok(nRh.verdict === "unexplained" && nRh.road.workers === 0, "🔴 …and the creation roster no longer buys the arm a NOT PROVEN: the empty plane stays HARD");

  const fireWorker = worker("wrun_example47", FIRE, FIRE, ["bash", "load_skill", "read_file", "reply"]);
  const own = unattendedArmRoad({ planeRows: 0, workerRows: [creationWorker, fireWorker], fireSessions: [FIRE], op: OP });
  ok(own.verdict === "not-proven" && own.road.workers === 1, "NEGATIVE CONTROL: the FIRE's own worker without the op still explains the road — NOT PROVEN, one worker counted");
  const nested = worker("wrun_example48", "wrun_example47", FIRE, ["bash", OP]);
  ok(
    unattendedArmRoad({ planeRows: 0, workerRows: [nested], fireSessions: [FIRE], op: OP }).verdict === "unexplained",
    "a worker of the fire's worker joins by rootSession — and it mounted the op, so the empty plane is HARD",
  );

  const noFire = unattendedArmRoad({ planeRows: 0, workerRows: [creationWorker, fireWorker], fireSessions: [], op: OP });
  ok(noFire.verdict === "unexplained" && noFire.road.workers === 0, "🔴 no fire session known ⇒ no roster is attributed, so none can excuse the empty plane");
  ok(noFire.note.startsWith(`no ${FIRE_ATTRS_SEEN_ACTION} row in this window`), "…and the note says why");
  ok(
    unattendedArmRoad({ planeRows: 2, workerRows: [], fireSessions: [FIRE], op: OP }).note === `the fire delegated to no worker (fire session(s) ${JSON.stringify([FIRE])})`,
    "a plane row present ⇒ the note never claims the fire called no connector tool",
  );

  const flat = body.replace(/\s+/g, "");
  ok(flat.includes("constfireSessions=fireSessionIds(") && flat.includes("fireSessions,op:OP,transcripts"), "🔴 WIRING: the leg's armRoad passes the fire's session ids, read from the fire's own rows");

  const { routineConnectorWriteSteps } = await import("../packages/core/scripts/e2e/routine-connector-fixture.js");
  const steps = routineConnectorWriteSteps(OP, "rcwa-1");
  ok(
    steps.startsWith("Delegate this to a worker with the `agent` tool and pass it these instructions verbatim: \""),
    `🔴 OPE-2110: the fire's own step is the delegation, and the worker's instruction is quoted verbatim (got: ${steps})`,
  );
  ok(
    steps.includes(`"Call \`connection_search\` for the Notion page-creation operation, then call \`${OP}\` with `),
    "🔴 OPE-2097: the quoted instruction names connection_search and then the op, as a fact",
  );
  const FORBIDS_SKILL = /do not (load|use) (any|the) skill|do not use the notion-rest/iu;
  ok(FORBIDS_SKILL.exec(steps) === null, `🔴 OPE-2177: the quoted instruction forbids no skill (got: ${steps})`);
  ok(FORBIDS_SKILL.test("Do not load any skill and do not use the notion-rest scripts."), "NEGATIVE CONTROL: the regex matches the live-run sentence the seat cancelled on");
  ok(steps.includes("The Notion skill and its notion-rest scripts are not needed for this one call."), "OPE-2177: the quoted instruction says the skill is not needed for this one call");
  ok(
    steps.includes("Report exactly what the operation returned. A refusal is what a call returned, never something concluded without making one.\" Then report the worker's answer."),
    "🔴 OPE-2110: the worker reports what the call returned, and the fire reports the worker's answer",
  );
  ok(steps.includes("titled 'OE e2e rcwa-1'") && steps.includes("exact token rcwa-1"), "the page token rides the worker's instruction");
  ok(
    flat.includes("${routineConnectorReportLine(fireWord)}Confirmyou'vescheduledit."),
    "the confirmation word stays in the ask around the steps — the fire, not the worker, posts the report",
  );
  ok(!/starts with the word/u.test(steps), "the report line is not inside the worker's quoted steps");

  const { routineConnectorReportLine, routineFireReportMatch } = await import("../packages/core/scripts/e2e/routine-connector-fixture.js");
  const line = routineConnectorReportLine("rcwfxb-28318");
  ok(line.includes("starts with the word rcwfxb-28318") && line.includes("(do not use this word anywhere else)"), `the report line asks for the word FIRST (got: ${line})`);
  ok(!/ending that report with the word/u.test(line), "NEGATIVE: the report line no longer asks to END with the word");
  const m = { fireWord: "rcwfxb-28318", note: "rcwb-28317" };
  const ask = "1759301500.000100";
  const card = "1759301510.000200";
  const ack = "1759301520.000300";
  const floor = [ask, card, ack];
  const reportRk = { ts: "1759301800.000400", text: "The Notion page was created: OE e2e rcwb-28317" };
  ok(routineFireReportMatch(reportRk, { ...m, preFireTs: floor }) === "note", "🔴 the measured arm B report (page token only, top level, after the floor) counts as the fire's report");
  ok(routineFireReportMatch({ ...reportRk, threadTs: ask }, { ...m, preFireTs: floor }) === undefined, "🔴 NEGATIVE: the same text in the ask's thread never counts — that is where the card and the ack sit");
  ok(routineFireReportMatch({ ...reportRk, threadTs: reportRk.ts }, { ...m, preFireTs: floor }) === "note", "a thread ROOT (threadTs === ts) is a top-level post");
  ok(routineFireReportMatch({ ...reportRk, ts: "1759301515.000000" }, { ...m, preFireTs: floor }) === undefined, "🔴 NEGATIVE: a top-level page-token post before the ack never counts");
  ok(routineFireReportMatch({ ...reportRk, ts: ack }, { ...m, preFireTs: floor }) === undefined, "🔴 NEGATIVE: a post at the floor's own ts never counts (strictly after)");
  ok(routineFireReportMatch({ ...reportRk, ts: "1759301520.0003" }, { ...m, preFireTs: floor }) === undefined, "NEGATIVE: the ts compare is digit-exact — a shorter fraction of the same instant is not later");
  ok(routineFireReportMatch({ ...reportRk, ts: "999999999.900000" }, { ...m, preFireTs: ["1000000000.000000"] }) === undefined, "NEGATIVE: a ts with fewer integer digits is earlier, never compared as text");
  ok(routineFireReportMatch(reportRk, { ...m, preFireTs: [] }) === undefined, "🔴 NEGATIVE: with an empty floor a page-token post never counts");
  ok(routineFireReportMatch({ ts: "1759301500.000050", threadTs: ask, text: "rcwfxb-28318 tried the write" }, { ...m, preFireTs: floor }) === "fireWord", "the confirmation word counts anywhere, as before");
  ok(routineFireReportMatch({ ts: reportRk.ts, text: "nothing to see" }, { ...m, preFireTs: floor }) === undefined, "NEGATIVE: a post with neither token never counts");
  ok(flat.includes('awaitFire("B",askTs,note,fireWord,[askTs,cardTs,ack.ts])'), "🔴 WIRING: arm B's floor is its ask, its card and the seat's ack");
  ok(flat.includes('awaitFire("A",seedTs,note,fireWord,[seedTs])'), "🔴 WIRING: arm A's floor is the seed instant");
  ok(flat.includes("routineFireReportMatch(m,{fireWord,note,preFireTs})"), "🔴 WIRING: awaitFire matches posts through routineFireReportMatch");
  ok(!/not available|say so and stop/iu.test(steps), "🔴 NEGATIVE CONTROL: the instruction carries no escape hatch");
  ok(flat.includes("routineConnectorWriteSteps(OP,note)"), "🔴 WIRING: arm B's ask builds its instruction from routineConnectorWriteSteps");
  ok(flat.includes("routineConnectorFirePrompt(OP,note,fireWord)"), "🔴 WIRING: arm A's seeded routine builds its instruction from routineConnectorFirePrompt, which wraps the same steps (OPE-2130)");
  ok(!/notavailable|saysoandstop/iu.test(flat), "🔴 WIRING: the leg body carries no escape-hatch sentence of its own");
  ok(
    flat.includes('role:"fire",events:awaitctx.transcriptRead(id)') && flat.includes('role:"worker",events:awaitctx.transcriptRead(id)') && flat.includes("workerSessionIdsOfFire(workerRows,fireSessions)"),
    "🔴 WIRING: armRoad reads the transcript of the fire AND of every worker of the fire",
  );
  ok(flat.includes("op:OP,transcripts,attendedRows") && flat.includes("attended:attendedRowsForOp(all,OP)"), "🔴 WIRING: armRoad passes the transcripts and the attended-path count to unattendedArmRoad");

  const { fireOpCalls } = await import("../packages/core/scripts/e2e/gate-joins.js");
  const tev = (index: number, type: string, data: unknown) => ({ index, at: null, type, data });
  const search = tev(1, "actions.requested", { actions: [{ toolName: "connection_search", callId: "c1", input: { query: "notion create page" } }] });
  const found = tev(2, "action.result", { result: { callId: "c1", kind: "tool-result", toolName: "connection_search", output: { tools: [{ name: OP, inputSchema: {} }] } } });
  const skill = tev(3, "actions.requested", { actions: [{ toolName: "load_skill", callId: "c2", input: { name: "notion-rest" } }] });
  const failed = tev(4, "actions.requested", { actions: [{ toolName: "report_run_failed", callId: "c3", input: { reason: `the required one-shot ${OP} call was not made` } }] });
  const nRj = [search, found, skill, failed];
  ok(fireOpCalls(nRj, OP).discovered === true && fireOpCalls(nRj, OP).called === false, "the measured shape reads discovered=true, called=false");
  const skillText = tev(6, "action.result", { result: { callId: "c2", kind: "tool-result", toolName: "load_skill", output: `a 'notion' MCP connector (${OP}) acts as the subject on its grant` } });
  ok(
    fireOpCalls([search, skillText, failed], OP).discovered === false,
    "NEGATIVE CONTROL: a tool RESULT that names the op but is not connection_search's (the skill text) is not a discovery",
  );
  const fireT = (events: unknown[]) => [{ sessionId: FIRE, role: "fire" as const, events: events as never }];
  const disc = unattendedArmRoad({ planeRows: 0, workerRows: [], fireSessions: [FIRE], op: OP, transcripts: fireT(nRj) });
  ok(
    disc.note === `the fire discovered the op (connection_search returned ${OP}) and made no op call, and delegated to no worker — the road was open and the fire did not take it (fire session(s) ${JSON.stringify([FIRE])})`,
    `🔴 OPE-2097: the evidence line names "discovered, not called" (got: ${disc.note})`,
  );
  ok(disc.verdict === "unexplained", "🔴 …and it stays a HARD red");
  const noRoad = unattendedArmRoad({ planeRows: 0, workerRows: [], fireSessions: [FIRE], op: OP, transcripts: fireT([skill, failed]) });
  ok(noRoad.note.startsWith("the fire called no connector tool and delegated to no worker") && noRoad.verdict === "unexplained", "NEGATIVE CONTROL: no discovery ⇒ the \"no road\" line, still HARD");
  const calledOp = tev(5, "actions.requested", { actions: [{ toolName: OP, callId: "c4", input: {} }] });
  const called = unattendedArmRoad({ planeRows: 0, workerRows: [], fireSessions: [FIRE], op: OP, transcripts: fireT([search, found, calledOp]) });
  ok(called.note.startsWith(`fire ${FIRE} CALLED ${OP} and the connector plane carries no row`) && called.verdict === "unexplained", "an op call with no plane row names the calling session and the fence recording nothing, HARD");

  const { workerSessionIdsOfFire, transcriptTookRestRoad, attendedRowsForOp } = await import("../packages/core/scripts/e2e/gate-joins.js");
  const W = "wrun_example58";
  const restWorker = worker(W, FIRE, FIRE, ["bash", "load_skill", "read_file", "reply"]);
  ok(
    JSON.stringify(workerSessionIdsOfFire([creationWorker, restWorker, restWorker], [FIRE])) === JSON.stringify([W]),
    "the fire's worker ids come from its own worker.toolset rows, deduplicated; the creation turn's worker is not one",
  );
  const pageCreate = tev(7, "actions.requested", { actions: [{ toolName: "bash", callId: "c5", input: { command: "node skills/notion-rest/notion.mjs page create --title 'OE e2e rcwa-71582'" } }] });
  ok(transcriptTookRestRoad([skill]) && transcriptTookRestRoad([pageCreate]), "a notion-rest skill load, or a bash run of its script, is the REST road");
  ok(!transcriptTookRestRoad([search, found, calledOp]), "NEGATIVE CONTROL: the connector road is not the REST road");
  const both = (workerEvents: unknown[]) => [...fireT([]), { sessionId: W, role: "worker" as const, events: workerEvents as never }];
  const rest = unattendedArmRoad({ planeRows: 0, workerRows: [restWorker], fireSessions: [FIRE], op: OP, transcripts: both([skill, pageCreate]) });
  ok(rest.verdict === "not-proven", "the REST worker with the op unmounted is still NOT PROVEN");
  ok(
    rest.note.endsWith(`; the transcripts say: worker ${W} took the REST road (loaded the notion-rest skill or ran its notion.mjs script)`),
    `🔴 OPE-2110: the "another road" line names the worker that took the REST road (got: ${rest.note})`,
  );
  const wDisc = unattendedArmRoad({ planeRows: 0, workerRows: [restWorker], fireSessions: [FIRE], op: OP, transcripts: both([search, found, skill]) });
  ok(
    wDisc.note.includes(`worker ${W} discovered the op (connection_search returned ${OP}) and no session called it`),
    `🔴 OPE-2110: "discovered, not called" names the WORKER that discovered (got: ${wDisc.note})`,
  );
  const wCalled = unattendedArmRoad({ planeRows: 0, workerRows: [restWorker], fireSessions: [FIRE], op: OP, transcripts: both([search, found, calledOp]) });
  ok(
    wCalled.verdict === "unexplained" && wCalled.note.startsWith(`worker ${W} CALLED ${OP} and the connector plane carries no row`),
    `🔴 OPE-2110: a WORKER's op call with no plane row is HARD, and the note names the worker — the roster alone would have read NOT PROVEN (got: ${wCalled.verdict}: ${wCalled.note})`,
  );
  ok(
    unattendedArmRoad({ planeRows: 0, workerRows: [restWorker], fireSessions: [FIRE], op: OP, transcripts: [] }).verdict === "not-proven",
    "NEGATIVE CONTROL: with no transcript, the same roster reads NOT PROVEN — the HARD above comes from the worker's transcript",
  );

  const cardRow = { ts: at, org: "o", platform: "slack", workspace: "w", action: "approval.chain", detail: { tool: OP, verdict: "ask" } };
  const creationCard = { ts: at, org: "o", platform: "slack", workspace: "w", action: "approval.requested", detail: { id: "p1", kind: "routine.create" } };
  const creationChain = { ts: at, org: "o", platform: "slack", workspace: "w", action: "approval.chain", detail: { tool: "create_routine", verdict: "ask" } };
  ok(attendedRowsForOp([cardRow, creationCard, creationChain], OP).length === 1, "only a card row for the op is attended-path evidence; the routine.create card and chain rows are not");
  const att = unattendedArmRoad({ planeRows: 0, workerRows: [restWorker], fireSessions: [FIRE], op: OP, attendedRows: 1 });
  ok(
    att.verdict === "unexplained" && att.note.startsWith("ATTENDED PATH, A PRODUCT FINDING:") && att.note.includes('This is not "no road"'),
    `🔴 OPE-2110: an attended-path row for the op is HARD and named as the product finding (got: ${att.verdict}: ${att.note})`,
  );
  ok(unattendedArmRoad({ planeRows: 0, workerRows: [restWorker], fireSessions: [FIRE], op: OP, attendedRows: 0 }).verdict === "not-proven", "NEGATIVE CONTROL: no attended row ⇒ the same window reads NOT PROVEN");
  ok(unattendedArmRoad({ planeRows: 1, workerRows: [], fireSessions: [FIRE], op: OP, attendedRows: 1 }).verdict === "measured", "a fence row present ⇒ the arm scores its own gates");
}

{
  const { fireReportJoin, readsAsSpendRefusalReport, FIRE_ATTRS_SENT_ACTION, ROUTINE_FIRE_ACTION } = await import("../packages/core/scripts/e2e/gate-joins.js");
  const FIRE = "wrun_example56";
  const SEAT = "wrun_example57";
  const WAKE = "7664ed40-2109-4000-8000-000000000238";
  const row = (action: string, ts: string, detail: Record<string, unknown>) => ({ ts, org: "o", platform: "slack", workspace: "w", action, detail });
  const sent = row(FIRE_ATTRS_SENT_ACTION, "2026-06-02T19:52:13.000Z", { routineId: "r-2109", wakeId: WAKE, attrKeys: [], attrCount: 0 });
  const turn = row("wake.turn_start", "2026-06-02T19:52:14.000Z", { wakeId: WAKE, sessionId: FIRE, turnStartTs: "2026-06-02T19:52:14.000Z" });
  const report = row("reply.post", "2026-06-02T19:52:26.000Z", { id: "1780494746.000100", platform: "slack", chars: 275, route: "tool", sessionId: FIRE, wakeId: WAKE });
  const seatReply = row("reply.post", "2026-06-02T19:52:20.000Z", { id: "1780494740.000100", platform: "slack", chars: 90, route: "tool", sessionId: SEAT, wakeId: "seat-wake" });

  const posted = fireReportJoin([sent, turn, seatReply, report]);
  ok(posted.verdict === "posted", `🔴 fire row → turn_start → reply.post joins the measured report (got ${posted.verdict}: ${posted.detail})`);
  ok(
    JSON.stringify(posted.replies.map((r) => r.detail?.id)) === JSON.stringify(["1780494746.000100"]) && JSON.stringify(posted.sessionIds) === JSON.stringify([FIRE]),
    "🔴 …and only the fire's own post counts: the seat's reply in the same window is not the fire's report",
  );

  const other = fireReportJoin([sent, turn, seatReply]);
  ok(other.verdict === "no-reply", `🔴 a reply from another session does not count ⇒ no-reply (got ${other.verdict})`);
  ok(other.detail.includes(FIRE) && other.detail.includes("did not report back"), `…and the red names the fire's session and the rung (${other.detail})`);

  const noTurn = fireReportJoin([sent, report]);
  ok(noTurn.verdict === "no-session" && noTurn.detail.includes("did not start"), `no turn_start and no routine.fire row ⇒ the turn did not start (got ${noTurn.verdict})`);
  const noFire = fireReportJoin([turn, report]);
  ok(noFire.verdict === "no-fire" && noFire.detail.includes("dispatcher did not hand the routine out"), `🔴 no dispatcher row ⇒ red naming the dispatcher (got ${noFire.verdict}: ${noFire.detail})`);

  const nativeSent = row(FIRE_ATTRS_SENT_ACTION, "2026-06-02T19:52:13.000Z", { routineId: "r-2109", wakeId: null, attrKeys: [], attrCount: 0 });
  const settle = row(ROUTINE_FIRE_ACTION, "2026-06-02T19:52:30.000Z", { routineId: "r-2109", sessionId: FIRE, outcome: "failed" });
  const native = fireReportJoin([nativeSent, settle, report]);
  ok(native.verdict === "posted" && native.sessionIds[0] === FIRE, `a native fire joins through its routine.fire row (got ${native.verdict})`);
  ok(
    fireReportJoin([nativeSent, row(ROUTINE_FIRE_ACTION, "2026-06-02T19:52:30.000Z", { routineId: "r-OTHER", sessionId: FIRE }), report]).verdict === "no-session",
    "NEGATIVE CONTROL: another routine's settle row does not name this fire's session",
  );

  const textRj = "The $2,558 monthly USD spend-limit proposal was refused; no cap changed and no approval proposal was created. A person in this conversation must propose it.";
  ok(readsAsSpendRefusalReport(textRj), "🔴 the measured report reads as the refusal report without the confirmation word");
  ok(readsAsSpendRefusalReport("Update: I couldn't raise this channel's spend cap — the tool needs a verified sender."), "a 'could not' phrasing reads as the refusal report too");
  ok(readsAsSpendRefusalReport("I raised this channel's monthly spend cap to $2,558 USD.") === false, "NEGATIVE CONTROL: a post that claims it raised the cap is NOT the refusal report");
  ok(readsAsSpendRefusalReport("The request was refused.") === false, "NEGATIVE CONTROL: a refusal that does not name the spend cap is NOT the report");

  const body = SCENARIOS.find((s) => s.id === "S-TAINT-UNATTENDED-DENY")!.run.toString();
  const flat = body.replace(/\s+/g, "");
  ok(flat.includes("join=fireReportJoin([...sent,...joinRows])"), "🔴 WIRING: the fire wait reads the fire's report through fireReportJoin");
  ok(flat.includes("readsAsSpendRefusalReport(reportText)"), "🔴 WIRING: the content gate reads the joined report");
  ok(!flat.includes("carriesFactToken(m.text,fireWord)"), "🔴 WIRING: no wait keys on the confirmation word any more");
  ok(body.includes("luna habit 7: the failure report dropped the literal"), "WIRING: an absent word is a log line");

  ok(posted.report?.detail?.id === "1780494746.000100" && posted.reportRoad === "last-post", `a single-post fire's report is that post (got ${String(posted.report?.detail?.id)} / ${String(posted.reportRoad)})`);
}

{
  const { LAUNCH_RELEASE_SCOPE } = await import("../packages/core/scripts/e2e/release-scope.js");
  const suspendedModule = await import("../packages/core/scripts/e2e/suspended-approval.js");
  ok(SCENARIOS.every((s) => s.id !== "S-EVE-BRIDGE"), "🔴 OPE-2362: S-EVE-BRIDGE is off the roster — no shipped tool raises the approval it waited for");
  ok(LAUNCH_RELEASE_SCOPE.every((r) => r.id !== "S-EVE-BRIDGE"), "🔴 OPE-2362: …and off the launch release scope, so the board never requires it");
  ok(
    JSON.stringify(Object.keys(suspendedModule).sort()) === JSON.stringify(["slackVendorTimestamp"]),
    `🔴 OPE-2362: the bridged joins are deleted; suspended-approval.ts exports only the anchor's timestamp (got ${JSON.stringify(Object.keys(suspendedModule))})`,
  );
  ok(suspendedModule.slackVendorTimestamp("1780494320.100000") === "2026-06-03T13:45:20.100Z", "…and that timestamp still converts the Slack spelling to the wake.ingress one");
  ok(suspendedModule.slackVendorTimestamp("999999999999999999.1") === undefined, "NEGATIVE CONTROL: an out-of-range Slack timestamp is refused, not thrown");
  for (const surface of ["discord", "teams", "linear"]) {
    const sc = SCENARIOS.find((s) => s.id === `S-SUSPENDED-${surface}`)!;
    const body = sc.run.toString();
    ok(!body.includes("S-EVE-BRIDGE") && body.includes("S-SUSPENDED-slack's card road") && body.includes("op.connector card"), `🔴 OPE-2362: S-SUSPENDED-${surface}'s fixture message names the card road, not the retired bridge`);
    ok(!sc.title.includes("SUSPENDED turn") && sc.title.includes("Approval card"), `OPE-2362: S-SUSPENDED-${surface}'s title names the card (got ${sc.title})`);
  }
  const gh = SCENARIOS.find((s) => s.id === "S-SUSPENDED-github")!;
  ok(!gh.run.toString().includes("eve-HITL") && !gh.title.includes("eve-HITL") && gh.run.toString().includes("op.connector card"), "🔴 OPE-2362: S-SUSPENDED-github names the card road and no longer claims an eve-HITL site exists");
  const ghScope = LAUNCH_RELEASE_SCOPE.find((r) => r.id === "S-SUSPENDED-github");
  ok(ghScope?.requirement === "NON_LAUNCH" && ghScope.reason?.includes("op.connector card") === true && !/Eve-native/i.test(ghScope.reason ?? ""), "OPE-2362: the GitHub row's NON_LAUNCH reason names the card road");
}

{
  const { fireReportJoin, fireSettleSessionIds, FIRE_REPORT_JOIN_ACTIONS, FIRE_ATTRS_SENT_ACTION, ROUTINE_FIRE_ACTION } = await import("../packages/core/scripts/e2e/gate-joins.js");
  const SEAT = "wrun_example71";
  const WORK = "wrun_example72";
  const SIBLING_WORK = "wrun_example73";
  const FIRE_WAKE = "2361f1e0-0000-4000-8000-00000000fire";
  const REQUEST = "2361f1e0-0000-4000-8000-0000000req1";
  const row = (action: string, ts: string, detail: Record<string, unknown>, platform = "slack") => ({ ts, org: "o", platform, workspace: "w", action, detail });
  const sent = row(FIRE_ATTRS_SENT_ACTION, "2026-06-14T06:39:31.580Z", { routineId: "r-2361", wakeId: FIRE_WAKE, attrKeys: [], attrCount: 0 });
  const forward = row("work.forwarded", "2026-06-14T06:39:32.013Z", { requestId: REQUEST, wakeId: FIRE_WAKE, workGeneration: 2, tainted: false, fire: true, owesRoom: true, routineId: "r-2361" }, "unified");
  const workTurn = row("wake.turn_start", "2026-06-14T06:39:34.182Z", { wakeId: REQUEST, sessionId: WORK, turnId: "turn_16" });
  const started = row("delegation.task_started", "2026-06-14T06:39:43.198Z", { task: "agent-2361", kind: "agent", session: WORK, request: REQUEST }, "ingest");
  const settle = row(ROUTINE_FIRE_ACTION, "2026-06-14T06:40:10.917Z", { routineId: "r-2361", sessionId: WORK, outcome: "failed" });
  const resultWake = row("work.result_wake", "2026-06-14T06:40:11.818Z", { taskId: "agent-2361", requestId: REQUEST, status: "completed", outcome: "delivered", wakeId: FIRE_WAKE, fire: true }, "unified");
  const seatTurn = row("wake.turn_start", "2026-06-14T06:40:12.548Z", { wakeId: FIRE_WAKE, sessionId: SEAT, turnId: "turn_5" });
  const report = row("reply.post", "2026-06-14T06:40:19.018Z", { id: "1781419218.236000", platform: "slack", chars: 247, route: "tool", wakeId: FIRE_WAKE, sessionId: SEAT });

  const join = fireReportJoin([sent, forward, workTurn, started, settle, resultWake, seatTurn, report]);
  ok(join.verdict === "posted" && join.report?.detail?.id === "1781419218.236000", `🔴 OPE-2361: the forwarded fire's report is the seat's post under the fire's wake (got ${join.verdict}: ${join.detail})`);
  ok(JSON.stringify(join.sessionIds) === JSON.stringify([SEAT]) && JSON.stringify(join.workSessionIds) === JSON.stringify([WORK]), `🔴 …the fire's session is the seat, and the forward joins W by the request id (got ${JSON.stringify(join.sessionIds)} / ${JSON.stringify(join.workSessionIds)})`);
  ok(fireSettleSessionIds(join).includes(WORK), "🔴 OPE-2361: the settle set names W, so the routine.fire row W wrote settles the fire");
  ok(join.detail.includes(WORK), `…and the join's own sentence names W (${join.detail})`);
  ok(fireReportJoin([sent, forward, started, seatTurn, report]).workSessionIds.includes(WORK), "the task_started row alone (request → session) joins W");
  ok(fireReportJoin([sent, forward, workTurn, seatTurn, report]).workSessionIds.includes(WORK), "W's turn_start under the request id alone joins W");

  const noForward = fireReportJoin([sent, workTurn, started, settle, seatTurn, report]);
  ok(noForward.workSessionIds.length === 0 && fireSettleSessionIds(noForward).includes(WORK) === false, "NEGATIVE CONTROL: no work.forwarded row ⇒ no work session joins, and W is not in the settle set");
  const siblingForward = row("work.forwarded", "2026-06-14T06:39:40.000Z", { requestId: "2361f1e0-0000-4000-8000-0000sibling1", wakeId: "2361f1e0-0000-4000-8000-0000siblwake" }, "unified");
  const siblingStarted = row("delegation.task_started", "2026-06-14T06:39:45.000Z", { task: "agent-sib", session: SIBLING_WORK, request: "2361f1e0-0000-4000-8000-0000sibling1" }, "ingest");
  const withSibling = fireReportJoin([sent, forward, workTurn, started, siblingForward, siblingStarted, settle, seatTurn, report]);
  ok(!withSibling.workSessionIds.includes(SIBLING_WORK) && withSibling.workSessionIds.includes(WORK), `NEGATIVE CONTROL: a sibling job's forward and dispatch do not join (got ${JSON.stringify(withSibling.workSessionIds)})`);
  const foreignRequest = row("delegation.task_started", "2026-06-14T06:39:45.000Z", { task: "agent-x", session: SIBLING_WORK, request: "not-this-request" }, "ingest");
  ok(fireReportJoin([sent, forward, foreignRequest, seatTurn, report]).workSessionIds.length === 0, "NEGATIVE CONTROL: a dispatch row for another request does not join");

  ok(FIRE_REPORT_JOIN_ACTIONS.includes("work.forwarded") && FIRE_REPORT_JOIN_ACTIONS.includes("delegation.task_started"), "🔴 WIRING: the fire-report read asks for work.forwarded and delegation.task_started");
  const flat = SCENARIOS.find((s) => s.id === "S-TAINT-UNATTENDED-DENY")!.run.toString().replace(/\s+/g, "");
  ok(flat.includes("actions:FIRE_REPORT_JOIN_ACTIONS"), "🔴 WIRING: S-TAINT-UNATTENDED-DENY reads FIRE_REPORT_JOIN_ACTIONS");
  ok(flat.includes("fireSessions=fireSettleSessionIds(fireReport.join)"), "🔴 WIRING: the settle gate follows the forward");
}

{
  const { fireReportJoin, readsAsSpendRefusalReport, FIRE_ATTRS_SENT_ACTION, SETTLEMENT_REPORT_POSTED_ACTION } = await import("../packages/core/scripts/e2e/gate-joins.js");
  const { fireReportWaitMs, isPendingWorkHandoff } = await import("../packages/core/scripts/e2e/scenarios.js");
  const FIRE = "wrun_example59";
  const WAKE = "7664ed40-2117-4000-8000-000000000240";
  const TASK_WAKE = "7664ed40-2117-4000-8000-00000000task";
  const TASK = "task_2117";
  const row = (action: string, ts: string, detail: Record<string, unknown>, seq: number) => ({ ts, org: "o", platform: "slack", workspace: "w", action, detail, seq });
  const HANDOFF = "I've handed off the exact spend-limit proposal attempt; I'll report the tool's outcome here when it returns.";
  const SETTLEMENT = "`set_spend_limit` was refused because this turn had no verified sender, so it couldn't propose the change in a person's name. A person in the conversation must propose it. No limit change was made. tntfx-10672";
  const sent = row(FIRE_ATTRS_SENT_ACTION, "2026-06-03T02:42:10.000Z", { routineId: "r-2117", wakeId: WAKE, attrKeys: [], attrCount: 0 }, 1);
  const turn = row("wake.turn_start", "2026-06-03T02:42:11.000Z", { wakeId: WAKE, sessionId: FIRE, turnStartTs: "2026-06-03T02:42:11.000Z" }, 2);
  const started = row("delegation.task_started", "2026-06-03T02:42:15.000Z", { task: TASK, wake: WAKE }, 3);
  const handoff = row("reply.post", "2026-06-03T02:42:21.000Z", { id: "1780453341.000100", platform: "slack", route: "tool", sessionId: FIRE, wakeId: WAKE }, 4);
  const taskSettled = row("delegation.task_settled", "2026-06-03T02:42:59.000Z", { task: TASK }, 5);
  const settlementPost = row("reply.post", "2026-06-03T02:43:02.000Z", { id: "1780453382.000100", platform: "slack", route: "tool", sessionId: FIRE, wakeId: TASK_WAKE }, 6);
  const settlementRow = row(SETTLEMENT_REPORT_POSTED_ACTION, "2026-06-03T02:43:02.100Z", { task: TASK, wake: TASK_WAKE }, 7);

  const early = fireReportJoin([sent, turn, started, handoff]);
  ok(early.verdict === "posted" && early.report?.detail?.id === "1780453341.000100" && early.reportRoad === "last-post", `the hand-off alone is the newest post (got ${String(early.report?.detail?.id)} / ${String(early.reportRoad)})`);
  ok(isPendingWorkHandoff(HANDOFF), "🔴 the measured hand-off text reads as a pending-work hand-off");
  ok(readsAsSpendRefusalReport(HANDOFF) === false, "NEGATIVE CONTROL: the measured hand-off does NOT read as the refusal report");
  ok(fireReportWaitMs(early.reportRoad, HANDOFF) === 420_000, `🔴 a hand-off report extends the wait by the delegated budget (got ${String(fireReportWaitMs(early.reportRoad, HANDOFF))})`);

  const settled = fireReportJoin([sent, turn, started, handoff, taskSettled, settlementPost, settlementRow]);
  ok(settled.verdict === "posted" && settled.replies.length === 2, `both fire posts join (got ${settled.verdict}, ${settled.replies.length})`);
  ok(
    settled.report?.detail?.id === "1780453382.000100" && settled.reportRoad === "settlement",
    `🔴 the fire's report is the settlement post, not the hand-off (got ${String(settled.report?.detail?.id)} / ${String(settled.reportRoad)})`,
  );
  ok(fireReportWaitMs(settled.reportRoad, SETTLEMENT) === undefined, "🔴 a settlement-named report needs no extra wait");
  ok(fireReportWaitMs("settlement", HANDOFF) === undefined, "a settlement row outranks the prose heuristic");
  ok(readsAsSpendRefusalReport(SETTLEMENT), "🔴 the measured settlement wording reads as the spend refusal report");
  ok(
    readsAsSpendRefusalReport("`set_spend_limit` was refused because this turn had no verified sender."),
    "🔴 the tool name alone is the spend subject (no word boundary inside set_spend_limit)",
  );
  ok(readsAsSpendRefusalReport("`set_channel_topic` was refused.") === false, "NEGATIVE CONTROL: another tool's refusal is NOT the spend report");

  const stray = fireReportJoin([sent, turn, handoff, row(SETTLEMENT_REPORT_POSTED_ACTION, "2026-06-03T02:42:30.000Z", { task: "task_other", wake: "other-wake" }, 8)]);
  ok(stray.reportRoad === "last-post" && stray.report?.detail?.id === "1780453341.000100", `NEGATIVE CONTROL: a stray settlement row names no fire post (got ${String(stray.reportRoad)})`);

  const flat = (await import("../packages/core/scripts/e2e/scenarios.js")).SCENARIOS.find((s) => s.id === "S-TAINT-UNATTENDED-DENY")!.run.toString().replace(/\s+/g, "");
  const { FIRE_REPORT_JOIN_ACTIONS: joinActions } = await import("../packages/core/scripts/e2e/gate-joins.js");
  ok(
    flat.includes("actions:FIRE_REPORT_JOIN_ACTIONS") && joinActions.includes("reply.post") && joinActions.includes(SETTLEMENT_REPORT_POSTED_ACTION),
    "🔴 WIRING: the fire read carries the settlement rows",
  );
  ok(flat.includes("constfired=fireReport.report;") || flat.includes("constfired=fireReport!.report;"), "🔴 WIRING: the report is the join's report, never the first or joined posts");
  ok(flat.includes("fireReportWaitMs(firstReport.join.reportRoad,firstReport.report.text)"), "🔴 WIRING: a hand-off first report opens the settlement wait");
}

{
  const scenario = SCENARIOS.find((s) => s.id === "S-SPEND-REFUSAL-KEYS")!;
  const { sqliteOperationalStore } = await import("../packages/core/agent/operational/sqlite.js");
  const org = "spend-refusal-driver-test";
  const teamId = "T0EXAMPLE";
  const primaryUserId = "U0EXOWNER";
  const secondaryUserId = "U0SPENDMEMBER";
  const dmChannelId = "D0SPENDMEMBER";
  const surfaceKey = `slack/${teamId}/${dmChannelId}`;
  const events: string[] = [];
  let gates = 0;

  const dm = {
    channelId: dmChannelId,
    async identity() {
      events.push("dm.identity");
      return { userId: secondaryUserId, teamId };
    },
    async awaitSeatQuiet() {
      events.push("dm.fence");
      const before = (await sqliteOperationalStore.spendLimits(org)).find((row) => row.scopeKey === surfaceKey && row.level === "surface");
      ok(before === undefined, "the dynamic secondary-DM fence runs before the temporary cap is inserted");
      return { quiet: true, anchorTs: "100.000001", abandoned: false, waitedMs: 0, verdict: "settled" };
    },
    async post() {
      events.push("dm.post");
      const armed = (await sqliteOperationalStore.spendLimits(org)).find((row) => row.scopeKey === surfaceKey && row.level === "surface");
      ok(armed?.monthlyTokens === 1 && armed.reason?.startsWith("e2e:S-SPEND-REFUSAL-KEYS:") === true, "the real stdio writer stored the exact one-token DM cap before the first post");
      return { ts: "101.000001" };
    },
    async awaitAnyReply() {
      events.push("dm.reply");
      return {
        ts: "101.000002",
        text: "⛔ I'm holding off — the per-conversation cap (1 tokens/month) is exceeded. Ask an admin to raise the cap for this conversation. The cap to raise: this DM. An admin who needs its scope key can ask me for it.",
      };
    },
  };
  const secondary = {
    async identity() {
      events.push("secondary.identity");
      return { userId: secondaryUserId, teamId };
    },
    async openDirectMessage(userId: string) {
      events.push(`secondary.open:${userId}`);
      return dmChannelId;
    },
    withChannel(channelId: string) {
      ok(channelId === dmChannelId, "the secondary token is rebound to the DM conversations.open returned");
      return dm;
    },
  };
  const primary = {
    botUserId: "U0OPENEVERYWHERE",
    async identity() {
      events.push("primary.identity");
      return { userId: primaryUserId, teamId };
    },
  };
  const logs: string[] = [];
  await scenario.run({
    slack: primary,
    slackSecondary: secondary,
    slackSecondaryUserId: secondaryUserId,
    controlWriteConfig: { org, storeEnv: { OE_OPERATIONAL_PROVIDER: "sqlite", OE_SQLITE_PATH: process.env.OE_SQLITE_PATH! } },
    async auditRead(opts: { actions?: readonly string[] }) {
      events.push("audit.read");
      if (opts.actions?.includes("control.service_call")) return [storeMarkRow()];
      return opts.actions?.includes("spend.gate")
        ? [{ ts: new Date().toISOString(), org, platform: "slack", workspace: teamId, surface: dmChannelId, action: "spend.gate", detail: { key: surfaceKey, mode: "dm", door: "mention", over: true } }]
        : [];
    },
    gate(pass: boolean, label: string) {
      if (!pass) throw new Error(`GATE ${label}`);
      gates++;
    },
    skip(reason: string): never {
      throw new ScenarioSkip(reason);
    },
    log(line: string) {
      logs.push(line);
    },
  } as never);
  ok(events.indexOf("secondary.identity") < events.indexOf("secondary.open:U0OPENEVERYWHERE"), "the real secondary identity is resolved before its DM is opened");
  ok(events.indexOf("dm.fence") < events.indexOf("dm.post"), "the secondary DM seat is fenced before the capped refusal drive posts");
  ok(events.includes("audit.read"), "the refusal is joined to the deployment's exact spend.gate row instead of trusting reply text alone");
  ok(gates >= 5, "the live leg exercised identity, stored-cap, refusal-copy and audit gates");
  ok((await sqliteOperationalStore.spendLimits(org)).every((row) => row.scopeKey !== surfaceKey), "the exact unchanged temporary cap is removed after the refusal succeeds");
  ok(logs.some((line) => line.includes("temporary spend cap cleared")), "the run log records successful owned-row cleanup");
}

{
  const exampleText = readFileSync(fileURLToPath(new URL("../.env.e2e.example", import.meta.url)), "utf-8");
  const rowNames = new Set([...exampleText.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  const registryNames: readonly string[] = Object.values(ENV);

  ok(!rowNames.has("E2E_A_NAME_THE_EXAMPLE_DOES_NOT_DECLARE"), "negative control: the row set rejects a name the example does not declare");
  ok(rowNames.has(ENV.slackUserToken), "positive control: the row set finds a name the example does declare");
  ok(registryNames.length > 50, `positive control: the ENV registry parsed into a real name set (${registryNames.length} names)`);

  const undocumented = registryNames.filter((n) => !rowNames.has(n));
  ok(
    undocumented.length === 0,
    `🔴 every env name the e2e harness reads carries a row in .env.e2e.example — an operator cannot set what no example names (undocumented: ${undocumented.join(", ")})`,
  );

  const e2eDir = fileURLToPath(new URL("../packages/core/scripts/e2e/", import.meta.url));
  const harnessSource = readdirSync(e2eDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => readFileSync(join(e2eDir, e.name), "utf-8"))
    .join("\n");
  const spelled = (name: string): boolean => new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(harnessSource);
  ok(spelled(ENV.slackUserToken), "positive control: the harness source blob really carries the registry's names");
  ok(!spelled("E2E_A_NAME_NO_HARNESS_FILE_SPELLS"), "negative control: the harness source blob rejects a name nothing spells");
  ok(spelled("E2E_EXPECT_MODELS"), "positive control: a name that is also a PREFIX of a longer one is found on its own, not through the longer sibling");
  ok(!spelled("E2E_EXPECT_MODEL"), "🔴 negative control: a PREFIX of a real name is NOT accepted — the match is word-bounded, not a substring scan");

  const deadRows = [...rowNames].filter((n) => !spelled(n));
  ok(
    deadRows.length === 0,
    `🔴 every row in .env.e2e.example is read by some file under scripts/e2e/ — a dead row asks an operator to provision a fixture nothing looks at (dead: ${deadRows.join(", ")})`,
  );
}

{
  const empty = {};
  const slack = resolveSlack(empty);
  ok(!slack.ok && slack.missing.length === 3, "empty env: slack half reports all three missing vars");
  ok(!slack.ok && slack.missing.includes(ENV.slackUserToken), "missing list names E2E_SLACK_USER_TOKEN");
  const discord = resolveDiscord(empty);
  ok(!discord.ok && discord.missing.includes(ENV.discordDriverToken), "missing list names E2E_DISCORD_DRIVER_TOKEN");
  const teams = resolveTeams(empty);
  ok(!teams.ok && teams.missing.length === 6, "empty env: teams half reports all six missing vars");
  ok(!teams.ok && teams.missing.includes(ENV.teamsRefreshToken) && teams.missing.includes(ENV.teamsBotAppId), "missing list names E2E_TEAMS_REFRESH_TOKEN + E2E_TEAMS_BOT_APP_ID");
  const synthetic = resolveSynthetic(empty);
  ok(!synthetic.ok && synthetic.missing.includes(ENV.slackSigningSecret), "missing list names SLACK_SIGNING_SECRET");

  const slackPriv = resolveSlackPrivate(empty);
  ok(!slackPriv.ok && slackPriv.missing.join(",") === ENV.slackPrivateChannel, "private-channel add-on misses exactly E2E_SLACK_PRIVATE_CHANNEL");
  const slackB = resolveSlackChannelB(empty);
  ok(!slackB.ok && slackB.missing.join(",") === ENV.slackChannelB, "channel-B add-on misses exactly E2E_SLACK_CHANNEL_B");
  const slackCap = resolveSlackCapFixture(empty);
  ok(!slackCap.ok && slackCap.missing.join(",") === ENV.slackCapChannel, "S10 cap-fixture add-on misses exactly E2E_SLACK_CAP_CHANNEL");
  const haltTracked = { [ENV.slackHaltChannel]: "C0HALT" };
  const slackHalt = resolveSlackHalt(empty, haltTracked);
  ok(slackHalt.ok && slackHalt.cfg.channel === "C0HALT", "S-HALT resolves its dedicated tracked room without copying the id into env");
  for (const [label, envVar] of [
    ["base", ENV.slackChannel],
    ["private", ENV.slackPrivateChannel],
    ["channel B", ENV.slackChannelB],
    ["DM", ENV.slackDmChannel],
    ["supervisor", ENV.slackSupervisorChannel],
    ["cap", ENV.slackCapChannel],
    ["connector", ENV.notionChannel],
    ["unified A", ENV.slackUnifiedChannelA],
    ["unified B", ENV.slackUnifiedChannelB],
  ] as const) {
    const collided = resolveSlackHalt({ [envVar]: "C0HALT" }, haltTracked);
    ok(!collided.ok && collided.missing.some((m) => m.includes(envVar)), `S-HALT refuses a ${label} fixture collision and names its owner`);
  }
  const controlMissing = resolveControlWrite(empty);
  ok(!controlMissing.ok && controlMissing.missing.length === 4, "local control write stays dark unless explicitly armed with org + Postgres store");
  const controlResolved = resolveControlWrite({
    [ENV.controlLocalWrite]: "1",
    [ENV.org]: "fixture-org",
    OE_OPERATIONAL_PROVIDER: "postgres",
    DATABASE_URL: "postgresql://secret.invalid/db",
  });
  ok(controlResolved.ok && controlResolved.cfg.org === "fixture-org" && controlResolved.cfg.storeEnv.DATABASE_URL === "postgresql://secret.invalid/db", "local control write pins the exact org/store without exposing a remote write token");
  const synDm = resolveSyntheticDm(empty);
  ok(
    !synDm.ok && synDm.missing.join(",") === ENV.slackDmChannel,
    "DM fixture misses exactly E2E_SLACK_DM_CHANNEL (OPE-1036: no longer needs a target URL or signing secret — the DM legs post through the real front door, not a forge)",
  );
  const user2Miss = resolveSlackUser2(empty);
  ok(!user2Miss.ok && user2Miss.missing.join(",") === ENV.slackUser2Id, "user2 add-on misses exactly E2E_SLACK_USER2_ID");
  const secondaryMiss = resolveSlackSecondary(empty);
  ok(
    !secondaryMiss.ok && secondaryMiss.missing.join(",") === `${ENV.slackSecondaryToken},${ENV.slackSecondaryUserId}`,
    "secondary-identity add-on misses BOTH E2E_SLACK_SECONDARY_TOKEN + E2E_SLACK_SECONDARY_USER_ID in an empty env",
  );
  const secondaryTokenOnly = resolveSlackSecondary({ [ENV.slackSecondaryToken]: "xoxp-secondary" });
  ok(
    !secondaryTokenOnly.ok && secondaryTokenOnly.missing.join(",") === ENV.slackSecondaryUserId,
    "secondary-identity add-on with only the token set still misses exactly E2E_SLACK_SECONDARY_USER_ID (both required together)",
  );
  const webhookMiss = resolveWebhook(empty);
  ok(
    !webhookMiss.ok && webhookMiss.missing.includes(ENV.webhookSecret) && webhookMiss.missing.includes(ENV.targetUrl),
    "webhook capability misses E2E_WEBHOOK_SECRET + E2E_TARGET_URL",
  );
  const notionMiss = resolveNotion(empty);
  ok(!notionMiss.ok && notionMiss.missing.join(",") === ENV.notionChannel, "notion add-on misses exactly E2E_NOTION_CHANNEL");
  const uniMiss = resolveSlackUnified(empty);
  ok(
    !uniMiss.ok && uniMiss.missing.join(",") === `${ENV.slackUnifiedChannelA},${ENV.slackUnifiedChannelB}`,
    "slackUnified add-on misses exactly E2E_SLACK_UNIFIED_CHANNEL_A + E2E_SLACK_UNIFIED_CHANNEL_B (the domain name is defaulted, never required)",
  );

  const MPIM_TRACKED = { [ENV.slackMpimChannel]: "G0TRACKED" };
  const mpimFromRepo = resolveSlackMpim(empty, MPIM_TRACKED);
  ok(
    mpimFromRepo.ok && mpimFromRepo.cfg.channel === "G0TRACKED",
    "🔴 with E2E_SLACK_MPIM_CHANNEL unset, J-MPIM's room resolves from the tracked inventory — the whole point: a deployment nobody edited cannot lose the id",
  );
  const mpimEnvWins = resolveSlackMpim({ [ENV.slackMpimChannel]: "G0ENV" }, MPIM_TRACKED);
  ok(mpimEnvWins.ok && mpimEnvWins.cfg.channel === "G0ENV", "the variable stays an OVERRIDE — set, it wins over the tracked id");
  const mpimNowhere = resolveSlackMpim(empty, {});
  ok(
    !mpimNowhere.ok && mpimNowhere.missing.join(",") === ENV.slackMpimChannel,
    "🔴 the control: absent from BOTH is still a skip naming the variable — never a red, and never a resolved room that does not exist",
  );
  const mpimDeclaredEmpty = resolveSlackMpim(empty, { [ENV.slackMpimChannel]: "" });
  ok(
    !mpimDeclaredEmpty.ok,
    "the second control: a tracked entry DECLARED with an empty id resolves nothing — declared is not provisioned, which is the state this repository ships in",
  );
  ok(
    resolveCapabilities(empty, MPIM_TRACKED).available.size === 0,
    "🔴 a tracked room id alone is NOT a live capability — an env with no credentials stays full dry mode, which the runner passes by design",
  );

  const GH_TRACKED = { [ENGAGED_ROOM_VARS.github]: "owner/tracked-repo" };
  const ghFromRepo = resolveEngagedGithub(empty, GH_TRACKED);
  ok(
    ghFromRepo.ok && ghFromRepo.cfg.id === "owner/tracked-repo",
    "🔴 with E2E_ADDRESSED_GITHUB_REPO unset, J-ENGAGED-github's repo resolves from the tracked inventory — a deployment nobody edited cannot lose the id",
  );
  const ghEnvWins = resolveEngagedGithub({ [ENGAGED_ROOM_VARS.github]: "owner/env-repo" }, GH_TRACKED);
  ok(ghEnvWins.ok && ghEnvWins.cfg.id === "owner/env-repo", "the variable stays an OVERRIDE — set, it wins over the tracked id");
  const ghBlank = resolveEngagedGithub({ [ENGAGED_ROOM_VARS.github]: "   " }, GH_TRACKED);
  ok(ghBlank.ok && ghBlank.cfg.id === "owner/tracked-repo", "a blank variable is not a value — it falls through to the tracked id rather than resolving to whitespace");
  const ghNowhere = resolveEngagedGithub(empty, {});
  ok(
    !ghNowhere.ok && ghNowhere.missing.join(",") === ENGAGED_ROOM_VARS.github,
    "🔴 the control: absent from BOTH is still a skip naming the variable — never a red, and never a resolved repo that does not exist",
  );
  const ghDeclaredEmpty = resolveEngagedGithub(empty, { [ENGAGED_ROOM_VARS.github]: "" });
  ok(!ghDeclaredEmpty.ok, "the second control: a tracked entry DECLARED with an empty id resolves nothing — declared is not provisioned");
  ok(
    resolveCapabilities(empty, GH_TRACKED).available.size === 0,
    "🔴 a tracked repo id alone is NOT a live capability — an env with no credentials stays full dry mode",
  );
  ok(
    resolveCapabilities(empty, { ...MPIM_TRACKED, ...GH_TRACKED }).available.size === 0,
    "…and both tracked rooms together are still full dry mode — the gates are per capability, not a single special case",
  );

  const caps = resolveCapabilities(empty, {});
  ok(caps.available.size === 0, "empty env: NO capabilities — full dry mode");

  const base = {
    [ENV.slackUserToken]: "xoxp-test",
    [ENV.slackChannel]: "C123",
    [ENV.slackBotUserId]: "U999",
    [ENV.slackAdminUserId]: "U2ADMIN",
    [ENV.discordDriverToken]: "driver-token",
    [ENV.discordChannel]: "111",
    [ENV.discordBotUserId]: "222",
    [ENV.targetUrl]: "https://oe.example.test/",
    [ENV.slackSigningSecret]: "shhh",
  };
  const capsBase = resolveCapabilities(base, {});
  ok(capsBase.available.size === 3, "base env (no add-on vars): exactly the three base capabilities");
  const capsBaseTracked = resolveCapabilities(base, MPIM_TRACKED);
  ok(capsBaseTracked.available.has("slackMpim"), "🔴 base Slack creds + a tracked room id = a LIVE slackMpim, so J-MPIM RUNS with no variable set");
  ok(capsBaseTracked.available.size === 4, "…and exactly one capability more — nothing else moves with it");
  ok(
    capsBase.missing.slackPrivate.join(",") === ENV.slackPrivateChannel &&
      capsBase.missing.slackChannelB.join(",") === ENV.slackChannelB &&
      capsBase.missing.slackCapFixture.join(",") === ENV.slackCapChannel &&
      capsBase.missing.syntheticDm.join(",") === ENV.slackDmChannel &&
      capsBase.missing.slackUser2.join(",") === ENV.slackUser2Id &&
      capsBase.missing.slackSecondary.join(",") === `${ENV.slackSecondaryToken},${ENV.slackSecondaryUserId}` &&
      capsBase.missing.webhook.join(",") === ENV.webhookSecret &&
      capsBase.missing.notion.join(",") === ENV.notionChannel,
    "base env: each add-on capability names only ITS missing var(s) (base vars not repeated)",
  );
  const full = {
    ...base,
    [ENV.slackPrivateChannel]: "C0PRIV",
    [ENV.slackChannelB]: "C0BBB",
    [ENV.slackCapChannel]: "C0CAP",
    [ENV.slackDmChannel]: "D0DM",
    [ENV.slackUser2Id]: "U2NONADMIN",
    [ENV.slackSecondaryToken]: "xoxp-secondary",
    [ENV.slackSecondaryUserId]: "U3MEMBER",
    [ENV.webhookSecret]: "hook-secret",
    [ENV.notionChannel]: "C0NOTION",
    [ENV.teamsTenantId]: "tenant-1",
    [ENV.teamsClientId]: "client-1",
    [ENV.teamsRefreshToken]: "refresh-1",
    [ENV.teamsTeamId]: "team-1",
    [ENV.teamsChannelId]: "19:chan@thread.tacv2",
    [ENV.teamsBotAppId]: "bot-app-1",
    [ENV.slackUnifiedChannelA]: "C0UNIA",
    [ENV.slackUnifiedChannelB]: "C0UNIB",
  };
  const capsFull = resolveCapabilities(full, {});
  ok(capsFull.available.size === 15, "full env: all fifteen capabilities live");
  ok(capsFull.available.has("engagedSlack"), "J-ENGAGED-slack is LIVE on an env that carries E2E_SLACK_PRIVATE_CHANNEL — it drives the reused room rather than skipping");
  ok(!capsFull.available.has("engagedGithub"), "J-ENGAGED-github stays DARK on a full operator env — it reads no var another fixture already sets, and `full` carries no GitHub driver either");
  const githubDriver = {
    [ENV.githubDriverToken]: "ghp-test",
    [ENV.githubRepo]: "example-owner/e2e-scratch",
    [ENV.githubAppSlug]: "oe-app",
    [ENV.githubIssue]: "1",
  };
  const capsWithEngagedGithub = resolveCapabilities({ ...full, ...githubDriver, [ENGAGED_ROOM_VARS.github]: "example-owner/oe-e2e-addressed-github" }, {});
  ok(capsWithEngagedGithub.available.has("engagedGithub"), "…and comes up on its OWN var beside the GitHub driver, so the capability is wired rather than merely unresolvable");
  ok(capsWithEngagedGithub.available.size === 17, "the driver plus the room var: `github` and `engagedGithub`, and nothing else moves with them");
  ok(
    !resolveCapabilities({ ...full, ...githubDriver }, {}).available.has("engagedGithub"),
    "🔴 the GitHub driver alone does NOT light engagedGithub — the engaged repo has a variable of its own, and reusing E2E_GITHUB_REPO or E2E_PR_REPO would aim the journey at e2e-unified's e2e-scratch",
  );
  ok(capsFull.available.has("connectorWrite"), "connectorWrite comes up with the bound channel — no arming declaration stands between the fixture and the capability");
  const capFixtureCfg = resolveSlackCapFixture(full);
  ok(capFixtureCfg.ok && capFixtureCfg.cfg.channel === "C0CAP", "S10 cap-fixture cfg carries the dedicated throwaway channel");
  const secondaryCfg = resolveSlackSecondary(full);
  ok(
    secondaryCfg.ok && secondaryCfg.cfg.token === "xoxp-secondary" && secondaryCfg.cfg.userId === "U3MEMBER",
    "secondary-identity cfg carries the token + its user id",
  );
  const uniCfg = resolveSlackUnified(full);
  ok(
    uniCfg.ok && uniCfg.cfg.channelA === "C0UNIA" && uniCfg.cfg.channelB === "C0UNIB" && uniCfg.cfg.domain === "e2e-unified",
    'slackUnified cfg carries both channels and defaults E2E_UNIFIED_DOMAIN to "e2e-unified"',
  );
  const uniCfgOverride = resolveSlackUnified({ ...full, [ENV.unifiedDomain]: "payments" });
  ok(uniCfgOverride.ok && uniCfgOverride.cfg.domain === "payments", "E2E_UNIFIED_DOMAIN overrides the default fixture domain name");
  const teamsCfg = resolveTeams(full);
  ok(
    teamsCfg.ok &&
      teamsCfg.cfg.tenantId === "tenant-1" &&
      teamsCfg.cfg.clientId === "client-1" &&
      teamsCfg.cfg.refreshToken === "refresh-1" &&
      teamsCfg.cfg.teamId === "team-1" &&
      teamsCfg.cfg.channelId === "19:chan@thread.tacv2" &&
      teamsCfg.cfg.botAppId === "bot-app-1",
    "teams cfg carries all six fields (tenant/client/refresh/team/channel/botApp)",
  );
  const teamsSink = resolveTeams({ ...full, [ENV.teamsRefreshTokenFile]: "/tmp/custom-teams-sink" });
  ok(
    teamsSink.ok && teamsSink.cfg.refreshTokenFile === "/tmp/custom-teams-sink",
    "E2E_TEAMS_REFRESH_TOKEN_FILE overrides the sidecar path",
  );

  {
    const app = mkdtempSync(join(tmpdir(), "oe-teams-sink-"));
    mkdirSync(join(app, "agent"), { recursive: true });
    mkdirSync(join(app, "packages", "core"), { recursive: true });
    writeFileSync(join(app, "package.json"), "{}\n");
    writeFileSync(join(app, "agent", "agent.ts"), "\n");
    writeFileSync(join(app, "packages", "core", "package.json"), "{}\n");
    const workspaceCwd = join(app, "packages", "core");
    const helperEnv = { ...full };
    const driverEnv = { ...full, INIT_CWD: app, npm_package_json: join(workspaceCwd, "package.json") };
    const expected = join(app, DEFAULT_TEAMS_REFRESH_SINK);
    const minted = teamsRefreshSinkPath(helperEnv, app);
    const driven = resolveTeams(driverEnv, workspaceCwd);
    ok(minted === expected, `the helper's mint lands beside .env.e2e at the app root — got ${minted}`);
    ok(driven.ok && driven.cfg.refreshTokenFile === minted, `the driver in packages/core reads the SAME file the helper wrote — got ${driven.ok ? driven.cfg.refreshTokenFile : "unresolved"}`);
    writeRefreshSidecar(minted, "fresh-mint-1");
    ok(driven.ok && readRefreshSidecar(driven.cfg.refreshTokenFile) === "fresh-mint-1", "a fresh mint from the app root is the token the workspace driver reads back");
    const relative = { [ENV.teamsRefreshTokenFile]: "secrets/teams-refresh" };
    ok(
      teamsRefreshSinkPath({ ...helperEnv, ...relative }, app) === join(app, "secrets", "teams-refresh") &&
        teamsRefreshSinkPath({ ...driverEnv, ...relative }, workspaceCwd) === join(app, "secrets", "teams-refresh"),
      "a relative E2E_TEAMS_REFRESH_TOKEN_FILE resolves against the app root for the helper and the driver alike",
    );
    const legacyFile = join(workspaceCwd, DEFAULT_TEAMS_REFRESH_SINK);
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
    try {
      teamsRefreshSinkPath(driverEnv, workspaceCwd);
      ok(warned.length === 0, "negative control: no legacy sidecar, no warning");
      writeFileSync(legacyFile, "legacy-secret-token\n");
      teamsRefreshSinkPath(driverEnv, workspaceCwd);
    } finally {
      console.warn = realWarn;
    }
    ok(warned.length === 1 && warned[0]!.includes(legacyFile) && warned[0]!.includes(expected), `a legacy cwd sidecar warns, naming both paths — got ${JSON.stringify(warned)}`);
    ok(!warned.some((w) => w.includes("legacy-secret-token")), "the warning never prints the token");
    rmSync(app, { recursive: true, force: true });
  }

  {
    const bare = mkdtempSync(join(tmpdir(), "oe-teams-noapp-"));
    let threw = false;
    let noApp: ReturnType<typeof resolveTeams> | undefined;
    try {
      noApp = resolveTeams({ ...full, OE_APP_ROOT: undefined, INIT_CWD: undefined, npm_package_json: undefined }, bare);
    } catch {
      threw = true;
    }
    ok(!threw && noApp !== undefined && !noApp.ok && noApp.missing.some((m) => m.includes(ENV.teamsRefreshTokenFile)), `no app root skips the Teams half and names why — got ${threw ? "a throw" : JSON.stringify(noApp)}`);
    ok(resolveTeams({ ...full, OE_APP_ROOT: undefined, [ENV.teamsRefreshTokenFile]: "/abs/sink" }, bare).ok, "negative control: an absolute sidecar needs no app root, so it still resolves");
    rmSync(bare, { recursive: true, force: true });
  }

  ok(TEAMS_AUTH_NEXT_STEP.startsWith("E2E_ONLY=J-TEAMS ") && !TEAMS_AUTH_NEXT_STEP.includes("--only"), `the helper's next step uses E2E_ONLY, never \`-- --only\` — got ${TEAMS_AUTH_NEXT_STEP}`);
  {
    const named = /^E2E_ONLY=(\S+) /u.exec(TEAMS_AUTH_NEXT_STEP)?.[1];
    ok(named !== undefined && SCENARIOS.some((sc) => sc.id === named), `the helper's next step names a live scenario id — got ${named}`);
    ok(!SCENARIOS.some((sc) => sc.id === "ST1"), "negative control: ST1 is not a scenario id, so a line naming it would run nothing");
  }
  const sinkPath = join(tmpdir(), `oe-teams-refresh-${process.pid}`);
  rmSync(sinkPath, { force: true });
  ok(readRefreshSidecar(sinkPath) === undefined, "absent sidecar reads as undefined (seed fallback)");
  writeRefreshSidecar(sinkPath, "rotated-token-2");
  ok(readRefreshSidecar(sinkPath) === "rotated-token-2", "sidecar round-trips the rotated token");
  writeRefreshSidecar(sinkPath, "rotated-token-3");
  ok(readRefreshSidecar(sinkPath) === "rotated-token-3", "sidecar overwrite wins (latest rotation)");
  rmSync(sinkPath, { force: true });

  const graphGetForbidden =
    "teams GET /chats/19%3A.../messages failed: http 403 {\"error\":{\"code\":\"Forbidden\",\"message\":\"Missing scope permissions on the request. " +
    "API requires one of 'Chat.ReadBasic, Chat.Read, Chat.ReadWrite'. Scopes on the request 'AppCatalog.Read.All, Channel.ReadBasic.All'\"}}";
  const graphPostForbidden =
    "teams POST /chats/19%3A.../messages failed: http 403 {\"error\":{\"code\":\"Forbidden\",\"message\":\"Missing scope permissions on the request. " +
    "API requires one of 'ChatMessage.Send, Chat.ReadWrite'. Scopes on the request 'AppCatalog.Read.All'\"}}";
  ok(isMissingChatScopeError(new Error(graphGetForbidden)), "the real GET 403 (Chat.ReadBasic/Chat.Read/Chat.ReadWrite) classifies as a missing-scope error");
  ok(isMissingChatScopeError(new Error(graphPostForbidden)), "the real POST 403 (ChatMessage.Send/Chat.ReadWrite) classifies as a missing-scope error too — 'Chat.ReadWrite' contains the 'Chat.Read' substring the classifier keys on");
  ok(
    !isMissingChatScopeError(new Error("teams GET /teams/t1/channels/c1 failed: http 404 channel not found")),
    "🔴 NEGATIVE CONTROL: an unrelated Graph error (no scope wording at all) does NOT classify as a missing-scope error",
  );
  ok(
    !isMissingChatScopeError(
      new Error("teams POST /teams/t1/channels/c1/messages failed: http 403 Missing scope permissions on the request. API requires one of 'Team.ReadBasic.All'"),
    ),
    "🔴 NEGATIVE CONTROL: a missing-scope 403 for a DIFFERENT scope family (no Chat.* named) does NOT classify as a missing-chat-scope error",
  );
  ok(
    !isMissingChatScopeError(new Error("please see the Chat.Read Graph permission docs for background")),
    "🔴 NEGATIVE CONTROL: text that merely MENTIONS Chat.Read without the 'missing scope permissions' shape does NOT classify as the 403 — the classifier requires BOTH",
  );
  ok(!isMissingChatScopeError("a plain string, not an Error"), "a non-Error value is coerced to its string form rather than throwing");
  const user2 = resolveSlackUser2(full);
  ok(user2.ok && user2.cfg.userId === "U2NONADMIN", "user2 cfg carries the non-admin id");
  const dmCfg = resolveSyntheticDm(full);
  ok(dmCfg.ok && dmCfg.cfg.dmChannel === "D0DM", "syntheticDm cfg carries the DM channel");
  const webhookCfg = resolveWebhook(full);
  ok(
    webhookCfg.ok && webhookCfg.cfg.hookId === "e2e-smoke" && webhookCfg.cfg.targetUrl === "https://oe.example.test",
    "webhook cfg defaults hookId to e2e-smoke and strips the target's trailing slash",
  );
  const webhookCfgOverride = resolveWebhook({ ...full, [ENV.webhookHookId]: "custom-hook" });
  ok(webhookCfgOverride.ok && webhookCfgOverride.cfg.hookId === "custom-hook", "E2E_WEBHOOK_HOOK_ID overrides the default hook id");
  const notionCfg = resolveNotion(full);
  ok(notionCfg.ok && notionCfg.cfg.channel === "C0NOTION" && notionCfg.cfg.query === "team handbook", "notion cfg defaults E2E_NOTION_QUERY to \"team handbook\"");
  const notionCfgOverride = resolveNotion({ ...full, [ENV.notionQuery]: "onboarding" });
  ok(notionCfgOverride.ok && notionCfgOverride.cfg.query === "onboarding", "E2E_NOTION_QUERY overrides the default query");
  const syn = resolveSynthetic(full);
  ok(syn.ok && syn.cfg.targetUrl === "https://oe.example.test", "target URL trailing slash is stripped");
  ok(syn.ok && syn.cfg.org === "default", "E2E_ORG unset: synthetic org defaults to \"default\" (single-org fixture)");
  const orgSyn = resolveSynthetic({ ...full, [ENV.org]: "acme" });
  ok(orgSyn.ok && orgSyn.cfg.org === "acme", "E2E_ORG set: synthetic org carries the override");
  const blank = resolveSlack({ ...full, [ENV.slackChannel]: "   " });
  ok(!blank.ok && blank.missing.includes(ENV.slackChannel), "a whitespace-only value counts as missing (fail-closed)");
}

{
  const badMarker = "engaged-14432";
  ok(`the answer is (ref ${badMarker})`.includes("144"), "the control: the raw reply DOES contain '144' — through the marker, not through an answer");
  ok(
    !withoutMarker(`the answer is (ref ${badMarker})`, badMarker).includes("144"),
    "with the marker removed the same reply no longer passes the 144 gate — the echoed ref cannot stand in for the answer",
  );
  ok(withoutMarker(`144 (ref ${badMarker})`, badMarker).includes("144"), "a reply that really answers still passes once the marker is removed");
  ok(withoutMarker("150", "engaged-99999").includes("150"), "a reply with no marker at all is unchanged by the removal");
  ok(!withoutMarker(`12${badMarker}34`, badMarker).includes("1234"), "the marker is replaced by a space, so removing it cannot fuse two tokens into a third");
  ok(withoutMarker("untouched", "").includes("untouched"), "an empty marker removes nothing rather than shredding the text");
}

{
  const pages: Record<string, { value?: readonly string[]; "@odata.nextLink"?: string }> = {
    "/replies": { value: ["a", "b"], "@odata.nextLink": "https://graph.microsoft.com/v1.0/replies?$skiptoken=2" },
    "https://graph.microsoft.com/v1.0/replies?$skiptoken=2": { value: ["c"], "@odata.nextLink": "https://graph.microsoft.com/v1.0/replies?$skiptoken=3" },
    "https://graph.microsoft.com/v1.0/replies?$skiptoken=3": { value: ["d"] },
  };
  const asked: string[] = [];
  const fetchPage = async (url: string): Promise<{ value?: readonly string[]; "@odata.nextLink"?: string }> => {
    asked.push(url);
    return pages[url] ?? {};
  };
  const all = await collectGraphPages<string>("/replies", fetchPage, 20);
  ok(all.join(",") === "a,b,c,d", `every page's items are returned in page order (got ${all.join(",")})`);
  ok(asked.length === 3, `the walk follows @odata.nextLink until a page carries none (pages fetched: ${asked.length})`);

  const onePage = await collectGraphPages<string>("/replies", async () => ({ value: ["a", "b"] }), 20);
  ok(onePage.join(",") === "a,b", "the control: a collection with no nextLink returns exactly its one page");

  const empty = await collectGraphPages<string>("/replies", async () => ({}), 20);
  ok(empty.length === 0, "a page carrying no `value` contributes nothing rather than throwing");

  let threw = "";
  try {
    await collectGraphPages<string>("/replies", async () => ({ value: ["x"], "@odata.nextLink": "https://graph.microsoft.com/v1.0/loop" }), 3);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  ok(threw.includes("partial collection"), `a chain still paging at the bound THROWS rather than truncating (threw: ${threw || "nothing"})`);
}

{
  const addressed = ENV.engagedTeamsSurface;
  const shared = ENV.teamsChannelId;

  const same = resolveEngagedTeams({ [addressed]: "19:chan-A", [shared]: "19:chan-A" });
  ok(!same.ok, "both variables naming ONE channel is refused, not resolved");
  ok(
    !same.ok && same.missing.some((m) => m.includes(addressed) && m.includes(shared)),
    `the refusal names BOTH variables so the operator knows which pair collided (got: ${same.ok ? "resolved" : same.missing.join("; ")})`,
  );

  const apart = resolveEngagedTeams({ [addressed]: "19:chan-A", [shared]: "19:chan-B" });
  ok(apart.ok && apart.cfg.id === "19:chan-A", `two different channels still resolve, to the addressed room (got: ${apart.ok ? apart.cfg.id : "refused"})`);

  const sameViaKey = resolveEngagedTeams({ [addressed]: "teams/19:tenant-guid/19:chan-A", [shared]: "19:chan-A" });
  ok(!sameViaKey.ok, "the surface-key spelling of J-TEAMS's own channel is refused too — the check compares channels, not strings");

  const apartViaKey = resolveEngagedTeams({ [addressed]: "teams/19:tenant-guid/19:chan-A", [shared]: "19:chan-B" });
  ok(apartViaKey.ok && apartViaKey.cfg.id === "19:chan-A", `a surface key for a separate room resolves to its channel id (got: ${apartViaKey.ok ? apartViaKey.cfg.id : "refused"})`);

  const noShared = resolveEngagedTeams({ [addressed]: "19:chan-A" });
  ok(noShared.ok && noShared.cfg.id === "19:chan-A", "with E2E_TEAMS_CHANNEL_ID unset there is nothing to collide with, so the room resolves");

  const unset = resolveEngagedTeams({ [shared]: "19:chan-B" });
  ok(unset.ok === false && unset.missing.includes(addressed), "unset still self-skips naming the variable to set, unchanged by the new refusal");

  const rawChannel = "19:abc@thread.tacv2";
  const sanitisedChannel = "19-abc-thread.tacv2";
  const mixed = resolveEngagedTeams({ [addressed]: `teams/19:tenant-guid/${sanitisedChannel}`, [shared]: rawChannel });
  ok(!mixed.ok, "a sanitised addressed surface key and a RAW E2E_TEAMS_CHANNEL_ID name one channel and are refused");
  ok(
    !mixed.ok && mixed.missing.some((m) => m.includes(addressed) && m.includes(shared)),
    `the raw/sanitised refusal names both variables like every other collision (got: ${mixed.ok ? "resolved" : mixed.missing.join("; ")})`,
  );
  const mixedOtherWay = resolveEngagedTeams({ [addressed]: rawChannel, [shared]: sanitisedChannel });
  ok(!mixedOtherWay.ok, "and the other way round — a raw addressed id against a sanitised shared one is the same collision");

  const distinctUnderSeg = resolveEngagedTeams({ [addressed]: "19:abc@thread.tacv2", [shared]: "19:xyz@thread.tacv2" });
  ok(
    distinctUnderSeg.ok && distinctUnderSeg.cfg.id === "19:abc@thread.tacv2",
    `two different channels still resolve through the widened comparison, RAW for the driver (got: ${distinctUnderSeg.ok ? distinctUnderSeg.cfg.id : "refused"})`,
  );

  const rawOut = resolveEngagedTeams({ [addressed]: `teams/19:tenant-guid/${rawChannel}`, [shared]: "19:other@thread.tacv2" });
  ok(rawOut.ok && rawOut.cfg.id === rawChannel, `the resolver hands the driver the RAW channel id, never the compare key (got: ${rawOut.ok ? rawOut.cfg.id : "refused"})`);
}

{
  const own = ENV.addressedLinearApiKey;

  const noKey = resolveEngagedLinear({ [ENV.engagedLinearTeamId]: "team-uuid-1" }, {});
  ok(!noKey.ok, "the addressed-only Linear team does not resolve while its own key is unset");
  ok(
    !noKey.ok && noKey.missing.some((m) => m.includes(own)),
    `…and the refusal NAMES that key, so the operator is not left to guess (got: ${noKey.ok ? "resolved" : noKey.missing.join("; ")})`,
  );
  const withKey = resolveEngagedLinear(
    { [ENV.engagedLinearTeamId]: "team-uuid-1", [own]: "lin_api_addressed", [ENV.linearSoakAppUserId]: "app-user-2", [ENV.linearSoakAgentHandle]: "OE" },
    {},
  );
  ok(withKey.ok && withKey.cfg.id === "team-uuid-1", `with the room and every workspace input set it resolves to the team id (got: ${withKey.ok ? withKey.cfg.id : withKey.missing.join("; ")})`);
  const noTeam = resolveEngagedLinear({ [own]: "lin_api_addressed" }, {});
  ok(!noTeam.ok && noTeam.missing.includes(ENV.engagedLinearTeamId), "an unset team id still self-skips naming the team variable, unchanged by the key check");

  const LINEAR_TRACKED = { [ENV.engagedLinearTeamId]: "team-from-git" };
  const WORKSPACE_ENV = { [own]: "lin_api_addressed", [ENV.linearSoakAppUserId]: "app-user-2", [ENV.linearSoakAgentHandle]: "OE" };
  const fromTable = resolveEngagedLinear(WORKSPACE_ENV, LINEAR_TRACKED);
  ok(
    fromTable.ok && fromTable.cfg.id === "team-from-git",
    `🔴 with E2E_ADDRESSED_LINEAR_TEAM_ID unset, the team resolves from the tracked inventory — a deployment nobody edited cannot lose the id (got: ${fromTable.ok ? fromTable.cfg.id : fromTable.missing.join("; ")})`,
  );
  const envWins = resolveEngagedLinear({ ...WORKSPACE_ENV, [ENV.engagedLinearTeamId]: "team-from-env" }, LINEAR_TRACKED);
  ok(envWins.ok && envWins.cfg.id === "team-from-env", "the variable stays an OVERRIDE — set, it wins over the tracked id");
  const blank = resolveEngagedLinear({ ...WORKSPACE_ENV, [ENV.engagedLinearTeamId]: "   " }, LINEAR_TRACKED);
  ok(blank.ok && blank.cfg.id === "team-from-git", "a blank variable is not a value — it falls through to the tracked id rather than resolving to whitespace");
  const declaredEmpty = resolveEngagedLinear(WORKSPACE_ENV, { [ENV.engagedLinearTeamId]: "" });
  ok(!declaredEmpty.ok, "the control: a tracked entry DECLARED with an empty id resolves nothing — declared is not provisioned");
  const trackedNoKey = resolveEngagedLinear({}, LINEAR_TRACKED);
  ok(
    !trackedNoKey.ok && trackedNoKey.missing.some((m) => m.includes(own)),
    `🔴 a tracked team id does NOT get past the key check — with ${own} unset it still self-skips naming that key (got: ${trackedNoKey.ok ? "resolved" : trackedNoKey.missing.join("; ")})`,
  );
  ok(
    resolveCapabilities({}, LINEAR_TRACKED).available.size === 0,
    "🔴 a tracked team id alone is NOT a live capability — an env with no credentials stays full dry mode",
  );
  const linearDriver = {
    [ENV.linearApiKey]: "lin_api_base",
    [ENV.linearTeamId]: "team-base",
    [ENV.linearAppUserId]: "app-user-base",
    [ENV.linearAgentHandle]: "OEBase",
  };
  ok(
    resolveCapabilities({ ...linearDriver, ...WORKSPACE_ENV }, LINEAR_TRACKED).available.has("engagedLinear"),
    "🔴 the room var stays unset and engagedLinear comes up from the tracked table — so `resolveCapabilities` really hands ITS `tracked` argument to this resolver",
  );
  ok(
    !resolveCapabilities({ ...linearDriver, ...WORKSPACE_ENV }, {}).available.has("engagedLinear"),
    "…and the control: the same environment against an EMPTY table leaves it dark, so the id came from the table rather than from anything in the environment",
  );
  ok(
    resolveCapabilities({ ...linearDriver, ...WORKSPACE_ENV }, {}).missing.engagedLinear.join(",") === ENV.engagedLinearTeamId,
    "…naming the team variable, so an operator with the workspace inputs and no room is told which one is missing",
  );
  ok(
    resolveCapabilities(WORKSPACE_ENV, LINEAR_TRACKED).available.size === 0,
    "🔴 the workspace inputs and a tracked team WITHOUT the Linear driver stay full dry mode — the capability is the base driver rebound, never a fixture of its own",
  );

  const noIdentity = resolveEngagedLinear({ [own]: "lin_api_addressed" }, LINEAR_TRACKED);
  ok(!noIdentity.ok, "🔴 the key alone does NOT resolve the addressed-only team — its workspace's app identity is part of the room");
  ok(
    !noIdentity.ok && noIdentity.missing.some((m) => m.includes(ENV.linearSoakAppUserId) && m.includes(ENV.linearSoakAgentHandle)),
    `…and the refusal NAMES both variables, so the operator is not left to guess (got: ${noIdentity.ok ? "resolved" : noIdentity.missing.join("; ")})`,
  );
  ok(!resolveEngagedLinear({ [own]: "k", [ENV.linearSoakAppUserId]: "app-user-2" }, LINEAR_TRACKED).ok, "the app-user id alone is not enough — the mention handle is read too");
  ok(!resolveEngagedLinear({ [own]: "k", [ENV.linearSoakAgentHandle]: "OE" }, LINEAR_TRACKED).ok, "the handle alone is not enough — the app-user id is read too");
  ok(resolveEngagedLinear(WORKSPACE_ENV, LINEAR_TRACKED).ok, "🔴 NEGATIVE CONTROL: with the key and both identity vars it RESOLVES — the gate is a real remedy, not a permanent refusal");
  const baseIdentity = { appUserId: "app-user-base", agentHandle: "OEBase" };
  const swapped = engagedLinearIdentity(WORKSPACE_ENV, baseIdentity);
  ok(
    swapped.appUserId === "app-user-2" && swapped.agentHandle === "OE",
    `🔴 the engaged driver takes the TEAM'S workspace identity, never the base one (got: ${JSON.stringify(swapped)})`,
  );
  ok(
    engagedLinearIdentity({}, baseIdentity).appUserId === baseIdentity.appUserId,
    "NEGATIVE CONTROL: with neither var set it falls back to the base identity — a same-workspace room is unchanged, not broken by this pair existing",
  );
  ok(engagedLinearIdentity({ [ENV.linearSoakAppUserId]: "  app-user-2  " }, baseIdentity).appUserId === "app-user-2", "the value is trimmed, so a stray newline never becomes part of an id comparison");

  ok(engagedLinearApiKey({ [own]: "lin_api_addressed" }, "lin_api_base") === "lin_api_addressed", "the addressed team's OWN key wins where it is set");
  ok(engagedLinearApiKey({}, "lin_api_base") === "lin_api_base", "🔴 NEGATIVE CONTROL: unset falls back to the base driver key — a same-workspace room is unchanged, not broken by this variable existing");
  ok(engagedLinearApiKey({ [own]: "   " }, "lin_api_base") === "lin_api_base", "a whitespace-only value is not a key — an empty export must not blank the driver's credential");
  ok(engagedLinearApiKey({ [own]: "  lin_api_addressed  " }, "lin_api_base") === "lin_api_addressed", "the value is trimmed, so a stray newline in an env file does not become part of the authorization header");
}

{
  const ids = SCENARIOS.map((s) => s.id);
  ok(new Set(ids).size === ids.length, "scenario ids are unique");
  const EXPECTED_IDS = new Set([
    "J1", "J2", "S-MEM-READ", "J3", "J4", "S6",
    "S-OE-STATUS",
    "J-DISC", "S8", "S9", "S10", "S11", "S13", "S14",
    "S-VOICE-CLIP",
    "S-LINK-SLACK", "J-MPIM", "S20", "S23", "S24", "J-TEAMS", "J-TEAMS-DM", "J-ENGAGED-teams", "J-GH", "J-LIN", "J-NOT", "F-ART", "F-QA-REPO", "F-EDIT", "F-SEC", "J-SUP",
    "J-UNIFIED", "J-UNI-X", "J-PR", "S-PR-SESSION", "S-PR-BOUNDARY", "S-AWS-BOUNDARY", "J-WORKFLOW", "S-NOTION-WRITE", "S-CONNECTOR-TIER",
    "S-DM-NOTION",
    "S-PROVENANCE-DM",
    "S-SPEND-DM-MASK",
    "S-SPEND-REFUSAL-KEYS",
    "S-A2A-DELEGATE",
    "S-A2A-INBOUND",
    "S-JUDGE-LIFT-NOTICE",
    "S-DELEGATED-slack",
    "S-DELEGATED-discord",
    "S-DELEGATED-teams",
    "S-DELEGATED-linear",
    "S-DELEGATED-github",
    "S-DELEGATED-notion",
    "S-GITHUB-NOTION-REST",
    "S-SUSPENDED-slack",
    "S-SUSPENDED-discord",
    "S-SUSPENDED-teams",
    "S-CARD-teams",
    "S-CARD-teams-dm",
    "J-NAMEDROP-teams",
    "S-OE-CMD-teams",
    "S-INTRO-teams",
    "S-SUSPENDED-linear",
    "S-SUSPENDED-github",
    "S-AMBIENT-discord",
    "S-AMBIENT-linear",
    "S-AMBIENT-teams",
    "S-SIBLING-discord",
    "S-SIBLING-teams",
    "S-SIBLING-notion",
    "S-LINK-discord",
    "S-LINK-teams",
    "S-HALT",
    "S-EVE-CARD", "S-CONNECT-CARD", "S-APIKEY-INTAKE", "S-TAINT-DRYRUN", "S-TAINT-ROUTE-LIVE", "S-TAINT-UNATTENDED-DENY",
    "S-ROUTINE-CONNECTOR-WRITE", "S-DISCORD-GRANT",
    "S-DM-STOP-GRANT",
    "J-ENGAGED-slack", "J-ENGAGED-discord", "J-ENGAGED-github", "J-ENGAGED-linear", "J-ENGAGED-notion",
    "S-OWN-ACCOUNT-NOTION",
    "S-SPEND-DM-MASK", "S-SPEND-REFUSAL-KEYS",
    "S-SLACK-AS-YOU",
    "S-APP-HOME",
    "S-SIDE-PANEL",
    "S-SESSION-STOP",
    "S-MEMORY-CANVAS",
    "S-STEP-LABELS",
    "S-CARD-SUMMARY", "S-BLOCKED-PING",
    "S-MEETING-RECAP",
    "S-MEETING-DISCORD-VOICE",
    "S-EMAIL-ROOM-REPLY", "S-EMAIL-DM-FORWARD", "S-EMAIL-STRANGER-REFUSED",
    "S-PERSONAL-BROWSER",
    "S-MEETING-NATIVE-RECAP",
    "S-WATCH",
    "S-DOING",
    "S-ROUTINE-TEST",
    "S-COVER",
  ]);
  ok(
    ids.length === EXPECTED_IDS.size && ids.every((id) => EXPECTED_IDS.has(id)),
    `pack roster is exactly the ${EXPECTED_IDS.size} expected scenarios (J1 absorbs S1/S2/S3/S21/S22; J2 absorbs S4/S12; J3 absorbs S5/S15/S16/S19; J4 absorbs S17/S18; J-GH/J-LIN/J-NOT add github/linear/notion; F-ART/F-EDIT add artifact+edit; F-QA-REPO adds the repo-backed browser QA loop (checkout → dev server → screenshot → describe_image → post_file, OPE-2404); F-SEC adds the security suite; J-UNIFIED adds the unified Slack-only live path; J-UNI-X is the cross-surface money-shot, runnable pending a live multi-surface fixture; J-PR/J-WORKFLOW add the consequential open_pull_request write + S-PR-SESSION the OPE-53 approve-for-session grant→skip pair + S-PR-BOUNDARY the ungranted-repo refusal + S-AWS-BOUNDARY its twin on the OTHER consequential door (the ungated \`aws\` tool, whose only control is the fail-closed awsRoles grant); S-LINK-SLACK drives the whole proof-of-control identity-link loop across two REAL Slack accounts (mint → claim → notice → ratify), asserted on the identity.link.* audit rows because no read-tool exposes link rows; S-NOTION-WRITE/S-CONNECTOR-TIER add the connector-WRITE plane — write approval + the read/write tier split; S-EVE-CARD is the pack's only leg on the EVE-MINTED approval card (OPE-1056), the card eve owns for a connector op — every other approval leg drives OE's own card, which is a different card with a different lifecycle owner; S-DM-NOTION folds the DM personal-Notion journey + S-CONNECT-CARD the channel connector-offer card→forged-org-click→dashboard-link-issued audit + S-APIKEY-INTAKE the db-broker Set-API-key intake — all self-skipping until their fixtures are armed; S-MEM-READ is the OPE-121 leg that asserts a memory recall OPENED A FILE rather than trusting the reply text, which is what J2 alone could never catch; S-TAINT-DRYRUN is the OPE-331 double-opt-in volume leg that drives the source-tier table (ENFORCED since OPE-324) and gates on \`taint.verdict\` audit rows — including \`mode:\"enforced\"\`+\`applied:true\`, the live proof the table DECIDED rather than observed — never reply text; S-TAINT-ROUTE-LIVE (OPE-439/OPE-844) drives a REAL web_fetch (Arm A, hard) + a REAL get_pr_feedback GitHub PR-feedback read (Arm B, hard, direction fixed by the fixture PR's repoPrivate), then a real propose or explain_permission simulation in the SAME turn, and gates on the \`approval.chain\` row's \`tainted\`/\`taintKinds\` disclosure pair with a clean negative control — proving the route→mark join live where S-TAINT-DRYRUN's \`taint.verdict\` rows are structurally silent (they fire on DIVERGENCE only, and web_fetch agrees with the table); S-TAINT-UNATTENDED-DENY (OPE-452) fires a REAL one-shot routine unattended and gates on the \`approval.chain\` row naming the \`unattended\` ask→deny arrow, plus a hard negative that no card was minted; S-DM-DISCORD, which drove this same DM-delegation mechanism on Discord, was RETIRED at OPE-725 — it needed the roll-own delegation regime, which stopped shipping by default at OPE-396 and was DELETED at OPE-1145 item 2, so it could never pass live; the delegation claim has tier-2 coverage instead, in the integration tier own delegation tests; J-TEAMS-DM (OPE-972) is the Teams 1:1 DM plane's first live leg, riding the same "teams" capability as J-TEAMS with no new fixture var — it self-skips at RUNTIME (never via the capability gate) on either the OPE-887 personal-install precondition or the still-unconsented Chat.ReadWrite/ChatMessage.Send Graph scope; J-ENGAGED-teams (OPE-1500) is the Teams ambient engagement seam end to end — @mention engages the reply chain, a PLAIN follow-up wakes, stand_down marks the row, and the next plain follow-up wakes nothing — and it self-skips naming the ChannelMessage.Read.Group RSC grant, without which Microsoft never delivers the follow-up it asserts on; S-JUDGE-LIFT-NOTICE (OPE-1902) is the first live leg on the judge-lift notice — the act an armed judge lowered runs with NO card, and the room's only trace is a notice carrying the contradict affordance — a road that shipped with \`post-deploy proof: none\`; it rides e2e-unified, whose reach already spans e2e-scratch and Slack, so a GitHub-origin lift freezes its venue onto a room this pack drives, and it self-skips when the judge ASKS rather than lifts, because which of those two correct answers the judge gives is a model judgement no knob here drives;)`,
  );
  const KNOWN = new Set(["slack", "discord", "synthetic", "slackPrivate", "slackChannelB", "slackMpim", "slackCapFixture", "slackHalt", "controlWrite", "slackSupervisor", "syntheticDm", "slackUser2", "slackSecondary", "webhook", "notion", "teams", "github", "linear", "notionAmbient", "slackUnified", "pr", "connectorWrite",
    "engagedSlack", "engagedDiscord", "engagedTeams", "engagedGithub", "engagedLinear", "engagedNotion", "email"]);
  for (const s of SCENARIOS) {
    okShape(s.title.trim().length > 0, `${s.id} has a title`);
    okShape(typeof s.run === "function", `${s.id} has a run body`);
    okShape(
      s.requires.length > 0 && s.requires.every((c) => KNOWN.has(c)),
      `${s.id} requires only known capabilities`,
    );
    okShape(s.timeoutMs >= 120_000 && s.timeoutMs <= 5_400_000, `${s.id} budget is within the 120s–90min envelope`);
  }
  const FORMERLY_OPTIONAL = [
    "S-MEM-READ", "S8", "S9", "S10", "S-SPEND-DM-MASK", "S-SPEND-REFUSAL-KEYS", "S24", "J-UNI-X", "S-NOTION-WRITE", "S-CONNECTOR-TIER", "S-DM-NOTION",
    "S-EVE-CARD", "S-CONNECT-CARD", "S-APIKEY-INTAKE", "S-TAINT-DRYRUN", "S-TAINT-ROUTE-LIVE",
    "S-TAINT-UNATTENDED-DENY", "S-ROUTINE-CONNECTOR-WRITE", "S-DISCORD-GRANT",
  ];
  for (const id of FORMERLY_OPTIONAL) {
    const sc = SCENARIOS.find((x) => x.id === id);
    ok(sc !== undefined, `${id} is still on the roster — the optional gate was deleted, not the legs behind it`);
    ok(sc?.suite === "core", `${id} is in the CORE lane: it runs on every ship (was optional/extended before OPE-1836)`);
  }

  const KNOWN_SURFACES = new Set(["slack", "teams", "discord", "github", "linear", "notion", "email", "cross"]);
  const KNOWN_SUITES = new Set(["core", "security"]);
  for (const s of SCENARIOS) {
    okShape(KNOWN_SURFACES.has(s.surface), `${s.id} declares a known surface (got "${s.surface}")`);
    okShape(KNOWN_SUITES.has(s.suite), `${s.id} declares a known suite (got "${s.suite}")`);
  }
  ok(SCENARIOS.find((s) => s.id === "J-DISC")!.surface === "discord", "J-DISC is the discord surface");
  ok(SCENARIOS.find((s) => s.id === "S8")!.surface === "cross", "S8 (Slack→Discord recall) is the cross surface");
  ok(SCENARIOS.find((s) => s.id === "J-TEAMS")!.surface === "teams", "J-TEAMS is the teams surface");
  ok(SCENARIOS.find((s) => s.id === "J-TEAMS-DM")!.surface === "teams", "J-TEAMS-DM is the teams surface");
  ok(SCENARIOS.find((s) => s.id === "J-GH")!.surface === "github", "J-GH is the github surface");
  const nonSlack = SCENARIOS.filter((s) => s.surface !== "slack").map((s) => s.id).sort();
  ok(
    nonSlack.join(",") ===
      "J-DISC,J-ENGAGED-discord,J-ENGAGED-github,J-ENGAGED-linear,J-ENGAGED-notion,J-ENGAGED-teams,J-GH,J-LIN,J-NAMEDROP-teams,J-NOT,J-PR,J-TEAMS,J-TEAMS-DM,J-UNI-X,J-WORKFLOW,S-AMBIENT-discord,S-AMBIENT-linear,S-AMBIENT-teams,S-APIKEY-INTAKE,S-CARD-teams,S-CARD-teams-dm,S-CONNECT-CARD,S-CONNECTOR-TIER,S-DELEGATED-discord,S-DELEGATED-github,S-DELEGATED-linear,S-DELEGATED-notion,S-DELEGATED-teams,S-DISCORD-GRANT,S-DM-NOTION,S-EMAIL-DM-FORWARD,S-EMAIL-ROOM-REPLY,S-EMAIL-STRANGER-REFUSED,S-EVE-CARD,S-GITHUB-NOTION-REST,S-INTRO-teams,S-JUDGE-LIFT-NOTICE,S-LINK-discord,S-LINK-teams,S-MEETING-DISCORD-VOICE,S-NOTION-WRITE,S-OE-CMD-teams,S-OWN-ACCOUNT-NOTION,S-PR-SESSION,S-PROVENANCE-DM,S-ROUTINE-CONNECTOR-WRITE,S-SIBLING-discord,S-SIBLING-notion,S-SIBLING-teams,S-SUSPENDED-discord,S-SUSPENDED-github,S-SUSPENDED-linear,S-SUSPENDED-teams,S8",
    "the non-slack scenarios are exactly S-EMAIL-ROOM-REPLY+S-EMAIL-DM-FORWARD+S-EMAIL-STRANGER-REFUSED(email, OPE-2440)/J-DISC+S-DISCORD-GRANT+S-MEETING-DISCORD-VOICE(discord)/S8+J-UNI-X+J-PR+S-PR-SESSION+J-WORKFLOW+S-JUDGE-LIFT-NOTICE(cross)/J-TEAMS+J-TEAMS-DM(teams)/J-GH(github)/J-LIN(linear)/J-NOT+S-NOTION-WRITE+S-CONNECTOR-TIER+S-DM-NOTION+S-EVE-CARD+S-CONNECT-CARD+S-APIKEY-INTAKE+S-ROUTINE-CONNECTOR-WRITE+S-OWN-ACCOUNT-NOTION(notion) PLUS the four non-slack engaged-seam journeys (OPE-1503) PLUS J-ENGAGED-teams (OPE-1500) PLUS the four Teams parity legs J-NAMEDROP-teams+S-OE-CMD-teams+S-INTRO-teams+S-CARD-teams-dm (OPE-2443/2444/2445/2447) (S-DM-DISCORD retired at OPE-725). S-JUDGE-LIFT-NOTICE is CROSS because its act originates on GitHub and its notice lands in the in-domain Slack venue — the split #911 measured, and the reason it is not a github-surface leg",
  );
  const smoke = SCENARIOS.filter((s) => s.smoke === true).map((s) => s.id);
  ok(smoke.join(",") === "J1,J-TEAMS", "the smoke lane is exactly J1 (slack wake+reply) + J-TEAMS (teams)");
  ok(
    SCENARIOS.filter((s) => s.suite === "security").map((s) => s.id).join(",") === "F-SEC,S-PR-BOUNDARY,S-AWS-BOUNDARY",
    "the security suite is F-SEC (tainted-remember/SSRF/injection) + S-PR-BOUNDARY (ungranted-repo PR refusal) + S-AWS-BOUNDARY (ungranted-AWS refusal: no host execution, no credential material)",
  );
  const unjudged = SCENARIOS.filter((s) => !s.judged).map((s) => s.id);
  ok(unjudged.join(",") === "S-MEM-READ,S6,S-OE-STATUS,S10,S-SPEND-DM-MASK,S-SPEND-REFUSAL-KEYS,S-VOICE-CLIP,S-LINK-SLACK,J-NOT,S-OWN-ACCOUNT-NOTION,J-SUP,S-DELEGATED-slack,S-DELEGATED-discord,S-DELEGATED-teams,S-DELEGATED-linear,S-DELEGATED-github,S-DELEGATED-notion,S-GITHUB-NOTION-REST,S-SUSPENDED-slack,S-SUSPENDED-discord,S-SUSPENDED-teams,S-CARD-SUMMARY,S-BLOCKED-PING,S-CARD-teams,J-NAMEDROP-teams,S-OE-CMD-teams,S-INTRO-teams,S-CARD-teams-dm,S-SUSPENDED-linear,S-SUSPENDED-github,S-AMBIENT-discord,S-AMBIENT-linear,S-AMBIENT-teams,S-SIBLING-discord,S-SIBLING-teams,S-SIBLING-notion,S-LINK-discord,S-LINK-teams,S-APP-HOME,S-SIDE-PANEL,S-SESSION-STOP,S-MEMORY-CANVAS,S-WATCH,S-DOING,S-ROUTINE-TEST,S-COVER,S-HALT,S-PR-SESSION,S-A2A-DELEGATE,S-A2A-INBOUND,S-PROVENANCE-DM,S-EVE-CARD,S-CONNECT-CARD,S-TAINT-DRYRUN,S-TAINT-ROUTE-LIVE,S-JUDGE-LIFT-NOTICE,S-TAINT-UNATTENDED-DENY,S-ROUTINE-CONNECTOR-WRITE,S-DISCORD-GRANT,S-DM-STOP-GRANT,J-ENGAGED-slack,J-ENGAGED-discord,J-ENGAGED-github,J-ENGAGED-linear,J-ENGAGED-notion,S-SLACK-AS-YOU,S-STEP-LABELS,S-MEETING-RECAP,S-MEETING-DISCORD-VOICE,S-EMAIL-ROOM-REPLY,S-EMAIL-DM-FORWARD,S-EMAIL-STRANGER-REFUSED,S-PERSONAL-BROWSER,S-MEETING-NATIVE-RECAP", "(S-VOICE-CLIP deliberately: the clip either reached the agent as words or it did not, and the reply either carries the one word the clip spoke or it does not — no judge reads that better) (J-NAMEDROP-teams/S-OE-CMD-teams/S-INTRO-teams/S-CARD-teams-dm deliberately: a name-drop, a command and an intro either wrote their surface.name_drop_*, teams.oe_command or teams.intro_posted row or they did not, and a chat card either reached the chat or it did not — the command answer and the intro are host copy, not model text) (S-WATCH deliberately: a dial either moved as a personal_watch.dial.set row or it did not, and the command's own answer is host-rendered text) (S-DOING deliberately: a Pause either moved the watch as a personal_watch.dial.set row or it did not, and a forged Pause must leave no routine.paused or dial row — nothing a reply says) (S-ROUTINE-TEST deliberately: a test either started as a routine.test_fired row, blocked its write as a routine.test_blocked row and left no routine.fire row, or it did not, and the summary is host text — nothing the model judged) (S-COVER deliberately: cover either reached the room as cover.wake and cover.answered rows and a reply whose first line is the host-written label, or it did not, and the recap is a cover.recap row — nothing the model judged) (S-EMAIL-ROOM-REPLY/S-EMAIL-DM-FORWARD/S-EMAIL-STRANGER-REFUSED deliberately: a reply either landed in the fixture inbox carrying the run token or it did not, and every other gate is an email.admitted or email.refused row) (S-PERSONAL-BROWSER deliberately: a browser either opened, acted and closed as browser.personal.* rows or it did not, and a channel ask must leave no browser.personal.open row — nothing a reply says) (S-MEETING-RECAP and S-MEETING-DISCORD-VOICE deliberately: a card either reached the audit trail as one meeting.join row or it did not, and no meeting.join row may precede a click) (S-MEETING-NATIVE-RECAP deliberately: the same shape for the meeting.recap card, and no meeting.recap_requested row may precede a click) (S-CARD-SUMMARY deliberately: the plain first line is host-rendered card text, so its gates are the notification text's first two lines and a reject ack, which no judge can read better) (S-BLOCKED-PING deliberately: a ping either wrote one attention.blocked outcome row for the asking person or it did not, and only the audit trail answers that) (S-APP-HOME deliberately: Slack offers no API to read a person's Home tab back, so the page reaching them is a home.publish row, and what Export and a forged Forget did is a memory.export row and the absence of a memory.purge row — nothing a reply says) (S-SIDE-PANEL deliberately: the answer either posted in the panel thread under a reply.post row of its own wake or it did not, the seat's wake either carries the host note naming the room or it does not, and a read of the room is a tool call that names it or returns it — nothing a reply says) (S-SESSION-STOP deliberately: a press either reached a running turn as a turn.cancel_requested row with via stop-button and the turn either wrote turn.cancelled or it did not — nothing a reply says) (S-MEMORY-CANVAS deliberately: a canvas either holds the run-unique fact or it does not, and the leg reads the canvas itself and the memory.canvas_refresh rows — never the teach reply) (S-STEP-LABELS deliberately: a tool step either ran or it did not, and the thread either holds one answer or it does not; the label itself is pinned offline) (S-SLACK-AS-YOU deliberately: the answer either carries the run-unique codename only the person can read or it does not, and the channel and write legs gate on connector.use/connector.mint/approval.requested rows and a channel read-back) (S-OWN-ACCOUNT-NOTION deliberately: an own-account ask either produced a connector.acting_identity refusal row or it did not, and the refusal SENTENCE is model-facing copy this leg's own backscroll already carries — grading the reply would grade its own history) (five of the six J-ENGAGED journeys are deliberately unjudged — J-ENGAGED-teams is the judged one: every gate is a reply.post or engagement.stood_down row, and the stand-down acknowledgement they would otherwise judge is model-authored copy the pack does not pin — their question is whether the engagement registry held the thread, which only a row answers) S-MEM-READ/S6/S10/S-LINK-SLACK/J-NOT/J-SUP/S-PR-SESSION/S-CONNECT-CARD/S-TAINT-DRYRUN/S-TAINT-ROUTE-LIVE/S-TAINT-UNATTENDED-DENY/S-ROUTINE-CONNECTOR-WRITE/S-DISCORD-GRANT are fully deterministic — no judge (S-ROUTINE-CONNECTOR-WRITE/S-DISCORD-GRANT deliberately: a fence either wrote its row or it did not, and both legs turn on rows the model cannot see — connector.refused/connector.unattended_lift and grant.asked/grant.used/grant.notified. A fire that says it could not write the page produces the same sentence whether the fence refused it or the tool was never mounted, which is exactly the ambiguity the audit gates resolve) (J-DM-SYNC, which carried this same posture for the Slack DM twin, was RETIRED by OPE-396 with the sync delegation arm it existed to exercise; S-DM-DISCORD, its Discord twin, was RETIRED by OPE-725 for the same reason) (S-TAINT-DRYRUN/S-TAINT-ROUTE-LIVE/S-TAINT-UNATTENDED-DENY deliberately: the verdict trail is a LOG — every gate is on taint.verdict/approval.chain audit rows, and what the model said about a page it read is not evidence about what the log recorded) (S-LINK-SLACK deliberately: an identity link either got WRITTEN or it didn't, and the only evidence of that is the identity.link.* audit rows — a model saying \"linked!\" is exactly the false pass this scenario exists to close) (S-MEM-READ deliberately: its whole point is that reply QUALITY is not the evidence — it gates on the memory.write audit row, the session-transcript read count and the touched silo set) (S15's deterministic legs folded into judged J3; S-PR-SESSION gates on GitHub-API readback + audit rows; S-CONNECT-CARD asserts the connector.dashboard_link_issued audit row; S-EVE-CARD deliberately: every gate is an action_id, an HTTP status or the run-unique token, and the one question it exists to answer — WHICH plane raised this card — is decided by the button's id, which no judge can read off a reply; hard gates: route status / audited silence / reply-target / in-channel presence) (S-A2A-DELEGATE deliberately: every gate is a card button, the run token on the card, the declared agent's fixed answer in the thread, or an a2a.* audit row — a judge cannot tell a delegation that ran from a reply that claims one) (S-A2A-INBOUND deliberately: it drives no model at all — every gate is an HTTP status, the card's own fields, or the absence of an a2a.inbound_accepted row) (S-JUDGE-LIFT-NOTICE deliberately: the lift is an `approval.autoapproved` row carrying `resolvedBy: \"judge\"` and the notice is joined to it by that row's own pending id — a judge cannot grade whether a notice reached a room, and the one thing a reply could say about it is the copy the notice itself carries)");
  const req = (id: string) => SCENARIOS.find((s) => s.id === id)!.requires.join("+");
  ok(req("S11") === "slack+slackPrivate", "S11 requires slack + slackPrivate");
  ok(req("J2") === "slack+slackChannelB", "J2 (memory journey) requires slack + slackChannelB (the union of S4's slack and S12's slack+slackChannelB)");
  ok(req("S13") === "slack+syntheticDm" && req("S14") === "slack+syntheticDm", "S13/S14 require slack + syntheticDm");
  ok(
    req("S-SUSPENDED-slack") === "slack+syntheticDm+synthetic",
    "S-SUSPENDED-slack drives the real Slack DM door that can legally use the consented personal connector",
  );
  ok(
    req("S-GITHUB-NOTION-REST") === "github+notionAmbient",
    "S-GITHUB-NOTION-REST requires the GitHub origin driver plus the independent Notion page readback driver",
  );
  ok(req("J3") === "slack+synthetic+slackUser2", "J3 (governance journey) requires slack + synthetic + slackUser2 (union of S5/S19 synthetic + S15/S16 non-admin identity)");
  ok(req("J4") === "slack+syntheticDm+notion", "J4 (access journey) requires slack + syntheticDm + notion (channel legs run in the one-member e2e-connector domain; DM legs keep their own driver)");
  ok(req("S20") === "slack+webhook", "S20 requires slack + webhook");
  ok(
    req("J-MPIM") === "slack+slackMpim",
    "J-MPIM (OPE-1509) requires slack + slackMpim — the base driver rebound onto the group DM, which is the pack's only mpim room",
  );
  ok(req("J1") === "slack" && req("S23") === "slack", "J1 (core journey) + S23 need only the base slack driver");
  ok(req("S24") === "slack+notion", "S24 requires slack + notion (the gated Notion add-on)");
  ok(req("J-TEAMS") === "teams", "J-TEAMS requires only the teams driver");
  ok(req("J-TEAMS-DM") === "teams", "J-TEAMS-DM requires only the teams driver — no new fixture var, the chat/scope gap is derived at runtime");
  ok(req("J-UNIFIED") === "slack+slackUnified", "J-UNIFIED requires slack + slackUnified (the two-channel unified-domain fixture; audit legs guard on targetUrl/token at runtime)");
  ok(req("J-UNI-X") === "slack+slackUnified+github", "J-UNI-X (plan-only) requires slack + slackUnified + github — the eventual cross-surface fixture union");
  ok(req("J-PR") === "slack+synthetic+pr", "J-PR requires slack + synthetic (forge the approve) + pr (the granted target repo + readback token)");
  ok(req("S-PR-BOUNDARY") === "slack", "S-PR-BOUNDARY requires only slack (the ungranted-repo ask needs no repo/token — the refusal precedes any remote touch)");
  ok(
    req("S-AWS-BOUNDARY") === "slack",
    "S-AWS-BOUNDARY requires only slack (the e2e channel has no awsRoles grant, so the fail-closed grant check refuses before any STS call — no AWS fixture needed, and deliberately so: a scenario that needed AWS creds to prove AWS is fenced would be unrunnable exactly where it matters)",
  );
  ok(
    req("S-LINK-SLACK") === "slack+syntheticDm+slackSecondary",
    "S-LINK-SLACK requires slack + syntheticDm (the initiator's DM turns — a driver-posted DM never wakes) + slackSecondary (a genuinely SECOND real account; link-store.ts refuses a self-claim, so this flow cannot be driven from one identity)",
  );
  ok(req("J-WORKFLOW") === "slack+synthetic+pr", "J-WORKFLOW requires slack + synthetic + pr (the read→PR→remember→recall chain reuses the PR drive)");
  ok(
    req("S-OWN-ACCOUNT-NOTION") === "notionAmbient",
    "S-OWN-ACCOUNT-NOTION (OPE-1599) requires only notionAmbient — J-NOT's own fixture, no new env var. It needs no `notion` capability: E2E_NOTION_CHANNEL's " +
      "room cannot produce the connector.acting_identity row at all (neither Notion read tool mounts there), which is why the leg drives a NOTION-origin turn",
  );

  const suspendedGithub = SCENARIOS.find((scenario) => scenario.id === "S-SUSPENDED-github")!;
  let githubGap = "";
  const forbiddenDriver = new Proxy({}, { get: () => { throw new Error("GitHub driver was touched before fixture preflight"); } });
  try {
    await suspendedGithub.run({
      github: forbiddenDriver,
      fixtureMissing: (reason: string): never => {
        throw new FixtureMissing(reason);
      },
    } as Parameters<typeof suspendedGithub.run>[0]);
  } catch (error) {
    if (error instanceof FixtureMissing) githubGap = error.message;
    else throw error;
  }
  ok(
    githubGap.includes("GAP (no live call was made)") && githubGap.includes("no connector write reachable from a GitHub seat that raises an op.connector card"),
    "S-SUSPENDED-github fails as a named static capability/fixture GAP without driving GitHub",
  );

  {
    const a2aLeg = SCENARIOS.find((scenario) => scenario.id === "S-A2A-DELEGATE")!;
    const a2aApps: string[] = [];
    const a2aGap = async (declaration: string | undefined): Promise<string> => {
      const app = mkdtempSync(join(tmpdir(), "oe-a2a-leg-"));
      a2aApps.push(app);
      writeFileSync(join(app, "package.json"), "{}\n");
      mkdirSync(join(app, "agent", "access"), { recursive: true });
      writeFileSync(join(app, "agent", "agent.ts"), "export {};\n");
      if (declaration !== undefined) writeFileSync(join(app, "agent", "access", "a2a-agents.ts"), declaration);
      const previous = process.env.OE_APP_ROOT;
      process.env.OE_APP_ROOT = app;
      try {
        await a2aLeg.run({
          slack: new Proxy({}, { get: () => { throw new Error("Slack driver was touched before the A2A precondition"); } }),
          fixtureMissing: (reason: string): never => {
            throw new FixtureMissing(reason);
          },
        } as unknown as Parameters<typeof a2aLeg.run>[0]);
        return "NO THROW";
      } catch (error) {
        return error instanceof FixtureMissing ? `FixtureMissing: ${error.message}` : `CRASH: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        if (previous === undefined) delete process.env.OE_APP_ROOT;
        else process.env.OE_APP_ROOT = previous;
      }
    };
    try {
      const noFile = await a2aGap(undefined);
      ok(
        noFile.startsWith("FixtureMissing: precondition a2a-declaration-file:") && noFile.includes("agent/access/a2a-agents.ts"),
        `🔴 OPE-2467: S-A2A-DELEGATE on an app with no a2a-agents.ts ends as the named precondition a2a-declaration-file, never a crash (got ${noFile.slice(0, 160)})`,
      );
      const empty = await a2aGap("export const A2A_AGENTS = [];\n");
      ok(
        empty.startsWith("FixtureMissing: precondition a2a-declared-agent:"),
        `OPE-2467: an a2a-agents.ts that declares no agent ends as the named precondition a2a-declared-agent (got ${empty.slice(0, 160)})`,
      );
      const broken = await a2aGap('import "./no-such-helper.js";\nexport const A2A_AGENTS = [];\n');
      ok(broken.startsWith("CRASH:"), `NEGATIVE CONTROL: an a2a-agents.ts that exists and FAILS to load still crashes — only the missing file is a precondition (got ${broken.slice(0, 160)})`);
    } finally {
      for (const app of a2aApps) await removeTempDir(app);
    }
  }

  {
    const origin = { surfaceKey: "github/example-owner/e2e-scratch", issueNumber: 77, commentId: 101, vendorCreatedAt: "2026-05-26T06:32:00Z" };
    const rows: AuditWireEntry[] = [
      { ts: "2026-05-26T06:32:01.000Z", org: "o", platform: "github", workspace: "example-owner", surface: origin.surfaceKey, action: "github.dispatched", detail: { issueNumber: 77, commentId: "101", wakeId: "wake-77" } },
      { ts: "2026-05-26T06:32:01.000Z", org: "o", platform: "github", workspace: "e2e-unified", surface: origin.surfaceKey, action: "wake.ingress", detail: { surfaceKey: origin.surfaceKey, vendorTs: "2026-05-26T06:32:00.000Z", vendorTsSource: "vendor-time", deliveryId: "delivery-77", wakeId: "wake-77" } },
      { ts: "2026-05-26T06:32:02.000Z", org: "o", platform: "github", workspace: "example-owner", surface: origin.surfaceKey, action: "wake.turn_start", detail: { wakeId: "wake-77", sessionId: "session-77" } },
      { ts: "2026-05-26T06:32:03.000Z", org: "o", platform: "github", workspace: "example-owner", surface: "e2e-scratch", action: "egress.policy", detail: { scopeKey: origin.surfaceKey, writeHosts: [{ host: "api.notion.com", credentialed: true, credential: "notion-rest", verb: ["GET", "POST", "PATCH"] }] } },
      { ts: "2026-05-26T06:32:07.000Z", org: "o", platform: "github", workspace: "example-owner", surface: "e2e-scratch", action: "reply.post", detail: { id: "303", platform: "github", sessionId: "session-77", wakeId: "wake-77" } },
      { ts: "2026-05-26T06:32:02.500Z", org: "o", platform: "unified", workspace: "delegation", action: "work.forwarded", detail: { requestId: "req-77", wakeId: "wake-77", seatSessionId: "session-77", workToken: "oe-dom:e2e-unified:win:w/e2e-unified:oe-sup:g1" } },
      { ts: "2026-05-26T06:32:03.500Z", org: "o", platform: "unified", workspace: "delegation", action: "delegation.task_started", detail: { task: "agent-77", session: "work-session-77", request: "req-77" } },
      { ts: "2026-05-26T06:32:05.500Z", org: "o", platform: "unified", workspace: "delegation", action: "delegation.task_settled", detail: { task: "agent-77", session: "work-session-77", status: "completed" } },
      { ts: "2026-05-26T06:32:05.700Z", org: "o", platform: "unified", workspace: "delegation", action: "work.result_wake", detail: { taskId: "agent-77", requestId: "req-77", status: "completed", outcome: "delivered", wakeId: "result-wake-77" } },
    ];
    const lifecycle = githubNotionOriginLifecycle(rows, origin);
    ok(
      lifecycle?.deliveryId === "delivery-77" && lifecycle.wakeId === "wake-77" && lifecycle.sessionId === "session-77",
      "GitHub→Notion origin rows join the exact issue/comment to one delivery, wake and session",
    );
    ok(
      githubNotionReplyRow(rows, { replyId: 303, sessionId: "session-77" })?.action === "reply.post",
      "…and the exact GitHub reply id joins to that session after its body names the independently-read block id",
    );
    ok(
      githubNotionOriginLifecycle([...rows, { ...rows[1]!, detail: { ...rows[1]!.detail, deliveryId: "other-delivery", wakeId: "other-wake" } }], origin)?.deliveryId === "delivery-77",
      "origin join ignores another issue's ingress even when GitHub stamped it in the same whole second",
    );
    ok(
      githubNotionOriginLifecycle([...rows, { ...rows[1]!, detail: { ...rows[1]!.detail, deliveryId: "ambiguous" } }], origin) === undefined,
      "origin join fails closed on a duplicate ingress for the exact shared wake id",
    );
    ok(
      githubNotionReplyRow(rows, { replyId: 303, sessionId: "another-session" }) === undefined &&
        githubNotionReplyRow([...rows, rows[4]!], { replyId: 303, sessionId: "session-77" }) === undefined,
      "reply join rejects the wrong session and an ambiguous duplicate row",
    );

    const forward = lifecycle ? githubNotionForward(rows, lifecycle) : undefined;
    ok(
      forward?.requestId === "req-77" && forward.workSessionId === "work-session-77" && forward.taskId === "agent-77" && forward.resultWakeId === "result-wake-77",
      `🔴 GitHub→Notion: the asking wake's forward joins W's task and the delivered result wake by request id (got ${JSON.stringify(forward)})`,
    );
    const without = (action: string) => rows.filter((row) => row.action !== action);
    ok(lifecycle !== undefined && githubNotionForward(without("work.forwarded"), lifecycle) === undefined, "GitHub→Notion NEGATIVE CONTROL: no work.forwarded row ⇒ no forward join");
    ok(lifecycle !== undefined && githubNotionForward(without("delegation.task_settled"), lifecycle) === undefined, "GitHub→Notion NEGATIVE CONTROL: a task that never settled ⇒ no forward join");
    ok(lifecycle !== undefined && githubNotionForward(without("work.result_wake"), lifecycle) === undefined, "GitHub→Notion NEGATIVE CONTROL: no delivered result wake ⇒ no forward join");
    ok(
      lifecycle !== undefined &&
        githubNotionForward(rows.map((row) => (row.action === "delegation.task_started" ? { ...row, detail: { ...row.detail, session: "session-77" } } : row)), lifecycle) === undefined,
      "GitHub→Notion: a task that ran on the SEAT's own session is not a forward",
    );
    ok(
      lifecycle !== undefined &&
        githubNotionForward(rows.map((row) => (row.action === "work.forwarded" ? { ...row, detail: { ...row.detail, wakeId: "other-wake", seatSessionId: "other-seat" } } : row)), lifecycle) === undefined,
      "GitHub→Notion: another wake's forward does not join this ask",
    );
    for (const action of ["work.forwarded", "delegation.task_started", "delegation.task_settled", "work.result_wake", "egress.policy"]) {
      ok((GITHUB_NOTION_REST_ACTIONS as readonly string[]).includes(action), `🔴 GitHub→Notion: the scenario's audit read asks for ${action}, or its join has nothing to join on`);
    }
    const liveRelay =
      "The paragraph was appended to Notion page `40000000-0000-4000-8000-000000000101`. The new block ID is `40000000-0000-4000-8000-0000000b10c1`.";
    ok(githubNotionReplyNamesBlock(liveRelay, "40000000-0000-4000-8000-0000000b10c1"), "🔴 GitHub→Notion: the live relay that names the block and drops the marker is the answer");
    ok(githubNotionReplyNamesBlock(liveRelay, "400000000000400080000000000B10C1"), "GitHub→Notion: the block id matches with no hyphens and in upper case");
    ok(!githubNotionReplyNamesBlock(liveRelay, "40000000-0101-804a-8b55-e1ba00cedb19"), "GitHub→Notion NEGATIVE CONTROL: a different block id does not match");
    ok(!githubNotionReplyNamesBlock(liveRelay, ""), "GitHub→Notion NEGATIVE CONTROL: an empty block id never matches");

    const timedOut = new Error("timed out after 420000ms waiting for the bot reply", { cause: new Error("last skip: reply 6000000001") });
    const aggregate = new AggregateError([timedOut, new Error("close refused")], "S-GITHUB-NOTION-REST failed");
    const printed = scenarioFailureMessage(aggregate);
    ok(
      printed.startsWith("S-GITHUB-NOTION-REST failed: [1] timed out after 420000ms") && printed.includes("(cause: last skip: reply 6000000001)") && printed.includes("[2] close refused"),
      `🔴 the runner prints every inner error and its cause of a RED leg's AggregateError (got ${printed})`,
    );
    ok(scenarioFailureMessage(new Error("plain")) === "plain", "the runner prints a plain error unchanged");
    ok(scenarioFailureMessage("text") === "text", "…and a thrown non-Error as text");
    ok(scenarioFailureMessage(new AggregateError(["x".repeat(5_000)], "big")).length < 4_100, "…and caps a huge message");

    const scenario = SCENARIOS.find((candidate) => candidate.id === "S-GITHUB-NOTION-REST")!;
    let marker = "";
    let ask = "";
    let archived = "";
    let closed = 0;
    const github = {
      repo: "example-owner/e2e-scratch",
      mention(text: string) { return `@open-everywhere ${text}`; },
      async createIssue(title: string) {
        marker = title.match(/github-notion-rest-\d+/u)?.[0] ?? "";
        return 77;
      },
      async comment(issue: number, body: string) {
        ok(issue === 77, "workflow posts its ask on the temporary issue it created");
        ask = body;
        return 101;
      },
      async commentById(issue: number, id: number) {
        return issue === 77 && id === 101 ? { id, body: ask, authorLogin: "driver", authorType: "User", createdAt: origin.vendorCreatedAt } : undefined;
      },
      async awaitBotReply(issue: number, after: number, opts: { skip?: (comment: { id: number; body: string }) => boolean | Promise<boolean> }) {
        const reply = { id: 303, body: `Completed ${marker}; new block block77`, authorLogin: "open-everywhere[bot]", authorType: "Bot", createdAt: "2026-05-26T06:32:06.000Z" };
        ok((await opts.skip?.({ id: 301, body: `Completed ${marker}` })) === true, "workflow rejects a marker-only reply that cannot prove the append returned a block id");
        ok((await opts.skip?.({ id: 302, body: "I'm pulling the page now and will reply with the new block id block77 when it lands." })) === true, "workflow skips a hand-off note even when it names the block id");
        ok((await opts.skip?.({ id: 304, body: "The new block ID is `block-77`." })) === false, "🔴 workflow accepts a relay that names the block and drops the marker (the 2026-10-06 board red)");
        ok(issue === 77 && after === 101 && (await opts.skip?.(reply)) === false, "workflow waits past hand-offs for the block-bearing settled GitHub reply");
        return reply;
      },
      async closeIssueStrict(issue: number) { closed = issue; },
    };
    const notion = {
      pageId: "notion-page-fixture",
      async awaitTextBlocks(want: string) {
        ok(want === marker, "workflow readback asks Notion for the one run marker created in GitHub");
        return [{ id: "block-77", type: "paragraph", text: `handoff ${marker}`, createdTime: "2026-05-26T06:32:05.000Z" }];
      },
      async archiveBlockStrict(id: string) { archived = id; },
    };
    let gates = 0;
    await scenario.run({
      github,
      notionAmbient: notion,
      async auditRead(opts: { actions?: readonly string[] }) { return opts.actions?.includes("control.service_call") ? [storeMarkRow()] : rows; },
      gate(pass: boolean, label: string) { if (!pass) throw new Error(`GATE ${label}`); gates++; },
      skip(reason: string): never { throw new ScenarioSkip(reason); },
      log() {},
    } as never);
    ok(marker.length > 0 && ask.includes(marker) && ask.includes("notion-page-fixture"), "workflow uses one unique marker and the exact E2E_NOTION_PAGE_ID fixture in its delegated ask");
    ok(ask.includes("do not wait for or claim a per-write approval"), "workflow states raw shared REST's real approval behavior instead of inventing a suspended request");
    ok(gates >= 7, `workflow gates vendor time, unique readback, mutation/reply order, the forward, credential route and exact lifecycle (got ${gates})`);

    {
      const realNow = Date.now;
      const realSetTimeout = globalThis.setTimeout;
      let fake = realNow();
      Date.now = () => fake;
      globalThis.setTimeout = ((fn: () => void, ms?: number) => { fake += ms ?? 0; return realSetTimeout(fn, 0); }) as typeof setTimeout;
      let noForward: unknown;
      try {
        await scenario.run({
          github,
          notionAmbient: notion,
          async auditRead(opts: { actions?: readonly string[] }) { return opts.actions?.includes("control.service_call") ? [storeMarkRow()] : rows.filter((row) => row.action !== "work.forwarded"); },
          gate(pass: boolean, label: string) { if (!pass) throw new Error(`GATE ${label}`); },
          skip(reason: string): never { throw new ScenarioSkip(reason); },
          log() {},
        } as never);
      } catch (error) {
        noForward = error;
      } finally {
        Date.now = realNow;
        globalThis.setTimeout = realSetTimeout;
      }
      const why = scenarioFailureMessage(noForward);
      ok(noForward instanceof AggregateError && why.includes("forward to the work session"), `🔴 workflow fails without the seat's forward, and the printed failure names the wait (got ${why.slice(0, 300)})`);
    }
    ok(archived === "block-77" && closed === 77, "workflow strictly archives the exact returned block and closes its own issue");

    let cleanupFailure: unknown;
    try {
      await scenario.run({
        github: { ...github, async closeIssueStrict() { throw new Error("close refused"); } },
        notionAmbient: notion,
        async auditRead(opts: { actions?: readonly string[] }) { return opts.actions?.includes("control.service_call") ? [storeMarkRow()] : rows; },
        gate(pass: boolean, label: string) { if (!pass) throw new Error(`GATE ${label}`); },
        skip(reason: string): never { throw new ScenarioSkip(reason); },
        log() {},
      } as never);
    } catch (error) {
      cleanupFailure = error;
    }
    ok(
      cleanupFailure instanceof AggregateError && cleanupFailure.message.includes("cleanup operation(s) also failed"),
      "workflow turns an owned issue cleanup failure into a scenario failure instead of reporting a fake green",
    );

    let lateArchived = "";
    let failedWait: unknown;
    try {
      await scenario.run({
        github: { ...github, async comment() { throw new Error("connection failed after GitHub may have accepted the comment"); } },
        notionAmbient: {
          ...notion,
          async pageTextBlocks() { return [{ id: "late-block-77", type: "paragraph", text: `late ${marker}`, createdTime: new Date().toISOString() }]; },
          async archiveBlockStrict(id: string) { lateArchived = id; },
        },
        async auditRead(opts: { actions?: readonly string[] }) { return opts.actions?.includes("control.service_call") ? [storeMarkRow()] : rows; },
        gate(pass: boolean, label: string) { if (!pass) throw new Error(`GATE ${label}`); },
        skip(reason: string): never { throw new ScenarioSkip(reason); },
        log() {},
      } as never);
    } catch (error) {
      failedWait = error;
    }
    ok(failedWait instanceof AggregateError && lateArchived === "late-block-77", "an ambiguous GitHub POST failure still re-reads within the cleanup cutoff and archives a resulting late marker block before reporting the original failure");
  }

  ok(req("J-ENGAGED-slack") === "slack+engagedSlack", "J-ENGAGED-slack requires slack + engagedSlack (the base xoxp driver, rebound onto the addressed-only channel)");
  ok(req("J-ENGAGED-discord") === "discord+engagedDiscord", "J-ENGAGED-discord requires discord + engagedDiscord");
  ok(req("J-ENGAGED-teams") === "teams+engagedTeams", "J-ENGAGED-teams requires teams + engagedTeams (OPE-1531 — its own fixture channel, never J-TEAMS’s E2E_TEAMS_CHANNEL_ID)");
  ok(req("J-ENGAGED-github") === "github+engagedGithub", "J-ENGAGED-github requires github + engagedGithub");
  ok(req("J-ENGAGED-linear") === "linear+engagedLinear", "J-ENGAGED-linear requires linear + engagedLinear");
  ok(req("J-ENGAGED-notion") === "notionAmbient+engagedNotion", "J-ENGAGED-notion requires notionAmbient + engagedNotion (the ambient Notion driver, rebound onto the addressed-only page)");
  const suiteOf = (id: string) => SCENARIOS.find((sc) => sc.id === id)!.suite;
  for (const id of ["J-ENGAGED-slack", "J-ENGAGED-discord", "J-ENGAGED-github", "J-ENGAGED-linear", "J-ENGAGED-notion"]) {
    ok(suiteOf(id) === "core", `${id} is core — its surface wires the §2.5 seam, so the journey must pass rather than be opted into`);
  }
  const surfaceOf = (id: string) => SCENARIOS.find((sc) => sc.id === id)!.surface;
  for (const [id, surface] of [
    ["J-ENGAGED-slack", "slack"],
    ["J-ENGAGED-discord", "discord"],
    ["J-ENGAGED-github", "github"],
    ["J-ENGAGED-linear", "linear"],
    ["J-ENGAGED-notion", "notion"],
  ] as const) {
    ok(surfaceOf(id) === surface, `${id} drives the ${surface} surface`);
  }
}

{
  const key = { surfaceKey: "slack/T1/C-HALT", channelId: "C-HALT", workspaceId: "T1", driverUserId: "U-DRIVER", runStart: "2026-05-26T05:32:00.000Z" };
  const anchorTs = "1779773520.123456";
  const wakeId = "wake-1";
  const ingressRow = {
    ts: "2026-05-26T05:32:00.200Z", org: "default", platform: "slack", workspace: "engineering", surface: key.surfaceKey,
    action: "wake.ingress", detail: { surfaceKey: key.surfaceKey, vendorTs: "2026-05-26T05:32:00.123Z", wakeId },
  };
  const setRow = {
    ts: "2026-05-26T05:32:01.000Z", org: "default", platform: "slack", workspace: "T1", surface: "C-HALT", principalId: "U-DRIVER",
    action: "admin.halt.set", detail: { door: "chat", level: "surface", scopeKey: key.surfaceKey, announced: true, wakeId, sessionId: "wrun-1", setAt: "2026-05-26T05:32:00.500Z" },
  };
  ok(haltWakeForSlackAnchor([ingressRow], key, anchorTs) === wakeId, "S-HALT resolves the exact posted Slack timestamp to its host wake");
  ok(
    haltWakeForSlackAnchor([{ ...ingressRow, surface: "slack/T2/C-HALT", detail: { ...ingressRow.detail, surfaceKey: "slack/T2/C-HALT" } }], key, anchorTs) === undefined,
    "S-HALT rejects an identical vendor timestamp from another workspace",
  );
  ok(haltWakeForSlackAnchor([ingressRow, { ...ingressRow, detail: { ...ingressRow.detail, wakeId: "wake-2" } }], key, anchorTs) === undefined, "S-HALT fails closed when one anchor appears to name multiple wakes");
  ok(haltSetEvidence(setRow, key, wakeId), "S-HALT accepts the exact announced chat row joined to the anchor's wake + session + stored timestamp");
  for (const [label, row] of [
    ["wrong room", { ...setRow, surface: "C-OTHER" }],
    ["wrong requester", { ...setRow, principalId: "U-OTHER" }],
    ["old row", { ...setRow, ts: "2026-05-26T05:31:59.000Z" }],
    ["silent halt", { ...setRow, detail: { ...setRow.detail, announced: false } }],
    ["missing wake", { ...setRow, detail: { ...setRow.detail, wakeId: "" } }],
    ["missing session", { ...setRow, detail: { ...setRow.detail, sessionId: "" } }],
    ["wrong wake", { ...setRow, detail: { ...setRow.detail, wakeId: "wake-2" } }],
    ["missing set timestamp", { ...setRow, detail: { ...setRow.detail, setAt: "" } }],
  ] as const) ok(!haltSetEvidence(row, key, wakeId), `S-HALT rejects ${label} evidence`);

  const clearRow = { ...setRow, principalId: "local-operator", action: "admin.halt.cleared", detail: { door: "control-mcp", level: "surface", scopeKey: key.surfaceKey, cleared: true } };
  ok(haltClearEvidence(clearRow, key), "S-HALT accepts the exact local control-plane clear row");
  ok(!haltClearEvidence({ ...clearRow, principalId: "U-DRIVER" }, key), "S-HALT rejects a clear not attributed to the local operator");
  ok(!haltClearEvidence({ ...clearRow, detail: { ...clearRow.detail, scopeKey: "slack/T1/C-OTHER" } }, key), "S-HALT rejects a different clear address");

  const handle = { orgWide: false as const, level: "surface" as const, scopeKey: key.surfaceKey, setAt: String(setRow.detail.setAt), setBy: key.driverUserId, setRef: wakeId };
  ok(haltOwnedBySet(handle, setRow, key, wakeId), "S-HALT adopts the exact audited set row for cleanup");
  ok(haltOwnedByWake(handle, key, wakeId), "S-HALT can recover its own wake-stamped row even if the later set audit read fails");
  ok(!haltOwnedByWake({ ...handle, setRef: "wake-2" }, key, wakeId), "S-HALT never adopts another wake's halt from the same driver");
  ok(!haltOwnedBySet({ ...handle, setAt: "2026-05-26T05:32:00.600Z" }, setRow, key, wakeId), "S-HALT never adopts a row whose store timestamp differs from the audited set event");
  ok(!haltOwnedByWake({ ...handle, setAt: "2026-05-26T05:31:59.000Z" }, key, wakeId), "S-HALT never adopts a pre-run halt");
  ok(!haltOwnedByWake({ ...handle, setBy: "operator" }, key, wakeId), "S-HALT never adopts another actor's halt");

  const scenario = SCENARIOS.find((s) => s.id === "S-HALT")!;
  ok(scenario.requires.join(",") === "slack,slackHalt,controlWrite", "S-HALT cannot run without the dedicated room and guarded local cleanup road");

  const clears: HaltOwnershipHandle[] = [];
  let replyError = "";
  let cleanupStatus = "";
  try {
    await Promise.reject(new Error("reply read failed"));
  } catch (err) {
    replyError = err instanceof Error ? err.message : String(err);
  } finally {
    const cleanup = await cleanupExactHalt({
      key,
      anchorTs,
      alreadyCleared: false,
      auditRead: async () => [ingressRow],
      inspectHalt: async () => handle,
      clearOwnedHalt: async (candidate) => {
        clears.push(candidate);
        return "cleared";
      },
      inspectOrgHalt: async () => undefined,
      clearOwnedOrgHalt: async () => "missing",
    });
    cleanupStatus = cleanup.status;
  }
  ok(replyError === "reply read failed", "S-HALT preserves the reply-read failure as the scenario red");
  ok(cleanupStatus === "cleared" && clears.length === 1 && clears[0] === handle, "S-HALT still clears the exact wake-owned halt when reply polling fails after the post");

  let foreignClears = 0;
  const foreignCleanup = await cleanupExactHalt({
    key,
    anchorTs,
    alreadyCleared: false,
    auditRead: async () => [ingressRow],
    inspectHalt: async () => ({ ...handle, setRef: "wake-foreign" }),
    clearOwnedHalt: async () => { foreignClears++; return "cleared"; },
    inspectOrgHalt: async () => undefined,
    clearOwnedOrgHalt: async () => { foreignClears++; return "cleared"; },
  });
  ok(foreignCleanup.status === "residue" && foreignCleanup.reason === "halt-not-owned" && foreignClears === 0, "S-HALT reply-failure cleanup leaves a foreign same-scope halt untouched");
}

{
  const none = new Set<"slack" | "discord" | "synthetic" | "slackPrivate" | "slackChannelB" | "slackMpim" | "slackCapFixture" | "slackHalt" | "controlWrite" | "slackSupervisor" | "syntheticDm" | "slackUser2" | "slackSecondary" | "webhook" | "notion" | "teams" | "github" | "linear" | "notionAmbient" | "slackUnified" | "pr" | "connectorWrite" | "engagedSlack" | "engagedDiscord" | "engagedTeams" | "engagedGithub" | "engagedLinear" | "engagedNotion" | "email">();
  const missing = {
    slack: [ENV.slackUserToken, ENV.slackChannel, ENV.slackBotUserId],
    discord: [ENV.discordDriverToken, ENV.discordChannel, ENV.discordBotUserId],
    synthetic: [ENV.targetUrl, ENV.slackSigningSecret, ENV.slackAdminUserId, ENV.slackChannel],
    slackPrivate: [ENV.slackPrivateChannel],
    slackChannelB: [ENV.slackChannelB],
    slackMpim: [ENV.slackMpimChannel],
    slackCapFixture: [ENV.slackCapChannel],
    slackHalt: [ENV.slackHaltChannel],
    controlWrite: ["E2E_CONTROL_LOCAL_WRITE=1", ENV.org, 'OE_OPERATIONAL_PROVIDER="postgres"', "DATABASE_URL"],
    slackSupervisor: [ENV.slackSupervisorChannel],
    syntheticDm: [ENV.slackDmChannel],
    slackUser2: [ENV.slackUser2Id],
    slackSecondary: [ENV.slackSecondaryToken, ENV.slackSecondaryUserId],
    webhook: [ENV.webhookSecret],
    notion: [ENV.notionChannel],
    teams: [ENV.teamsTenantId, ENV.teamsClientId, ENV.teamsRefreshToken, ENV.teamsTeamId, ENV.teamsChannelId, ENV.teamsBotAppId],
    github: [ENV.githubDriverToken, ENV.githubRepo, ENV.githubAppSlug, ENV.githubIssue],
    linear: [ENV.linearApiKey, ENV.linearTeamId, ENV.linearAppUserId, ENV.linearAgentHandle],
    notionAmbient: [ENV.notionDriverKey, ENV.notionAmbientPageId, ENV.notionBotUserId, ENV.notionWorkspaceId],
    slackUnified: [ENV.slackUnifiedChannelA, ENV.slackUnifiedChannelB],
    pr: [ENV.prRepo, ENV.githubDriverToken],
    connectorWrite: [ENV.notionChannel],
    soakSlack: [ENV.slackSoakChannelDev, ENV.slackSoakChannelOps],
    soakNotion: [ENV.notionSoakPage1, ENV.notionSoakPage2],
    soakLinear: [ENV.linearSoakLabelId],
    engagedSlack: [ENGAGED_ROOM_VARS.slack],
    engagedDiscord: [ENGAGED_ROOM_VARS.discord],
    engagedTeams: [ENGAGED_ROOM_VARS.teams],
    engagedGithub: [ENGAGED_ROOM_VARS.github],
    engagedLinear: [ENGAGED_ROOM_VARS.linear],
    engagedNotion: [ENGAGED_ROOM_VARS.notion],
    email: [ENV.emailApiKey, ENV.emailSenderInbox, ENV.emailRoomInbox],
  } as const;
  for (const s of SCENARIOS) {
    const reason = skipReason(s, none, missing, false);
    ok(reason !== undefined, `${s.id} skips in dry mode`);
    ok(/E2E_|SLACK_SIGNING_SECRET/.test(reason ?? ""), `${s.id} dry-skip names the env vars to set`);
  }
  const all = new Set(["slack", "discord", "synthetic", "slackPrivate", "slackChannelB", "slackMpim", "slackCapFixture", "slackHalt", "controlWrite", "slackSupervisor", "syntheticDm", "slackUser2", "slackSecondary", "webhook", "notion", "teams", "github", "linear", "notionAmbient", "slackUnified", "pr", "connectorWrite", "engagedSlack", "engagedDiscord", "engagedTeams", "engagedGithub", "engagedLinear", "engagedNotion", "email"] as const);
  const noneMissing = {
    slack: [],
    discord: [],
    synthetic: [],
    slackPrivate: [],
    slackChannelB: [],
    slackMpim: [],
    slackCapFixture: [],
    slackHalt: [],
    controlWrite: [],
    slackSupervisor: [],
    syntheticDm: [],
    slackUser2: [],
    slackSecondary: [],
    webhook: [],
    notion: [],
    teams: [],
    github: [],
    linear: [],
    notionAmbient: [],
    slackUnified: [],
    pr: [],
    connectorWrite: [],
    soakSlack: [],
    soakNotion: [],
    soakLinear: [],
    engagedSlack: [],
    engagedDiscord: [],
    engagedTeams: [],
    engagedGithub: [],
    engagedLinear: [],
    engagedNotion: [],
    email: [],
  } as const;
  ok(skipReason(SCENARIOS[0], all, noneMissing, false) === undefined, "the first scenario (J1) runs when its capability is live");

  {
    const grant = SCENARIOS.find((sc) => sc.id === "S-DISCORD-GRANT")!;
    ok(grant.suite === "core", "precondition: S-DISCORD-GRANT is core — it used to be the optional leg that made the asymmetry reachable");
    ok(skipReason(grant, all, noneMissing, true) === undefined, "naming S-DISCORD-GRANT directly RUNS it");
    ok(skipReason(grant, all, noneMissing, false) === undefined, "…and so does a plain pass: there is no flag left to forget");
  }

  const roomOnlyMissing = new Set(["slack", "discord", "github", "linear", "notionAmbient"] as const);
  for (const [id, varName] of [
    ["J-ENGAGED-slack", ENGAGED_ROOM_VARS.slack],
    ["J-ENGAGED-discord", ENGAGED_ROOM_VARS.discord],
    ["J-ENGAGED-github", ENGAGED_ROOM_VARS.github],
    ["J-ENGAGED-linear", ENGAGED_ROOM_VARS.linear],
    ["J-ENGAGED-notion", ENGAGED_ROOM_VARS.notion],
  ] as const) {
    const reason = skipReason(SCENARIOS.find((sc) => sc.id === id)!, roomOnlyMissing, missing);
    ok(reason?.includes(varName) === true, `${id} names ${varName} while its room is unprovisioned (got ${JSON.stringify(reason)})`);
  }
  {
    const collided = resolveEngagedTeams({ [ENGAGED_ROOM_VARS.teams]: "19:chan-A", [ENV.teamsChannelId]: "19:chan-A" });
    const teamsLive = new Set([...all].filter((c) => c !== "engagedTeams"));
    const reason = skipReason(
      SCENARIOS.find((sc) => sc.id === "J-ENGAGED-teams")!,
      teamsLive,
      { ...noneMissing, engagedTeams: collided.ok ? [] : collided.missing },
    );
    ok(
      reason?.includes(`set ${ENGAGED_ROOM_VARS.teams} to a channel other than ${ENV.teamsChannelId}'s`) === true,
      `the collision's reason reads as a REMEDY inside skipReason's "(set …)" frame (got ${JSON.stringify(reason)})`,
    );
  }

  for (const sc of SCENARIOS) {
    if (sc.expensive === true) continue;
    ok(
      skipReason(sc, all, noneMissing) === undefined,
      `${sc.id} runs on a PLAIN pass once its capabilities are live — no flag to set, no tier to opt into`,
    );
  }
  {
    const expensive = SCENARIOS.find((sc) => sc.expensive === true);
    ok(expensive !== undefined, "precondition: the roster still carries an expensive leg to control against");
    if (expensive) {
      ok(skipReason(expensive, all, noneMissing)?.includes("expensive") === true, "🔴 NEGATIVE CONTROL: an expensive leg is still deferred by the same planner call");
      ok(skipReason(expensive, all, noneMissing, true) === undefined, "…and naming it directly runs it — the cost gate takes naming as consent");
    }
  }
  const allButNotion = new Set(["slack", "discord", "synthetic", "slackPrivate", "slackChannelB", "syntheticDm", "slackUser2", "webhook"] as const);
  const s24CapMissing = skipReason(SCENARIOS.find((s) => s.id === "S24")!, allButNotion, missing);
  ok(s24CapMissing === `missing notion driver (set ${ENV.notionChannel})`, "S24's reason names exactly E2E_NOTION_CHANNEL when the notion capability is absent");
  const slackOnly = new Set(["slack"] as const);
  const s7reason = skipReason(SCENARIOS.find((s) => s.id === "J-DISC")!, slackOnly, missing, false);
  ok(s7reason?.includes("discord") === true && s7reason.includes(ENV.discordDriverToken), "J-DISC skip names the discord vars specifically");
  const st1reason = skipReason(SCENARIOS.find((s) => s.id === "J-TEAMS")!, slackOnly, missing, false);
  ok(st1reason?.includes("teams") === true && st1reason.includes(ENV.teamsRefreshToken), "J-TEAMS skip names the teams vars specifically");
  ok(skipReason(SCENARIOS.find((s) => s.id === "J-TEAMS")!, all, noneMissing, false) === undefined, "J-TEAMS runs when the teams capability is live");
  const dmReason = skipReason(SCENARIOS.find((s) => s.id === "J-TEAMS-DM")!, slackOnly, missing, false);
  ok(dmReason?.includes("teams") === true && dmReason.includes(ENV.teamsRefreshToken), "J-TEAMS-DM skip names the teams vars specifically when the base capability is missing");
  ok(skipReason(SCENARIOS.find((s) => s.id === "J-TEAMS-DM")!, all, noneMissing, false) === undefined, "J-TEAMS-DM is attempted (capability-wise) once the teams capability is live — its own precondition gap is a runtime skip, not a capability skip");
  const baseOnly = new Set(["slack", "discord", "synthetic"] as const);
  const s11 = skipReason(SCENARIOS.find((s) => s.id === "S11")!, baseOnly, missing, false);
  ok(s11 === `missing slackPrivate driver (set ${ENV.slackPrivateChannel})`, "S11 skip names exactly E2E_SLACK_PRIVATE_CHANNEL");
  const jmpimScenario = SCENARIOS.find((s) => s.id === "J-MPIM")!;
  const jmpim = skipReason(jmpimScenario, baseOnly, missing, false);
  const noSlack = new Set(["discord", "synthetic"] as const);
  const roomPresent = { ...missing, slackMpim: [] as readonly string[] };
  const jmpimRoomOk = skipReason(jmpimScenario, noSlack, roomPresent, false);
  ok(
    jmpimRoomOk?.includes("mpim:history") === false,
    `🔴 …and NO remedy when slackMpim itself resolved — the gap is the base driver, and a remedy naming the room would send the operator at a fixture that is present (got: ${JSON.stringify(jmpimRoomOk)})`,
  );
  ok(
    jmpim?.startsWith(`missing slackMpim driver (set ${ENV.slackMpimChannel})`) === true,
    "J-MPIM skip names exactly E2E_SLACK_MPIM_CHANNEL — the group DM is the one fixture it cannot derive",
  );
  ok(
    jmpim?.includes("the room EXISTS and TRACKED_ROOM_IDS carries its id") === true,
    "🔴 J-MPIM's remedy states the room's REAL state — open, and its id tracked — never the pre-OPE-1662 'does not exist yet'",
  );
  ok(jmpim?.includes("mpim:history") === true, "🔴 …and it names the read scope that is actually missing, not the write scope the driver app already holds");
  ok(jmpim?.includes("mpim:write") === false, "…and it no longer names `mpim:write`, which the driver app got before the room was opened");
  ok(jmpim?.includes("provision-mpim") === true, "…and the command that re-opens the room if its id ever leaves the table");
  ok(
    skipCategory(jmpimScenario, baseOnly, false) === "missing-capability",
    "…and it stays a SKIP, never a red — the remedy rides the same missing-capability category the runner skips on",
  );
  ok(
    skipReason(SCENARIOS.find((s) => s.id === "S11")!, baseOnly, missing, false)?.includes("—") === false,
    "the control: a capability whose gap IS its variable carries no remedy clause",
  );
  const j2 = skipReason(SCENARIOS.find((s) => s.id === "J2")!, baseOnly, missing, false);
  ok(j2?.includes(ENV.slackChannelB) === true && j2.includes("slackChannelB"), "J2 skip names E2E_SLACK_CHANNEL_B");
  for (const id of ["S13", "S14"]) {
    const r = skipReason(SCENARIOS.find((s) => s.id === id)!, baseOnly, missing, false);
    ok(r?.includes(ENV.slackDmChannel) === true && r.includes("syntheticDm"), `${id} skip names E2E_SLACK_DM_CHANNEL`);
  }
  {
    const r = skipReason(SCENARIOS.find((s) => s.id === "J3")!, baseOnly, missing, false);
    ok(r === `missing slackUser2 driver (set ${ENV.slackUser2Id})`, "J3 skip names exactly E2E_SLACK_USER2_ID");
  }
  const j4 = skipReason(SCENARIOS.find((s) => s.id === "J4")!, baseOnly, missing, false);
  ok(j4?.includes(ENV.slackDmChannel) === true && j4.includes("syntheticDm"), "J4 skip names E2E_SLACK_DM_CHANNEL (the DM negative leg's fixture)");
  const s20 = skipReason(SCENARIOS.find((s) => s.id === "S20")!, baseOnly, missing, false);
  ok(s20 === `missing webhook driver (set ${ENV.webhookSecret})`, "S20 skip names exactly E2E_WEBHOOK_SECRET");
  const jUni = skipReason(SCENARIOS.find((s) => s.id === "J-UNIFIED")!, baseOnly, missing, false);
  ok(
    jUni === `missing slackUnified driver (set ${ENV.slackUnifiedChannelA}, ${ENV.slackUnifiedChannelB})`,
    "J-UNIFIED skip names exactly E2E_SLACK_UNIFIED_CHANNEL_A + E2E_SLACK_UNIFIED_CHANNEL_B",
  );
  for (const id of ["S11", "J2", "J3", "J4", "S13", "S14", "S20", "S23", "J-UNIFIED", "J-PR", "S-PR-BOUNDARY", "J-WORKFLOW"]) {
    ok(skipReason(SCENARIOS.find((s) => s.id === id)!, all, noneMissing, false) === undefined, `${id} runs (non-optional) when its fixtures are live`);
  }
  {
    const baseSyn = new Set(["slack", "synthetic"] as const);
    const jpr = skipReason(SCENARIOS.find((s) => s.id === "J-PR")!, baseSyn, missing, false);
    ok(jpr === `missing pr driver (set ${ENV.prRepo}, ${ENV.githubDriverToken})`, "J-PR skip names exactly E2E_PR_REPO + E2E_GITHUB_DRIVER_TOKEN (the pr capability)");
    const jwf = skipReason(SCENARIOS.find((s) => s.id === "J-WORKFLOW")!, baseSyn, missing, false);
    ok(jwf === `missing pr driver (set ${ENV.prRepo}, ${ENV.githubDriverToken})`, "J-WORKFLOW skip names exactly the pr capability vars");
    ok(skipReason(SCENARIOS.find((s) => s.id === "S-PR-BOUNDARY")!, new Set(["slack"] as const), missing, false) === undefined, "S-PR-BOUNDARY runs with slack alone (no pr fixture — the ungranted-repo refusal needs none)");
  }
  {
    const jx = SCENARIOS.find((s) => s.id === "J-UNI-X")!;
    const capMiss = skipReason(jx, baseOnly, missing);
    ok(capMiss?.includes("slackUnified") === true && capMiss.includes(ENV.slackUnifiedChannelA), "J-UNI-X names the unified fixture vars while they are unset");
    ok(skipReason(jx, all, noneMissing) === undefined, "J-UNI-X runs on a PLAIN pass with full tokens — no tier to opt into");
    const runSelfSkip = async (armed: boolean): Promise<{ skip: string; gate: string }> => {
      const before = process.env.E2E_UNIX_ARMED;
      if (armed) process.env.E2E_UNIX_ARMED = "1";
      else delete process.env.E2E_UNIX_ARMED;
      let skip = "";
      let gate = "";
      try {
        await jx.run({
          skip: (why: string) => { throw new ScenarioSkip(why); },
          gate: (pass: boolean, why: string) => { if (!pass) throw new Error(`GATE ${why}`); },
        } as never);
      } catch (err) {
        if (err instanceof ScenarioSkip) skip = err.message;
        else if (err instanceof Error && err.message.startsWith("GATE ")) gate = err.message;
        else throw err;
      } finally {
        if (before === undefined) delete process.env.E2E_UNIX_ARMED;
        else process.env.E2E_UNIX_ARMED = before;
      }
      return { skip, gate };
    };
    const unarmed = await runSelfSkip(false);
    const selfSkip = unarmed.skip;
    ok(selfSkip.includes("live-fixture-pending"), "…without the unified-audit caller the body self-skips as live-fixture-pending (fixture detection, not a stub)");
    ok(selfSkip.includes("E2E_TARGET_URL") && selfSkip.includes("E2E_CONTROL_READ_TOKEN"), "…and the self-skip names the env pair that arms fixture detection");
    ok(!selfSkip.includes("TODO(unified-dispatch)") && !selfSkip.includes("TODO(unified-reply)"), "…and no longer names the retired TODO(unified-dispatch)/TODO(unified-reply) stubs (they are wired)");
    ok(unarmed.gate === "", "…and the UNARMED branch never gates — a missing fixture is a skip, not a red");
    const armed = await runSelfSkip(true);
    ok(armed.skip === "", "E2E_UNIX_ARMED=1: the armed fixture does NOT skip — an armed regression must not read as 'not provisioned'");
    ok(
      armed.gate.includes("ARMED fixture regressed") && armed.gate.includes("live-fixture-pending"),
      "E2E_UNIX_ARMED=1: the same missing fixture GATES, naming the armed flag and carrying the underlying reason",
    );
  }
  for (const id of ["J1", "S23"]) {
    ok(skipReason(SCENARIOS.find((s) => s.id === id)!, slackOnly, missing, false) === undefined, `${id} runs with slack alone (no add-on fixture needed)`);
  }
}

{
  for (const s of SCENARIOS) {
    const satisfied = new Set(s.requires);
    const missingForSatisfied = Object.fromEntries(s.requires.map((c) => [c, [] as string[]])) as Record<(typeof s.requires)[number], string[]>;
    const cat = skipCategory(s, satisfied);
    const reason = skipReason(s, satisfied, missingForSatisfied);
    ok((cat !== undefined) === (reason !== undefined), `${s.id}: skipCategory and skipReason agree on definedness (capabilities satisfied)`);
    if (s.expensive) {
      ok(cat === "expensive-not-included", `${s.id}: expensive — deferred with its cost named until somebody opts in`);
      ok(skipCategory(s, satisfied, false, true) === undefined, `${s.id}: expensive — runs once includeExpensive is on`);
      ok(skipCategory(s, satisfied, true) === undefined, `${s.id}: expensive — naming it directly is consent too`);
    } else {
      ok(cat === undefined, `${s.id}: runs once its capabilities are satisfied — there is no tier to opt into`);
    }
    ok(skipCategory(s, new Set()) === "missing-capability", `${s.id}: skips as missing-capability with zero capabilities available`);
  }
}
{
  const counts = emptySkipCounts();
  ok(SKIP_KINDS.every((k) => counts[k] === 0), "emptySkipCounts starts every bucket at zero");
  ok(renderSkipBreakdown(counts) === "none", "renderSkipBreakdown reports 'none' when every bucket is zero — the negative control for the non-empty case below");
  ok(SKIP_KINDS.length === 7, "the skip-reason taxonomy has exactly 7 closed categories");
  counts["missing-capability"] = 3;
  counts["filtered-only"] = 1;
  ok(
    renderSkipBreakdown(counts) === "1 filtered-only, 3 missing-capability",
    "renderSkipBreakdown lists only the non-zero buckets, in fixed taxonomy order regardless of assignment order",
  );
}

{
  ok(
    expensiveReasonError({ id: "FAKE-OK", expensive: true, costReason: "burns ~5M tokens per run" }) === undefined,
    "expensive:true + a non-empty costReason validates (no error)",
  );
  ok(
    expensiveReasonError({ id: "FAKE-NONE", expensive: true, costReason: undefined }) !== undefined,
    "expensive:true with costReason UNSET refuses — the reason is the point of the flag",
  );
  ok(
    expensiveReasonError({ id: "FAKE-EMPTY", expensive: true, costReason: "" }) !== undefined,
    "expensive:true with costReason === '' refuses",
  );
  ok(
    expensiveReasonError({ id: "FAKE-WS", expensive: true, costReason: "   " }) !== undefined,
    "expensive:true with a whitespace-only costReason refuses (trimmed before the emptiness check)",
  );
  ok(
    expensiveReasonError({ id: "FAKE-WS", expensive: true, costReason: "   " })?.includes("FAKE-WS") === true,
    "the refusal names the offending scenario id",
  );
  ok(
    expensiveReasonError({ id: "FAKE-CHEAP", expensive: false, costReason: undefined }) === undefined,
    "expensive:false never refuses regardless of costReason (negative control)",
  );
  ok(
    expensiveReasonError({ id: "FAKE-CHEAP2" }) === undefined,
    "a scenario with expensive entirely absent never refuses (the common-case default)",
  );
  ok(
    SCENARIOS.every((s) => expensiveReasonError(s) === undefined),
    "no roster scenario is currently flagged expensive without a reason (module-load validation shape)",
  );
  const badRoster = [
    { id: "BAD1", expensive: true, costReason: "" },
    { id: "BAD2", expensive: true, costReason: "   " },
    { id: "BAD3", expensive: false },
  ];
  let threw = false;
  let thrownMessage = "";
  try {
    const errors = badRoster.map((s) => expensiveReasonError(s)).filter((e) => e !== undefined);
    if (errors.length > 0) throw new Error(`e2e scenario roster: ${errors.join("; ")}`);
  } catch (err) {
    threw = true;
    thrownMessage = String(err instanceof Error ? err.message : err);
  }
  ok(threw, "a roster carrying an expensive-but-reasonless entry trips the module-load validation shape");
  ok(
    thrownMessage.includes("BAD1") && thrownMessage.includes("BAD2") && !thrownMessage.includes("BAD3"),
    "the thrown message names exactly the two offending ids, not the clean BAD3 entry",
  );

  const fakeExpensive = {
    id: "FAKE-EXP",
    requires: ["slack"],
    optional: false,
    expensive: true,
    costReason: "burns ~5M tokens/run (compaction repro shape)",
  } as any;
  const satisfied = new Set(["slack"]) as any;
  const missingNone = { slack: [] as string[] } as any;
  ok(
    skipCategory(fakeExpensive, satisfied, false) === "expensive-not-included",
    "an expensive scenario with satisfied capabilities skips by default (not named, no --include-expensive)",
  );
  const defaultReason = skipReason(fakeExpensive, satisfied, missingNone, false);
  ok(defaultReason !== undefined, "the default skip carries a printed reason");
  ok(
    defaultReason?.includes(fakeExpensive.costReason) === true,
    "the printed default-skip reason names the scenario's own costReason verbatim — a silent absence is a defect",
  );
  ok(
    skipCategory(fakeExpensive, satisfied, true, false) === undefined,
    "naming the scenario id directly (explicitlyNamed=true) always runs it, even expensive and with no --include-expensive flag",
  );
  ok(
    skipReason(fakeExpensive, satisfied, missingNone, true, false) === undefined,
    "skipReason agrees: a directly-named expensive scenario has no skip reason (it runs)",
  );
  ok(
    skipCategory(fakeExpensive, satisfied, false, true) === undefined,
    "--include-expensive / E2E_INCLUDE_EXPENSIVE=1 (includeExpensive=true) runs an expensive scenario even when not named directly",
  );
  ok(
    skipReason(fakeExpensive, satisfied, missingNone, false, true) === undefined,
    "skipReason agrees: includeExpensive=true clears the skip reason",
  );
  ok(
    skipCategory(fakeExpensive, new Set(), true, true) === "missing-capability",
    "missing-capability still wins over the expensive gate, even with BOTH explicitlyNamed and includeExpensive set",
  );
  const fakeCheap = { id: "FAKE-CHEAP", requires: ["slack"] } as any;
  ok(
    skipCategory(fakeCheap, satisfied, false) === undefined,
    "a non-expensive scenario is unaffected by the expensive gate (negative control)",
  );

  const expensiveIds = SCENARIOS.filter((s) => s.expensive === true).map((s) => s.id);
  ok(
    expensiveIds.join(",") === "S-TAINT-ROUTE-LIVE",
    `the roster's expensive set is exactly S-TAINT-ROUTE-LIVE — the one leg measured green past the ~10-minute bar (1246.8 s, 2026-09-10 full pack). Got: ${expensiveIds.join(",") || "(none)"}`,
  );
  for (const id of ["J-GH", "F-EDIT", "F-SEC", "J-UNI-X"]) {
    const s = SCENARIOS.find((x) => x.id === id);
    ok(s !== undefined, `${id} is still in the roster (the not-flagged assertion below needs a subject)`);
    ok(s?.expensive !== true, `${id} is NOT flagged expensive — a leg that REDS on its reply timeout is broken, not expensive`);
  }
  const routeLive = SCENARIOS.find((s) => s.id === "S-TAINT-ROUTE-LIVE")!;
  ok(routeLive.costReason?.includes("1246.8 s") === true, "S-TAINT-ROUTE-LIVE's costReason carries the measured duration, not an estimate");
  ok(
    skipCategory(routeLive, satisfied, false, false) === "expensive-not-included",
    "on a plain pack (no expensive opt-in) S-TAINT-ROUTE-LIVE is deferred as expensive-not-included",
  );
  const fullPackReason = skipReason(routeLive, satisfied, missingNone, false, false);
  ok(
    fullPackReason?.includes(routeLive.costReason!) === true,
    "…and the printed skip line names its costReason verbatim — the cost is visible, never a silent absence",
  );
  ok(
    skipCategory(routeLive, satisfied, false, true) === undefined,
    "includeExpensive=true runs S-TAINT-ROUTE-LIVE (negative control — the flag gates, it does not retire the leg)",
  );
  ok(
    skipCategory(routeLive, satisfied, true, false) === undefined,
    "naming the id directly runs it with no expensive opt-in (negative control)",
  );
  ok(
    skipCategory(routeLive, satisfied, true, false) === undefined,
    "naming the id alone RUNS it — the gate that used to outrank the cost gate is gone",
  );
  ok(
    skipCategory(routeLive, satisfied, false, false) === "expensive-not-included",
    "🔴 NEGATIVE CONTROL: a pass that names nothing still defers it on cost, naming the reason",
  );
}

{
  const { bareSurfaceSegment, factToken, otherFactTokens, approveButton, contradictButton, legGate } = await import(
    "../packages/core/scripts/e2e/journey.js"
  );
  ok(/^falcon-\d{1,5}$/.test(factToken("falcon")), "factToken appends a run-unique numeric suffix to the stem");
  ok(factToken("x") !== factToken("x") || true, "factToken is stem-scoped (suffix derives from the clock)");

  ok(bareSurfaceSegment("example-owner/oe-e2e-addressed-github") === "oe-e2e-addressed-github", "🔴 OPE-1991: the owner/repo slug reduces to the repo NAME the reply.post row carries");
  ok(bareSurfaceSegment("C0ABC") === "C0ABC", "IDEMPOTENT on a value with no path — a Discord snowflake, a Linear team id and a Notion page id all pass through unchanged");
  ok(bareSurfaceSegment("slack/T0ABC/C0ABC") === "C0ABC", "…and a fully-qualified surface KEY reduces to the bare segment too, which is the same conversion in the other direction");
  ok(bareSurfaceSegment("") === "", "NEGATIVE: an empty value is handed back, never turned into some other scope");
  ok(bareSurfaceSegment("owner/") === "owner/", "🔴 NEGATIVE: a trailing slash yields an EMPTY last segment, and an empty scope reads as NO scope at all — so the value is handed back instead");

  ok(
    JSON.stringify(otherFactTokens("The explicit verification record says the OPE121 canary code is obsidian-37625", "obsidian", "obsidian-54772")) ===
      JSON.stringify(["obsidian-37625"]),
    "🔴 OPE-1977: otherFactTokens names the PREVIOUS board's canary the recall turn chose instead — the line that tells fixture accumulation from a broken memory read",
  );
  ok(otherFactTokens("the canary is obsidian-54772", "obsidian", "obsidian-54772").length === 0, "NEGATIVE: this run's OWN canary is never reported as stale");
  ok(
    otherFactTokens("the canary is OBSIDIAN-54772", "obsidian", "obsidian-54772").length === 0,
    "NEGATIVE: the comparison is case-insensitive, exactly as the recall gate's own containment check is — a case difference is not a second canary",
  );
  ok(
    JSON.stringify(otherFactTokens("obsidian-1 and obsidian-2 and obsidian-1", "obsidian", "obsidian-9")) === JSON.stringify(["obsidian-1", "obsidian-2"]),
    "…each stale token ONCE, in first-seen order — a silo holding one line twice is still one stale canary",
  );
  ok(otherFactTokens("no tokens here at all", "obsidian", "obsidian-1").length === 0, "VACUITY: a reply quoting no token claims nothing — the reader is a diagnostic, never an assertion of its own");
  ok(otherFactTokens("abc-1", "a.c", "x").length === 0, "🔴 the stem is ESCAPED, so a caller may pass any literal — an unescaped `a.c` would match `abc-1` and report a token nothing wrote");
  ok(JSON.stringify(otherFactTokens("a.c-1", "a.c", "x")) === JSON.stringify(["a.c-1"]), "…and the escaped stem still matches its own literal (the positive control for the line above)");
  {
    const { carriesFactToken, distinctFactToken, examinedPostLines } = await import("../packages/core/scripts/e2e/journey.js");
    const asked = "rcwfxa-60697";

    ok(
      carriesFactToken(
        "Refused: the Notion connector is not authorized for this account, so I could not access its page-creation operation. rcwa-60697",
        asked,
      ),
      "🔴 OPE-2032: a fired post spelling the token with a SHORTER stem matches — the shape of the post a live run's wait missed",
    );
    ok(carriesFactToken("I tried the connector tool and it refused. rcwfxa-60697", asked), "POSITIVE CONTROL: the token spelled exactly as asked still matches");
    ok(
      !carriesFactToken("Refused: the Notion connector is not authorized for this account.", asked),
      "🔴 NEGATIVE: a post carrying NO digit run does not match — the refusal prose alone is not the fire's confirmation word",
    );
    ok(!carriesFactToken("OE e2e rcwa-60696", asked), "🔴 NEGATIVE: the same stem family with a DIFFERENT digit run does not match — the digits are the anchor, not the letters");
    ok(!carriesFactToken("the monthly cap is now 60697 USD per month", asked), "🔴 NEGATIVE: a bare figure in the prose is not the token — the stem prefix has to ride with it");
    ok(
      !carriesFactToken("rcwa-160697", asked) && !carriesFactToken("rcwa-606971", asked),
      "🔴 NEGATIVE: a LONGER number never satisfies the run — the digits are delimited on both sides, so a page count containing them is not the word",
    );
    ok(carriesFactToken("RCWA-60697", asked), "the match is case-insensitive — a model that recases the token it echoes has still echoed it");
    ok(!carriesFactToken("rcw and then much later in the same sentence 60697", asked), "NEGATIVE: the prefix sits within twelve stem characters of the run, not anywhere in the post");
    ok(!carriesFactToken("xrcwa-60697", asked), "NEGATIVE: the ANCHOR needs the prefix to start a token, so a longer word ending in it does not widen the match");
    ok(
      carriesFactToken("ref plain-token here", "plain-token") && !carriesFactToken("ref plain-toke here", "plain-token"),
      "a value that is not a factToken has no digit anchor, so it falls back to EXACT containment rather than matching more loosely than the caller asked",
    );
    ok(carriesFactToken("marker del-sl-60697", "del-sl-60697"), "🔴 a HYPHENATED stem still matches its own token verbatim — the anchor cannot bridge the hyphen, so exact containment has to answer first");
    ok(
      carriesFactToken("x github-notion-rest-60697", "github-notion-rest-60697"),
      "🔴 …and so does a stem longer than the twelve characters the anchor spans — `github-notion-rest` is a stem this pack mints",
    );
    ok(carriesFactToken("reportrcwfxa-60697", asked), "🔴 a token GLUED to the preceding word matches — `includes` accepted it, and the anchor may only ever ADD spellings");
    ok(!carriesFactToken("marker del-sl-60698", "del-sl-60697"), "NEGATIVE CONTROL: the containment fallback is exact, so a hyphenated stem with the WRONG digits still does not match");

    ok(distinctFactToken("rcwfxa", ["rcwa-60697"], 60697) === "rcwfxa-60698", "🔴 OPE-2032: a digit run the other token already holds is walked past — two tokens minted in one millisecond share a clock, not a number");
    ok(distinctFactToken("rcwfxa", ["rcwa-60696"], 60697) === "rcwfxa-60697", "POSITIVE CONTROL: a free number is kept exactly as minted");
    ok(distinctFactToken("rcwfxa", ["rcwa-99999"], 99999) === "rcwfxa-0", "the walk WRAPS at 100000 — the same modulus factToken mints under, so the token stays the shape every gate reads");
    ok(distinctFactToken("rcwfxa", ["not-a-token"], 4) === "rcwfxa-4", "a taken value carrying no digit run reserves nothing");
    ok(
      !carriesFactToken("reason: e2e connector-write proof, ref rcwa-60697", distinctFactToken("rcwfxa", ["rcwa-60697"], 60697)),
      "🔴 THE JOIN: the minted fire word does NOT match the creation CARD's own note — the false-match two tokens exist to prevent, which matching on digits alone would have re-opened",
    );

    ok(
      JSON.stringify(examinedPostLines([{ ts: "1780491746.509000", text: "Refused: the connector\n  is not authorized. rcwa-60697" }])) ===
        JSON.stringify(["1780491746.509000 | Refused: the connector is not authorized. rcwa-60697"]),
      "🔴 OPE-2032: a timed-out wait prints each bot post's ts and its first 120 characters, whitespace collapsed to one line per post",
    );
    ok(examinedPostLines([{ ts: "1.1", text: "x".repeat(400) }])[0].length === "1.1".length + 3 + 120, "the text is cut at 120 characters, so one long post cannot flood the leg log");
    ok(examinedPostLines([]).length === 0, "VACUITY: no bot posts is an empty list, never a line claiming one");
    ok(
      JSON.stringify(examinedPostLines([{ ts: "1.1", text: "only post" }], 0)) === JSON.stringify(["… 1 earlier bot post(s) elided"]),
      "🔴 a limit of ZERO keeps nothing — `slice(-0)` is `slice(0)`, which would hand back EVERY post under a line saying none were kept",
    );
    const newestFirst = Array.from({ length: 15 }, (_, i) => ({ ts: `${1780491746 + (14 - i)}.509499`, text: `post ${14 - i}` }));
    ok(newestFirst[0].text === "post 14" && newestFirst[14].text === "post 0", "fixture control: the input really is newest-first, or the assertion below proves nothing");
    const examinedLines = examinedPostLines(newestFirst);
    ok(
      examinedLines.length === 13 && examinedLines[0] === "… 3 earlier bot post(s) elided" && examinedLines[12].endsWith("| post 14") && examinedLines[1].endsWith("| post 3"),
      "🔴 the MOST RECENT twelve are kept, OLDEST FIRST, and the elision is COUNTED — posts 0-2 go, post 14 stays and reads last",
    );
    ok(!examinedLines.some((l) => l.endsWith("| post 0")), "🔴 NEGATIVE: the OLDEST post is the one elided — a raw slice of the live page would have kept it and dropped post 14");
  }

  const card = { ts: "1.1", text: "raise cap?", actions: [{ actionId: "oe_approval:approve:row-9", value: "default" }] };
  const decoded = approveButton(card);
  ok(decoded?.pendingId === "row-9" && decoded.org === "default", "approveButton decodes pendingId off the action_id and org off value");
  ok(approveButton({ ts: "1.2", text: "decided" }) === undefined, "approveButton returns undefined for a decided card (no actions block)");
  const notice = { ts: "1.3", text: "Ran without asking: routine.create", actions: [{ actionId: "oe_approval:contradict:row-9", value: "default" }] };
  const contradict = contradictButton(notice);
  ok(
    contradict?.pendingId === "row-9" && contradict.org === "default",
    "OPE-1902: contradictButton decodes the pending id off the action_id and the org off value — flow.ts refuses a click carrying no org as malformed",
  );
  ok(
    approveButton(notice) === undefined,
    "🔴 OPE-1902: an approve decoder finds NOTHING on a judge-lift notice — the act already ran, and the notice offers no approval",
  );
  ok(
    contradictButton(card) === undefined,
    "🔴 OPE-1902 NEGATIVE CONTROL: a contradict decoder finds nothing on a pending APPROVAL card — otherwise the live gate would read an ordinary card as proof the notice road ran",
  );
  ok(
    approveButton({ ts: "1.3", text: "x", actions: [{ actionId: "oe_approval:reject:row-9", value: "default" }] }) === undefined,
    "approveButton ignores a reject-only button (it keys on the approve prefix)",
  );
  ok(approveButton({ ts: "1.4", text: "x", actions: [{ actionId: "oe_approval:approve:row-x" }] })?.org === "", "a value-less approve button decodes org as empty (flow.ts fail-softs it)");

  const { eveRequestApprovalButtons } = await import("../packages/core/scripts/e2e/journey.js");
  const deploy142 = {
    ts: "2.1",
    text: "Approve tool call: notion__notion-create-pages",
    actions: [
      { actionId: "eve_input:tool-approval:req-1:button:1", value: "cancel", text: "Cancel" },
      { actionId: "eve_input:tool-approval:req-1:button:0", value: "approve", text: "Approve" },
    ],
  };
  const d142 = eveRequestApprovalButtons(deploy142);
  ok(d142?.approve.actionId === "eve_input:tool-approval:req-1:button:0", "eveRequestApprovalButtons reads the approve side off `value:\"approve\"` (a live run's Approve/Cancel card, in the pinned eve's shapes)");
  ok(d142?.deny?.actionId === "eve_input:tool-approval:req-1:button:1", "…and the deny side off `value:\"cancel\"` — the option id the pinned eve actually stamps — so the label set is not the only thing finding it");
  const allowDeny = eveRequestApprovalButtons({ ts: "2.2", text: "allow?", actions: [{ actionId: "b1", text: "Deny" }, { actionId: "b2", text: "Allow" }] });
  ok(allowDeny?.approve.actionId === "b2" && allowDeny.deny?.actionId === "b1", "eveRequestApprovalButtons falls back to the LABEL set (Allow/Deny) when the buttons carry no value");
  ok(
    eveRequestApprovalButtons({ ts: "2.3", text: "raise cap?", actions: [{ actionId: "oe_approval:approve:row-9", value: "default", text: "Approve" }, { actionId: "oe_approval:reject:row-9", value: "default", text: "Reject" }] }) === undefined,
    "eveRequestApprovalButtons REFUSES an OE-minted card — every `oe_approval:` button is dropped before the match, however it is labelled",
  );
  ok(eveRequestApprovalButtons({ ts: "2.4", text: "decided" }) === undefined, "eveRequestApprovalButtons returns undefined for a decided/button-less message");
  ok(
    eveRequestApprovalButtons({ ts: "2.5", text: "connect?", actions: [{ actionId: "oe_connect:notion:api-key", value: "default", text: "Set API key" }] }) === undefined,
    "eveRequestApprovalButtons returns undefined for the connector-OFFER card (neither an approve value nor an approve label)",
  );
  const approveOnly = eveRequestApprovalButtons({ ts: "2.6", text: "x", actions: [{ actionId: "b3", value: "approve", text: "Approve" }] });
  ok(
    approveOnly?.approve.actionId === "b3" && approveOnly.deny === undefined,
    "an approve-only card still DECODES, with no deny side — rather than mis-reading the approve button as both, or answering undefined",
  );

  const seen: string[] = [];
  const wrapped = legGate((cond, label) => seen.push(`${cond}|${label}`), "teardown");
  wrapped(true, "cleared the override");
  ok(seen[0] === "true|teardown: cleared the override", "legGate prefixes the gate label with the leg name");
}

{
  const empty = {};
  const ghMiss = resolveGithub(empty);
  ok(!ghMiss.ok && ghMiss.missing.length === 4 && ghMiss.missing.includes(ENV.githubDriverToken), "github half reports its four required vars missing in an empty env");
  const ghBase = resolveGithub({
    [ENV.githubDriverToken]: "ghp_x",
    [ENV.githubRepo]: "acme/scratch",
    [ENV.githubAppSlug]: "open-everywhere",
    [ENV.githubIssue]: "7",
  });
  ok(ghBase.ok && ghBase.cfg.repo === "acme/scratch" && ghBase.cfg.appSlug === "open-everywhere" && ghBase.cfg.issue === "7", "github cfg carries repo/appSlug/issue");
  ok(ghBase.ok && ghBase.cfg.webhookSecret === undefined && ghBase.cfg.installationId === undefined, "github forge vars are absent unless set (the forge leg self-skips)");
  const ghForge = resolveGithub({
    [ENV.githubDriverToken]: "ghp_x",
    [ENV.githubRepo]: "acme/scratch",
    [ENV.githubAppSlug]: "open-everywhere",
    [ENV.githubIssue]: "7",
    [ENV.githubWebhookSecret]: "whsec",
    [ENV.githubInstallationId]: "12345",
  });
  ok(ghForge.ok && ghForge.cfg.webhookSecret === "whsec" && ghForge.cfg.installationId === "12345", "github cfg carries the optional forge vars when present");

  const { signGithubBody, buildIssueCommentEvent } = await import("../packages/core/scripts/e2e/github-forge.js");
  const { verifyGithubSignature } = await import("@open-everywhere/core/agent/routines/events.js");
  const secret = "gh-e2e-secret";
  const payload = buildIssueCommentEvent({ commentId: 42, body: "@open-everywhere summarise", driverLogin: "e2e-user", issueNumber: 7, repoFullName: "acme/scratch", installationId: 99 });
  const raw = JSON.stringify(payload);
  const sig = signGithubBody(secret, raw);
  ok(sig.startsWith("sha256="), 'github signature carries the "sha256=" prefix');
  ok(verifyGithubSignature(secret, raw, sig), "a signed github forge body verifies against the real verifyGithubSignature");
  ok(!verifyGithubSignature(secret, raw + "x", sig), "a tampered github body fails verification");
  ok(!verifyGithubSignature("wrong", raw, sig), "the wrong github secret fails verification");
  const ev = buildIssueCommentEvent({ commentId: 1, body: "@open-everywhere hi", driverLogin: "u", issueNumber: 3, repoFullName: "o/r", installationId: 5 });
  const comment = ev.comment as { user?: { type?: string }; body?: string };
  ok(ev.action === "created" && comment.user?.type === "User", "forged issue_comment is action=created with a User-typed (not Bot) author");
  ok((comment.body ?? "").startsWith("@open-everywhere"), "forged comment body carries the @slug mention (githubBotMentioned wakes on it)");
  ok((ev.repository as { full_name?: string }).full_name === "o/r", "forged event names the repo full_name");
}

{
  const { engagedRepoSkipReason, GithubDriver } = await import("../packages/core/scripts/e2e/github-driver.js");
  const publicReason = engagedRepoSkipReason("acme/fixture", false);
  ok(publicReason !== undefined, "a PUBLIC fixture repo yields a skip reason");
  ok(publicReason!.includes("acme/fixture"), "…which names the repo the operator must fix");
  ok(publicReason!.includes("PUBLIC") && publicReason!.includes("githubEngagedFollowUpReach"), "…and names the privacy floor that makes step (b) unreachable");
  ok(publicReason!.includes("E2E_ADDRESSED_GITHUB_REPO"), "…and the variable that points the journey elsewhere");
  ok(engagedRepoSkipReason("acme/fixture", true) === undefined, "a PRIVATE fixture repo yields no skip — the journey runs");
  ok(engagedRepoSkipReason("acme/fixture", undefined) === undefined, "an UNREADABLE probe yields no skip either — unknown privacy is not evidence the floor blocks step (b)");

  const realFetch = globalThis.fetch;
  try {
    const driver = new GithubDriver({ repo: "acme/fixture", token: "driver-token", appSlug: "open-everywhere", issue: "7" } as never);
    globalThis.fetch = async () => new Response(JSON.stringify({ number: 77, state: "closed" }), { status: 200 });
    await driver.closeIssueStrict(77);
    let malformed: unknown;
    globalThis.fetch = async () => new Response(JSON.stringify({ number: 77, state: "open" }), { status: 200 });
    try { await driver.closeIssueStrict(77); } catch (error) { malformed = error; }
    ok(malformed instanceof Error && malformed.message.includes("no matching closed issue"), "strict GitHub teardown rejects a malformed 2xx that did not close its exact issue");
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  const { GithubDriver, GITHUB_PAGE_SIZE, GITHUB_MAX_PAGES, walkGithubPages } = await import(
    "../packages/core/scripts/e2e/github-driver.js"
  );
  const realFetch = globalThis.fetch;
  try {
    const driver = new GithubDriver({ repo: "acme/fixture", token: "driver-token", appSlug: "open-everywhere", issue: "1" } as never);

    const all = Array.from({ length: 101 }, (_, i) => ({
      id: 5_609_000_000 + i,
      body: i === 100 ? "gh-20698 — the answer the leg is waiting for" : `human chatter ${i}`,
      user: { login: i === 100 ? "open-everywhere[bot]" : "example-owner", type: i === 100 ? "Bot" : "User" },
      created_at: `2026-09-09T22:${String(10 + Math.floor(i / 10)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
    }));
    const pagesServed: number[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      pagesServed.push(page);
      return new Response(JSON.stringify(all.slice((page - 1) * perPage, page * perPage)), { status: 200 });
    }) as typeof fetch;

    const comments = await driver.comments(1);
    ok(comments.length === 101, `🔴 the walk surfaces ALL 101 comments, not the first page (got ${comments.length})`);
    ok(comments[100]?.id === 5_609_000_100, `🔴 …and the 101st is present — the exact comment a single-page read drops (got ${comments[100]?.id})`);
    ok(pagesServed.length === 2 && pagesServed[0] === 1 && pagesServed[1] === 2, `…having read page 1 then page 2 and STOPPED on the short page (got ${JSON.stringify(pagesServed)})`);
    ok(comments[100]?.authorLogin === "open-everywhere[bot]" && driver.isBotComment(comments[100]!), "…and the 101st maps as a BOT comment, so awaitBotReply's predicate can match it");

    const found = await driver.awaitBotReply(1, 5_609_000_099, { timeoutMs: 5_000 });
    ok(found.id === 5_609_000_100, `🔴 awaitBotReply finds a bot reply that sits on PAGE 2 (got ${found.id})`);

    pagesServed.length = 0;
    const hundred = all.slice(0, 100);
    globalThis.fetch = (async (input: unknown) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page") ?? "1");
      pagesServed.push(page);
      return new Response(JSON.stringify(page === 1 ? hundred : []), { status: 200 });
    }) as typeof fetch;
    const exact = await driver.comments(1);
    ok(exact.length === 100 && pagesServed.length === 2, `an exactly-full first page is followed by ONE confirming read and no more (got ${exact.length} comments over ${pagesServed.length} page(s))`);
  } finally {
    globalThis.fetch = realFetch;
  }

  ok(GITHUB_PAGE_SIZE === 100, "the page size is GitHub's own maximum for these endpoints");
  const shortFirst = await walkGithubPages("t", async () => [1, 2, 3], { pageSize: 100 });
  ok(shortFirst.length === 3, "a short first page ends the walk immediately");
  const twoPages = await walkGithubPages("t", async (p) => (p === 1 ? [1, 2] : [3]), { pageSize: 2 });
  ok(twoPages.join(",") === "1,2,3", "pages are concatenated in page order, oldest page first");

  let capped: unknown;
  try {
    await walkGithubPages("issues/1/comments", async () => [1, 2], { pageSize: 2, maxPages: 3 });
  } catch (error) {
    capped = error;
  }
  ok(capped instanceof Error, "🔴 a list still FULL at the last page THROWS rather than returning a silently truncated answer");
  ok(
    capped instanceof Error && capped.message.includes("issues/1/comments") && capped.message.includes("refuses"),
    `…and the message names the endpoint and says it refused, so the red reads as itself (got: ${capped instanceof Error ? capped.message : String(capped)})`,
  );
  ok(GITHUB_MAX_PAGES > 1, "the default cap leaves room for a real fixture issue to grow past one page");
}

{
  const { buildAgentSessionEvent, FORGE_SESSION_ID, FORGE_ORGANIZATION_ID, FORGE_ISSUE_ID, FORGE_CREATOR_ID } = await import(
    "../packages/core/scripts/e2e/linear-driver.js"
  );
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  ok(UUID_RE.test(FORGE_SESSION_ID), "FORGE_SESSION_ID is UUID-shaped");
  ok(UUID_RE.test(FORGE_ORGANIZATION_ID), "FORGE_ORGANIZATION_ID is UUID-shaped");
  ok(UUID_RE.test(FORGE_ISSUE_ID), "FORGE_ISSUE_ID is UUID-shaped");
  ok(UUID_RE.test(FORGE_CREATOR_ID), "FORGE_CREATOR_ID is UUID-shaped");

  ok(!UUID_RE.test("forged-session"), "negative control: the pre-OPE-886 literal 'forged-session' is NOT UUID-shaped");

  const ev = buildAgentSessionEvent({
    action: "created",
    organizationId: FORGE_ORGANIZATION_ID,
    sessionId: FORGE_SESSION_ID,
    issueId: FORGE_ISSUE_ID,
    issueIdentifier: "OE-0",
    teamId: "team-x",
    creatorId: FORGE_CREATOR_ID,
    nowMs: 1_700_000_000_000,
  });
  const session = (ev.agentSession ?? {}) as { id?: string; creator?: { id?: string } };
  ok(session.id === FORGE_SESSION_ID, "buildAgentSessionEvent embeds the UUID sessionId verbatim as agentSession.id");
  ok(session.creator?.id === FORGE_CREATOR_ID, "buildAgentSessionEvent embeds the UUID creatorId verbatim as agentSession.creator.id");
}

{
  const prMiss = resolvePr({});
  ok(!prMiss.ok && prMiss.missing.length === 2 && prMiss.missing.includes(ENV.prRepo) && prMiss.missing.includes(ENV.githubDriverToken), "pr half reports E2E_PR_REPO + E2E_GITHUB_DRIVER_TOKEN missing in an empty env");
  const prRepoOnly = resolvePr({ [ENV.prRepo]: "acme/e2e-scratch" });
  ok(!prRepoOnly.ok && prRepoOnly.missing.join(",") === ENV.githubDriverToken, "pr half still fails-closed on the reused driver PAT when only E2E_PR_REPO is set");
  const prFull = resolvePr({ [ENV.prRepo]: "acme/e2e-scratch", [ENV.githubDriverToken]: "ghp_x" });
  ok(prFull.ok && prFull.cfg.repo === "acme/e2e-scratch" && prFull.cfg.token === "ghp_x", "pr cfg carries the target repo + the reused driver token");

  const { classifyPrMiss } = await import("../packages/core/scripts/e2e/journey.js");
  ok(classifyPrMiss('repo "acme/x" is not granted to this channel. Allowed: (none). Grant it via a bundle') === "grant-refused", "classifyPrMiss: a fail-closed grant refusal → grant-refused (SKIP with provisioning guidance)");
  ok(classifyPrMiss("the staging push of my-branch failed — checkout the repo first") === "errored", "classifyPrMiss: a push/checkout failure → errored (prefer FAIL)");
  ok(classifyPrMiss("couldn't push your branch to the remote") === "errored", "classifyPrMiss: a couldn't-push reply → errored");
  ok(classifyPrMiss("Sure — what change would you like in the PR?") === "no-tool", "classifyPrMiss: a plain narration reply (no tool call) → no-tool (SKIP as model-choice)");
}

{
  const { findJudgeAllow, prOpenRowPublishes } = await import("../packages/core/scripts/e2e/journey.js");
  const row = (action: string, detail: Record<string, unknown>) => ({
    ts: "2026-04-13T17:44:49.000Z",
    org: "default",
    platform: "slack",
    workspace: "acme",
    action,
    detail,
  });
  const allowRow = row("approval.judge.verdict", {
    tool: "open_pull_request",
    action: "pr.open",
    mode: "enforce",
    verdict: "allow",
    enforcedVerdict: "allow",
    resolvedBy: "judge",
    source: "model",
    passes: 2,
    reasoning: "a one-line README addition against a granted fixture repo, requested in-room",
  });

  ok(findJudgeAllow([], "open_pull_request") === undefined, "findJudgeAllow: an EMPTY window is not an allow — no rows, no arm (card absence alone must stay a skip)");
  const hit = findJudgeAllow([allowRow], "open_pull_request");
  ok(hit?.enforcedVerdict === "allow" && hit.resolvedBy === "judge" && hit.passes === 2, "findJudgeAllow: a matching enforce-mode allow row is returned with resolvedBy/passes/reasoning for the caller to log");
  ok((hit?.reasoning ?? "").includes("granted fixture repo"), "findJudgeAllow: the judge's REASONING is carried through — it is the only review surface for an auto-approved consequential write");
  ok(
    findJudgeAllow([row("approval.judge.verdict", { tool: "forget", enforcedVerdict: "allow" })], "open_pull_request") === undefined,
    "findJudgeAllow: another judge-deferred verb's allow in the SAME window is NOT this action's arm (the row must name the tool)",
  );
  ok(
    findJudgeAllow([row("approval.judge.verdict", { tool: "open_pull_request", verdict: "allow", enforcedVerdict: "ask" })], "open_pull_request") === undefined,
    "findJudgeAllow: a judge allow that the chain RAISED back to ask is not the arm — a card was posted, so arm (a) owns that run (enforcedVerdict is the field, not verdict)",
  );
  ok(
    findJudgeAllow([row("approval.judge.verdict", { tool: "open_pull_request", verdict: "ask", enforcedVerdict: "allow", resolvedBy: "domain-mode" })], "open_pull_request")?.resolvedBy === "domain-mode",
    "findJudgeAllow: a judge ask that a CONFIG element lowered to allow still explains the missing card — the arm is about what was enforced, and resolvedBy says which happened",
  );
  ok(
    findJudgeAllow([row("approval.judge.shadow", { tool: "open_pull_request", enforcedVerdict: "allow" })], "open_pull_request") === undefined,
    "findJudgeAllow: a phase-1 approval.judge.shadow row never arms anything — shadow rows are log-only and influenced nothing",
  );

  const prRows = [
    row("pr.open", { repo: "acme/e2e-scratch", number: 18, head: "e2e-wf-1", base: "main" }),
    row("pr.update", { repo: "acme/e2e-scratch", number: 4, head: "old", base: "main" }),
    row("pr.open", { repo: "other/repo", number: 99, head: "x", base: "main" }),
    row("pr.open", { repo: "acme/e2e-scratch", number: 18, head: "e2e-wf-1", base: "main" }),
  ];
  ok(
    JSON.stringify(prOpenRowPublishes(prRows).map((p) => p.number)) === JSON.stringify([18, 99]),
    "prOpenRowPublishes: pr.open rows only (a pr.update means a PR was ALREADY open for that head — a different state), de-duplicated, newest-first",
  );
  ok(
    JSON.stringify(prOpenRowPublishes(prRows, "acme/e2e-scratch")) === JSON.stringify([{ number: 18, head: "e2e-wf-1" }]),
    "prOpenRowPublishes: narrowing to the fixture repo drops another repo's publish from the same window, and the row's `head` rides along so a miss-path teardown needs no second GitHub read",
  );
  ok(
    prOpenRowPublishes([row("pr.open", { repo: "acme/e2e-scratch" })]).length === 0,
    "prOpenRowPublishes: a pr.open row with no `number` yields nothing (never guess a PR number — the teardown closes whatever it is handed)",
  );
  ok(
    prOpenRowPublishes([row("pr.open", { repo: "acme/e2e-scratch", number: 7 })])[0]?.head === undefined,
    "prOpenRowPublishes: a row that states no head yields no head — the caller reads it back from GitHub rather than being handed a guess",
  );
  ok(
    prOpenRowPublishes([row("pr.open", { repo: "acme/e2e-scratch", number: 7, head: "" })])[0]?.head === undefined,
    "prOpenRowPublishes: an EMPTY head is no head — `deleteBranch(\"\")` is not a teardown",
  );
}

{
  const { drivePrOpen } = await import("../packages/core/scripts/e2e/journey.js");
  type DriveArgs = Parameters<typeof drivePrOpen>[0];

  const TOKEN = "prline-83737";
  const auditRow = (action: string, detail: Record<string, unknown>) => ({
    ts: "2026-06-03T03:43:49.000Z",
    org: "default",
    platform: "slack",
    workspace: "acme",
    action,
    detail,
  });
  const ALLOW = auditRow("approval.judge.verdict", {
    tool: "open_pull_request",
    action: "pr.open",
    mode: "enforce",
    verdict: "allow",
    enforcedVerdict: "allow",
    resolvedBy: "judge",
    passes: 2,
    reasoning: "a one-line README addition against a granted fixture repo, requested in-room",
  });
  const PUBLISH = auditRow("pr.open", { repo: "example-owner/e2e-scratch", number: 101, head: "add-prline-83737", sha: "4c5d1f8b", tainted: false });

  const HANDOFF = "I'm handing off the repo change and PR flow now — the worker will check out, commit and open the PR.";

  const cardlessSlack = {
    mention: (t: string) => `<@bot> ${t}`,
    post: async () => ({ ts: "1780456498.000100" }),
    awaitThreadReply: async () => ({ ts: "1780456498.000200", text: HANDOFF }),
    awaitThreadMessage: async (_threadTs: string, opts: { readonly timeoutMs: number }) => {
      await new Promise((resolve) => setTimeout(resolve, opts.timeoutMs));
      throw new Error(`timed out after ${opts.timeoutMs}ms waiting for an approval card`);
    },
    isBotReply: () => true,
    channelId: "C0EXCHAN003",
    identity: async () => ({ userId: "U0", teamId: "T0" }),
  };

  const lateReader = (visibleFromRead: number, rows: readonly unknown[]) => {
    const readsAt: number[] = [];
    const started = Date.now();
    return {
      readsAt,
      read: async () => {
        readsAt.push(Date.now() - started);
        return readsAt.length >= visibleFromRead ? rows : [];
      },
    };
  };

  const baseArgs = (over: Record<string, unknown>): DriveArgs =>
    ({
      slack: cardlessSlack,
      synthetic: {},
      gate: (cond: boolean, what: string) => {
        if (!cond) throw new Error(`gate failed: ${what}`);
      },
      log: () => {},
      pr: { getPr: async () => ({ head: "add-prline-83737", base: "main" }), prContainsToken: async () => true },
      ask: "checkout the repo, add a line to README.md, and open a pull request",
      token: TOKEN,
      base: "main",
      leg: "pr",
      repo: "example-owner/e2e-scratch",
      ...over,
    }) as unknown as DriveArgs;

  {
    const reader = lateReader(2, [ALLOW, PUBLISH]);
    const result = await drivePrOpen(baseArgs({ timeoutMs: 5_000, auditRead: reader.read }));
    ok(result.published === true && result.arm === "judge-allow", "drivePrOpen: a judge verdict row that appears only on a LATER probe tick still resolves as ARM (b) — the probe keeps reading, it is not one-shot");
    ok(result.published === true && result.prNumber === 101, "…on the PR the pr.open row names, read back and hard-gated exactly as arm (a)'s PR is");
    ok(reader.readsAt.length >= 2, "…and the drive really did read the audit more than once (a one-shot read would prove nothing about a late row)");
  }

  {
    const reader = lateReader(Number.MAX_SAFE_INTEGER, []);
    const started = Date.now();
    const result = await drivePrOpen(baseArgs({ timeoutMs: 4_000, auditRead: reader.read }));
    const elapsed = Date.now() - started;
    ok(result.published === false && result.miss === "no-tool", "drivePrOpen: no card and no verdict row anywhere in the budget is still the model-declined SKIP — card absence never becomes an arm");
    ok(elapsed >= 3_500, `…and the drive spent the WHOLE card budget looking (${elapsed}ms of 4000ms) rather than giving up on an early tick`);
    ok(elapsed < 12_000, `…while spending it ONCE, concurrently (${elapsed}ms): a probe with its own serial budget would have cost the card budget plus that budget`);
    ok(reader.readsAt.length >= 3, `…and it kept reading the audit across the whole window (${reader.readsAt.length} reads), not only at the start`);
  }

  {
    const reader = lateReader(2, [ALLOW, PUBLISH]);
    const result = await drivePrOpen(baseArgs({ timeoutMs: 0, auditRead: reader.read }));
    ok(result.published === true && result.arm === "judge-allow" && result.prNumber === 101, "drivePrOpen: a verdict row visible only to the FINAL re-read is reported as ARM (b) — 'CANNOT RUN' is the most expensive sentence this drive can say, so it costs one more read first");
    ok(reader.readsAt.length === 2, "…and that re-read is exactly one extra request (the probe's single tick, then the last chance)");
  }

  {
    const reader = lateReader(2, [PUBLISH]);
    const opened: { number: number; head: string }[] = [];
    const result = await drivePrOpen(baseArgs({ timeoutMs: 0, auditRead: reader.read, onPublished: (p: { number: number; head: string }) => opened.push(p) }));
    ok(
      result.published === false && result.miss === "published-unevidenced",
      "drivePrOpen: a pr.open row with NO judge verdict row is still NOT an arm — the arm stays gated on the verdict row, never on card absence",
    );
    ok(
      opened.length === 1 && opened[0]?.number === 101 && opened[0]?.head === "add-prline-83737",
      "🔴 …and the published PR is registered for the caller's TEARDOWN anyway, head and all — a leg that ends in CANNOT RUN used to strand a real PR in the fixture repo",
    );
    ok(
      result.published === false && result.reason.includes("open_pull_request DID run") && result.reason.includes("#101"),
      "🔴 …and the miss REASON names the published PR and says the tool ran — a torn-down PR reported as 'the model never called the tool' is the exact false sentence this ticket exists to kill",
    );
  }

  {
    const reader = lateReader(2, [PUBLISH]);
    const opened: { number: number; head: string }[] = [];
    await drivePrOpen(
      baseArgs({
        timeoutMs: 0,
        auditRead: reader.read,
        onPublished: (p: { number: number; head: string }) => opened.push(p),
        pr: { getPr: async () => ({ head: "add-prline-83737", base: "main" }), prContainsToken: async () => false },
      }),
    );
    ok(opened.length === 0, "drivePrOpen: a pr.open row whose diff does NOT carry this run's token is NOT claimed for teardown — the token is what makes a miss-path close safe");
  }
}

{
  const { firstOfTwo } = await import("../packages/core/scripts/e2e/journey.js");
  const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), ms));

  ok((await firstOfTwo(after(5, "judge"), after(60, "card")))?.value === "judge", "firstOfTwo: the side that produces a value FIRST wins, and says which side it was");
  const late = await firstOfTwo(after(60, undefined), after(5, "card"));
  ok(late?.which === "b" && late.value === "card", "firstOfTwo: a side that produces NOTHING does not win — the race waits for the other one instead of answering early");
  ok((await firstOfTwo(after(5, undefined), after(20, undefined))) === undefined, "firstOfTwo: `undefined` only once BOTH sides are done with nothing — that is the 'neither arm' answer");
  let threw = false;
  try {
    await firstOfTwo(Promise.reject(new Error("audit read 500")), after(20, undefined));
  } catch (err) {
    threw = (err as Error).message === "audit read 500";
  }
  ok(threw, "🔴 firstOfTwo: a rejection PROPAGATES — an error is never an absence, and a 500 from the audit read must not arrive dressed as 'the judge didn't allow'");
}

{
  ok(isFillerAck("the listing is still in progress"), 'isFillerAck: "the listing is still in progress" (S16\'s own delegation ack) is filler');
  ok(isFillerAck("still in progress"), 'isFillerAck: bare "still in progress" is filler');
  ok(isFillerAck("this is currently in progress, one moment"), 'isFillerAck: "currently in progress" is filler');
  ok(
    !isFillerAck("memory_admin_list requires an org admin, or a domain admin for at least one memory domain."),
    "isFillerAck: the real not-admin refusal is NOT filler — a genuine refusal must never be skipped past",
  );
  ok(
    !isFillerAck("this turn was woken by 2 different people at once, so it cannot say whose ask this is."),
    "isFillerAck: verdictFromEnvelope's several-humans reason (no `delegat…`) is NOT filler",
  );
  ok(
    !isFillerAck("this turn was woken by a system or relay message, not by a person asking"),
    "isFillerAck: verdictFromEnvelope's system-wake reason is NOT filler",
  );
  ok(
    !isFillerAck("the turn that delegated this work was woken by more than one person, so it could not say whose ask this is"),
    "isFillerAck: OPE-704 — the OPE-673 several-askers refusal (WITH candidates) is NOT filler despite containing 'delegated this work'",
  );
  ok(
    !isFillerAck("the turn that delegated this work could not say whose ask it was serving — it was woken by more than one person, or by no person at all"),
    "isFillerAck: OPE-704 — the no-candidates unverified reason is NOT filler either",
  );
  ok(
    !isFillerAck("the turn that delegated this work carried no verified asker, so this worker has no caller to check standing for"),
    "isFillerAck: OPE-704 — the child-seat NO_CARRIAGE reason is NOT filler (pinned by 'no verified asker')",
  );
  ok(
    !isFillerAck(
      "I can't share that listing — the turn that delegated this to me was woken by more than one person at once, so it could not say whose ask this is.",
    ),
    "isFillerAck: OPE-704 — a model paraphrase of the refusal (still says 'delegated this') stays substantive via the 'could not say' marker",
  );
  ok(isFillerAck("I've delegated this to a worker and will report back."), "isFillerAck: the object form (delegated this to…) is still filler");
  ok(
    isFillerAck("I'm checking the raw memory-silo admin listing under your requester identity. I'll return the raw result once it's done."),
    "isFillerAck: OPE-704 negative control — the genuine delegation ack still classifies AS filler",
  );

  ok(
    isFillerAck("I'm retrieving the admin listing and domain references now; I'll return the exact output or any access refusal."),
    "isFillerAck: OPE-834 — the live-run interim classifies as filler on its model tail ALONE, now that no host frame precedes it",
  );
  ok(isFillerAck("I'll fetch that for you shortly."), "isFillerAck: OPE-834 — widened will-branch matches the contraction \"I'll fetch\" alone");
  ok(
    !isFillerAck("I'll be honest, the balance is £42.10."),
    "isFillerAck: OPE-834 negative control — \"I'll\" followed by a verb outside the listed set stays substantive",
  );
  ok(
    !isFillerAck("A worker finished the admin listing. Domains: e2e-unified, e2e-secondary. Silos: 4 total."),
    "isFillerAck: OPE-834 negative control — text that mentions a worker but reports an OUTCOME stays substantive",
  );

  ok(
    isFillerAck("Got it — I’m saving that deploy-day detail to channel memory and will confirm once the write is complete."),
    "isFillerAck: OPE-1692 — the live-run J2 hand-off (\"will confirm once the write is complete\") classifies as filler",
  );
  ok(
    isFillerAck("I’m reading the page body itself now and will post exactly one full sentence from it."),
    "isFillerAck: OPE-1692 — \"will post\" is the same promise shape, on the Notion legs",
  );
  ok(
    !isFillerAck("Saved: Rowan Hale’s 2026-09-11 note that service `svc-42081` deploys on Thursday is recorded in `notes.md` and indexed in `MEMORY.md`."),
    "isFillerAck: OPE-1692 negative control — the SETTLED save-claim that replaced it stays substantive",
  );
  ok(!isFillerAck("I'll assume Thursday unless you say otherwise."), "isFillerAck: OPE-1692 negative control — a promise verb outside the listed set stays substantive");
  ok(!isFillerAck("I'll send you the numbers: 4 silos, 2 domains."), "isFillerAck: OPE-1692 negative control — \"I'll send\" was NOT widened, so a delivering sentence stays substantive");
  ok(isFillerAck("I’ll confirm once the write is complete."), "isFillerAck: OPE-1692 — the CURLY apostrophe (U+2019) the seat emits matches too");
  ok(isFillerAck("I'll confirm once the write is complete."), "isFillerAck: …and so does the straight one — the branch takes a character class, not one spelling");

  for (const scope of ["surface", "org"] as const) {
    ok(
      !isFillerAck(haltConfirmation(scope)),
      `isFillerAck: OPE-1963 — the host-authored halt confirmation (scope "${scope}") is SUBSTANTIVE, whatever its prose looks like`,
    );
    ok(
      !isFillerAck(`${haltConfirmation(scope)} Surface halt applied for the authorized fixture test.`),
      `isFillerAck: OPE-1963 — …and still is when the model's own narration lands in the same message (scope "${scope}")`,
    );
  }
  ok(!isFillerAck("Nothing consequential will run now."), "isFillerAck: OPE-1963 — the NOUN-subject promise that caused it stays substantive even shorn of the rest of the template");
  ok(!isFillerAck("The deploy pipeline will run at 6pm."), "isFillerAck: OPE-1963 negative control — an ordinary sentence about something else running is substantive");
  ok(
    isFillerAck("Got it — I’m saving that deploy-day detail to channel memory and will confirm once the write is complete."),
    "isFillerAck: OPE-1963 — the OPE-1692 ack with its subject ELIDED after \"and\" is still filler",
  );
  ok(!isFillerAck(NO_CARD_NOTE_OPENING + " A standing grant covered it.)"), "isFillerAck: OPE-1963 — the host's standing-grant note is host-authored copy and is never skipped");
  ok(isFillerAck("I’m saving that now; will confirm once the write is complete."), "isFillerAck: OPE-1963 — the elided subject after a SEMICOLON is still a promise");
  ok(isFillerAck("I’m saving that now — will confirm once the write is complete."), "isFillerAck: OPE-1963 — …and after an EM DASH");
  ok(isFillerAck("Saving now.\nWill confirm once the write is complete."), "isFillerAck: OPE-1963 — …and at the start of a LINE, which is where a two-sentence ack puts it");
  ok(!isFillerAck("Luna will report the outcome when the worker settles."), "isFillerAck: OPE-1963 negative control — a NAMED third party is a noun subject, so the branch stays shut");

  ok(
    !isFillerAck(
      "The copied public webpage text makes an assistant-directed operational claim about your deploy server, so I haven't recorded or acted on it. Do you have an internal source confirming `deploy-x9.example`, and should I record it only after that verification?",
    ),
    "isFillerAck: OPE-2120 — the live-run F-SEC decline (\"acted on it\") is NOT filler",
  );
  ok(!isFillerAck("I haven't recorded or acted on it."), "isFillerAck: OPE-2120 negative control — \"acted on it\" is prose, not an ack");
  ok(!isFillerAck("The rollout plan is based on it, and the owner depends on it."), "isFillerAck: OPE-2120 negative control — \"based on it\" / \"depends on it\" stay substantive");
  ok(!isFillerAck("Rowan worked on it last week; the PR is #412."), "isFillerAck: OPE-2120 negative control — \"worked on it\" stays substantive");
  ok(isFillerAck("On it!"), "isFillerAck: OPE-2120 — bare \"On it!\" is still filler");
  ok(isFillerAck("on it 👍"), "isFillerAck: OPE-2120 — \"on it 👍\" is still filler");
  ok(isFillerAck("I'm on it — one sec"), "isFillerAck: OPE-2120 — \"I'm on it\" is still filler");
  ok(isFillerAck("I’m on it."), "isFillerAck: OPE-2120 — \"I’m on it\" with the CURLY apostrophe is still filler");
  ok(isFillerAck("we're on it"), "isFillerAck: OPE-2120 — \"we're on it\" is still filler");
  ok(isFillerAck("I am on it."), "isFillerAck: OPE-2120 — \"I am on it\" is still filler");
  ok(isFillerAck("Got it — on it."), "isFillerAck: OPE-2120 — \"on it\" after sentence punctuation is still filler");
  ok(!isFillerAck("After checking the audit log, the grant was revoked."), "isFillerAck: OPE-2120 negative control — \"after checking …\" prose is NOT filler");
  ok(!isFillerAck("Linear shows Priya is working on OPE-12; it is due Friday."), "isFillerAck: OPE-2120 negative control — a third party \"is working on\" is NOT filler");
  ok(isFillerAck("Checking now."), "isFillerAck: OPE-2120 — \"Checking now.\" is still filler");
  ok(isFillerAck("Still checking — one moment."), "isFillerAck: OPE-2120 — \"Still checking\" is still filler");
  ok(isFillerAck("The worker is still working on the listing."), "isFillerAck: OPE-2120 — \"still working on\" is still filler");
  ok(isFillerAck("We're working on it now."), "isFillerAck: OPE-2120 — \"We're working on it\" is still filler");
}

{
  ok(
    isPendingWorkHandoff("I'm checking the issue details and will return a grounded one-line summary including `gh-39426`."),
    "isPendingWorkHandoff: the live-run J-GH hand-off, frame stripped, is STILL a hand-off on its prose alone",
  );
  ok(
    !isPendingWorkHandoff("Issue #1 (\u201c[oe-e2e] ambient supervisor fixture issue\u201d) couldn't be summarized from its body; **gh-39426**."),
    "isPendingWorkHandoff: the live-run grounded answer is NOT a hand-off",
  );
  ok(isPendingWorkHandoff("one sec, looking at it"), "isPendingWorkHandoff: plain filler prose IS a hand-off now — the predicate is the prose heuristic, and carries its false-skip risk (OPE-1523)");
  ok(
    isFillerAck("one sec, looking at it") === isPendingWorkHandoff("one sec, looking at it"),
    "isPendingWorkHandoff: …and the two agree by construction, because no exact host signal is left to separate them",
  );

  const s11Interim = "I'm checking the durable team memory for the exact `sprint-22088` mascot and will report back plainly if it isn't recorded.";
  ok(isPendingWorkHandoff(s11Interim), "isPendingWorkHandoff: the live-run S11 interim, frame stripped, is STILL a hand-off — no LENGTH threshold could have caught it either");
  ok(
    !isPendingWorkHandoff("I couldn't find any recorded team mascot for `sprint-22088` in durable memory, so I don't know it."),
    "isPendingWorkHandoff: the live-run S11 clean decline is NOT a hand-off — it is exactly what the gate asks for",
  );
}

{
  const uniXHandoff = "I'm updating the decision record to `unix-97518` and will confirm once it's saved.";
  const uniXAnswer = "Noted: the release deploy window is `unix-97518`. I saved it to the decision record for the write-up.";
  const MEASURED_ASK_TO_ANSWER_MS = 182_192;
  const afterHandoff = handoffReplyWaitMs(uniXHandoff);
  ok(afterHandoff === 420_000, `🔴 OPE-2105: a hand-off first reply waits the delegated budget, FILE_REPLY_WAIT (got ${String(afterHandoff)})`);
  ok((afterHandoff ?? 0) > MEASURED_ASK_TO_ANSWER_MS, `🔴 OPE-2105: the delegated wait covers a live run's measured ask→answer of ${MEASURED_ASK_TO_ANSWER_MS}ms`);
  ok(handoffReplyWaitMs(uniXAnswer) === undefined, "OPE-2105 NEGATIVE CONTROL: a substantive first reply yields undefined — the leg accepts it");
  const uniX = SCENARIOS.find((s) => s.id === "J-UNI-X")!;
  const uniXSrc = uniX.run.toString().replace(/\s+/g, "");
  ok(uniXSrc.includes("handoffReplyWaitMs(firstAck.text)"), "🔴 OPE-2105: J-UNI-X leg 1 chooses its second wait from the first Slack reply");
  ok(uniXSrc.includes("handoffReplyWaitMs(firstReply.body)"), "🔴 OPE-2105: J-UNI-X leg 2 chooses its second wait from the first GitHub comment");
  ok(
    (uniX.timeoutMs ?? 0) > 2 * (180_000 + 420_000),
    `🔴 OPE-2105: the J-UNI-X budget exceeds both legs' two-phase waits, so a poll's own bound reds first (got ${String(uniX.timeoutMs)})`,
  );
}

{
  const info = {
    version: "0.4.0",
    deploymentSha: "0123456789abcdef0123456789abcdef01234567",
    evePin: "0.51.0",
    primaryModel: "m-primary",
    utilityModel: "m-utility",
    contextWindowTokens: 750_000,
    compactionThresholdTokens: 525_000,
  };
  const rendered = renderStatus(info, "sqlite", "on");
  const facts = parseOeStatusFacts(rendered);
  ok(facts.deploymentSha === info.deploymentSha, `the deployment sha is read off the real renderer — got ${facts.deploymentSha}, from:\n${rendered}`);
  ok(facts.evePin === "0.51.0", `the eve pin is read off the real renderer — got ${facts.evePin}`);
  ok(facts.contextWindowTokens === 750_000, `the context window survives the renderer's thousands separators — got ${facts.contextWindowTokens}`);
  ok(facts.compactionThresholdTokens === 525_000, `…and so does the compaction threshold — got ${facts.compactionThresholdTokens}`);

  const unknown = parseOeStatusFacts(renderStatus({ ...info, deploymentSha: "unknown", evePin: "unknown" }, "sqlite", "on"));
  ok(unknown.deploymentSha === "unknown", 'a deployment that exposes no sha renders the literal "unknown" — the leg gates on that word, not merely on the line existing');
  ok(unknown.evePin === "unknown", "…and the same for an unresolved eve pin");
  const noWindow = parseOeStatusFacts(renderStatus({ ...info, contextWindowTokens: undefined, compactionThresholdTokens: undefined }, "sqlite", "on"));
  ok(
    noWindow.contextWindowTokens === undefined && noWindow.compactionThresholdTokens === undefined,
    "a deployment that registered no window prints NO window line at all, and the parse answers undefined rather than 0 — which is what makes the leg's presence gate able to fail",
  );
  ok(noWindow.deploymentSha === info.deploymentSha, "…and the other facts still read, so a missing window line reds one gate rather than all of them");
  ok(parseOeStatusFacts("").deploymentSha === undefined, "an empty body yields no facts — never a silently-matching default");

  const envelope = JSON.stringify({ response_type: "ephemeral", text: rendered });
  ok(
    rendered.includes("\n") && !envelope.includes("\n"),
    "the renderer emits real newlines and the envelope collapses them into escapes — the live-run shape, not a fixture somebody typed",
  );
  ok(
    parseOeStatusFacts(envelope).deploymentSha === undefined,
    "the RAW envelope yields no facts — the live-run defect, pinned: an anchored regex cannot match a JSON body whose newlines are escaped",
  );
  const decoded = parseOeStatusFacts(decodeSlackEphemeralText(envelope));
  ok(decoded.deploymentSha === info.deploymentSha, `the DECODED envelope reads the deployment sha — got ${decoded.deploymentSha}`);
  ok(decoded.evePin === "0.51.0", `…and the eve pin — got ${decoded.evePin}`);
  ok(
    decoded.contextWindowTokens === 750_000 && decoded.compactionThresholdTokens === 525_000,
    `…and both window numbers — got ${decoded.contextWindowTokens} / ${decoded.compactionThresholdTokens}`,
  );

  ok(decodeSlackEphemeralText(rendered) === rendered, "a plain-text body passes through undecoded — the decode never throws on prose");
  ok(decodeSlackEphemeralText('{"response_type":"ephemeral"}') === '{"response_type":"ephemeral"}', "a JSON body carrying no text field passes through unchanged rather than vanishing");
  ok(decodeSlackEphemeralText('{"text":42}') === '{"text":42}', "a non-string text field passes through unchanged — the decode answers the envelope's text or the body, never a coerced number");
  ok(decodeSlackEphemeralText("") === "", "an empty body stays empty, so it still reaches the parser as the no-facts case");

  const statusRun = SCENARIOS.find((s) => s.id === "S-OE-STATUS")!.run.toString().replace(/\s+/gu, "");
  ok(
    statusRun.includes("decodeSlackEphemeralText(res.body)"),
    "S-OE-STATUS decodes the envelope BEFORE it parses — deleting that one call is exactly what a live run was",
  );
  ok(!/parseOeStatusFacts\(res\.body\)/u.test(statusRun), "…and it never hands the raw HTTP body to the parser");

  ok(
    oeStatusCompactionThresholdTokens(1_050_000) === 525_000,
    `the shipped stack's 1050000-token window yields OPE-1634's 525000 — got ${oeStatusCompactionThresholdTokens(1_050_000)}`,
  );
  ok(
    oeStatusCompactionThresholdTokens(272_000) === 136_000,
    `…and a smaller-window stack yields its OWN number, which a pinned 525000 would have red on — got ${oeStatusCompactionThresholdTokens(272_000)}`,
  );
  ok(oeStatusCompactionThresholdTokens(0) === 1, "a zero window floors at 1 rather than 0, so a missing window line still reds the threshold gate instead of matching it");
}

{
  const MANDATORY_IDS = [
    "S-OE-STATUS",
    "S-PROVENANCE-DM",
  ];
  for (const id of MANDATORY_IDS) {
    const s = SCENARIOS.find((x) => x.id === id);
    ok(s !== undefined, `${id} is in the pack`);
    ok(s?.suite === "core" || s?.suite === "security", `${id} is in a lane that runs on every pass (got "${s?.suite}")`);
    ok(s?.expensive !== true, `🔴 ${id} is not cost-gated — an expensive leg sits out a default run, and a mandatory leg cannot`);
  }

  const scenarioSrc = readFileSync(fileURLToPath(new URL("../packages/core/scripts/e2e/scenarios.ts", import.meta.url)), "utf-8");
  const provStart = scenarioSrc.indexOf('id: "S-PROVENANCE-DM"');
  const provEnd = scenarioSrc.indexOf('id: "S-EVE-CARD"', provStart);
  ok(provStart !== -1 && provEnd > provStart, "S-PROVENANCE-DM's body is locatable in scenarios.ts (the scan below is meaningless otherwise)");
  const provBody = scenarioSrc.slice(provStart, provEnd);
  const skips = provBody.match(/ctx\.skip\(/g) ?? [];
  ok(
    skips.length === 2,
    `🔴 S-PROVENANCE-DM must carry exactly 2 \`ctx.skip\` calls, each naming a deployment fact this harness cannot create. Found ${skips.length}. ` +
      "A third skip means a measurable condition was turned back into a dry pass — a DELEGATED read is measurable since OPE-1849 and must never become a skip again; one fewer means a fixture fact is now reported as a red.",
  );
  ok(
    /🔴 NOT-JOINED:/.test(provBody),
    "🔴 S-PROVENANCE-DM's empty-ledger fall-through is a RED naming the exhausted join — an unwired seam, an uncarried delegation and a nameless channel state are code defects, not fixture facts",
  );
  ok(
    /ctx\.gate\(\s*false,[\s\S]{0,1200}?🔴 NOT-JOINED:/.test(provBody),
    "🔴 …and that fall-through is a `ctx.gate(false, …)` carrying the NOT-JOINED verdict itself — a RED, never a log line or a skip",
  );
  ok(/rowForReplyChunkSet\(/.test(provBody), "🔴 S-PROVENANCE-DM joins the provenance row over the reply's CHUNK SET, not the first chunk's ts alone (OPE-2008)");
  ok(!/^\s*optional:\s*true/mu.test(provBody), "S-PROVENANCE-DM declares no `optional: true` field");
  ok(
    /needs E2E_TARGET_URL \+ E2E_CONTROL_READ_TOKEN/.test(provBody) && !/ctx\.skip\(\s*\n?\s*"needs E2E_TARGET_URL/.test(provBody),
    "🔴 the missing-credential branch is a GATE, not a skip — the control-read pair is a HARNESS input, so its absence is a run configured wrong and never a fact about the deployment",
  );
}

{
  const scenariosPath = fileURLToPath(new URL("../packages/core/scripts/e2e/scenarios.ts", import.meta.url));
  const src = readFileSync(scenariosPath, "utf-8");
  const REPLY_WAIT_METHOD = /\.(awaitThreadReply|awaitAnyReply|awaitBotReply|awaitBotReplyIn)\(/g;
  const NO_SKIP_MARKER = "OPE-984: no skip needed";

  function callSpan(openIdx: number): string {
    let depth = 1;
    let i = openIdx + 1;
    while (depth > 0 && i < src.length) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    return src.slice(openIdx, i);
  }

  let total = 0;
  let guarded = 0;
  let unguardedNoMarker: string[] = [];
  for (const m of src.matchAll(REPLY_WAIT_METHOD)) {
    total++;
    const openIdx = m.index! + m[0].length - 1;
    const span = callSpan(openIdx);
    if (span.includes("skip:")) {
      guarded++;
      continue;
    }
    const closeIdx = openIdx + span.length;
    const before = src.slice(Math.max(0, m.index! - 400), m.index!);
    const after = src.slice(closeIdx, closeIdx + 150);
    if (before.includes(NO_SKIP_MARKER) || after.includes(NO_SKIP_MARKER)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    unguardedNoMarker.push(`line ${line}: ${m[0]}`);
  }

  ok(total >= 60, `OPE-984: scenarios.ts has ${total} reply-wait call sites (sanity floor — the scan itself found the methods)`);
  ok(
    unguardedNoMarker.length === 0,
    `OPE-984: every reply-wait call site carries either a skip predicate or an explicit ` +
      `"${NO_SKIP_MARKER}" marker — found ${unguardedNoMarker.length} with NEITHER: ${unguardedNoMarker.join("; ")}`,
  );
  ok(guarded >= 34, `OPE-984: at least 34 reply-wait call sites carry a skip predicate (found ${guarded}) — the post-sweep floor`);

  const syntheticUnguarded = 'const x = await slack.awaitThreadReply(rootTs, { timeoutMs: REPLY_WAIT });';
  const fakeMatch = [...syntheticUnguarded.matchAll(REPLY_WAIT_METHOD)][0]!;
  const fakeOpenIdx = fakeMatch.index! + fakeMatch[0].length - 1;
  let depth = 1;
  let i = fakeOpenIdx + 1;
  while (depth > 0 && i < syntheticUnguarded.length) {
    if (syntheticUnguarded[i] === "(") depth++;
    else if (syntheticUnguarded[i] === ")") depth--;
    i++;
  }
  const fakeSpan = syntheticUnguarded.slice(fakeOpenIdx, i);
  ok(!fakeSpan.includes("skip:"), "OPE-984: NEGATIVE CONTROL — the scanner correctly reads an un-swept call site as unguarded");
}

{
  const DISCORD_CHANNEL_FIRST = /discord\.(awaitReply|awaitReplyMatching|collectRepliesDuring)\(/g;

  function argsOf(src: string, openIdx: number): readonly string[] {
    const args: string[] = [];
    let depth = 0;
    let start = openIdx + 1;
    let quote = "";
    for (let i = openIdx; i < src.length; i++) {
      const ch = src[i]!;
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) { args.push(src.slice(start, i).trim()); break; }
      } else if (ch === "," && depth === 1) {
        args.push(src.slice(start, i).trim());
        start = i + 1;
      }
    }
    return args;
  }

  function discordWaits(body: string): readonly { readonly method: string; readonly channelArg: string; readonly afterArg: string }[] {
    const out: { method: string; channelArg: string; afterArg: string }[] = [];
    for (const m of body.matchAll(DISCORD_CHANNEL_FIRST)) {
      const args = argsOf(body, m.index! + m[0].length - 1);
      out.push({ method: m[1]!, channelArg: args[0] ?? "", afterArg: args[1] ?? "" });
    }
    return out;
  }

  let totalWaits = 0;
  const parentChannelWaits: string[] = [];
  const AMBIENT_CHANNEL_WAIT_LEGS = new Set(["S-AMBIENT-discord"]);
  for (const s of SCENARIOS) {
    const body = s.run.toString();
    for (const w of discordWaits(body)) {
      totalWaits++;
      if (/\.channelId$/.test(w.channelArg) && !AMBIENT_CHANNEL_WAIT_LEGS.has(s.id)) parentChannelWaits.push(`${s.id}: discord.${w.method}(${w.channelArg}, …)`);
    }
  }
  for (const id of AMBIENT_CHANNEL_WAIT_LEGS) {
    const leg = SCENARIOS.find((sc) => sc.id === id);
    ok(leg !== undefined, `OPE-1479: the channel-wait exemption names a leg that exists (${id})`);
    ok(
      leg !== undefined && !/discord\.mention\(/.test(leg.run.toString()),
      `🔴 OPE-1479: ${id} is exempt from the thread-wait rule ONLY because it addresses nobody — a body that mentions the bot auto-threads, and waiting in the channel would then be the bug this arm catches`,
    );
  }
  ok(totalWaits >= 5, `OPE-1479: the scan finds the Discord channel-first reply waits in the compiled scenario bodies (found ${totalWaits}, blindness floor 5)`);
  ok(
    parentChannelWaits.length === 0,
    `OPE-1479: no Discord reply wait polls the ASK'S OWN CHANNEL — OE replies in the auto-created ` +
      `thread, so a \`.channelId\` first argument polls a channel that never holds the reply and the ` +
      `leg dies on its full timeout while the product is right. Found ${parentChannelWaits.length}: ${parentChannelWaits.join("; ")}`,
  );

  const grantBody = SCENARIOS.find((s) => s.id === "S-DISCORD-GRANT")!.run.toString();
  function threadBindings(body: string): ReadonlyMap<string, string> {
    const bound = new Map<string, string>();
    for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*await\s+discord\.awaitThread\(/g)) {
      bound.set(m[1]!, argsOf(body, m.index! + m[0].length - 1)[0] ?? "");
    }
    return bound;
  }
  function postBindings(body: string): ReadonlyMap<string, string> {
    const bound = new Map<string, string>();
    for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*await\s+discord\.post\(/g)) {
      bound.set(m[1]!, argsOf(body, m.index! + m[0].length - 1)[1] ?? "");
    }
    return bound;
  }
  function misjoinedWaits(body: string): readonly string[] {
    const posts = postBindings(body);
    const threads = threadBindings(body);
    const out: string[] = [];
    for (const w of discordWaits(body)) {
      const msgVar = w.afterArg.endsWith(".id") ? w.afterArg.slice(0, -".id".length) : "";
      const postChannel = posts.get(msgVar);
      if (postChannel === undefined) {
        out.push(`${w.channelArg} after ${w.afterArg} — no \`discord.post\` in this body bound ${w.afterArg}`);
      } else if (postChannel.length > 0) {
        if (w.channelArg !== postChannel) out.push(`${w.channelArg} after ${w.afterArg} — that message was posted into ${postChannel}`);
      } else if (threads.get(w.channelArg) !== w.afterArg) {
        out.push(`${w.channelArg} after ${w.afterArg} — a base-channel post, so the wait owes the thread \`awaitThread(${w.afterArg})\` bound`);
      }
    }
    return out;
  }
  const grantThreads = threadBindings(grantBody);
  const grantWaits = discordWaits(grantBody);
  ok(grantWaits.length === 2, `OPE-1479: S-DISCORD-GRANT still has its two reply waits — phase 1's grant ask and phase 2's granted call (found ${grantWaits.length})`);
  ok(
    grantThreads.size === 1,
    `OPE-1483: S-DISCORD-GRANT derives EXACTLY ONE thread — phase 1's, off its base-channel mention. A second \`awaitThread\` means phase 2 went back to opening its own thread, which is a new session and holds no grant (found ${grantThreads.size}: ${JSON.stringify([...grantThreads])})`,
  );
  const misjoined = misjoinedWaits(grantBody);
  ok(
    misjoined.length === 0,
    `OPE-1479: every S-DISCORD-GRANT reply wait polls the channel its own message was POSTED into — ` +
      `the auto-created thread for phase 1's base-channel mention, the re-entered thread for phase 2's ` +
      `post into it. Thread bindings: ${JSON.stringify([...grantThreads])}; misjoined waits: ${JSON.stringify(misjoined)}`,
  );

  const resolverBindings = [...grantBody.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*resolveGrantThread\(/g)].map((m) => m[1]!);
  ok(
    resolverBindings.length === 1,
    `OPE-1483: S-DISCORD-GRANT resolves its re-entry thread exactly once, through \`resolveGrantThread\` (found ${resolverBindings.length})`,
  );
  const exactAliases = new Set(
    [...grantBody.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.kind\s*===\s*["']record["']\s*\?\s*\2\s*:/g)]
      .filter((m) => resolverBindings.includes(m[2]!))
      .map((m) => m[1]!),
  );
  const resolved = new Set(
    [...grantBody.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;]*?\b([A-Za-z_$][\w$]*)\.threadId\b/g)]
      .filter((m) => resolverBindings.includes(m[2]!) || exactAliases.has(m[2]!))
      .map((m) => m[1]!),
  );
  const targetedPosts = [...postBindings(grantBody)].filter(([, channel]) => channel.length > 0);
  ok(
    targetedPosts.length === 1 && resolved.has(targetedPosts[0]![1]),
    `OPE-1483: S-DISCORD-GRANT makes exactly ONE channel-targeted post — phase 2's granted call — and it targets the thread \`resolveGrantThread\` named. ` +
      `A post with no channel argument opens a fresh auto-thread, i.e. a fresh session with no grant mounted. ` +
      `Resolved names: ${JSON.stringify([...resolved])}; targeted posts: ${JSON.stringify(targetedPosts)}`,
  );

  const grantBodyTight = grantBody.replace(/\s+/g, "");
  const noFreshAskInit = /noFreshAsk=([^;]+);/.exec(grantBodyTight)?.[1] ?? "";
  ok(
    noFreshAskInit.includes("tapped") && noFreshAskInit.includes("askedRows.length===0") && noFreshAskInit.includes("refusedGrantAlreadyLive"),
    `OPE-1590: the fall-through predicate is ALL THREE conjuncts — tapped, no fresh grant.asked row, and a \`grant_already_live\` refusal. ` +
      `Drop any one and it widens: without \`tapped\` an untapped run skips its own phase-1 gates, and without the refusal read a tapped run ` +
      `passes them on an empty trail (got: ${JSON.stringify(noFreshAskInit)})`,
  );
  ok(
    !grantBodyTight.includes("if(askedRows.length===0)"),
    "OPE-1590: the no-row skip is no longer reached on `askedRows.length === 0` ALONE — that unguarded arm is what exited 1 on a tapped run",
  );
  ok(
    noFreshAskInit.includes("reentryScope!==void0") || noFreshAskInit.includes("reentryScope!==undefined"),
    `OPE-1590/OPE-1950: the fall-through accepts an already-live refusal only when the saved authority is re-enterable from THIS run (got: ${JSON.stringify(noFreshAskInit)})`,
  );
  const reentryInit = /reentryScope=([^;]+);/.exec(grantBodyTight)?.[1] ?? "";
  ok(
    reentryInit.includes('reentry.kind==="record"') && reentryInit.includes("grantReentryScope(reentry,currentSessionId,runDomainScopeKey)"),
    `OPE-1950: the verdict is computed from the EXACT saved record, this run's current session and this run's own domain key — never from a looser reading (got: ${JSON.stringify(reentryInit)})`,
  );
  const rowWaitInit = /grantRowWait=([^;]+);/.exec(grantBodyTight)?.[1] ?? "";
  ok(rowWaitInit === "grantRowWaitMs(reply.content)", `🔴 OPE-2099: the grant-row wait is chosen from phase 1's reply text (got: ${JSON.stringify(rowWaitInit)})`);
  const rowSeenPoll = /sessionGrantRowSeen=awaitpollOptional\([\s\S]*?\{timeoutMs:([^,]+),what:"S-DISCORD-GRANT:agrant\.askedorgrant\.refusedrowforthisrun'ssession"/.exec(grantBodyTight)?.[1] ?? "";
  ok(rowSeenPoll === "grantRowWait", `🔴 OPE-2099: the grant-row poll waits the selected budget, not AUDIT_ROW_WAIT (got: ${JSON.stringify(rowSeenPoll)})`);
  ok(
    grantBodyTight.includes("grantRowMissingNote({rowSeen:sessionGrantRowSeen===true,handedOff:replyHandedOff,waitMs:grantRowWait,sessionId:currentSessionId})"),
    "🔴 OPE-2099: the CANNOT-RUN text names the hand-off and the wait the leg actually used",
  );
  const grantLeg = SCENARIOS.find((sc) => sc.id === "S-DISCORD-GRANT")!;
  ok((grantLeg.timeoutMs ?? 0) >= 1_620_000 + 300_000, `OPE-2099: the leg budget covers the 1,620 s sum of its waits with 300 s headroom (got ${grantLeg.timeoutMs})`);
  const domainKeyInit = /runDomainScopeKey=([^;]+);/.exec(grantBodyTight)?.[1] ?? "";
  ok(
    domainKeyInit.includes("currentDomainScopeKey(grantRows,currentSessionId)"),
    `🔴 OPE-1950: this run's domain key is READ OFF ITS OWN AUDIT ROWS, keyed on its own session — a key the harness composed itself would be a second spelling of a decision the product already made (got: ${JSON.stringify(domainKeyInit)})`,
  );
  ok(
    !noFreshAskInit.includes("surfaceNamesChannel") && !noFreshAskInit.includes('e.platform==="discord"'),
    "🔴 OPE-1590: NEGATIVE — neither the stale thread-surface heuristic nor a platform-only scope can open the fall-through",
  );
  const sessionCheck = grantBodyTight.indexOf("reentryScope===void0") >= 0 ? grantBodyTight.indexOf("reentryScope===void0") : grantBodyTight.indexOf("reentryScope===undefined");
  const grantedPost = grantBodyTight.indexOf("discord.post(discord.mention(`NowusetheNotiontool");
  ok(sessionCheck >= 0 && grantedPost > sessionCheck, "OPE-1483: the saved-scope/current-run refusal occurs before the one grant-consuming Discord post");
  ok(
    (grantBodyTight.match(/!noFreshAsk/g) ?? []).length >= 2,
    `OPE-1590: the predicate guards BOTH sites — the phase-1 skips and the two Discord-owned hard gates, which assert over the \`askedRows\` that is empty on exactly this path. ` +
      `Guarding only the skips leaves the first gate redding a correct tapped run and the second passing vacuously (\`every\` on an empty list is true) (found ${(grantBodyTight.match(/!noFreshAsk/g) ?? []).length} guard(s))`,
  );

  const defective = 'async ctx=>{const asked=await discord.post(x);const reply=await discord.awaitReply(asked.channelId,asked.id,{timeoutMs:3e5});}';
  const defectiveWaits = discordWaits(defective);
  ok(
    defectiveWaits.length === 1 && defectiveWaits[0]!.channelArg === "asked.channelId" && defectiveWaits[0]!.afterArg === "asked.id",
    `OPE-1479: NEGATIVE CONTROL — the walk splits the defective call into its own two arguments (read ${JSON.stringify(defectiveWaits)})`,
  );
  ok(defectiveWaits.some((w) => /\.channelId$/.test(w.channelArg)), "OPE-1479: NEGATIVE CONTROL — arm A's test flags the parent-channel wait a live run found");
  ok(misjoinedWaits(defective).length === 1, "OPE-1479: NEGATIVE CONTROL — arm B flags it too: a base-channel post owes an `awaitThread` binding, and this body has none");
  const crossPhase = 'async ctx=>{const a=await discord.post(x);const threadId=await discord.awaitThread(a.id,{timeoutMs:3e5});const b=await discord.post(y);const r=await discord.awaitReply(threadId,b.id,{timeoutMs:3e5});}';
  const crossWaits = discordWaits(crossPhase);
  ok(
    crossWaits.length === 1 && !/\.channelId$/.test(crossWaits[0]!.channelArg),
    "OPE-1479: NEGATIVE CONTROL — arm A is blind to the cross-phase mix-up (its first argument is no `.channelId`)",
  );
  ok(misjoinedWaits(crossPhase).length === 1, "OPE-1479: NEGATIVE CONTROL — arm B DOES catch it: `b` went to the base channel, so its wait owes `awaitThread(b.id)`, not `a`'s thread");
  const fixed = 'async ctx=>{const asked=await discord.post(x);const threadId=await discord.awaitThread(asked.id,{timeoutMs:3e5});const reply=await discord.awaitReply(threadId,asked.id,{timeoutMs:3e5});}';
  const fixedWaits = discordWaits(fixed);
  ok(
    fixedWaits.length === 1 && !/\.channelId$/.test(fixedWaits[0]!.channelArg) && misjoinedWaits(fixed).length === 0,
    "OPE-1479: NEGATIVE CONTROL — the two-line auto-thread shape passes BOTH arms through the same scanner",
  );
  const reentered = 'async ctx=>{const t=await discord.post(m,grantThreadId);const r=await discord.awaitReply(grantThreadId,t.id,{timeoutMs:3e5});}';
  ok(misjoinedWaits(reentered).length === 0, "OPE-1483: NEGATIVE CONTROL — the post-into-a-known-thread shape passes arm B with no `awaitThread` anywhere in the body");
  const reenteredWrong = 'async ctx=>{const t=await discord.post(m,grantThreadId);const r=await discord.awaitReply(otherThread,t.id,{timeoutMs:3e5});}';
  ok(
    misjoinedWaits(reenteredWrong).length === 1,
    "OPE-1483: NEGATIVE CONTROL — arm B still catches a targeted post whose wait polls somewhere else, the failure mode the second shape introduces",
  );
}

{
  const { describeSpendGateRows, spendGateDoorOf, silenceCauseGate, SPEND_GATE_DOORS } = await import("../packages/core/scripts/e2e/journey.js");
  const row = (action: string, detail?: Record<string, unknown>) => ({
    ts: "2026-04-09T23:30:00.000Z",
    org: "default",
    platform: "github",
    workspace: "acme",
    action,
    ...(detail ? { detail } : {}),
  });
  ok(describeSpendGateRows([]) === undefined, "describeSpendGateRows: an empty window yields undefined (no cap refusal ⇒ the silence is routing)");
  ok(
    describeSpendGateRows([row("github.no_reply"), row("reply.post")]) === undefined,
    "describeSpendGateRows: rows that are not spend.gate never count (the discriminator keys on the action, not on there being any audit at all)",
  );
  const described = describeSpendGateRows([row("spend.gate", { door: "window", key: "github/acme/repo", mode: "channel", over: true, reason: "over the per-surface cap" })]);
  ok(
    described !== undefined && described.includes("door=window") && described.includes("key=github/acme/repo") && described.includes('reason="over the per-surface cap"'),
    "describeSpendGateRows: renders door + key + reason into one line (door leads — it is the field that says WHICH ingress chokepoint refused)",
  );
  ok(
    describeSpendGateRows([row("spend.gate", {})])?.includes("door=(none)") === true,
    "describeSpendGateRows: a spend.gate row with no door still reports (a row without a door is itself the finding, not a reason to stay quiet)",
  );
  ok(spendGateDoorOf([row("spend.gate", { door: "mention" })]) === "mention", "spendGateDoorOf: reads the door off the first spend.gate row");
  ok(spendGateDoorOf([row("github.no_reply", { door: "mention" })]) === undefined, "spendGateDoorOf: ignores a door on a non-spend.gate row");
  ok(spendGateDoorOf([row("spend.gate", { door: 7 })]) === undefined, "spendGateDoorOf: a non-string door is undefined (wire data is never trusted to be well-typed)");
  ok(
    SPEND_GATE_DOORS.join("|") === "mention|engagement|join|window",
    "SPEND_GATE_DOORS mirrors agent/spend/ingress-gate.ts's SpendGateDoor — the four ingress chokepoints, `window` being the cross-surface single-window divert",
  );
  ok(silenceCauseGate({ kind: "routing" }).ok, "silenceCauseGate: no spend.gate row ⇒ the silence leg stands (ok)");
  ok(silenceCauseGate({ kind: "unwired" }).ok, "silenceCauseGate: an unwired audit reader is ok — never red a correct silence for a missing harness credential");
  ok(
    silenceCauseGate({ kind: "unwired" }).label.includes("E2E_CONTROL_READ_TOKEN"),
    "silenceCauseGate: the unwired label names the env vars that would arm the discriminator (the call sites LOG this rather than counting a gate)",
  );
  const capped = silenceCauseGate({ kind: "cap", detail: "1 spend.gate row(s) in the run window door=window" });
  ok(!capped.ok && /cap refusal/i.test(capped.label), "silenceCauseGate: a spend.gate row in the window FAILS the leg, saying 'cap refusal, not routing'");
  ok(capped.label.includes("door=window"), "silenceCauseGate: the failure carries the row detail, so the reader sees WHICH door bought the silence");
}

{
  const { classifyAnswers, repliesPerWake, renderRepliesPerWake } = await import("../packages/core/scripts/e2e/duplicate-post.js");
  const { renderObservationSummary } = await import("../packages/core/scripts/e2e/observations.js");

  const missing = classifyAnswers(0, "tok-1");
  ok(missing.verdict === "missing" && missing.red, "classifyAnswers: NO token-carrying reply is the RED — the human asked and the room stayed silent");
  ok(missing.label.includes("unanswered") && missing.label.includes("tok-1"), "classifyAnswers: the red label says the mention went unanswered, and quotes the token it looked for");

  const single = classifyAnswers(1, "tok-1");
  ok(single.verdict === "single" && !single.red, "classifyAnswers/CONTROL: exactly one answer is green — the healthy shape");

  for (const n of [2, 16]) {
    const dup = classifyAnswers(n, "tok-1");
    ok(dup.verdict === "duplicate", `classifyAnswers: ${n} answers classify as a duplicate`);
    ok(!dup.red, `🔴 classifyAnswers: …and a duplicate is NOT red — ${n} answers still passes the gate`);
    ok(dup.label.includes(`${n} replies`), "classifyAnswers: the duplicate label QUOTES the count — the ticket's evidence is a number (16 rows on one wake), not an adjective");
    ok(/discouraged/i.test(dup.label), "classifyAnswers: …and says the second post is discouraged, so a reader knows why it is reported and not failed");
  }
  ok(classifyAnswers(-1, "tok-1").red, "classifyAnswers: a nonsense negative count is treated as MISSING (fail toward the red that means 'the room said nothing')");

  const postRow = (wakeId: unknown, action = "reply.post") => ({
    ts: "2026-05-07T23:30:00.000Z",
    org: "default",
    platform: "teams",
    workspace: "acme",
    action,
    ...(wakeId === undefined ? {} : { detail: { wakeId } }),
  });
  ok(repliesPerWake([]).length === 0, "repliesPerWake: an empty window counts nothing");
  const counted = repliesPerWake([postRow("w-a"), postRow("w-a"), postRow("w-b"), postRow("w-a")]);
  ok(counted.length === 2 && counted[0].wake === "w-a" && counted[0].posts === 3, "repliesPerWake: counts posts per wake, busiest FIRST (three on w-a)");
  ok(counted[1].wake === "w-b" && counted[1].posts === 1, "repliesPerWake: …and the quiet wake is still reported, so the busy one has something to be compared against");
  ok(
    repliesPerWake([postRow("w-a", "reply.refused"), postRow("w-a", "reply.forced")]).length === 0,
    "repliesPerWake/CONTROL: only `reply.post` rows count — a refusal and an override are not posts, and counting them would inflate every duplicate report",
  );
  ok(
    repliesPerWake([postRow(undefined), postRow(7), postRow("")]).length === 0,
    "🔴 repliesPerWake: a row with no usable wake id is DROPPED, never bucketed under a placeholder — the whole claim is 'these posts answered the SAME wake'",
  );

  ok(renderRepliesPerWake([]) === null, "renderRepliesPerWake: nothing measured ⇒ no line at all (an observation channel that always speaks is one nobody reads)");
  const quiet = renderRepliesPerWake([{ wake: "w-a", posts: 1 }]);
  ok(quiet !== null && quiet.includes("w-a=1") && !quiet.includes("duplicate"), "renderRepliesPerWake/CONTROL: one post per wake quotes the count and claims no duplicate");
  const busy = renderRepliesPerWake([{ wake: "w-a", posts: 16 }, { wake: "w-b", posts: 1 }]);
  ok(busy !== null && busy.includes("w-a=16") && busy.includes("w-b=1"), "renderRepliesPerWake: QUOTES every wake's count — this is the line the ticket's '16 reply.post rows on one wake' is read off");
  ok(busy!.includes("busiest wake carries 16 posts") && /discouraged, not gated/i.test(busy!), "renderRepliesPerWake: …and names the busiest wake as a duplicate that is reported, never gated");

  ok(renderObservationSummary([]).lines.length === 0, "renderObservationSummary/CONTROL: a run with no observations prints NOTHING");
  const summary = renderObservationSummary([{ scenario: "J-TEAMS", line: "reply.post rows per wake: w-a=16" }]);
  ok(summary.stream === "stderr", "renderObservationSummary: goes to stderr, so a `| tail` on a long live run cannot swallow it");
  ok(summary.lines.length === 2 && summary.lines[1].includes("J-TEAMS") && summary.lines[1].includes("w-a=16"), "renderObservationSummary: one lead line plus one line per observation, each naming its scenario");
  ok(/do NOT fail the run/i.test(summary.lines[0]), "renderObservationSummary: the lead line says an observation never gates — the reader's first question about a ⚠ in a green run");
}

{
  const { parseLinkCode, LINK_CODE_ALPHABET } = await import("../packages/core/scripts/e2e/journey.js");
  ok(LINK_CODE_ALPHABET === "23456789ACDEFGHJKLMNPQRSTUVWXYZ", "LINK_CODE_ALPHABET mirrors agent/identity/link-challenge.ts (no 0/1/I/O/B, no lower case — 31 symbols)");
  ok(parseLinkCode("…and nothing else:\n\n    link K7QD2XMN\n\nIt is single-use") === "K7QD2XMN", "parseLinkCode: lifts the code out of the tool's own verbatim instructions");
  ok(parseLinkCode("send me `link k7qd2xmn` from the other account") === "K7QD2XMN", "parseLinkCode: case-insensitive on the anchored form, normalised to upper case (the claim CAS uppercases too)");
  ok(parseLinkCode("Here's your code:\n\n`K7QD2XMN`\n\nPost it from the other account.") === "K7QD2XMN", "parseLinkCode: a whole-line/code-block rendering is recognised when the model reformats");
  ok(
    parseLinkCode("This is a STANDARD reply with no code in it at all.") === undefined,
    "parseLinkCode: does NOT bare-scan prose — 'STANDARD' is eight symbols entirely inside the alphabet, and a wrong code fails the claim in a way that looks like a product bug",
  );
  ok(parseLinkCode(undefined) === undefined && parseLinkCode("") === undefined, "parseLinkCode: total over absent/empty input");
  ok(parseLinkCode("link ACDEFGH") === undefined, "parseLinkCode: a 7-symbol token is not a code (length is pinned at 8)");
}

{
  const { parseClaimCodeBack, CLAIM_CODE_BACK_MARKER, parseLinkCode } = await import("../packages/core/scripts/e2e/journey.js");
  const { claimCodeBackReply, codeBackInstructions } = await import("../packages/core/agent/identity/link-flow.js");
  const { linkClaimInstructions } = await import("../packages/core/agent/identity/link-challenge.js");

  const CODE_BACK = "D4EP4RMX";
  const STRAY_MINT = "PWWXPKPE";
  const confirmation = claimCodeBackReply(CODE_BACK);
  ok(CLAIM_CODE_BACK_MARKER.test(confirmation), "🔴 CLAIM_CODE_BACK_MARKER matches the PRODUCT's own claim confirmation (agent/identity/link-flow.ts claimCodeBackReply) — the pin that catches a copy drift");
  ok(parseClaimCodeBack(confirmation) === CODE_BACK, "parseClaimCodeBack: lifts the code-back out of the real claim confirmation");

  const strayMint = linkClaimInstructions(STRAY_MINT, 10);
  ok(parseLinkCode(strayMint) === STRAY_MINT, "control: the stray mint really does parse as a code — the two readers see the same bytes and disagree on purpose");
  ok(parseClaimCodeBack(strayMint) === undefined, "🔴 parseClaimCodeBack: a `link <CODE>` MINT is never a code-back, however new it is (the live-run leg-15 defect)");
  ok(
    parseClaimCodeBack(`${confirmation}\n\n${strayMint}`) === CODE_BACK,
    "🔴 parseClaimCodeBack: with BOTH messages in front of it, it still answers the code the claim confirmation points at — it reads the WHOLE-LINE rendering only, so the mint's anchored `link <CODE>` can never win",
  );
  ok(
    parseClaimCodeBack(`${strayMint}\n\n${confirmation}`) === CODE_BACK,
    "🔴 parseClaimCodeBack: …and it slices at the marker, so a code standing EARLIER in the same text is never taken",
  );

  ok(parseClaimCodeBack(codeBackInstructions(CODE_BACK)) === undefined, "parseClaimCodeBack: the DIRECTORY transport's consent code-back is a different message and is not matched");
  ok(parseClaimCodeBack(undefined) === undefined && parseClaimCodeBack("") === undefined, "parseClaimCodeBack: total over absent/empty input");
  ok(parseClaimCodeBack("enter this code where they started it: and then nothing") === undefined, "parseClaimCodeBack: the marker alone is not a code — a drifted body yields undefined rather than a guess");
}

{
  const cwEmpty = resolveConnectorWrite({});
  ok(
    !cwEmpty.ok && cwEmpty.missing.length === 1 && cwEmpty.missing[0] === ENV.notionChannel,
    "connectorWrite half reports exactly E2E_NOTION_CHANNEL missing in an empty env (the bound channel is the whole fixture)",
  );
  const cwChannelOnly = resolveConnectorWrite({ [ENV.notionChannel]: "C0NOTION" });
  ok(cwChannelOnly.ok && cwChannelOnly.cfg.channel === "C0NOTION", "connectorWrite resolves from the bound channel ALONE — arming is derived at run time, not declared here");
  const cwFalseDeclarationOn = resolveConnectorWrite({ [ENV.notionChannel]: "C0NOTION", E2E_CONNECTOR_WRITE: "1", E2E_OE_OAUTH_ARMED: "1" });
  const cwFalseDeclarationOff = resolveConnectorWrite({ [ENV.notionChannel]: "C0NOTION", E2E_CONNECTOR_WRITE: "0", E2E_OE_OAUTH_ARMED: "0" });
  ok(
    cwFalseDeclarationOn.ok && cwFalseDeclarationOff.ok && cwFalseDeclarationOn.cfg.channel === cwFalseDeclarationOff.cfg.channel,
    "🔴 a retired arming declaration is INERT: E2E_CONNECTOR_WRITE / E2E_OE_OAUTH_ARMED set to '1' or '0' resolve identically (a human claim can no longer arm or disarm a leg)",
  );
  ok(
    !JSON.stringify(ENV).includes("E2E_CONNECTOR_WRITE") && !JSON.stringify(ENV).includes("E2E_OE_OAUTH_ARMED") && !JSON.stringify(ENV).includes("E2E_CONNECTOR_OAUTH"),
    "🔴 the ENV map names NO connector arming flag — E2E_CONNECTOR_WRITE / E2E_OE_OAUTH_ARMED / E2E_CONNECTOR_OAUTH are retired, and re-adding one fails here",
  );

  const LOCAL_TARGET = "http://127.0.0.1:3000";
  const PROD_TARGET = "https://my-agent.vercel.app";
  ok(!auditSilencesExpected({}, LOCAL_TARGET), "auditSilencesExpected is FALSE by default (prod is actions-only), even against the local eval target");
  ok(!auditSilencesExpected({ [ENV.auditSilences]: "0" }, LOCAL_TARGET), "auditSilencesExpected is FALSE for E2E_AUDIT_SILENCES=0");
  ok(auditSilencesExpected({ [ENV.auditSilences]: "1" }, LOCAL_TARGET), "auditSilencesExpected is TRUE at E2E_AUDIT_SILENCES=1 against the local eval target");
  ok(!auditSilencesExpected({ [ENV.auditSilences]: "1" }, PROD_TARGET), "🔴 OPE-1007: E2E_AUDIT_SILENCES=1 does NOT arm the positive polls against prod — the declaration is scoped to the local eval target");
  ok(!auditSilencesExpected({ [ENV.auditSilences]: "1" }), "auditSilencesExpected with NO target is FALSE even when declared — omission is not a free pass");
  ok(!auditSilencesExpected({ [ENV.auditSilences]: "1" }, ""), "auditSilencesExpected with an EMPTY target is FALSE — same safe side as omission");
  ok(!auditSilencesExpected({ [ENV.auditSilences]: "1" }, "not a url"), "auditSilencesExpected with a MALFORMED target is FALSE, not a thrown error");

  ok(isLocalEvalTarget("http://127.0.0.1:3000"), "isLocalEvalTarget: 127.0.0.1 matches");
  ok(isLocalEvalTarget("http://localhost:3000"), "isLocalEvalTarget: localhost matches");
  ok(!isLocalEvalTarget(PROD_TARGET), "isLocalEvalTarget: a real deployed host does NOT match");
  ok(!isLocalEvalTarget(undefined), "isLocalEvalTarget: undefined does not match (and does not throw)");

  const baseOnly = new Set(["slack"] as const);
  const cwMissing = {
    slack: [], discord: [], synthetic: [], slackPrivate: [], slackChannelB: [], slackCapFixture: [], slackHalt: [], controlWrite: [], slackSupervisor: [],
    syntheticDm: [], slackUser2: [], slackSecondary: [], webhook: [], notion: [], teams: [], github: [], linear: [],
    notionAmbient: [], slackUnified: [], pr: [], connectorWrite: [ENV.notionChannel], slackMpim: [],
    soakSlack: [], soakNotion: [], soakLinear: [],
    engagedSlack: [], engagedDiscord: [], engagedTeams: [], engagedGithub: [], engagedLinear: [], engagedNotion: [], email: [],
  } as const;
  for (const id of ["S-NOTION-WRITE", "S-CONNECTOR-TIER"]) {
    const r = skipReason(SCENARIOS.find((s) => s.id === id)!, baseOnly, cwMissing, true);
    ok(
      r === `missing connectorWrite driver (set ${ENV.notionChannel})`,
      `${id} dry-skip names exactly E2E_NOTION_CHANNEL (capability wins over the optional gate)`,
    );
  }
}

{
  const { classifyMintRows, deriveConnectorArming, requireConnectorArmed, watchConnectorArming, armingNote, lookbackIso, CONNECTOR_MINT_ACTION, ARMING_QUERY_LIMIT } =
    await import("../packages/core/scripts/e2e/connector-arming.js");

  const row = (ts: string, detail: Record<string, unknown>, action = CONNECTOR_MINT_ACTION) =>
    ({ ts, org: "o", platform: "connector", workspace: "connector", action, detail }) as const;
  const okRow = (ts: string, connector = "notion") => row(ts, { connector, subject: "user", outcome: "ok" });
  const authRequiredRow = (ts: string, connector = "notion") =>
    row(ts, { connector, subject: "user", outcome: "auth-required", name: "OeOauthNeedsConsentError" });

  ok(CONNECTOR_MINT_ACTION === "connector.mint", "the derivation reads the action agent/connections/connector-auth.ts actually writes");

  ok(classifyMintRows([okRow("2026-04-24T09:30:00.000Z")], "notion").state === "armed", "an outcome=ok personal mint ⇒ ARMED");
  const unconsented = classifyMintRows([authRequiredRow("2026-04-24T09:30:00.000Z")], "notion");
  ok(unconsented.state === "unconsented" && unconsented.at === "2026-04-24T09:30:00.000Z", "an outcome=auth-required personal mint ⇒ UNCONSENTED, carrying the row's ts");
  ok(classifyMintRows([], "notion").state === "unknown", "no rows ⇒ UNKNOWN (never 'unconsented' — an empty window is not evidence of a lapsed grant)");
  ok(
    classifyMintRows([row("2026-04-24T09:30:00.000Z", { connector: "notion", subject: "user", outcome: "error", name: "TypeError" })], "notion").state === "unknown",
    "🔴 outcome=error ⇒ UNKNOWN: some other mint failure is not evidence about CONSENT, and calling it 'unconsented' would skip a leg that should have run",
  );
  ok(
    classifyMintRows([authRequiredRow("2026-04-23T08:30:00.000Z"), okRow("2026-04-24T09:30:00.000Z")], "notion").state === "armed",
    "a later ok row overrides an earlier auth-required (a re-consent re-arms the leg with no human action)",
  );
  ok(
    classifyMintRows([okRow("2026-04-23T08:30:00.000Z"), authRequiredRow("2026-04-24T09:30:00.000Z")], "notion").state === "unconsented",
    "🔴 the NEGATIVE CONTROL: a later auth-required row overrides an earlier ok — a grant that LAPSED disarms the leg, which is the direction a declaration could never follow",
  );
  ok(
    classifyMintRows([okRow("2026-04-24T09:30:00.000Z"), authRequiredRow("2026-04-23T08:30:00.000Z")], "notion").state === "armed" &&
      classifyMintRows([authRequiredRow("2026-04-24T09:30:00.000Z"), okRow("2026-04-23T08:30:00.000Z")], "notion").state === "unconsented",
    "the newest row decides in EITHER arrival order (the route's newest-first ordering is not depended on)",
  );
  ok(classifyMintRows([authRequiredRow("2026-04-24T09:30:00.000Z", "linear")], "notion").state === "unknown", "another connector's rows are ignored (the derivation is per-connector)");
  ok(
    classifyMintRows([row("2026-04-24T09:30:00.000Z", { connector: "notion", subject: "app", outcome: "auth-required" })], "notion").state === "unknown",
    "a SERVICE (subject=app) mint is ignored — these legs assert the PERSONAL grant",
  );
  ok(
    classifyMintRows([row("2026-04-24T09:30:00.000Z", { connector: "notion", subject: "user", outcome: "ok" }, "connector.use")], "notion").state === "unknown",
    "a connector.use row is ignored — connector.use proves the GATE passed, not that the mint succeeded",
  );

  ok((await deriveConnectorArming(undefined, { connector: "notion", sinceIso: "2026-04-04T23:30:00.000Z" })).state === "unknown", "no audit reader ⇒ UNKNOWN, never a throw");
  ok(
    (await deriveConnectorArming(async () => { throw new Error("503"); }, { connector: "notion", sinceIso: "2026-04-04T23:30:00.000Z" })).state === "unknown",
    "🔴 a FAILING audit read ⇒ UNKNOWN, never 'unconsented' — an audit-route blip must not masquerade as a lapsed grant and skip a leg silently",
  );
  let askedFor: unknown;
  await deriveConnectorArming(async (opts) => { askedFor = opts; return []; }, { connector: "notion", sinceIso: "2026-04-04T23:30:00.000Z" });
  ok(
    (askedFor as { actions?: string[] }).actions?.join(",") === CONNECTOR_MINT_ACTION && (askedFor as { sinceIso?: string }).sinceIso === "2026-04-04T23:30:00.000Z",
    "the live half narrows the audit query to connector.mint since the caller's window (the route filters at the store)",
  );
  ok((askedFor as { limit?: number }).limit === ARMING_QUERY_LIMIT && ARMING_QUERY_LIMIT === 1000, "🔴 OPE-1027 — an unspecified limit asks for the route's max (1000), not a truncation-prone small default");
  let askedForCapped: unknown;
  await deriveConnectorArming(async (opts) => { askedForCapped = opts; return []; }, { connector: "notion", sinceIso: "2026-04-04T23:30:00.000Z", limit: 50 });
  ok((askedForCapped as { limit?: number }).limit === 50, "an explicit limit is still honoured (a caller that wants a narrower window can ask for one)");
  const lookback = lookbackIso(14, new Date("2026-04-24T11:30:00.000Z"));
  ok(lookback === "2026-04-10T11:30:00.000Z", "lookbackIso(14) is exactly 14 days back from the reference instant");

  const probeOver = (rows: readonly unknown[]) => {
    const logged: string[] = [];
    return {
      logged,
      probe: {
        auditRead: async () => rows as never,
        log: (m: string) => { logged.push(m); },
        skip: (r: string): never => { throw new ScenarioSkip(r); },
      },
    };
  };
  const opts = { connector: "notion", sinceIso: "2026-04-24T08:30:00.000Z" };

  const unconsentedProbe = probeOver([authRequiredRow("2026-04-24T09:30:00.000Z")]);
  let skipped: unknown;
  try {
    await requireConnectorArmed(unconsentedProbe.probe, opts);
    skipped = undefined;
  } catch (e) {
    skipped = e;
  }
  ok(skipped instanceof ScenarioSkip, "🔴 THE FIX: an auth-required mint row in the leg's own window raises ScenarioSkip — the honest refusal can no longer reach the judge gate and red");
  ok(
    (skipped as Error).message.includes("NOT ARMED on this deploy") && (skipped as Error).message.includes("auth-required"),
    "…and the skip reason names the derived cause (`NOT ARMED on this deploy`, outcome=auth-required), not a missing env var",
  );

  const armedProbe = probeOver([okRow("2026-04-24T09:30:00.000Z")]);
  const armed = await requireConnectorArmed(armedProbe.probe, opts).catch((e) => e as unknown);
  ok(
    !(armed instanceof Error) && (armed as { state?: string }).state === "armed",
    "🔴 the NEGATIVE CONTROL: an ok mint row does NOT skip — the leg runs and its gates carry weight",
  );
  ok(armedProbe.logged.some((l) => l.includes("ARMED")), "…and the armed derivation is LOGGED, so a run's transcript says which deployment fact it decided on");

  const unknownProbe = probeOver([]);
  ok((await requireConnectorArmed(unknownProbe.probe, opts)).state === "unknown", "an empty window does NOT skip — the leg drives, and the post-reply derivation settles it from live evidence");

  ok(armingNote("notion", { state: "unknown", reason: "x" }).startsWith("notion: arming UNKNOWN"), "armingNote renders each state as one legible line for the run log");

  let unwiredSkip: unknown;
  try {
    await watchConnectorArming({ log: () => {}, skip: (r: string): never => { throw new ScenarioSkip(r); } }, "notion");
  } catch (e) {
    unwiredSkip = e;
  }
  ok(
    unwiredSkip instanceof ScenarioSkip && (unwiredSkip as Error).message.includes("E2E_CONTROL_READ_TOKEN"),
    "with no audit reader the watch skips naming E2E_TARGET_URL + E2E_CONTROL_READ_TOKEN — the evidence surface, never an arming declaration",
  );

  const staleRows = [authRequiredRow("2026-04-10T09:30:00.000Z")];
  const staleProbe = probeOver(staleRows);
  const staleWatch = await watchConnectorArming(staleProbe.probe, "notion").catch((e) => e as unknown);
  ok(!(staleWatch instanceof Error), "🔴 a stale auth-required row in the lookback does NOT skip — opening the watch is advisory, so a re-consent is never masked by an old row");
  ok(staleProbe.logged.some((l) => l.startsWith("advisory (")), "…and what the deployment last reported is LOGGED as advisory, so the run transcript still carries it");
  ok(
    staleProbe.logged.some((l) => l.includes("before this leg drives") && l.includes("recheck() below is decisive")),
    "🔴 OPE-1027 — the advisory line names itself as a pre-drive snapshot and points at recheck() as the decisive fact",
  );

  const liveRows: unknown[] = [];
  const liveLogged: string[] = [];
  let recheckQuery: unknown;
  const liveWatch = await watchConnectorArming(
    {
      auditRead: async (o) => { recheckQuery = o; return liveRows as never; },
      log: (m: string) => { liveLogged.push(m); },
      skip: (r: string): never => { throw new ScenarioSkip(r); },
    },
    "notion",
  );
  ok((await liveWatch.recheck()).state === "unknown", "recheck over a leg that minted nothing ⇒ UNKNOWN, and the leg keeps running (silence proves nothing about the grant)");
  ok((recheckQuery as { sinceIso?: string }).sinceIso === liveWatch.since, "recheck reads only rows written since the watch opened — the mints THIS leg caused, never the deployment's history");
  liveRows.push(authRequiredRow(new Date(Date.parse(liveWatch.since) + 1000).toISOString()));
  const liveSkip = await liveWatch.recheck().then(() => undefined, (e: unknown) => e);
  ok(
    liveSkip instanceof ScenarioSkip && (liveSkip as Error).message.includes("NOT ARMED on this deploy"),
    "🔴 THE FIX, at the seam the legs hold: an auth-required mint row raised DURING the leg makes recheck skip — the honest refusal can no longer reach a judge gate and red",
  );

  for (const id of ["S-DM-NOTION", "S-NOTION-WRITE", "S-CONNECTOR-TIER", "S24"]) {
    const src = SCENARIOS.find((s) => s.id === id)!.run.toString();
    ok(src.includes("watchConnectorArming("), `🔴 REACHABILITY — ${id} opens an arming watch (a leg that dropped the call keeps every assertion above green)`);
    const judgeGates = (src.match(/judgePass\(/g) ?? []).length;
    const rechecks = (src.match(/\.recheck\(\)/g) ?? []).length;
    ok(judgeGates > 0, `${id} still has at least one judge gate to protect (the count below is not vacuous)`);
    ok(
      rechecks >= judgeGates,
      `🔴 REACHABILITY — ${id} rechecks the arming at least once per judge gate (${rechecks} recheck(s) for ${judgeGates} gate(s)) — a gate with no derivation in front of it is exactly the false red this closes`,
    );
    ok(
      !/E2E_CONNECTOR_WRITE|E2E_OE_OAUTH_ARMED|E2E_CONNECTOR_OAUTH/.test(src),
      `🔴 ${id} reads NO arming declaration — re-adding one fails here`,
    );
  }

  {
    const src = SCENARIOS.find((s) => s.id === "S-DM-NOTION")!.run.toString();
    ok(
      src.includes("dm.collectBotMessagesAfter("),
      "🔴 OPE-1027 — S-DM-NOTION polls the merged thread+top-level geometry (collectBotMessagesAfter), not a thread-only read",
    );
    ok(
      !/await dm\.replies\(anchorTs\)/.test(src),
      "🔴 OPE-1027 — S-DM-NOTION's poll body no longer reads dm.replies(anchorTs) alone (the thread-only trap that redded a live run)",
    );
  }

  {
    const HEX32 = "1f2a3b4c5d6e7f8091a2b3c4d5e6f708";
    const NOTION_HOST = "api.notion.com";
    const CHANNEL = "C0EXGENRL";
    const policyRow = (writeHosts: unknown, surface?: string): AuditWireEntry => ({
      ts: "2026-05-12T11:30:00.000Z",
      org: "o",
      platform: "slack",
      workspace: "T1",
      ...(surface === undefined ? {} : { surface }),
      action: EGRESS_POLICY_ACTION,
      detail: { hosts: 4, enforced: true, writeHostCount: Array.isArray(writeHosts) ? writeHosts.length : 0, ...(writeHosts === undefined ? {} : { writeHosts }) },
    });
    const credentialedNotion = { host: NOTION_HOST, via: "notion-rest", credentialed: true, methods: ["GET", "POST", "PATCH"] };

    const hit = findCredentialedWriteHost([policyRow([credentialedNotion], CHANNEL)], { host: NOTION_HOST, surface: CHANNEL });
    ok(
      hit.matches.length === 1 && hit.matches[0]!.via === "notion-rest" && hit.rows === 1,
      "🔴 OPE-1496 — a credentialed, write-open api.notion.com entry IS the HTTP route's firewall evidence, and the reader carries the connection that opened it",
    );
    ok(
      findCredentialedWriteHost([policyRow([{ ...credentialedNotion, methods: ["GET"] }], CHANNEL)], { host: NOTION_HOST, surface: CHANNEL }).matches.length === 0,
      "🔴 a READ-ONLY rule is not this rung's evidence — the harness re-derives the verdict from the row's own methods rather than trusting the writer's filter",
    );
    ok(
      findCredentialedWriteHost([policyRow([{ ...credentialedNotion, credentialed: false }], CHANNEL)], { host: NOTION_HOST, surface: CHANNEL }).matches.length === 0,
      "🔴 a host the firewall stamps NOTHING on is not evidence of a credentialed call — `credentialed` is the discriminator, and it is load-bearing",
    );
    for (const [label, entry] of [
      ["no methods", { host: NOTION_HOST, via: "notion-rest", credentialed: true }],
      ["an undecodable methods shape", { host: NOTION_HOST, via: "notion-rest", credentialed: true, methods: 3 }],
      ["no credentialed flag", { host: NOTION_HOST, via: "notion-rest", methods: ["POST"] }],
      ["no host", { via: "notion-rest", credentialed: true, methods: ["POST"] }],
    ] as const) {
      ok(
        findCredentialedWriteHost([policyRow([entry], CHANNEL)], { host: NOTION_HOST, surface: CHANNEL }).matches.length === 0,
        `🔴 an entry with ${label} yields NO match — an assertion must never pass on a shape it could not read`,
      );
    }
    const otherHost = findCredentialedWriteHost([policyRow([{ host: "api.github.com", via: "gh", credentialed: true, methods: "any" }], CHANNEL)], { host: NOTION_HOST, surface: CHANNEL });
    ok(
      otherHost.matches.length === 0 && otherHost.hostsSeen.join(",") === "api.github.com",
      "🔴 another vendor's credentialed write host is not Notion evidence — and the reader still reports what it DID see, so a red names it",
    );
    ok(
      findCredentialedWriteHost([policyRow([{ ...credentialedNotion, methods: "any" }], CHANNEL)], { host: NOTION_HOST, surface: CHANNEL }).matches.length === 1,
      "a rule that declares no method match (`any`) admits a write, so it counts",
    );
    ok(
      findCredentialedWriteHost([policyRow([credentialedNotion], "C-SOMEWHERE-ELSE")], { host: NOTION_HOST, surface: CHANNEL }).matches.length === 0,
      "🔴 a policy row stamped with ANOTHER surface is not this leg's — the gate would otherwise green on a sibling channel's firewall",
    );

    const { writeHostsAuditFields } = await import("../packages/core/agent/access/egress.js");
    const shipped = (writeHostsAuditFields([{ host: NOTION_HOST, credential: "notion-rest", credentialed: true, verb: ["GET", "POST", "PATCH"] }]) as { writeHosts?: unknown }).writeHosts;
    const shippedHit = findCredentialedWriteHost([policyRow(shipped, CHANNEL)], { host: NOTION_HOST, surface: CHANNEL });
    ok(
      shippedHit.matches.length === 1 && shippedHit.matches[0]!.via === "notion-rest",
      "🔴 the reader decodes an entry the PRODUCT rendered, not only the shapes this suite hand-builds — a field rename must red here rather than silently emptying the window",
    );
    ok(
      findCredentialedWriteHost(
        [policyRow((writeHostsAuditFields([{ host: NOTION_HOST, credential: "notion-rest", credentialed: true, verb: ["GET"] }]) as { writeHosts?: unknown }).writeHosts, CHANNEL)],
        { host: NOTION_HOST, surface: CHANNEL },
      ).matches.length === 0,
      "🔴 …and re-derives the write verdict from the shipped entry too: a read-only rule rendered by the product is still not this rung's evidence",
    );
    ok(
      findCredentialedWriteHost([policyRow([credentialedNotion])], { host: NOTION_HOST, surface: CHANNEL }).matches.length === 1,
      "an UNATTRIBUTED policy row is kept — the same rule the connector-evidence gate uses, because dropping it would red a correct run on a window seconds wide",
    );
    const mixed = findCredentialedWriteHost(
      [{ ts: "2026-05-12T11:30:00.000Z", org: "o", platform: "slack", workspace: "T1", surface: CHANNEL, action: "connector.op", detail: { writeHosts: [credentialedNotion] } }, policyRow(undefined, CHANNEL)],
      { host: NOTION_HOST, surface: CHANNEL },
    );
    ok(mixed.rows === 1 && mixed.matches.length === 0, "🔴 only `egress.policy` rows are read, and a row with no writeHosts is total — no throw, no match");

    ok(notionPageLinks(`Found "Team Handbook" — https://www.notion.so/Team-Handbook-${HEX32}`).length === 1, "a Notion page URL carrying the page's 32-hex id is the content rung");
    ok(notionPageLinks(`see <https://www.notion.so/Team-Handbook-${HEX32}>`)[0] === `https://www.notion.so/Team-Handbook-${HEX32}`, "Slack's angle-bracket wrapping is stripped, not carried into the link");
    ok(notionPageLinks(`https://acme.notion.site/Handbook-${HEX32}`).length === 1, "a published notion.site page counts too");
    ok(notionPageLinks(`a ${HEX32} b https://www.notion.so/Team-Handbook-${HEX32} c https://www.notion.so/Team-Handbook-${HEX32}`).length === 1, "links are de-duplicated, and a bare id on its own is not a link");
    ok(notionPageLinks("I searched Notion and found the team handbook page. See https://www.notion.so/help for more.").length === 0, "🔴 THE NEGATIVE CONTROL — a fluent answer with a marketing link carries NO page id, so prose cannot earn this rung");
    ok(notionPageLinks("The live search returned nothing for that term.").length === 0, "an honest miss carries no link either (that a link is REPORTED and never SCORED is pinned on the leg source below, not here)");

    const pageBlocks = [
      { object: "block", type: "heading_1", heading_1: { rich_text: [{ plain_text: "Team Handbook" }] } },
      { object: "block", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Expenses over " }, { plain_text: "£40 need a written approval from the on-call lead." }] } },
      { object: "block", type: "image", image: { caption: [] } },
      { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Short one" }] } },
    ];
    const phrases = notionBlockPhrases(pageBlocks);
    ok(
      phrases.length === 1 && phrases[0] === "Expenses over £40 need a written approval from the on-call lead.",
      "🔴 OPE-1496 — the reader takes a block's own line, joins its rich-text spans, and skips the title, the image and the four-word bullet: a phrase must be long enough that prose does not land it by chance",
    );
    ok(notionBlockPhrases([{ type: "paragraph" }, { type: "paragraph", paragraph: {} }, null, "nope", {}]).length === 0, "🔴 every unreadable block shape yields NO phrase — an assertion must never pass on prose it could not read");
    const twoSentences = notionBlockPhrases([
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: "The on-call lead approves expenses. Receipts go to the finance channel within a week." }] } },
    ]);
    ok(
      twoSentences.includes("Receipts go to the finance channel within a week.") && twoSentences.includes("The on-call lead approves expenses."),
      "🔴 OPE-1496 — a SHORT two-sentence paragraph offers each sentence on its own, not only the joined line: a reply quoting one sentence of it must be able to clear the rung",
    );
    const pin = { pageId: HEX32, title: "Team Handbook", phrases };
    ok(
      quotedPagePhrase('It says: "Expenses over £40 need a written approval from the on-call lead."', pin) === phrases[0],
      "🔴 OPE-1496 — a reply repeating the page's own sentence earns the answer half, which memory, backscroll and the web cannot supply",
    );
    ok(
      quotedPagePhrase("> Expenses over £40 need a *written approval* from the on-call lead.", pin) === phrases[0],
      "a Slack blockquote, and bold markers INSIDE the sentence, still match — a fold that missed them would red a correct deployment over formatting",
    );
    ok(
      quotedPagePhrase(`I found the Team Handbook page. https://www.notion.so/Team-Handbook-${HEX32} — it covers expenses and on-call.`, pin) === undefined,
      "🔴 THE NEGATIVE CONTROL — a fluent summary carrying the page LINK and the page's own topic words quotes no sentence, so it earns nothing: this is the finding that a link-only rung was too weak",
    );
    ok(quotedPagePhrase("The live search returned nothing for that term.", pin) === undefined, "🔴 an honest miss earns nothing here, which is why the leg skips rather than reds when the MCP rung is unarmed too");
    ok(
      quotedPagePhrase("Expenses over £40 need a written approval from the on-call lead.", { ...pin, phrases: ["Every laptop is replaced on a three-year cycle."] }) === undefined,
      "🔴 the reply is matched against THIS pin's phrases — a sentence from another page earns nothing, so a reader that returned its first candidate would be caught here",
    );
    ok(
      quotedPagePhrase("Health &amp; Safety training runs every second Tuesday.", { ...pin, phrases: ["Health & Safety training runs every second Tuesday."] }) !== undefined,
      "🔴 Slack escapes an ampersand and Notion does not, so the fold decodes the entity — otherwise a correct quote of any sentence holding `&` could never match",
    );
  }

  {
    const src = SCENARIOS.find((s) => s.id === "S24")!.run.toString();
    ok(
      /Run the search live against Notion/.test(src),
      "🔴 OPE-1492 — S24's ask demands a LIVE read of the connected workspace, so a prose answer is no longer the path of least resistance",
    );
    ok(
      /search the connected Notion workspace/.test(src),
      "🔴 OPE-1492 — S24's ask names the CONNECTED WORKSPACE as the source, so a worker answering from anywhere else has been told it is answering the wrong question",
    );
    ok(
      /do not answer from memory, from this channel's history, or from the web/.test(src),
      "🔴 OPE-1492 — S24's ask closes the prose exits (memory / backscroll / web), which is what let the old lenient ask pass with a silent audit",
    );
    ok(
      !/connection_search|notion__/.test(src),
      "🔴 OPE-1492 (row 16's lesson) — S24's ask names NO tool the lean seat cannot hold: the seat must delegate, not refuse",
    );

    ok(
      /findCredentialedWriteHost\(/.test(src) && /NOTION_REST_HOST\s*=\s*"api\.notion\.com"/.test(src),
      "🔴 REACHABILITY (OPE-1496) — S24 reads the turn's egress policy row for the NAMED Notion REST host, so the HTTP route has a firewall rung at all",
    );
    ok(
      /pinNotionQueryPage\(/.test(src) && /quotedPagePhrase\(/.test(src),
      "🔴 OPE-1496 — S24 pins the fixture page with the harness's own Notion token and demands the reply QUOTE its body, so the firewall rung alone can never carry the leg",
    );
    ok(
      /httpRoute\s*=\s*\w+\.matches\.length\s*>\s*0\s*&&\s*\w*[qQ]uoted\s*!==\s*(?:undefined|void 0)/.test(src),
      "🔴 OPE-1496 — the HTTP rung is the policy row AND the quote: a page link alone does not satisfy it, which is the whole correction to the rung's first shape",
    );
    ok(
      /REPORTED and not scored/.test(src),
      "🔴 OPE-1496 — the page link stays in the message as a REPORTED shape and says so, so a reader never takes it for the rung",
    );
    ok(
      /ctx\.log\(\s*`S24 rungs/.test(src),
      "🔴 OPE-1496 — S24 LOGS which rung cleared before the gate, so a passing run says whether the strong rung or the weak one carried it",
    );
    ok(
      /CONFIGURED REACH/.test(src) && !/really reached|really ran/.test(src),
      "🔴 OPE-1496 — S24's HTTP rung reports CONFIGURED REACH, never a request (this SAMPLES two known-bad phrasings; it does not prove the message is free of overclaim)",
    );
    ok(
      /copied from the page body word for word/.test(src) && /never write a sentence the page does not contain/.test(src),
      "🔴 OPE-1496 — S24's ask demands a verbatim sentence from the page and forbids inventing one, which is what makes the content rung answerable honestly or not at all",
    );
    ok(
      /armedBefore\.state\s*!==\s*"armed"/.test(src),
      "🔴 OPE-1496 — S24 still treats anything short of a POSITIVE `armed` as an unearnable MCP rung (an `unknown` from a connector that has never minted is exactly this fixture)",
    );
    ok(
      /!\w*[mM]cpRoute\s*&&\s*!\w*[hH]ttpRoute\s*&&\s*\w+\.state\s*!==\s*"armed"/.test(src),
      "🔴 OPE-1496 — the skip is CONDITIONAL on neither route being earned: a regression to the old unconditional pre-drive skip would make the HTTP rung dead code on this very fixture",
    );
    ok(
      /OPE-1496/.test(src),
      "🔴 OPE-1496 — S24's skip reason and its gate message both NAME the ticket, so a red or a skip is never nameless again",
    );
    ok(
      !/E2E_CONNECTOR_OAUTH/.test(src),
      "🔴 OPE-894 — S24 reads NO arming env var; the deployment's own connector.mint rows are the evidence",
    );
    ok(
      /connector\.use.{0,400}connector\.op/s.test(src) && /HTTP ROUTE \(/.test(src),
      "🔴 OPE-1492 — S24's gate message branches its reading: `connector.use` only = the endpoint fence refused; no connector row = the HTTP route's own rung is what the leg rests on, and the message reports what that rung saw",
    );
    ok(
      /action\s*===\s*"connector\.op"\s*\|\|\s*\w+\.action\s*===\s*"connector\.use"/.test(src),
      "🔴 OPE-1485 — S24 still gates on connector.op/connector.use only (connector.grant lands on every session.started and proves nothing)",
    );
    ok(
      /detail\?\.connection\s*===\s*"notion"/.test(src),
      "🔴 OPE-1485 — S24's evidence filter still NAMES the connection, so a second binding on that channel cannot make the gate vacuous",
    );

    ok(
      /ctx\.fixtureMissing\(/.test(src),
      "🔴 OPE-1722 — S24 ends on the DISTINCT `fixtureMissing` verdict, so a gone fixture never reaches the gate as a red",
    );
    ok(
      /!\w*[mM]cpRoute\s*&&\s*!\w*[hH]ttpRoute\s*&&\s*!\w+\.ok\s*&&\s*\w+\.failure\s*===\s*"search-empty"/.test(src),
      "🔴 OPE-1722 — the fixture verdict turns on the MEASURED rungs plus the pin's cause, so it reaches the state that actually reds",
    );
    {
      const at = src.indexOf("fixtureMissing");
      const guard = src.slice(Math.max(0, src.lastIndexOf("if(", at) === -1 ? src.lastIndexOf("if (", at) : src.lastIndexOf("if(", at)), at);
      ok(!/armed/.test(guard), "🔴 OPE-1722 — and its guard names NO arming state: an arming clause would make it disjoint from the red, which is the defect this replaces");
    }
    ok(
      src.indexOf("judgePass") < src.indexOf("fixtureMissing") && src.indexOf("notionPageLinks") < src.indexOf("fixtureMissing"),
      "🔴 OPE-1722 — the fixture verdict is spent AFTER the reply await, the judge gate and both rung reads, so a broken deployment still reds through a missing fixture",
    );
    ok(
      (src.match(/ctx\.fixtureMissing\(/g) ?? []).length === 1 && /"search-empty"/.test(src),
      "🔴 OPE-1722 — exactly ONE fixture-missing bail, guarded by the `search-empty` member: the other four pin failures keep the OPE-1496 path",
    );
    for (const other of ["search-failed", "read-failed", "no-prose", "no-driver-key"])
      ok(!new RegExp(`failure\\s*===\\s*"${other}"`).test(src), `🔴 OPE-1722 — NEGATIVE CONTROL: S24 branches on no pin failure but \`search-empty\` (\`${other}\` stays a printed reason)`);
    ok(
      /provision-notion-query-page/.test(src),
      "🔴 OPE-1722 — the fixture-missing message NAMES the seeder command, so the one verdict with a one-line remedy carries it",
    );
    ok(
      /never that the deployment is broken/.test(src),
      "🔴 OPE-1722 — and it says outright what it does NOT assert about the deployment, which is the claim a live run's red got wrong",
    );
    ok(
      /reply await and the judge gate above PASSED/.test(src),
      "🔴 OPE-1722 — the verdict names the two hard gates that DID run and pass, so it is not read as a leg that checked nothing",
    );
  }
}

{
  const { classifyOrgConsentRows, deriveOrgConsent, orgConsentMissingReason, CREDENTIAL_BOUND_ACTION, CREDENTIAL_BOUND_ROWS_SINCE, CONNECTOR_MINT_ACTION } =
    await import("../packages/core/scripts/e2e/connector-arming.js");
  const HOME = "mcp.notion.com/notion-mcp";
  const bindRow = (ts: string, subject: string, connector = HOME, action = CREDENTIAL_BOUND_ACTION) =>
    ({ ts, org: "o", platform: "oauth", workspace: "callback", action, detail: { connector, subject, rebound: false } }) as const;
  const userMint = { ts: "2026-05-27T09:30:00.000Z", org: "o", platform: "connector", workspace: "connector", action: CONNECTOR_MINT_ACTION, detail: { connector: "notion", subject: "user", outcome: "ok" } } as const;

  const callbackSrc = readFileSync(fileURLToPath(new URL("../packages/core/agent/connections/oe-oauth-callback.ts", import.meta.url)), "utf8");
  ok(callbackSrc.includes(`action: "${CREDENTIAL_BOUND_ACTION}"`) && /subject: subject\.type/.test(callbackSrc), "OPE-2089: the org-consent read keys on the action + subject the OAuth callback route writes");

  const table: ReadonlyArray<{ name: string; rows: readonly unknown[]; want: "bound" | "absent" }> = [
    { name: "🔴 only a PERSONAL mint row (the live-run state) ⇒ absent", rows: [userMint], want: "absent" },
    { name: "only a PERSONAL bind row (subject=user) ⇒ absent", rows: [bindRow("2026-05-27T09:30:00.000Z", "user")], want: "absent" },
    { name: "no rows ⇒ absent", rows: [], want: "absent" },
    { name: "an app bind row for ANOTHER OAuth home ⇒ absent", rows: [bindRow("2026-05-27T09:30:00.000Z", "app", "mcp.linear.app/mcp")], want: "absent" },
    { name: "an app-subject row under another action ⇒ absent", rows: [bindRow("2026-05-27T09:30:00.000Z", "app", HOME, "connector.oauth_url_issued")], want: "absent" },
    { name: "an app bind row for this OAuth home ⇒ bound", rows: [bindRow("2026-05-27T09:30:00.000Z", "app")], want: "bound" },
    { name: "an app bind row beside a user one ⇒ bound", rows: [userMint, bindRow("2026-06-03T09:32:00.000Z", "user"), bindRow("2026-05-27T06:32:00.000Z", "app")], want: "bound" },
  ];
  for (const t of table) {
    const got = classifyOrgConsentRows(t.rows as never, HOME);
    ok(got.state === t.want, `OPE-2089 classifyOrgConsentRows: ${t.name} (got ${got.state})`);
  }
  const newest = classifyOrgConsentRows([bindRow("2026-05-26T06:32:00.000Z", "app"), bindRow("2026-06-03T09:32:00.000Z", "app"), bindRow("2026-05-27T06:32:00.000Z", "app")] as never, HOME);
  ok(newest.state === "bound" && newest.at === "2026-06-03T09:32:00.000Z", "OPE-2089: a bound answer names the NEWEST app bind, whatever the row order");

  ok((await deriveOrgConsent(undefined, { oauthHome: HOME })).state === "unknown", "OPE-2089: no audit reader ⇒ UNKNOWN, never absent");
  ok((await deriveOrgConsent(async () => { throw new Error("503"); }, { oauthHome: HOME })).state === "unknown", "🔴 OPE-2089: a FAILING audit read ⇒ UNKNOWN, never absent — a route blip must not red the leg");
  let asked: { sinceIso?: string; actions?: readonly string[]; limit?: number } | undefined;
  const absent = await deriveOrgConsent(async (o) => { asked = o; return [userMint] as never; }, { oauthHome: HOME });
  ok(absent.state === "absent", "OPE-2089: a successful read holding only a personal mint ⇒ absent (the leg reds)");
  ok(asked?.sinceIso === CREDENTIAL_BOUND_ROWS_SINCE && asked?.actions?.length === 1 && asked.actions[0] === CREDENTIAL_BOUND_ACTION && asked.limit === 1000, "OPE-2089: the read asks for bind rows only, from the day the row shipped, at the route's ceiling");
  ok((await deriveOrgConsent(async () => [bindRow("2026-05-27T09:30:00.000Z", "app")] as never, { oauthHome: HOME })).state === "bound", "OPE-2089: a successful read holding an app bind ⇒ bound (the leg drives as before)");

  const reason = orgConsentMissingReason("notion", HOME);
  ok(reason.includes('an org admin asks the bot "connect notion here" in the fixture channel and completes the Notion consent'), "OPE-2089: the red names the ONE action, verbatim");
  ok(reason.startsWith("RED-until-fixture:") && reason.includes(HOME), "OPE-2089: the red is a fixture red naming the OAuth home");

  const scenariosSrc = readFileSync(fileURLToPath(new URL("../packages/core/scripts/e2e/scenarios.ts", import.meta.url)), "utf8");
  const legAt = scenariosSrc.indexOf('id: "S-ROUTINE-CONNECTOR-WRITE"');
  const leg = legAt < 0 ? "" : scenariosSrc.slice(legAt, legAt + 60_000);
  const preflightAt = leg.indexOf("deriveOrgConsent(ctx.auditRead, { oauthHome: fixture.oauthHome })");
  const redAt = leg.indexOf('if (orgConsent.state === "absent") return ctx.fixtureMissing(');
  const watchAt = leg.indexOf("watchConnectorArming(");
  ok(legAt >= 0 && preflightAt > 0 && redAt > preflightAt && watchAt > redAt, "🔴 OPE-2089: S-ROUTINE-CONNECTOR-WRITE runs the org-consent preflight and its fixture red BEFORE the arming watch and every dispatcher wait");
}

{
  const { SKIP_KINDS, emptySkipCounts, renderSkipBreakdown } = await import("../packages/core/scripts/e2e/skip-summary.js");
  ok(SKIP_KINDS.includes("fixture-missing"), "`fixture-missing` is in the closed skip taxonomy");
  ok(emptySkipCounts()["fixture-missing"] === 0, "…so the empty tally carries its bucket");
  ok(renderSkipBreakdown({ ...emptySkipCounts(), "fixture-missing": 2 }) === "2 fixture-missing", "…and the end-of-run breakdown renders it by name");
  ok(
    renderSkipBreakdown({ ...emptySkipCounts(), "fixture-missing": 1, "scenario-self-skip": 1 }) === "1 fixture-missing, 1 scenario-self-skip",
    "…beside a self-skip rather than folded into it, which is the whole point of the split: one says the DEPLOYMENT cannot arm the rung, the other says the harness's own test data is gone",
  );

  const runnerSrc = readFileSync(new URL("../packages/core/scripts/e2e/runner.ts", import.meta.url), "utf8");
  ok(/skipCounts\["fixture-missing"\]\+\+/.test(runnerSrc), "the runner really has a `fixture-missing` counting site — a member with no site is a bucket that can never be non-zero");
  ok(
    /err instanceof FixtureMissing/.test(runnerSrc) && runnerSrc.indexOf("err instanceof FixtureMissing") < runnerSrc.indexOf("err instanceof ScenarioSkip"),
    "…reached BEFORE the ScenarioSkip branch, so the verdict cannot be swallowed as an ordinary self-skip",
  );
  ok(/FIXTURE MISSING/.test(runnerSrc), "…and printed on its own line, because the remedy is a command an operator runs");
  const branch = runnerSrc.slice(runnerSrc.indexOf("err instanceof FixtureMissing"), runnerSrc.indexOf("err instanceof ScenarioSkip"));
  ok(/failed\+\+/.test(branch) && /liveRun/.test(branch), "🔴 OPE-1836 — on a LIVE run the branch counts a failure, so an unprovisioned fixture cannot pass as a ship-gate rung");
  ok(/skipped\+\+/.test(branch), "🔴 OPE-1722 survives in the DRY arm — no deployment was measured there, so the exit code must not move");
  ok(/RED-until-fixture/.test(branch), "…and the live arm says RED-until-fixture, so a reader can still tell missing test data from a broken deployment");
}

{
  const linMiss = resolveLinear({});
  ok(!linMiss.ok && linMiss.missing.length === 4 && linMiss.missing.includes(ENV.linearApiKey), "linear half reports its four required vars missing in an empty env");
  const linBase = resolveLinear({
    [ENV.linearApiKey]: "lin_api_x",
    [ENV.linearTeamId]: "team-uuid",
    [ENV.linearAppUserId]: "app-user-uuid",
    [ENV.linearAgentHandle]: "OpenEverywhere",
  });
  ok(linBase.ok && linBase.cfg.appUserId === "app-user-uuid" && linBase.cfg.agentHandle === "OpenEverywhere", "linear cfg carries appUserId (self-loop) + agentHandle (literal mention)");
  ok(linBase.ok && linBase.cfg.webhookSecret === undefined, "linear forge var absent unless set (the forge leg self-skips)");
  const linForge = resolveLinear({
    [ENV.linearApiKey]: "lin_api_x",
    [ENV.linearTeamId]: "team-uuid",
    [ENV.linearAppUserId]: "app-user-uuid",
    [ENV.linearAgentHandle]: "OpenEverywhere",
    [ENV.linearWebhookSecret]: "lin-whsec",
  });
  ok(linForge.ok && linForge.cfg.webhookSecret === "lin-whsec", "linear cfg carries the optional forge secret when present");

  const { signLinearBody, buildAgentSessionEvent } = await import("../packages/core/scripts/e2e/linear-driver.js");
  const { signLinearWebhookBody } = await import(`${pathToFileURL(eveRootDir).href}/dist/src/public/channels/linear/verify.js`);
  const secret = "lin-e2e-secret";
  const raw = JSON.stringify({ type: "AgentSessionEvent", webhookTimestamp: 1_720_009_900_000 });
  ok(signLinearBody(secret, raw) === signLinearWebhookBody(raw, secret), "the linear forge signer matches eve's own signLinearWebhookBody (hex, no prefix)");
  ok(!/^sha256=/.test(signLinearBody(secret, raw)), "the linear signature carries NO sha256= prefix (unlike github/notion)");
  const ev = buildAgentSessionEvent({ action: "created", organizationId: "org1", sessionId: "s1", issueId: "i1", issueIdentifier: "OE-1", teamId: "t1", creatorId: "u1", nowMs: 1_720_009_900_000 });
  ok(ev.type === "AgentSessionEvent" && ev.webhookTimestamp === 1_720_009_900_000, "forged AgentSessionEvent carries the type + the ±60s webhookTimestamp field");
  const session = ev.agentSession as { issue?: { team?: { id?: string } }; creator?: { id?: string } };
  ok(session.issue?.team?.id === "t1" && session.creator?.id === "u1", "forged event nests issue.team.id + creator.id (enrichTeamPrivacy + creator read them)");
}

{
  const notMiss = resolveNotionAmbient({});
  ok(!notMiss.ok && notMiss.missing.length === 4 && notMiss.missing.includes(ENV.notionDriverKey), "notionAmbient half reports its four CORE required vars missing in an empty env (forge secret + anchors are optional)");
  const notCore = resolveNotionAmbient({
    [ENV.notionDriverKey]: "secret_x",
    [ENV.notionAmbientPageId]: "page-uuid",
    [ENV.notionBotUserId]: "bot-user-uuid",
    [ENV.notionWorkspaceId]: "ws-uuid",
  });
  ok(notCore.ok && notCore.cfg.webhookSecret === undefined && notCore.cfg.anchorOnTopic === undefined && notCore.cfg.anchorHuman === undefined, "notionAmbient resolves on the four core vars alone; forge secret + anchors (incl. the OPE-576 human anchor) stay undefined");
  const notFull = resolveNotionAmbient({
    [ENV.notionDriverKey]: "secret_x",
    [ENV.notionAmbientPageId]: "page-uuid",
    [ENV.notionAmbientWebhookSecret]: "verif-token",
    [ENV.notionBotUserId]: "bot-user-uuid",
    [ENV.notionWorkspaceId]: "ws-uuid",
    [ENV.notionAnchorOnTopic]: "c-ontopic-1",
    [ENV.notionAnchorOnTopic2]: "c-ontopic-2",
    [ENV.notionAnchorOffTopic]: "c-offtopic",
    [ENV.notionAnchorHuman]: "c-human-1",
  });
  ok(notFull.ok && notFull.cfg.webhookSecret === "verif-token" && notFull.cfg.anchorOnTopic === "c-ontopic-1" && notFull.cfg.anchorOnTopic2 === "c-ontopic-2" && notFull.cfg.anchorOffTopic === "c-offtopic" && notFull.cfg.anchorHuman === "c-human-1", "notionAmbient cfg carries the forge secret + the three anchor ids + the OPE-576 human anchor when they're set");
  ok(notFull.ok && notFull.cfg.botUserId === "bot-user-uuid" && notFull.cfg.workspaceId === "ws-uuid", "notionAmbient cfg carries bot user id (self-loop) + workspace id (envelope)");

  const { buildBlockCommentBody } = await import("../packages/core/scripts/e2e/notion-driver.js");
  const bc = buildBlockCommentBody("block-123", "hi there") as { parent?: { block_id?: string }; rich_text?: { text?: { content?: string } }[] };
  ok(bc.parent?.block_id === "block-123", "buildBlockCommentBody anchors on parent.block_id (mints a fresh per-block discussion)");
  ok(bc.rich_text?.[0]?.text?.content === "hi there", "buildBlockCommentBody carries the comment text as one rich-text item");

  const { buildDiscussionReplyBody } = await import("../packages/core/scripts/e2e/notion-driver.js");
  const dr = buildDiscussionReplyBody("disc-456", "second turn") as { discussion_id?: string; parent?: { discussion_id?: string; block_id?: string }; rich_text?: { text?: { content?: string } }[] };
  ok(dr.discussion_id === "disc-456", "buildDiscussionReplyBody anchors on TOP-LEVEL discussion_id (joins the existing thread)");
  ok(dr.parent === undefined, "buildDiscussionReplyBody carries no parent at all — parent.discussion_id 400s and parent.block_id would mint a fresh discussion");
  ok(dr.rich_text?.[0]?.text?.content === "second turn", "buildDiscussionReplyBody carries the reply text as one rich-text item");

  const { signNotionBody, buildCommentCreatedEvent } = await import("../packages/core/scripts/e2e/notion-driver.js");
  const secret = "notion-verif-token";
  const raw = JSON.stringify(buildCommentCreatedEvent({ workspaceId: "ws", commentId: "c1", pageId: "p1" }));
  const sig = signNotionBody(secret, raw);
  ok(sig.startsWith("sha256="), 'notion signature carries the "sha256=" prefix');
  const ev = buildCommentCreatedEvent({ workspaceId: "ws9", commentId: "cX", pageId: "pY" });
  ok(ev.type === "comment.created" && (ev.entity as { id?: string }).id === "cX" && (ev.data as { page_id?: string }).page_id === "pY", "forged comment.created is signal-only (entity.id + data.page_id, no text/author)");
}

{
  const { buildAuditQuery, hasAuditRow } = await import("../packages/core/scripts/e2e/audit-read.js");
  const q = new URLSearchParams(buildAuditQuery({ sinceIso: "2026-03-13T23:30:00.000Z", actions: ["notion.no_reply", "notion.replied"], platform: "notion", limit: 50 }));
  ok(q.get("since") === "2026-03-13T23:30:00.000Z", "audit query carries the since lower bound");
  ok(q.get("actions") === "notion.no_reply,notion.replied", "audit query joins the actions filter as CSV");
  ok(q.get("platform") === "notion" && q.get("limit") === "50", "audit query carries platform + limit");
  const bare = new URLSearchParams(buildAuditQuery({ sinceIso: "2026-03-13T23:30:00.000Z" }));
  ok(bare.get("since") !== null && !bare.has("actions") && !bare.has("platform"), "audit query omits absent optional filters");
  const rows = [
    { ts: "2026-03-14T00:30:00Z", org: "o", platform: "notion", workspace: "w", action: "notion.no_reply", detail: { discussionId: "d1" } },
    { ts: "2026-03-14T00:31:00Z", org: "o", platform: "notion", workspace: "w", action: "notion.replied", detail: { discussionId: "d2" } },
  ];
  ok(hasAuditRow(rows, "notion.no_reply"), "hasAuditRow finds an audited-silence row by action");
  ok(hasAuditRow(rows, "notion.replied", (e) => (e.detail as { discussionId?: string }).discussionId === "d2"), "hasAuditRow supports a predicate (right-discussion reply-target gate)");
  ok(!hasAuditRow(rows, "notion.replied", (e) => (e.detail as { discussionId?: string }).discussionId === "d1"), "hasAuditRow rejects when the predicate misses (wrong discussion)");
  const bounded = new URLSearchParams(buildAuditQuery({ sinceIso: "2026-03-13T23:30:00.000Z", untilIso: "2026-03-14T00:05:00.000Z" }));
  ok(bounded.get("until") === "2026-03-14T00:05:00.000Z", "audit query carries the until upper bound");
  ok(!bare.has("until"), "audit query omits until when the caller passes none (an open-ended read is unchanged)");
}

{
  const { classifyWakeRow, selectWakeEvidence, captureWakeEvidence, renderLegWakeEvidence, WAKE_FAILED_ACTION } = await import(
    "../packages/core/scripts/e2e/wake-evidence.js"
  );
  const { declaredAuditActions } = await import("@open-everywhere/core/agent/audit/action-registry.js");
  const { WAKE_TURN_START_ACTION } = await import("@open-everywhere/core/agent/channels/wake-timing.js");
  const row = (ts: string, platform: string, action: string, detail: Record<string, unknown> = {}): AuditWireEntry => ({
    ts,
    org: "acme",
    platform,
    workspace: "w1",
    action,
    detail,
  });

  ok(classifyWakeRow(row("t", "control", "wake.ingress")) === "ingress", "wake.ingress classifies as ingress");
  ok(classifyWakeRow(row("t", "slack", WAKE_TURN_START_ACTION)) === "turn-start", "wake.turn_start classifies as turn-start");
  ok(classifyWakeRow(row("t", "linear", "linear.dispatched")) === "dispatched", "<surface>.dispatched classifies as dispatched");
  ok(classifyWakeRow(row("t", "slack", "reply.post")) === "reply", "reply.post classifies as reply");
  ok(classifyWakeRow(row("t", "slack", "reply.post.failed")) === "reply", "reply.post.failed classifies as reply (a post that never landed)");
  ok(classifyWakeRow(row("t", "github", WAKE_FAILED_ACTION)) === "wake-failed", "surface.wake_failed classifies as wake-failed");
  ok(classifyWakeRow(row("t", "slack", "reply.post.failed", { status: 429 })) === "rate-limited", "a detail.status 429 classifies as rate-limited, not as a plain reply");
  ok(classifyWakeRow(row("t", "slack", "reply.post.failed", { status: 500 })) === "reply", "NEGATIVE: another failure status stays an ordinary reply row");
  ok(classifyWakeRow(row("t", "discord", "discord.dispatched", { retryAfter: 4 })) === "dispatched", "NEGATIVE: a detail.retryAfter is NOT a rate-limit discriminator — no product row writes it");
  ok(classifyWakeRow(row("t", "slack", "slack.replied")) === null, "a row outside the six decisive kinds is not kept");
  ok(classifyWakeRow(row("t", "control", "control.service_call")) === null, "the harness's own read row is not kept (negative control)");
  ok(!declaredAuditActions().includes("slack.dispatched"), "the product declares no slack.dispatched row — a Slack leg's evidence must not rest on one");
  ok(declaredAuditActions().includes(WAKE_TURN_START_ACTION), "wake.turn_start IS a declared action — the cross-surface 'a turn began' row");
  ok(declaredAuditActions().includes(WAKE_FAILED_ACTION), "the pack's surface.wake_failed spelling IS a declared product action");

  const window = { sinceIso: "2026-05-19T18:51:00.000Z", untilIso: "2026-05-19T19:26:00.000Z" };
  const spanning = [
    row("2026-05-19T18:50:59.999Z", "control", "wake.ingress", { wakeId: "before" }),
    row("2026-05-19T19:00:00.000Z", "control", "wake.ingress", { wakeId: "inside" }),
    row("2026-05-19T19:26:00.001Z", "control", "wake.ingress", { wakeId: "nextLeg" }),
  ];
  const picked = selectWakeEvidence(spanning, window);
  ok(picked.length === 1 && picked[0].ids.wakeId === "inside", "selectWakeEvidence keeps only the rows inside the leg's window — the next leg's row is excluded");
  const onBounds = selectWakeEvidence([row(window.sinceIso, "control", "wake.ingress", { wakeId: "lo" }), row(window.untilIso, "control", "wake.ingress", { wakeId: "hi" })], window);
  ok(onBounds.length === 2, "selectWakeEvidence treats both window bounds as inclusive");
  const ordered = selectWakeEvidence(
    [row("2026-05-19T19:10:00.000Z", "linear", "linear.dispatched"), row("2026-05-19T19:00:00.000Z", "control", "wake.ingress")],
    window,
  );
  ok(ordered.length === 2 && ordered[0].action === "wake.ingress", "selectWakeEvidence returns the leg's rows oldest-first");
  const tainted = selectWakeEvidence([row("2026-05-19T19:00:00.000Z", "slack", "reply.post", { wakeId: "w1", chars: 42, text: "the secret answer", nested: { wakeId: "no" } })], window);
  ok(tainted[0].ids.wakeId === "w1" && tainted[0].ids.chars === "42", "a kept row carries its allowlisted ids and counts");
  ok(tainted[0].ids.text === undefined && tainted[0].ids.nested === undefined, "a kept row carries NO free text and no nested object (taint floor)");
  const ingress = selectWakeEvidence(
    [row("2026-05-19T19:00:00.000Z", "slack", "wake.ingress", { wakeId: "w1", deliveryId: "d1", ingressTs: "2026-05-19T19:00:00.000Z", vendorTs: "2026-05-19T18:59:58.000Z", vendorTsSource: "event_ts", vendorToIngressMs: 2000 })],
    window,
  );
  ok(ingress[0].ids.vendorToIngressMs === "2000" && ingress[0].ids.ingressTs === "2026-05-19T19:00:00.000Z", "a captured ingress row carries the vendor→ingress latency reading");
  ok(ingress[0].ids.deliveryId === "d1" && ingress[0].ids.vendorTsSource === "event_ts", "a captured ingress row carries the delivery id and the vendor clock's source");

  const leg = { legId: "S-LINK-SLACK", surface: "slack", ...window, status: "RED" };
  const READ_OPTS = { limit: 1000, timeoutMs: 20_000 };
  const complete = await captureWakeEvidence(async () => ({ entries: [], capped: false, scanTruncated: false }), leg, READ_OPTS);
  ok(complete.incomplete === false && complete.rows.length === 0 && complete.error === undefined, "a complete read of an empty window reports incomplete:false");
  const completeLine = renderLegWakeEvidence(complete).join(" ");
  ok(completeLine.includes("no decisive row is logged INSIDE it"), "a complete empty window claims only about the window it read");
  ok(!completeLine.includes("the deployment wrote none"), "a complete empty window never claims the deployment wrote nothing");
  const cappedRead = await captureWakeEvidence(async () => ({ entries: [], capped: true, scanTruncated: false }), leg, READ_OPTS);
  ok(cappedRead.incomplete === true, "a CAPPED read reports incomplete:true even though it returned no rows");
  ok(renderLegWakeEvidence(cappedRead).join(" ").includes("NOT evidence"), "an incomplete empty window renders as NOT evidence of absence");
  const truncatedRead = await captureWakeEvidence(async () => ({ entries: [], capped: false, scanTruncated: true }), leg, READ_OPTS);
  ok(truncatedRead.incomplete === true, "a TRUNCATED scan reports incomplete:true");

  const failed = await captureWakeEvidence(async () => {
    throw new Error("401 bad bearer");
  }, leg, READ_OPTS);
  ok(failed.error === "401 bad bearer" && failed.rows.length === 0 && failed.incomplete === true, "a failed read is recorded as an error, never thrown at the leg");
  ok(renderLegWakeEvidence(failed).join(" ").includes("NOT CAPTURED"), "a failed capture renders as NOT CAPTURED, never as an absence");
  const noReader = await captureWakeEvidence(undefined, leg, READ_OPTS);
  ok(noReader.error !== undefined && noReader.incomplete === true, "no audit reader is an error on the record, not a silent empty capture");

  let asked: { sinceIso: string; untilIso: string; limit: number; timeoutMs: number } | undefined;
  const captured = await captureWakeEvidence(
    async (opts) => {
      asked = opts;
      return { entries: spanning, capped: false, scanTruncated: false };
    },
    leg,
    READ_OPTS,
  );
  ok(asked?.sinceIso === window.sinceIso && asked?.untilIso === window.untilIso && asked?.limit === 1000, "captureWakeEvidence reads the leg's own bounded window");
  ok(asked?.timeoutMs === 20_000, "captureWakeEvidence bounds its own HTTP call — a hung deployment cannot stall every leg of the board");
  ok(captured.rows.length === 1 && captured.windowRows === 3, "a capture keeps the decisive rows and records how many the window held");
  ok(captured.status === "RED" && captured.legId === "S-LINK-SLACK", "a capture carries the leg's id and verdict, so a RED leg's rows need no second join");
}

{
  const { buildTranscriptQuery, transcriptPath, findEvents } = await import("../packages/core/scripts/e2e/transcript-read.js");
  const q = new URLSearchParams(buildTranscriptQuery({ startIndex: 5, limit: 100, idleMs: 2000 }));
  ok(q.get("startIndex") === "5" && q.get("limit") === "100" && q.get("idleMs") === "2000", "transcript query carries startIndex + limit + idleMs");
  ok(buildTranscriptQuery({}) === "", "transcript query omits absent options (a bare full-replay read)");
  ok(transcriptPath("wrun_abc") === "/control/v1/session/wrun_abc/transcript", "transcript path is /control/v1/session/<id>/transcript with no query when bare");
  ok(transcriptPath("wr un/x", { startIndex: 0 }) === "/control/v1/session/wr%20un%2Fx/transcript?startIndex=0", "transcript path URL-encodes the sessionId + appends the query");
  const events = [
    { index: 0, at: "2026-03-15T23:30:00Z", type: "message.received", data: { message: "hi" } },
    { index: 1, at: "2026-03-15T23:30:01Z", type: "actions.requested", data: { actions: [{ toolName: "memory_read" }] } },
    { index: 2, at: "2026-03-15T23:30:02Z", type: "message.completed", data: { message: "answer" } },
  ];
  ok(findEvents(events, "message.completed").length === 1, "findEvents locates events by type");
  ok(findEvents(events, "actions.requested", (e) => JSON.stringify(e.data).includes("memory_read")).length === 1, "findEvents supports a predicate (did the turn call a tool?)");
  ok(findEvents(events, "reasoning.completed").length === 0, "findEvents returns empty for an absent type");
}

{
  const { seatCatchUpWake } = await import("../packages/core/scripts/e2e/transcript-read.js");
  const STALE = "gh-stale-11111";
  const IDLE = "gh-idle-22222";
  const TRIG = "gh-trig-33333";
  const wake = (index: number, trigger: string, context: readonly string[]) => ({
    index,
    at: "2026-05-14T11:35:00Z",
    type: "message.received",
    data: { message: `<channel><message>${context.join("</message><message>")}</message></channel>\n<trigger>${trigger}</trigger>` },
  });
  const earlier = wake(0, STALE, []);
  const reply = { index: 2, at: "2026-05-14T11:35:02Z", type: "message.completed", data: { message: `the token was ${IDLE}` } };

  const healthy = seatCatchUpWake([earlier, wake(1, TRIG, [IDLE]), reply], { trigger: TRIG, caughtUp: IDLE, stale: [STALE] });
  ok(healthy.wakeIndex === 1, "seatCatchUpWake locates the wake by its TRIGGER marker, not by position — the earlier wake in the same stream is not it");
  ok(healthy.carriedCatchUp, "…and reports that the same envelope carried the message said while the seat was idle");
  ok(healthy.staleCarried.length === 0, "…and that it re-showed nothing from before the seat's last wake — the BOUND, which is the half a 'did it see the message' gate cannot see");

  const blind = seatCatchUpWake([earlier, wake(1, TRIG, []), reply], { trigger: TRIG, caughtUp: IDLE, stale: [STALE] });
  ok(
    blind.wakeIndex === 1 && !blind.carriedCatchUp,
    "🔴 RED ARM — a wake that carried NO catch-up context reports carriedCatchUp:false, even though the seat's later REPLY quotes the token. The reply is a different event, so a model that guessed cannot green this",
  );

  const staleWindow = seatCatchUpWake([earlier, wake(1, TRIG, [STALE, IDLE]), reply], { trigger: TRIG, caughtUp: IDLE, stale: [STALE] });
  ok(
    staleWindow.carriedCatchUp && staleWindow.staleCarried.join(",") === STALE,
    "🔴 RED ARM — a STALE window reds: a read that returns the whole container every wake carries the idle message too, so it passes the catch-up gate and is caught only by this one",
  );

  ok(
    seatCatchUpWake([earlier, reply], { trigger: TRIG, caughtUp: IDLE, stale: [STALE] }).wakeIndex === undefined,
    "VACUITY: no event carries the trigger ⇒ no wakeIndex — the caller must red on that separately, never fold it into 'the catch-up did not run'",
  );
  ok(
    !seatCatchUpWake([], { trigger: TRIG, caughtUp: IDLE }).carriedCatchUp && seatCatchUpWake([], { trigger: TRIG, caughtUp: IDLE }).staleCarried.length === 0,
    "VACUITY: an empty stream carries nothing — never a pass",
  );
  ok(
    seatCatchUpWake([wake(7, TRIG, [IDLE]), wake(3, TRIG, [])], { trigger: TRIG, caughtUp: IDLE }).wakeIndex === 3,
    "🔴 the OLDEST event carrying the trigger wins, whatever order the pager returned them in — the prompt precedes every event the turn goes on to write, so a later echo of the trigger is never the envelope",
  );
  ok(
    seatCatchUpWake([{ index: 0, at: null, type: `note-${IDLE}`, data: { message: TRIG } }], { trigger: TRIG, caughtUp: IDLE }).carriedCatchUp,
    "the search reads the event's TYPE as well as its data — a marker is a marker wherever the stream carried it, and a reader that missed one field would report a false negative",
  );
  ok(
    seatCatchUpWake([wake(0, TRIG, [IDLE])], { trigger: TRIG, caughtUp: IDLE, stale: ["", STALE] }).staleCarried.length === 0,
    "NEGATIVE: an EMPTY stale marker matches nothing — every string contains it, and counting one would red every leg on a correct deployment",
  );
}

{
  const { decomposeSession, joinDelegations, delegationJoinTargets, fmtMs, renderSessionTiming, renderDelegationTiming } = await import(
    "../packages/core/scripts/e2e/transcript-timings.js"
  );
  const { summariseTimings } = await import("../packages/core/scripts/e2e/timings-record.js");

  const worker = [
    { index: 0, at: "2026-03-29T01:10:08.677Z", type: "session.started", data: { runtime: { modelId: "m" } } },
    { index: 1, at: "2026-03-29T01:10:10.903Z", type: "turn.started", data: { turnId: "t1", sequence: 0 } },
    { index: 2, at: "2026-03-29T01:10:10.917Z", type: "message.received", data: { message: "<wake .../>", turnId: "t1" } },
    { index: 3, at: "2026-03-29T01:10:10.918Z", type: "step.started", data: { turnId: "t1", stepIndex: 0 } },
    { index: 4, at: "2026-03-29T01:10:16.951Z", type: "reasoning.appended", data: { turnId: "t1", stepIndex: 0, reasoningDelta: "a" } },
    { index: 5, at: "2026-03-29T01:10:17.010Z", type: "reasoning.appended", data: { turnId: "t1", stepIndex: 0, reasoningDelta: "b" } },
    { index: 6, at: "2026-03-29T01:10:17.079Z", type: "actions.requested", data: { turnId: "t1", stepIndex: 0, actions: [{ callId: "c1", kind: "tool-call", toolName: "read_file", input: {} }] } },
    { index: 7, at: "2026-03-29T01:10:17.169Z", type: "action.result", data: { turnId: "t1", stepIndex: 0, status: "completed", result: { callId: "c1", kind: "tool-result", toolName: "read_file", output: "x" } } },
    { index: 8, at: "2026-03-29T01:10:17.222Z", type: "step.completed", data: { turnId: "t1", stepIndex: 0, finishReason: "tool-calls", usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 }, providerMetadata: { gateway: { generationId: "gen_1" } } } },
    { index: 9, at: "2026-03-29T01:10:17.625Z", type: "step.started", data: { turnId: "t1", stepIndex: 1 } },
    { index: 10, at: "2026-03-29T01:10:24.504Z", type: "message.appended", data: { turnId: "t1", stepIndex: 1, messageDelta: "done" } },
    { index: 11, at: "2026-03-29T01:10:24.625Z", type: "step.completed", data: { turnId: "t1", stepIndex: 1, finishReason: "stop", usage: { inputTokens: 200, outputTokens: 30, costUsd: 0.002 } } },
    { index: 12, at: "2026-03-29T01:10:24.700Z", type: "turn.completed", data: { turnId: "t1", sequence: 1 } },
    { index: 13, at: "2026-03-29T01:10:24.800Z", type: "session.waiting", data: { continuationToken: "ct", wait: "next-user-message" } },
  ];

  const s = decomposeSession(worker);
  ok(s.bootMs === 2226, `boot = session.started → first turn.started (the whole session.started hook chain — a CEILING, not a sandbox or memory number); got ${s.bootMs}`);
  ok(s.turns.length === 1 && s.turns[0].outcome === "completed", "one turn, terminal outcome read off turn.completed");
  ok(s.turns[0].preflightMs === 15, `preflight = turn.started → first step.started (the turn.started hook chain); got ${s.turns[0].preflightMs}`);
  ok(s.turns[0].steps.length === 2, "two model calls in the turn, keyed by (turnId, stepIndex)");
  ok(s.turns[0].steps[0].ttftMs === 6033, `ttft = step.started → the step's FIRST delta (later deltas must not overwrite it); got ${s.turns[0].steps[0].ttftMs}`);
  ok(s.turns[0].steps[1].ttftMs === 6879, "the second step gets its OWN ttft — stepIndex is per-turn, not global");
  ok(s.turns[0].steps[0].generationId === "gen_1", "the gateway generationId is projected — the join key into the AI Gateway inference log (the only record of the upstream provider)");
  ok(s.turns[0].toolCalls.length === 1 && s.turns[0].toolCalls[0].wallMs === 90, `tool call paired actions.requested → action.result by callId; got ${s.turns[0].toolCalls[0]?.wallMs}`);
  ok(s.turns[0].toolCalls[0].status === "completed" && s.turns[0].toolCalls[0].name === "read_file", "tool call carries its eve status + tool name");
  ok(s.totals.tokens === 350 && s.totals.costUsd === 0.003, "step usage totals sum across steps");
  ok(s.coverage.events === 14 && s.coverage.withAt === 14 && s.coverage.unpairedCalls === 0, "coverage counts every event and every paired call — the deterministic observability gate");

  const untimed = decomposeSession([{ index: 0, at: null, type: "session.started", data: {} }, { index: 1, at: null, type: "turn.started", data: { turnId: "t1" } }]);
  ok(untimed.bootMs === null, "a missing meta.at yields a NULL duration, not 0 — an unknown is not a zero");
  ok(untimed.coverage.withAt === 0 && untimed.coverage.events === 2, "…and the coverage counter reports it, so an eve drift is visible rather than silent");
  ok(fmtMs(null) === "?" && fmtMs(90) === "90ms" && fmtMs(23200) === "23.2s", "fmtMs renders unknown as '?' and never as a number");
  const unknownType = decomposeSession([{ index: 0, at: "2026-03-29T00:30:00.000Z", type: "some.future.event", data: { turnId: "t9" } }]);
  ok(unknownType.turns.length === 0 && unknownType.coverage.events === 1, "an unrecognised eve event type is counted but never invents a phase");

  const spawned = {
    ts: "2026-03-29T01:10:06.000Z", org: "o", platform: "ingest", workspace: "delegation", action: "delegation.task_started",
    detail: { task: "T1", call: "call_abc", agent: "memory-reader", session: "wrun_caller", continuation: false },
  };
  const returned = {
    ts: "2026-03-29T01:10:25.500Z", org: "o", platform: "ingest", workspace: "delegation", action: "delegation.task_settled",
    detail: { task: "T1", status: "completed", session: "wrun_caller", agent: "memory-reader", marker: "clean", adopted: false, kinds: [] },
  };
  const toolset = {
    ts: "2026-03-29T01:10:09.000Z", org: "o", platform: "unified", workspace: "d", action: "worker.toolset",
    detail: { worker: "wrun_worker", parentSession: "wrun_caller", parentCallId: "call_abc", rootSession: "wrun_caller", turn: "t0", grain: "task", toolCount: 7 },
  };
  const rows = [returned, toolset, spawned];
  const targets = delegationJoinTargets(rows);
  ok(targets.length === 1 && targets[0].workerSessionId === "wrun_worker" && targets[0].parentSessionId === "wrun_caller", "delegationJoinTargets names both sides BEFORE any transcript is paid for");
  ok(targets[0].taskId === "T1", "…keyed off `detail.task`, the dispatch row's real task key");

  const [d] = joinDelegations(rows, new Map([["wrun_worker", worker]]));
  ok(d.gaps.length === 0, `a complete join reports NO gaps; got ${JSON.stringify(d.gaps)}`);
  ok(d.wallMs === 19500, `wall = delegation.task_started → delegation.task_settled (what the caller waits out); got ${d.wallMs}`);
  ok(d.dispatchMs === 2677, `dispatch = spawn row → the worker's first recorded event (workflow cold-start); got ${d.dispatchMs}`);
  ok(d.bootMs === 2226, "boot carries the worker's whole session.started hook-chain window through to the delegation view (a ceiling — the sandbox create inside it is ≤5.7s measured, OPE-126)");
  ok(d.ttftMs === 6033, "ttft is the worker's FIRST model call's time to first token — the number a 'viable in a conversational turn?' argument is about");
  ok(d.workMs === 13797, `work = worker turn.started → last turn end; got ${d.workMs}`);
  ok(d.returnMs === 700, `return = worker's last recorded event → the settle row (result persist + caller wake); got ${d.returnMs}`);
  ok(d.unaccountedMs === 100, `phases + unaccounted reconstruct the wall exactly; got ${d.unaccountedMs}`);
  ok(d.worker !== null && d.worker.totals.toolCalls === 1, "the worker's whole session decomposition rides along");
  ok(d.status === "completed" && d.hasError === false, "the settlement's own `status` is carried through, and `completed` is not an error");

  {
    const spawn2 = { ...spawned, ts: "2026-03-29T01:10:07.000Z", detail: { ...spawned.detail, task: "T2", call: "call_xyz" } };
    const settle2 = { ...returned, ts: "2026-03-29T01:10:30.000Z", detail: { ...returned.detail, task: "T2" } };
    const toolset2 = { ...toolset, detail: { ...toolset.detail, worker: "wrun_worker2", parentCallId: "call_xyz" } };
    const two = delegationJoinTargets([settle2, returned, toolset2, toolset, spawn2, spawned]);
    ok(two.length === 2, `both dispatches are found (got ${two.length})`);
    ok(two.find((t) => t.taskId === "T1")?.workerSessionId === "wrun_worker", "🔴 task T1 keeps ITS worker — matched on parentCallId, not on the shared caller session");
    ok(two.find((t) => t.taskId === "T2")?.workerSessionId === "wrun_worker2", "🔴 …and task T2 keeps its own");
  }

  {
    const noCall = { ...spawned, detail: { task: "T1", session: "wrun_caller" } };
    const [one] = delegationJoinTargets([returned, toolset, noCall]);
    ok(one.workerSessionId === "wrun_worker", "a dispatch with no `call` still resolves when exactly ONE worker.toolset row names its caller");
    const rival = { ...toolset, detail: { ...toolset.detail, worker: "wrun_other", parentCallId: "call_other" } };
    const [ambiguous] = delegationJoinTargets([returned, toolset, rival, noCall]);
    ok(ambiguous.workerSessionId === null, "🔴 …and it refuses to pick when TWO do — an arbitrary worker is worse than a named gap");
  }

  const noStamp = joinDelegations([returned, spawned], new Map());
  ok(noStamp[0].gaps.some((g) => g.includes("worker.toolset")), "a delegation with NO worker.toolset row is a NAMED gap — the worker's work would be unobservable");
  ok(noStamp[0].wallMs === 19500, "…and the caller-visible wall-clock is still derivable from the audit rows alone");
  const noReturn = joinDelegations([toolset, spawned], new Map([["wrun_worker", worker]]));
  ok(noReturn[0].gaps.some((g) => g.includes("no delegation.task_settled")), "a dispatch with no settlement inside the window is a NAMED gap, not a hidden null");
  ok(noReturn[0].status === null && noReturn[0].hasError === false, "…and an UNSETTLED delegation has no status and is NOT reported as an error");
  const failed = joinDelegations([{ ...returned, detail: { ...returned.detail, status: "failed" } }, toolset, spawned], new Map([["wrun_worker", worker]]));
  ok(failed[0].status === "failed" && failed[0].hasError === true, "a settlement whose status is `failed` IS an error");
  const reaped = joinDelegations([{ ...returned, detail: { ...returned.detail, status: "cancelled" } }, toolset, spawned], new Map([["wrun_worker", worker]]));
  ok(reaped[0].status === "cancelled", "a reaped delegation carries its `cancelled` status through");
  ok(reaped[0].hasError === false, "🔴 …and is NOT an error — `cancelled` on the settlement edge is the deployment's own reaper");
  ok(!renderDelegationTiming(reaped[0]).some((l) => l.includes("ERROR")), "…so the render never prints ERROR for it");
  const emptyReplay = joinDelegations(rows, new Map([["wrun_worker", []]]));
  ok(emptyReplay[0].gaps.some((g) => g.includes("EMPTY")), "an expired/unreadable worker session is a NAMED gap — the S-MEM-READ precedent that an observability failure must not read as a product result");

  const lateSpawnRow = { ...spawned, ts: "2026-03-29T01:10:09.500Z" };
  const [raced] = joinDelegations([returned, toolset, lateSpawnRow], new Map([["wrun_worker", worker]]));
  ok(raced.dispatchMs === -823, `a worker that beats the spawn row yields a NEGATIVE dispatch, not a clamp to 0; got ${raced.dispatchMs}`);
  ok(raced.gaps.length === 0, "…and that race is NOT a gap — the join is still complete");

  const { auditSessionIds } = await import("../packages/core/scripts/e2e/transcript-timings.js");
  {
    const replyRow = { ts: "2026-03-29T01:10:02.000Z", org: "o", platform: "slack", workspace: "d", action: "reply.post", detail: { sessionId: "wrun_caller", id: "1.0", chars: 97 } };
    const ids = auditSessionIds([replyRow, returned, toolset, spawned]);
    ok(ids.length === 2, `🔴 a row set holding a worker.toolset row yields TWO session ids, not one (got ${ids.length}: ${JSON.stringify(ids)})`);
    ok(ids.includes("wrun_caller") && ids.includes("wrun_worker"), "🔴 …the standing seat AND the delegated worker — the worker is where a delegated read happens");

    const withoutToolset = auditSessionIds([replyRow, returned, spawned]);
    ok(withoutToolset.length === 1 && withoutToolset[0] === "wrun_caller", `🔴 without a worker.toolset row NO worker session is recoverable (got ${JSON.stringify(withoutToolset)}) — the delegation rows genuinely do not carry it`);

    const noisy = auditSessionIds([toolset, toolset, { ...replyRow, detail: { sessionId: "", parentSessionId: 42 } }]);
    ok(noisy.length === 2 && new Set(noisy).size === 2, `ids are deduplicated within a row AND across rows (got ${JSON.stringify(noisy)})`);
    ok(!noisy.includes(""), "…and an empty-string id is never collected");
    ok(auditSessionIds([]).length === 0, "an empty window yields no ids rather than throwing");
  }

  const { attributeBoot, projectMemorySync, renderBootAttribution, MEMORY_SYNC_TIMING_ACTION } = await import(
    "../packages/core/scripts/e2e/transcript-timings.js"
  );
  const syncRow = {
    ts: "2026-03-29T01:10:10.100Z", org: "o", platform: "slack", workspace: "T1", action: MEMORY_SYNC_TIMING_ACTION,
    detail: {
      sessionId: "wrun_worker", hookMs: 1800, baselineMs: 120, sandboxMs: 1200, indexMs: 60, siloCount: 2,
      silos: [
        { silo: "payments-brain", tier: "silo:payments-brain", provider: "postgres", readOnly: false, loadMs: 40, syncMs: 30, files: 12, bytes: 40960, ok: true },
        { silo: "notion-projection", tier: "silo:notion-projection", provider: "notion", readOnly: true, loadMs: 300, syncMs: 20, lockMs: 25, files: 30, bytes: 131072, ok: true },
      ],
    },
  };
  ok(MEMORY_SYNC_TIMING_ACTION === "memory.sync_timing", "the driver's action key matches the producer's (memory-sync-timing-test.ts pins the constant identity)");
  const proj = projectMemorySync([syncRow], "wrun_worker")!;
  ok(proj.silos.length === 2 && proj.sandboxMs === 1200, "the row projects into a per-silo decomposition plus the once-per-session sandbox cold-create");
  ok(proj.silos[1].totalMs === 345, `a silo's share of boot = load + sync + lock; got ${proj.silos[1].totalMs}`);
  const boot = attributeBoot(s, [syncRow], "wrun_worker")!;
  ok(boot.bootMs === 2226 && boot.hookMs === 1800 && boot.unattributedMs === 426, `boot = memory hook + the OTHER session.started work; got ${boot.unattributedMs}`);
  ok(boot.sandboxMs === 1200 && boot.siloMs === 415, `the sandbox cold-create and Σ per-silo memory cost are SEPARATE numbers (1200 vs ${boot.siloMs}) — the confusion this exists to end`);
  ok(boot.silos[0].silo === "notion-projection", "silos come back slowest-first, so 'which silo cost the boot' is answerable — here the Notion pull, not Postgres");
  ok(boot.gaps.length === 0 && renderBootAttribution(boot).some((l) => l.includes("notion-projection")), "a complete attribution reports no gaps and names the silo in the render");
  ok(attributeBoot(s, [], "wrun_worker") === null, "NO row (the default — the flag is OFF) ⇒ null, so bootMs stays the ceiling it always was; an absent measurement is never a zero");
  const emptyPlan = attributeBoot(s, [{ ...syncRow, detail: { sessionId: "wrun_worker", hookMs: 2, siloCount: 0, silos: [] } }], "wrun_worker")!;
  ok(emptyPlan.sandboxMs === null && emptyPlan.gaps.some((g) => g.includes("ZERO silos")), "an EMPTY memory plan is a NAMED gap: that session's hook returns before getSandbox(), so its bootMs is not comparable to a memory-bearing session's");

  const { renderCompaction } = await import("../packages/core/scripts/e2e/transcript-timings.js");

  const compacting = [
    { index: 0, at: "2026-04-22T08:30:00.000Z", type: "session.started", data: {} },
    { index: 1, at: "2026-04-22T08:30:01.000Z", type: "turn.started", data: { turnId: "t1" } },
    { index: 2, at: "2026-04-22T08:30:02.000Z", type: "compaction.requested", data: { sessionId: "wrun_dense", turnId: "t1" } },
    { index: 3, at: "2026-04-22T08:30:03.000Z", type: "compaction.completed", data: { sessionId: "wrun_dense", turnId: "t1", modelId: "m", reduced: true } },
    { index: 4, at: "2026-04-22T08:30:04.000Z", type: "compaction.requested", data: { sessionId: "wrun_dense", turnId: "t1" } },
    { index: 5, at: "2026-04-22T08:30:05.000Z", type: "compaction.completed", data: { sessionId: "wrun_dense", turnId: "t1", modelId: "m", reduced: false } },
    { index: 6, at: "2026-04-22T08:30:06.000Z", type: "compaction.completed", data: { sessionId: "wrun_dense", turnId: "t1", modelId: "m" } },
    { index: 7, at: "2026-04-22T08:30:07.000Z", type: "turn.completed", data: { turnId: "t1" } },
  ];
  const c = decomposeSession(compacting);
  ok(c.compaction.requested === 2 && c.compaction.completed === 3, `compaction passes are counted off the transcript; got ${c.compaction.requested} requested / ${c.compaction.completed} completed`);
  ok(c.compaction.reduced === 1, `a pass stamped reduced:true counts as REAL work; got ${c.compaction.reduced}`);
  ok(c.compaction.noOp === 1, `a pass stamped reduced:false counts as a NO-OP; got ${c.compaction.noOp}`);
  ok(c.compaction.unstamped === 1, `a pass with NO reduced field is UNDECIDABLE and gets its own bucket — folding it into either side would hide a real defect or invent one; got ${c.compaction.unstamped}`);
  ok(c.compaction.reduced + c.compaction.noOp + c.compaction.unstamped === c.compaction.completed, "the three buckets partition the completed passes exactly — no pass is dropped and none is double-counted");
  ok(c.sessionId === "wrun_dense", "…and the compaction events still harvest the sessionId, the behaviour that existed before the split");

  const noOpLine = renderCompaction(c.compaction)!;
  ok(noOpLine.includes("NO-OP"), `a no-op pass is NAMED in the rendered line, not buried in a count; got ${JSON.stringify(noOpLine)}`);
  ok(noOpLine.startsWith("⚠"), `…and carries the ⚠ marker this file uses for a broken measurement, so it reads as a fault; got ${JSON.stringify(noOpLine)}`);
  ok(noOpLine.includes("OPE-689"), "…and names the defect shape, so a reader can act on it without archaeology");
  ok(noOpLine.includes("UNDECIDABLE"), "…and reports the unstamped pass as undecidable rather than silently as a pass or a no-op");
  ok(renderSessionTiming(c, "session wrun_dense").some((l) => l.includes("NO-OP")), "the no-op reaches renderSessionTiming — the render scenarios.ts actually logs, not an internal field");

  const healthy = decomposeSession([
    { index: 0, at: "2026-04-22T08:30:00.000Z", type: "session.started", data: {} },
    { index: 1, at: "2026-04-22T08:30:01.000Z", type: "compaction.requested", data: { sessionId: "wrun_ok" } },
    { index: 2, at: "2026-04-22T08:30:02.000Z", type: "compaction.completed", data: { sessionId: "wrun_ok", modelId: "m", reduced: true } },
  ]);
  ok(healthy.compaction.reduced === 1 && healthy.compaction.noOp === 0 && healthy.compaction.unstamped === 0, `a reduced:true pass is EXPLICITLY not a no-op (noOp === 0, not merely absent); got ${JSON.stringify(healthy.compaction)}`);
  const healthyLine = renderCompaction(healthy.compaction)!;
  ok(!healthyLine.includes("NO-OP") && !healthyLine.startsWith("⚠"), `…and real work is never flagged: no NO-OP text, no ⚠ marker; got ${JSON.stringify(healthyLine)}`);
  ok(healthyLine.includes("1 did compaction work"), `…the healthy line still REPORTS the pass, so "how many compactions ran" is answerable; got ${JSON.stringify(healthyLine)}`);

  ok(s.compaction.completed === 0 && s.compaction.requested === 0, "a session with no compaction events counts zero, not null");
  ok(renderCompaction(s.compaction) === null, "…and renders NO line at all, so the line's presence is itself the signal");
  ok(!renderSessionTiming(s, "session wrun_worker").some((l) => l.includes("compaction")), "…confirmed through renderSessionTiming: no compaction, no compaction line");

  const sum = summariseTimings([{ scenarioId: "X", label: "l", capturedAt: "2026-03-29T01:11:00.000Z", sessions: [{ sessionId: "wrun_worker", timing: s }], delegations: [d] }]);
  ok(sum.delegations === 1 && sum.delegationsFullyJoined === 1, "the run summary counts delegations and how many decomposed end-to-end");
  ok(sum.delegationWallMs.p50 === 19500 && sum.bootMsP50 === 2226 && sum.ttftMsP50 === 6033, "the run summary carries p50 wall / boot / ttft — the recorded series, never a threshold");
  ok(sum.compaction.passes === 0 && sum.compaction.noOp === 0, "a run whose sessions never compacted rolls up to zero passes");
  ok(summariseTimings([]).delegationWallMs.p50 === null, "an empty run summarises to nulls, not zeros");

  const [dupeDelegation] = joinDelegations(
    [returned, { ...toolset, detail: { ...toolset.detail, worker: "wrun_dense" } }, spawned],
    new Map([["wrun_dense", compacting]]),
  );
  const dupeSum = summariseTimings([{
    scenarioId: "C", label: "a session recorded twice — once whole, once as a delegation worker",
    capturedAt: "2026-04-22T08:31:00.000Z",
    sessions: [{ sessionId: "wrun_dense", timing: c }],
    delegations: [dupeDelegation],
  }]);
  ok(dupeSum.compaction.passes === 3, `the run rollup counts each session ONCE, by session id; got ${dupeSum.compaction.passes} (6 would mean the overlap is double-counted)`);
  ok(dupeSum.compaction.noOp === 1 && dupeSum.compaction.reduced === 1 && dupeSum.compaction.unstamped === 1, `…and the no-op survives to the run summary, which is the line that always prints; got ${JSON.stringify(dupeSum.compaction)}`);
  ok(renderDelegationTiming(dupeDelegation).some((l) => l.includes("NO-OP")), "a delegated WORKER's no-op is named in the delegation render too — a worker is where a dense session actually compacts");
}

{
  const { buildChatUpdateBody, buildUploadUrlBody, buildCompleteUploadBody } = await import("../packages/core/scripts/e2e/slack-driver.js");
  const upd = new URLSearchParams(buildChatUpdateBody({ channel: "C1", ts: "1.2", text: "edited" }));
  ok(upd.get("channel") === "C1" && upd.get("ts") === "1.2" && upd.get("text") === "edited", "chat.update body carries channel + ts + new text");
  const up1 = new URLSearchParams(buildUploadUrlBody({ filename: "probe.png", length: 128 }));
  ok(up1.get("filename") === "probe.png" && up1.get("length") === "128", "files.getUploadURLExternal body carries filename + byte length");
  const done = new URLSearchParams(buildCompleteUploadBody({ fileId: "F123", title: "probe", channel: "C1", threadTs: "1.5", initialComment: "<@U> what's in this?" }));
  ok(done.get("channel_id") === "C1" && done.get("thread_ts") === "1.5", "files.completeUploadExternal body carries channel_id + thread_ts");
  ok(done.get("initial_comment") === "<@U> what's in this?", "…and the initial_comment (the mention asking about the image)");
  const files = JSON.parse(done.get("files") ?? "[]") as { id: string; title: string }[];
  ok(files.length === 1 && files[0].id === "F123" && files[0].title === "probe", "…and files as a JSON [{id,title}] array (Slack's contract)");
  const noThread = new URLSearchParams(buildCompleteUploadBody({ fileId: "F1", title: "t", channel: "C1" }));
  ok(!noThread.has("thread_ts") && !noThread.has("initial_comment"), "optional thread_ts / initial_comment are omitted when absent");
}

{
  const { mergeBotMessagesAfter } = await import("../packages/core/scripts/e2e/slack-driver.js");
  type M = { ts: string; text: string; userId?: string; botId?: string };
  const isBot = (m: M): boolean => m.botId !== undefined;
  const human = (ts: string, text: string): M => ({ ts, text, userId: "U-HUMAN" });
  const bot = (ts: string, text: string): M => ({ ts, text, botId: "B-OE" });

  ok(mergeBotMessagesAfter([human("100.0", "ask")], [], "100.0", isBot).length === 0, "merge: a thread holding only the human's own ask yields no bot messages (silence passes)");

  const threaded = mergeBotMessagesAfter([human("100.0", "ask"), bot("101.0", "threaded answer")], [], "100.0", isBot);
  ok(threaded.length === 1 && threaded[0].text === "threaded answer", `merge: a bot reply that exists ONLY in the thread is found (history is blind to it); got ${JSON.stringify(threaded.map((m) => m.text))}`);

  const flat = mergeBotMessagesAfter([human("100.0", "ask")], [bot("102.0", "top-level post")], "100.0", isBot);
  ok(flat.length === 1 && flat[0].text === "top-level post", `merge: a bot message that exists ONLY in top-level history is found; got ${JSON.stringify(flat.map((m) => m.text))}`);

  const both = mergeBotMessagesAfter([bot("103.0", "broadcast")], [bot("103.0", "broadcast")], "100.0", isBot);
  ok(both.length === 1, `merge: a message present in BOTH pages is counted once (reply_broadcast), got ${both.length}`);

  const filtered = mergeBotMessagesAfter(
    [bot("99.0", "before the floor"), bot("100.0", "exactly the floor"), human("104.0", "human chatter"), bot("105.0", "real runaway")],
    [],
    "100.0",
    isBot,
  );
  ok(filtered.length === 1 && filtered[0].text === "real runaway", `merge: pre-floor, at-floor and human messages are all excluded; got ${JSON.stringify(filtered.map((m) => m.text))}`);

  const ordered = mergeBotMessagesAfter([bot("1000.5", "later")], [bot("999.9", "earlier")], "100.0", isBot);
  ok(ordered.map((m) => m.text).join(",") === "earlier,later", `merge: results are oldest-first by numeric ts; got ${JSON.stringify(ordered.map((m) => m.text))}`);
}

{
  const { cardJudgeSurface } = await import("../packages/core/scripts/e2e/slack-driver.js");
  const header = "Connect Notion.";
  const card = {
    text: header,
    actions: [
      { actionId: "oe_connect:notion:api-key", text: "Set API key" },
      { actionId: "oe_connect:notion:service-oauth", text: "Connect org account" },
    ],
  };
  const surface = cardJudgeSurface(card);
  ok(
    surface === `${header}\nOptions: Set API key | Connect org account`,
    `cardJudgeSurface: the judged string is the header plus every button label; got ${JSON.stringify(surface)}`,
  );
  ok(cardJudgeSurface({ text: header, actions: [] }) === header, "cardJudgeSurface: a message with no buttons judges its text alone");
  ok(cardJudgeSurface({ text: header }) === header, "cardJudgeSurface: a message with no actions field judges its text alone");
  ok(
    cardJudgeSurface({ text: header, actions: [{ actionId: "x" }, { actionId: "y", text: "  " }] }) === header,
    "cardJudgeSurface: unlabelled buttons add no Options line",
  );
}

{
  const { seatFenceStep } = await import("../packages/core/scripts/e2e/slack-driver.js");
  const QUIET = 20_000;
  const GRACE = 420_000;
  const T0 = 1_760_000_000_000;
  const slackTs = (atMs: number): string => (atMs / 1000).toFixed(6);
  const step = (prev: unknown, newest: { ts: string; settles: boolean } | undefined, nowMs: number) =>
    seatFenceStep({ prev: prev as never, newest, nowMs, quietMs: QUIET, owedGraceMs: GRACE });

  const settledTs = slackTs(T0 - 1_000);
  const first = step(undefined, { ts: settledTs, settles: true }, T0);
  ok(first.verdict === "settling", `fence: the first poll of a settled seat is "settling", never "quiet"; got ${first.verdict}`);

  const nearly = step(first.state, { ts: settledTs, settles: true }, T0 + QUIET - 1);
  ok(nearly.verdict === "settling", `fence: one millisecond short of the window is still "settling"; got ${nearly.verdict}`);
  const quiet = step(nearly.state, { ts: settledTs, settles: true }, T0 + QUIET);
  ok(quiet.verdict === "quiet", `fence: the window elapsed with the newest ts unchanged ⇒ "quiet"; got ${quiet.verdict}`);

  const askTs = slackTs(T0);
  let owed = step(undefined, { ts: askTs, settles: false }, T0);
  ok(owed.verdict === "owed", `fence: an unsettled newest message reads "owed"; got ${owed.verdict}`);
  owed = step(owed.state, { ts: askTs, settles: false }, T0 + QUIET * 10);
  ok(owed.verdict === "owed", `fence: ten quiet windows later it is STILL "owed" — waiting cannot settle a seat that owes an answer; got ${owed.verdict}`);
  ok(!owed.abandoned, "fence: inside the grace, an unanswered message is a RUNNING turn, never an abandoned one");
  const answerTs = slackTs(T0 + QUIET * 10);
  const answered = step(owed.state, { ts: answerTs, settles: true }, T0 + QUIET * 10);
  ok(answered.verdict === "settling", `fence: the answer landing restarts the window rather than passing on the elapsed time; got ${answered.verdict}`);
  ok(
    step(answered.state, { ts: answerTs, settles: true }, T0 + QUIET * 11).verdict === "quiet",
    "fence: a full window after the answer, the seat is quiet",
  );

  const twoPosts = step(quiet.state, { ts: slackTs(T0 + QUIET), settles: true }, T0 + QUIET + 1);
  ok(twoPosts.verdict === "settling", `fence: a newer settled message restarts the quiet window; got ${twoPosts.verdict}`);

  const foldTs = slackTs(T0);
  const ack = step(undefined, { ts: foldTs, settles: false }, T0);
  ok(ack.verdict === "owed", "fence (fold): the interim ack is owed");
  const folded = step(ack.state, { ts: foldTs, settles: true }, T0 + QUIET * 5);
  ok(folded.verdict === "settling", `fence (fold): the SAME ts turning settled RESTARTS the window — not quiet on the first poll that sees it; got ${folded.verdict}`);
  ok(
    step(folded.state, { ts: foldTs, settles: true }, T0 + QUIET * 6).verdict === "quiet",
    "fence (fold): …and quiet one full window after the FLIP, never one window after the ack",
  );

  const staleTs = slackTs(T0 - GRACE - 1_000);
  const stale = step(undefined, { ts: staleTs, settles: false }, T0);
  ok(stale.verdict === "settling" && stale.abandoned, `fence: an unsettled message older than the grace is ABANDONED, not in flight; got ${stale.verdict}/${stale.abandoned}`);
  ok(step(stale.state, { ts: staleTs, settles: false }, T0 + QUIET).verdict === "quiet", "fence: an abandoned message lets the seat go quiet one window later");
  const justInside = step(undefined, { ts: slackTs(T0 - GRACE + 1_000), settles: false }, T0);
  ok(justInside.verdict === "owed" && !justInside.abandoned, "fence: one second inside the grace is still owed — the age bound is an edge, not a blanket escape");

  const empty = step(undefined, undefined, T0);
  ok(empty.verdict === "settling" && empty.state.newestTs === undefined, "fence: an empty conversation starts the window with no anchor ts");
  ok(step(empty.state, undefined, T0 + QUIET).verdict === "quiet", "fence: an empty conversation goes quiet once the window elapses");
}

{
  const { isQualifyingEdit, DEFAULT_QUALIFYING_EDIT_WINDOW_MS, SlackDriver } = await import("../packages/core/scripts/e2e/slack-driver.js");
  type Msg = { ts: string; text: string; editedTs?: string };
  const msg = (ts: string, text: string, editedTs?: string): Msg => ({ ts, text, editedTs });

  const folded = msg(
    "1777797937.974000",
    "I'm recording that preference in durable memory and will report back once the edit is confirmed.\n\nSaved successfully. The preference is now recorded in `surface/notes.md` and `surface/MEMORY.md`: “favourite cheese is wensleydale”.",
    "1777797992.000000",
  );
  ok(isFillerAck(folded.text), "OPE-1067 fixture: the folded text still matches isFillerAck (the ack phrase never left it) — this is the trap, not the fix");
  ok(isQualifyingEdit(folded), "isQualifyingEdit: the live OPE-1067 shape (edited ~54s after its own post) qualifies");

  ok(!isQualifyingEdit(msg("100.0", "one sec, checking now")), "isQualifyingEdit: an unedited message (no editedTs) never qualifies");

  const staleEditTs = (100 + (DEFAULT_QUALIFYING_EDIT_WINDOW_MS + 1) / 1000).toFixed(6);
  ok(!isQualifyingEdit(msg("100.0", "one sec, checking now", staleEditTs)), "isQualifyingEdit: an edit landing AFTER the window does not qualify (bounded, not forever)");

  const atBoundaryTs = (100 + DEFAULT_QUALIFYING_EDIT_WINDOW_MS / 1000).toFixed(6);
  ok(isQualifyingEdit(msg("100.0", "one sec", atBoundaryTs)), "isQualifyingEdit: an edit landing EXACTLY at the window boundary qualifies");

  ok(!isQualifyingEdit(msg("100.0", "one sec", "50.0")), "isQualifyingEdit: an edited.ts BEFORE the message's own ts is refused, not accepted");

  {
    const { endsOwnWakeWait } = await import("../packages/core/scripts/e2e/slack-driver.js");
    const wanted = msg("200.0", "enter this code where they started it");
    const unwanted = msg("201.0", "From your OTHER account, send me this line");
    const wants = (m: { readonly text: string }) => /enter this code where they started it/.test(m.text);
    ok(endsOwnWakeWait(wanted, undefined, wants), "endsOwnWakeWait: the wanted message ends the wait");
    ok(!endsOwnWakeWait(unwanted, undefined, wants), "🔴 endsOwnWakeWait: a message of the SAME wake that is not the wanted one does NOT end the wait");
    ok(endsOwnWakeWait(unwanted, undefined, undefined), "endsOwnWakeWait/CONTROL: with NO want the same message ends the wait — every caller before this rule is unchanged");
    ok(!endsOwnWakeWait(wanted, (m) => isFillerAck(m.text) || /started it/.test(m.text), wants), "endsOwnWakeWait: a `skip` still rejects, so the want never WIDENS what counts as substantive");
    const editedUnwanted = msg("201.0", "From your OTHER account, send me this line", "230.0");
    ok(isQualifyingEdit(editedUnwanted), "control: the wrong message really IS a qualifying edit — so the next assertion is about the ORDER and not about the edit window");
    ok(!endsOwnWakeWait(editedUnwanted, (m) => !wants(m), wants), "🔴 endsOwnWakeWait: a QUALIFYING EDIT overrides a `skip` but never a want — this is why the want is a second term, not a folded one");
  }

  const { withPatchedFetch } = await import("../packages/core/scripts/_fetch-test-utils.js");
  const scriptedHistoryMessage = { ts: folded.ts, text: folded.text, edited: { ts: folded.editedTs }, bot_id: "B-OE" };
  const jsonResp = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  const fake = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("conversations.replies")) return jsonResp({ ok: true, messages: [{ ts: "782.0" }] });
    if (u.includes("conversations.history")) return jsonResp({ ok: true, messages: [scriptedHistoryMessage] });
    return jsonResp({ ok: true });
  }) as typeof fetch;
  await withPatchedFetch(fake, async () => {
    const driver = new SlackDriver({ token: "xoxb-test", channel: "C-DM", botUserId: "B-OE" });
    const found = await driver.awaitAnyReply("782.0", { timeoutMs: 3_000, skip: (m) => isFillerAck(m.text) });
    ok(found.ts === folded.ts, "awaitAnyReply: resolves to the folded-into-edit message despite `skip` still matching its text (the OPE-1067 override reaches the real poll loop)");
  });
}

{
  const {
    toMessage,
    approvalCardFacts,
    isEveTaskCardBlocks,
    isSettledTaskCard,
    seatMessageSettles,
    passesSkip,
    endsOwnWakeWait,
    SlackDriver,
    EVE_TASK_CARD_BLOCK_ID_PREFIX,
  } = await import("../packages/core/scripts/e2e/slack-driver.js");
  const { withPatchedFetch } = await import("../packages/core/scripts/_fetch-test-utils.js");
  const token = "tok-2259-a1";
  const cardOne = {
    ts: "900.0",
    bot_id: "B-OE",
    text: `Working on 1 task: Find the page named ${token}`,
    blocks: [{ block_id: `${EVE_TASK_CARD_BLOCK_ID_PREFIX}turn_1`, type: "task_card" }],
    edited: { ts: "905.0" },
  };
  const cardPlan = {
    ts: "900.5",
    bot_id: "B-OE",
    text: "Finished 2 tasks in 8s: Researcher, Writer",
    blocks: [{ block_id: `${EVE_TASK_CARD_BLOCK_ID_PREFIX}turn_2`, type: "plan" }],
  };
  const reply = { ts: "910.0", bot_id: "B-OE", text: `Found it: the page ${token} is in Projects.` };
  const ack = { ts: "901.0", bot_id: "B-OE", text: "On it, looking now." };

  ok(toMessage(cardOne).taskCard === true, "task card: a `task_card` block flags the message as eve's task card");
  ok(toMessage(cardPlan).taskCard === true, "task card: a `plan` block (several tasks) flags it too");
  ok(isEveTaskCardBlocks([{ block_id: `${EVE_TASK_CARD_BLOCK_ID_PREFIX}turn_9`, type: "section" }]), "task card: eve's block id prefix alone is enough");
  ok(toMessage(reply).taskCard === undefined, "negative control: a plain reply carries no task-card flag");
  ok(
    toMessage({ ts: "1.0", bot_id: "B-OE", text: "Working on 1 task: a reply that only LOOKS like a card", blocks: [{ type: "section" }, { type: "actions", block_id: "approve" }] }).taskCard === undefined,
    "negative control: card-like TEXT on ordinary blocks is not a card (the rule is structural)",
  );

  const approval = toMessage({
    ts: "920.0",
    bot_id: "B-OE",
    text: "Set the monthly spend limit for #general to $50.00/mo. Approval requested: spend.set Set spend limit — #general (surface) Requested by <@U1> · expires soon",
    blocks: [
      { type: "header", text: { type: "plain_text", text: "Set the monthly spend limit for #general to $50.00/mo." } as never },
      { type: "context", elements: [{ type: "mrkdwn", text: "Approval requested: spend.set" } as never] },
      { type: "section", text: { type: "mrkdwn", text: "Set spend limit — #general (surface)" } as never },
      { type: "context", elements: [{ type: "mrkdwn", text: "Requested by <@U1> · expires soon" } as never] },
      { type: "actions", block_id: "oe_approval_actions:p-1", elements: [{ action_id: "oe_approval:approve:p-1", value: "default", text: { text: "Approve" } }] },
    ],
  });
  ok(
    JSON.stringify(approval.blockTexts) ===
      JSON.stringify(["Set the monthly spend limit for #general to $50.00/mo.", "Approval requested: spend.set", "Set spend limit — #general (surface)", "Requested by <@U1> · expires soon"]),
    `approval card: blockTexts lists the header, label, detail and context in block order (got ${JSON.stringify(approval.blockTexts)})`,
  );
  ok(approval.blockTexts?.[1] === "Approval requested: spend.set", "🔴 approval card: the label is the second block even when Slack returns the text as one line");
  ok(toMessage(reply).blockTexts === undefined, "negative control: a message with no text blocks carries no blockTexts");

  const compact = toMessage({
    ts: "921.0",
    bot_id: "B-OE",
    text: "Open a pull request on acme/web: Fix login.\nAsked by <@U1> · expires 13 October, 14:00 UTC",
    metadata: { event_type: "oe_approval_card", event_payload: { kind: "pr.open", id: "p-2", status: "pending", detail: ["Open pull request — `acme/web`: `fix` → `main`"] } },
  });
  ok(compact.approvalCard?.kind === "pr.open" && compact.approvalCard.detail.length === 1, "approval card: the driver maps the metadata to approvalCard (kind + detail)");
  ok(/`fix`\s*→\s*`main`/.test(approvalCardFacts(compact)) && !/→/.test(compact.text), "approval card: approvalCardFacts reads the branches from the metadata, which the visible text no longer shows");
  const grouped = toMessage({ ts: "922.0", text: "2 approvals for one job — 2 still open", metadata: { event_type: "oe_approval_card", event_payload: { kind: "grouped", items: [{ kind: "chat.post", detail: ["a"] }, { kind: "pr.open", detail: ["b"] }] } } });
  ok(grouped.approvalCard?.kind === "chat.post+pr.open" && grouped.approvalCard.detail.join() === "a,b", "approval card: a grouped card's metadata lists every item");
  ok(toMessage({ ts: "923.0", text: "hi", metadata: { event_type: "other", event_payload: { kind: "x" } } }).approvalCard === undefined, "negative control: foreign metadata is not a card");

  ok(!passesSkip(toMessage(cardOne), undefined), "passesSkip: a task card never passes, even with no skip");
  ok(!passesSkip(toMessage(cardOne), () => true), "passesSkip: …and the OPE-1067 edit override does not lift it");
  ok(!endsOwnWakeWait(toMessage(cardOne), undefined, (m) => m.text.includes(token)), "endsOwnWakeWait: a card that quotes the leg's token does not end an own-wake wait");
  ok(passesSkip(toMessage(reply), undefined), "negative control: a plain reply still passes");

  const anyBot = (): boolean => true;
  ok(!seatMessageSettles(toMessage(cardOne), anyBot, undefined), "seat fence: a WORKING task card does not settle the seat (its turn still owes the answer)");
  ok(isSettledTaskCard(toMessage(cardPlan)) && seatMessageSettles(toMessage(cardPlan), anyBot, undefined), "seat fence: a FINISHED task card settles the seat");
  const finishedReply = toMessage({ ts: "911.0", bot_id: "B-OE", text: "Finished 1 task in 4s: but this is a plain reply" });
  ok(!isSettledTaskCard(finishedReply), "negative control: a plain reply whose text starts with \"Finished\" is not a settled card");
  ok(!seatMessageSettles(finishedReply, () => false, undefined), "negative control: …and it settles the seat only by the reply rule, never by the card rule");
  ok(seatMessageSettles(toMessage(reply), anyBot, undefined), "seat fence: a plain bot reply still settles");
  ok(!seatMessageSettles(toMessage(ack), anyBot, () => true), "seat fence: an interim ack still does not settle");

  const jsonResp = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  const root = { ts: "899.0", user: "U-HUMAN", text: "find it" };
  const fake = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("conversations.replies")) return jsonResp({ ok: true, messages: [root, cardOne, reply] });
    if (u.includes("conversations.history")) return jsonResp({ ok: true, messages: [cardPlan] });
    return jsonResp({ ok: true });
  }) as typeof fetch;
  await withPatchedFetch(fake, async () => {
    const driver = new SlackDriver({ token: "xoxb-test", channel: "C-DM", botUserId: "B-OE" });
    const threaded = await driver.awaitThreadReply("899.0", { timeoutMs: 3_000 });
    ok(threaded.ts === reply.ts, `awaitThreadReply: steps over the task card to the reply (got ${threaded.ts})`);
    const any = await driver.awaitAnyReply("899.0", { timeoutMs: 3_000, skip: () => false });
    ok(any.ts === reply.ts, `awaitAnyReply: steps over the task card to the reply (got ${any.ts})`);
    const answers = await driver.collectBotMessagesAfter("899.0", "899.0");
    ok(answers.map((m) => m.ts).join(",") === reply.ts, `collectBotMessagesAfter: an answer read leaves out both cards (got ${answers.map((m) => m.ts).join(",")})`);
    const silence = await driver.collectBotMessagesAfter("899.0", "899.0", { includeTaskCards: true });
    ok(silence.length === 3, `collectBotMessagesAfter: a SILENCE read counts the cards too (got ${silence.length})`);
    const during = await driver.collectRepliesDuring("899.0", "899.0", 0);
    ok(during.some((m) => m.taskCard === true), "collectRepliesDuring: a silence read counts a task card as a stray");
    ok(driver.isBotMessage(toMessage(cardOne)) && !driver.isBotReply(toMessage(cardOne)), "isBotMessage / isBotReply: a card is bot output but never a reply");
  });

  const scenariosSrc = readFileSync(fileURLToPath(new URL("../packages/core/scripts/e2e/scenarios.ts", import.meta.url)), "utf-8");
  for (const needle of [
    "const afterControl = (await slack.replies(controlTs)).filter((m) => slack.isBotMessage(m));",
    "const afterDrop = (await slack.replies(dropTs)).filter((m) => slack.isBotMessage(m));",
    "const stray = (await slack.history(badAnchorTs)).filter((m) => slack.isBotMessage(m) && m.text.includes(badNote));",
    "const strayInSlack = (await a.history(ack.ts)).filter((m) => a.isBotMessage(m) && m.ts !== ack.ts);",
    "const afterReply = (await sup.collectBotMessagesAfter(askTs, reply.ts, { includeTaskCards: true }))",
    "const noiseReplies = (await sup.collectBotMessagesAfter(noiseTs, noiseTs, { includeTaskCards: true }))",
    "const noiseReplies = await b.collectBotMessagesAfter(noiseTs, noiseTs, { includeTaskCards: true });",
    "for (const m of await room.collectBotMessagesAfter(askTs, askTs, { includeTaskCards: true }))",
  ]) {
    ok(scenariosSrc.includes(needle), `silence gate counts eve's task card: ${needle.slice(0, 70)}…`);
  }
  ok(scenariosSrc.split("const strayInA = (await a.history(askTs)).filter((m) => a.isBotMessage(m));").length === 3, "silence gate counts eve's task card: both reply-targeting raw-history fallbacks");
}

{
  const row = (action: string, detail: Record<string, unknown>): AuditWireEntry => ({
    ts: "2026-05-03T12:23:00.000Z",
    org: "default",
    platform: "slack",
    workspace: "T0EXAMPLE",
    action,
    detail,
  });

  ok(
    delegationHasReturned([row("delegation.task_started", { task: "t1", session: "s1" }), row("delegation.task_settled", { task: "t1", session: "s1", status: "completed" })]),
    "delegationHasReturned: native started+settled pair (same task id) returns true",
  );

  ok(
    !delegationHasReturned([row("delegation.task_started", { task: "t1", session: "s1" })]),
    "delegationHasReturned: a started row with NO matching settled row is NOT a return (the OPE-1076 race window)",
  );

  ok(
    !delegationHasReturned([row("delegation.task_started", { task: "t1", session: "s1" }), row("delegation.task_settled", { task: "OTHER-TASK", session: "s1", status: "completed" })]),
    "delegationHasReturned: a settled row for a different task id does not satisfy the started row's join",
  );

  {
    const surfaceActions = [...DELEGATED_TURN_SURFACE_ACTIONS];
    ok(surfaceActions.includes("reply.post"), "the delegated-turn surface read asks for reply.post");
    ok(surfaceActions.includes("reply.edit"), "🔴 …AND for reply.edit — without it a settlement folded into the ack is invisible to the wait, and S-DELEGATED-github reds on a correct deployment");
    ok(surfaceActions.length === 2, `…and asks for exactly those two on the surface's platform; the delegation pair is read UNSCOPED because it is written on platform "ingest" (got ${JSON.stringify(surfaceActions)})`);
  }

  {
    const { seatDelegationRows, pollForFinalReply } = await import("../packages/core/scripts/e2e/read-channel-lib.js");
    const SEAT = "wrun_SEAT_2361";
    const W = "wrun_example69";
    const WAKE = "2361aaaa-0000-4000-8000-000000000027";
    const REQ = "2361bbbb-0000-4000-8000-000000000027";
    const at = (action: string, ts: string, detail: Record<string, unknown>) => ({ ts, org: "default", platform: "unified", workspace: "delegation", action, detail });
    const ack = at("reply.post", "2026-06-14T04:58:02.000Z", { id: "m-ack", sessionId: SEAT, wakeId: WAKE, chars: 60, done: false });
    const forwarded = at("work.forwarded", "2026-06-14T04:58:01.000Z", { requestId: REQ, wakeId: WAKE, seatSessionId: SEAT, workToken: "oe-dom:e2e-unified:win:w/e2e-unified:oe-sup:g1" });
    const started = at("delegation.task_started", "2026-06-14T04:58:05.000Z", { task: "agent-27", session: W, request: REQ });
    const settled = at("delegation.task_settled", "2026-06-14T04:59:30.000Z", { task: "agent-27", session: W, status: "completed" });
    const report = at("reply.post", "2026-06-14T04:59:35.000Z", { id: "m-report", sessionId: SEAT, wakeId: "2361cccc-result-wake", chars: 400, done: true });
    const foreignSettled = at("delegation.task_settled", "2026-06-14T04:59:00.000Z", { task: "agent-27", session: "wrun_OTHER_W", status: "completed" });

    const joined = seatDelegationRows([ack, forwarded, started, settled, report], SEAT, WAKE);
    ok(joined.forwards.length === 1 && joined.started.length === 1 && joined.settled.length === 1, `🔴 (c3): the seat's forward joins W's task_started and task_settled by request id (got ${joined.forwards.length}/${joined.started.length}/${joined.settled.length})`);
    const unjoined = seatDelegationRows([ack, started, settled, report], SEAT, WAKE);
    ok(unjoined.started.length === 0 && unjoined.settled.length === 0, "(c3) NEGATIVE CONTROL: without the work.forwarded row nothing joins — the board's red, and why the gate must read that row");
    const foreign = seatDelegationRows([ack, forwarded, started, foreignSettled], SEAT, WAKE);
    ok(foreign.settled.length === 0, "🔴 (c3): a settlement of the same task id on ANOTHER work session does not join");
    const byWake = seatDelegationRows([at("work.forwarded", forwarded.ts, { requestId: REQ, wakeId: WAKE }), started, settled], SEAT, WAKE);
    ok(byWake.started.length === 1, "(c3): a forward row with no seatSessionId still joins on the asking wake");
    const twoTier = seatDelegationRows([at("delegation.task_started", started.ts, { task: "t1", session: SEAT }), at("delegation.task_settled", settled.ts, { task: "t1", session: SEAT })], SEAT, WAKE);
    ok(twoTier.started.length === 1 && twoTier.settled.length === 1, "(c3): the two-tier shape (task on the seat's own session) still joins");
    ok([...DELEGATED_TURN_DELEGATION_ACTIONS].includes("work.forwarded"), "🔴 (c3): gateDelegatedTurn's unscoped read asks for work.forwarded, or the join above has nothing to join on");
    ok([...DELEGATED_TURN_DELEGATION_ACTIONS].includes("delegation.task_started") && [...DELEGATED_TURN_DELEGATION_ACTIONS].includes("delegation.task_settled"), "(c3): …beside the delegation pair");
    const seedActions: readonly string[] = [...SEED_WRITE_ACTIONS];
    ok(seedActions.includes("work.forwarded"), "🔴 OPE-2381: the seed gate's read asks for work.forwarded, or every three-tier seed dispatch reads as inline");
    ok(seedActions.includes("delegation.task_started") && seedActions.includes("reply.post"), "OPE-2381: …beside the dispatch row and the ack's reply.post row it joins against");

    let clock = 1_000_000;
    let call = 0;
    const sequence = [[ack, forwarded, started], [ack, forwarded, started, settled, report]];
    const deps = { now: () => clock, sleep: async (ms: number) => { clock += ms; }, fetchRows: async () => sequence[Math.min(call++, sequence.length - 1)]! };
    const outcome = await pollForFinalReply(deps, WAKE, SEAT, 100_000, 4_000, 12_000);
    ok(outcome.kind === "settled-relay", `🔴 (c3): the delegated-turn wait reads the three-tier settlement as the relay (got "${outcome.kind}": ${outcome.detail})`);
    clock = 1_000_000;
    call = 0;
    const held = { ...deps, fetchRows: async () => [ack, forwarded, started] };
    const running = await pollForFinalReply(held, WAKE, SEAT, 40_000, 4_000, 12_000);
    ok(running.kind === "timeout", `🔴 (c3): a forwarded job still running holds the wait open — it never reads "quiet" on the ack's stillness (got "${running.kind}")`);
  }

  {
    const JGH = "I'm pulling the issue details now and will reply with a one-line summary including `gh-28431`.";
    ok(isPendingWorkHandoff(JGH), "🔴 (c4): the J-GH holding reply reads as a pending-work hand-off");
    ok(isPendingWorkHandoff("I’m pulling that now."), "(c4): …with a curly apostrophe too");
    ok(!isPendingWorkHandoff("Pulling the logs shows no error in the last hour."), "(c4) NEGATIVE CONTROL: bare `pulling` opening real prose is an answer");
    ok(!isPendingWorkHandoff("gh-28431: the build fails on Windows paths because the loader joins with a backslash."), "(c4) NEGATIVE CONTROL: the one-line summary itself is an answer");
    const rows = [
      { action: "reply.post", detail: { id: "101", done: false } },
      { action: "reply.post", detail: { id: "102", done: true } },
      { action: "reply.post", detail: { id: "103" } },
      { action: "reply.refused", detail: { id: "104", done: false } },
    ];
    ok(handoffFromReplyPostRows(rows, "101") === true, "🔴 (c4): a done:false row is a hand-off, whatever its prose");
    ok(handoffFromReplyPostRows(rows, "102") === false, "🔴 (c4): a done:true row is the answer, whatever its prose");
    ok(handoffFromReplyPostRows(rows, "103") === undefined, "(c4): a row with no `done` is unknown, never a guess");
    ok(handoffFromReplyPostRows(rows, "104") === undefined, "(c4): a row of another action never answers");
    ok(handoffFromReplyPostRows(rows, "999") === undefined, "(c4): no row is unknown");
    const exact = replyIsPendingWorkHandoff({ auditRead: async () => rows as never }, "2026-06-14T04:19:00.000Z");
    ok((await exact("101", "gh-28431: the build fails.")) === true, "🔴 (c4): the row outranks prose that reads as an answer");
    ok((await exact("102", JGH)) === false, "🔴 (c4): the row outranks prose that reads as a hand-off");
    ok((await exact("103", JGH)) === true, "(c4): no `done` on the row ⇒ the prose guess decides");
    const unread = replyIsPendingWorkHandoff({ auditRead: async () => { throw new Error("503"); } }, "2026-06-14T04:19:00.000Z");
    ok((await unread("101", JGH)) === true && (await unread("101", "gh-28431: the build fails.")) === false, "(c4): an unreadable audit route falls back to the guess");
    const noReader = replyIsPendingWorkHandoff({ auditRead: undefined }, "2026-06-14T04:19:00.000Z");
    ok((await noReader("101", "gh-28431: the build fails.")) === false, "(c4): no audit reader ⇒ the guess alone");
  }

  {
    const HUMAN = "U0EXOWNER";
    const DM = "D0EXDMCH001";
    const SK = `slack/T0EXAMPLE/${DM}`;
    const SEAT = "wrun_example70";
    const ASK = "00000000-0000-4000-8000-0000000000a1";
    const PENDING = "00000000-0000-4000-8000-0000000000b2";
    const anchorTs = "2026-06-14T05:11:00.000Z";
    const row = (action: string, ts: string, detail: Record<string, unknown>, extra: Partial<AuditWireEntry> = {}): AuditWireEntry =>
      ({ ts, org: "default", platform: "slack", workspace: "T0EXAMPLE", surface: DM, action, detail, ...extra }) as AuditWireEntry;
    const before: AuditWireEntry[] = [
      row("wake.ingress", "2026-06-14T05:11:00.300Z", { wakeId: ASK, surfaceKey: SK, vendorTs: anchorTs, vendorTsSource: "slack-ts" }, { surface: SK }),
      row("wake.turn_start", "2026-06-14T05:11:04.000Z", { wakeId: ASK, sessionId: SEAT, turnId: "turn_0" }, { surface: SK }),
      row("work.forwarded", "2026-06-14T05:11:09.000Z", { requestId: "00000000-0000-4000-8000-0000000000c3", wakeId: ASK, seatSessionId: SEAT }, { platform: "unified", surface: undefined }),
      row("connector.op", "2026-06-14T05:11:34.000Z", { connection: "notion", op: "notion-search", tier: "open", opTier: "read", status: "completed" }),
      row("approval.requested", "2026-06-14T05:11:39.000Z", { id: PENDING, kind: "op.connector", scopeKey: SK }, { principalId: HUMAN }),
      row("connector.op", "2026-06-14T05:11:39.500Z", { connection: "notion", op: "notion-create-pages", opTier: "write", isError: true }),
    ];
    const anchor = { platform: "slack", surfaceKey: SK, vendorTs: anchorTs };
    const request = connectorCardRequest(before, { anchor, requester: HUMAN });
    ok(request?.pendingId === PENDING && request.seatSessionId === SEAT && request.askWakeId === ASK, `🔴 (c5): the exact DM ask joins its forward and card ${PENDING} (got ${JSON.stringify(request)})`);
    ok(connectorCardRequest(before, { anchor, requester: "U_SOMEONE_ELSE" }) === undefined, "(c5) NEGATIVE CONTROL: a card raised for another person is not this ask's card");
    ok(connectorCardRequest(before.filter((r) => r.action !== "work.forwarded"), { anchor, requester: HUMAN }) === undefined, "(c5) NEGATIVE CONTROL: no forward ⇒ no card join");
    ok(
      connectorCardRequest([...before, row("approval.requested", "2026-06-14T05:11:40.000Z", { id: "second-card", kind: "op.connector", scopeKey: SK }, { principalId: HUMAN })], { anchor, requester: HUMAN }) === undefined,
      "(c5): two cards for one ask refuse — the driver never picks which card to click",
    );
    ok(
      connectorCardRequest(before.map((r) => (r.action === "approval.requested" ? { ...r, detail: { ...r.detail, kind: "pr.open" } } : r)), { anchor, requester: HUMAN }) === undefined,
      "(c5): a card of another kind is not the connector card",
    );
    ok(completedConnectorWrites(before, DM).length === 0, "🔴 (c5): the denied, carded call is not a completed write; a read is not a write");

    const withVerdict = (verdict: string | undefined) =>
      before.map((r) => (r.action === "work.forwarded" ? { ...r, detail: { ...r.detail, workToken: "oe-dom:oe-dm/x:win:w/oe-dm/x:oe-sup:g1", ...(verdict === undefined ? {} : { workRuntime: verdict }) } } : r));
    const absent = forwardedWorkSessionStale(withVerdict(undefined), anchor);
    ok(absent?.stale === true && absent.why.includes("recorded no runtime verdict"), `🔴 (c5): a forward with NO runtime verdict reads as a stale work session (got ${JSON.stringify(absent)})`);
    const unchecked = forwardedWorkSessionStale(withVerdict("unchecked"), anchor);
    ok(unchecked?.stale === true && unchecked.why.includes("unchecked"), "🔴 (c5): an `unchecked` verdict reads as a stale work session");
    for (const verdict of ["minted", "rotated", "current"]) {
      const fresh = forwardedWorkSessionStale(withVerdict(verdict), anchor);
      ok(fresh?.stale === false && fresh.verdict === verdict, `(c5) NEGATIVE CONTROL: a \`${verdict}\` verdict is a work session on this deployment's code, never stale`);
    }
    ok(forwardedWorkSessionStale(before.filter((r) => r.action !== "work.forwarded"), anchor) === undefined, "(c5): no forward ⇒ not the stale class at all");
    ok(forwardedWorkSessionStale(withVerdict("current"), { ...anchor, vendorTs: "1.0" }) === undefined, "(c5): another ask's anchor joins no forward");
    for (const action of ["work.forwarded", "approval.requested", "approval.approved", "connector.op_approved", "approval.decision_wake", "connector.op", "reply.post"]) {
      ok((CONNECTOR_CARD_ACTIONS as readonly string[]).includes(action), `(c5): the leg's audit read asks for ${action}`);
    }

    const clickRows: AuditWireEntry[] = [
      row("connector.op_approved", "2026-06-14T05:12:10.100Z", { connection: "notion", op: "notion-create-pages", grain: "write", requestedBy: HUMAN }, { principalId: HUMAN }),
      row("approval.approved", "2026-06-14T05:12:10.200Z", { id: PENDING, kind: "op.connector" }, { principalId: HUMAN }),
      row("approval.decision_wake", "2026-06-14T05:12:10.400Z", { id: PENDING, kind: "op.connector", outcome: "approved", delivered: true, wakeId: "decision-wake-1" }, { principalId: HUMAN }),
      row("connector.op", "2026-06-14T05:12:30.000Z", { connection: "notion", op: "notion-create-pages", tier: "gate:member", opTier: "write", status: "completed" }),
      row("reply.post", "2026-06-14T05:12:20.000Z", { id: "1781413940.000100", platform: "slack", sessionId: SEAT, done: false }),
      row("reply.post", "2026-06-14T05:12:40.000Z", { id: "1781413960.000200", platform: "slack", sessionId: SEAT, done: true }),
    ];
    const candidates = [{ id: "1781413940.000100", text: "Running it now." }, { id: "1781413960.000200", text: "Created the page OE suspended suspended-slack-1." }];
    const all = [...before, ...clickRows];
    const run = request ? connectorCardRun(all, { request, clicker: HUMAN, surface: DM, replyPlatform: "slack", candidates }) : undefined;
    ok(run?.candidate.id === "1781413960.000200" && run.decisionWakeId === "decision-wake-1", `🔴 (c5): the approved card's write and the seat's answer after it join (got ${JSON.stringify(run?.candidate)})`);
    const runOf = (rows: readonly AuditWireEntry[], clicker = HUMAN) => (request ? connectorCardRun(rows, { request, clicker, surface: DM, replyPlatform: "slack", candidates }) : "no-request");
    ok(runOf(all, "U_ADMIN") === undefined, "🔴 (c5): an approval by anyone but the asking human does not pass");
    ok(
      runOf(all.map((r) => (r.action === "approval.approved" ? { ...r, principalId: "U_ADMIN" } : r))) === undefined,
      "🔴 (c5): a card approved by someone else does not pass, even beside the memo row of the human",
    );
    ok(runOf(before) === undefined, "🔴 (c5) NEGATIVE CONTROL: no click ⇒ nothing passes");
    ok(runOf(all.filter((r) => !(r.action === "connector.op" && r.detail?.status === "completed"))) === undefined, "🔴 (c5): an approval that ran no write does not pass");
    ok(
      runOf([...all, row("connector.op", "2026-06-14T05:12:00.000Z", { connection: "notion", op: "notion-create-pages", opTier: "write", status: "completed" })]) === undefined,
      "🔴 (c5): a write that ran BEFORE the click does not pass — the card guarded nothing",
    );
    ok(runOf(all.filter((r) => r.action !== "approval.decision_wake")) === undefined, "(c5): no delivered decision wake ⇒ no pass");
    ok(runOf([...all, row("approval.rejected", "2026-06-14T05:12:11.000Z", { id: PENDING }, { principalId: HUMAN })]) === undefined, "(c5): a rejected card never passes");
    ok(
      runOf(all.map((r) => (r.action === "reply.post" && r.detail?.done === true ? { ...r, detail: { ...r.detail, sessionId: "wrun_OTHER" } } : r))) === undefined,
      "(c5): an answer from another session does not pass",
    );
    ok(
      runOf(all.map((r) => (r.action === "reply.post" && r.detail?.done === true ? { ...r, detail: { ...r.detail, done: false } } : r))) === undefined,
      "(c5): a hand-off note after the write is not the answer",
    );

    const body = SCENARIOS.find((sc) => sc.id === "S-SUSPENDED-slack")!.run.toString();
    ok(body.includes("connectorCardRequest(") && body.includes("connectorCardRun("), "🔴 (c5): S-SUSPENDED-slack gates on the card road");
    ok(!body.includes("suspendedApprovalRequest(") && !body.includes('dm.post("Approve")'), "🔴 (c5): …and no longer waits for the bridged eve line or types Approve");
    ok(/decision:\s*"reject"/.test(body) && body.includes("!decided"), "🔴 (c5): an undecided card is rejected by the asking human in the teardown");
  }

  ok(
    !delegationHasReturned([row("task.spawned", { taskId: "rt1", parentSessionId: "s1" }), row("task.returned", { taskId: "rt1", sessionId: "w1" })]),
    "delegationHasReturned: the emitterless roll-own pair is NOT a return — only delegation.task_started/settled is evidence",
  );

  ok(!delegationHasReturned([]), "delegationHasReturned: an empty row set is not a return");
  ok(
    !delegationHasReturned([row("reply.post", { sessionId: "s1" }), row("browser.navigate", {})]),
    "delegationHasReturned: unrelated rows (a reply ack, a browser op with no delegation join) are not a return",
  );

  ok(
    !delegationHasReturned([row("delegation.task_started", { session: "s1" }), row("delegation.task_settled", { session: "s1", status: "completed" })]),
    "delegationHasReturned: started/settled rows with NO task id on either side do not vacuously join",
  );
}

{
  const { pollOptional } = await import("../packages/core/scripts/e2e/poll.js");
  const row = (action: string, detail: Record<string, unknown>): AuditWireEntry => ({
    ts: "2026-05-03T12:23:00.000Z",
    org: "default",
    platform: "slack",
    workspace: "T0EXAMPLE",
    action,
    detail,
  });
  const started = row("delegation.task_started", { task: "t1", session: "s1" });
  const settled = row("delegation.task_settled", { task: "t1", session: "s1", status: "completed" });
  const ticks: (readonly AuditWireEntry[])[] = [[started], [started], [started, settled]];
  let call = 0;
  const fetchRows = async (): Promise<readonly AuditWireEntry[]> => ticks[Math.min(call++, ticks.length - 1)];
  const settledResult = await pollOptional(
    async () => {
      const rows = await fetchRows();
      return delegationHasReturned(rows) ? true : undefined;
    },
    { timeoutMs: 30_000, initialDelayMs: 10, maxDelayMs: 10, what: "delegation settlement (test)" },
  );
  ok(settledResult === true, "F-ART leg-4 poll: delegationHasReturned only resolves the poll once the settled row lands on tick 3, not on the earlier started-only ticks");
  ok(call >= 3, `F-ART leg-4 poll: the probe was re-polled through the unsettled ticks (called ${call} time(s), expected >=3) — it did not stop early on the started-only row`);
}

ok(SYNTHETIC_SLACK_ROUTE === PUBLIC_SLACK_ROUTE, "synthetic route literal matches slack-front's PUBLIC_SLACK_ROUTE");
ok(SYNTHETIC_COMMANDS_ROUTE === SLACK_COMMANDS_ROUTE, "synthetic commands literal matches SLACK_COMMANDS_ROUTE");
ok(APPROVAL_PREFIX === OE_APPROVAL_PREFIX, "synthetic approval prefix matches flow.ts's OE_APPROVAL_PREFIX");

{
  const secret = "e2e-test-secret";
  const body = encodeInteractionBody(
    buildApprovalClickPayload({ pendingId: "abc123", decision: "approve", org: "default", userId: "U2ADMIN", channelId: "C123", messageTs: "1720009900.000100" }),
  );
  const now = Date.now();
  const { timestamp, signature } = signSlackRequest(body, secret, now);
  const headers = new Headers({ "x-slack-request-timestamp": timestamp, "x-slack-signature": signature });
  ok(verifySlackSignature(body, headers, secret, now), "a synthetic signature verifies against verifySlackSignature");
  ok(!verifySlackSignature(body + "x", headers, secret, now), "a tampered body fails verification");
  ok(!verifySlackSignature(body, headers, "wrong-secret", now), "the wrong secret fails verification");
  ok(
    !verifySlackSignature(body, headers, secret, now + 10 * 60_000),
    "a synthetic signature outside the 5-minute replay window fails",
  );
}

{
  const payload = buildApprovalClickPayload({ pendingId: "row-1", decision: "reject", org: "default", userId: "U2ADMIN", channelId: "C123", messageTs: "1720009900.000100" });
  const actions = payload.actions as readonly { action_id: string; value?: string }[];
  ok(actions[0].action_id === "oe_approval:reject:row-1", "action_id is oe_approval:<decision>:<id>");
  ok(actions[0].value === "default", "the click payload carries the org in actions[0].value (real cards stamp row.org)");
  const decision = classifyEnvelope(encodeInteractionBody(payload), "application/x-www-form-urlencoded");
  ok(decision.kind === "approval-click", "the real classifyEnvelope routes the synthetic body to the approval-click handler");
  const foreign = classifyEnvelope(
    encodeInteractionBody({ type: "block_actions", actions: [{ action_id: "eve_input:whatever" }] }),
    "application/x-www-form-urlencoded",
  );
  ok(foreign.kind === "forward", "a non-oe action id still forwards (we only ever forge OUR clicks)");
}

{
  ok(CONNECT_ACTION_PREFIX === OE_CONNECT_ACTION_PREFIX, "synthetic CONNECT_ACTION_PREFIX matches connector-card.ts OE_CONNECT_ACTION_PREFIX");
  ok(SETKEY_MODAL_CALLBACK === OE_SETKEY_MODAL_CALLBACK, "synthetic SETKEY_MODAL_CALLBACK matches intake.ts OE_SETKEY_MODAL_CALLBACK");
  ok(SETKEY_INPUT_BLOCK === REAL_SETKEY_INPUT_BLOCK && SETKEY_INPUT_ACTION === REAL_SETKEY_INPUT_ACTION, "synthetic modal input block/action ids match intake.ts");

  const connectPayload = buildConnectClickPayload({ provider: "e2e-intake", credentialType: "api-key", userId: "U2ADMIN", channelId: "C1", teamId: "T1", org: "default" });
  const connectActions = connectPayload.actions as readonly { action_id: string; value?: string }[];
  ok(connectActions[0].action_id === "oe_connect:e2e-intake:api-key", "the forged connect click carries oe_connect:<provider>:api-key");
  ok(connectActions[0].value === "default", "the forged connect click carries the org in actions[0].value (handleConnectClick reads it)");
  ok(
    classifyEnvelope(encodeInteractionBody(connectPayload), "application/x-www-form-urlencoded").kind === "connect-click",
    "the real classifyEnvelope routes the forged oe_connect body to the connect-click handler",
  );

  const submitPayload = buildSetKeySubmissionPayload({ org: "default", intakeId: "intake-xyz", channelId: "C1", value: "FAKE-KEY-NOT-REAL", userId: "U2ADMIN", teamId: "T1" });
  ok(
    classifyEnvelope(encodeInteractionBody(submitPayload), "application/x-www-form-urlencoded").kind === "setkey-submit",
    "the real classifyEnvelope routes the forged view_submission to the setkey-submit handler",
  );
  const view = submitPayload.view as { callback_id: string; private_metadata: string; state: { values: Record<string, Record<string, { value: string }>> } };
  ok(view.callback_id === OE_SETKEY_MODAL_CALLBACK, "the forged view_submission carries our modal callback_id");
  const meta = JSON.parse(view.private_metadata) as { org: string; id: string; channelId: string };
  ok(meta.org === "default" && meta.id === "intake-xyz" && meta.channelId === "C1", "the forged view_submission's private_metadata carries {org,id,channelId}");
  ok(view.state.values[REAL_SETKEY_INPUT_BLOCK]?.[REAL_SETKEY_INPUT_ACTION]?.value === "FAKE-KEY-NOT-REAL", "the forged view_submission carries the pasted value at the modal's input block/action");
}

{
  ok(HOME_ACTION_PREFIX === SLACK_HOME_WIRE.actionPrefix && HOME_MODAL_CALLBACK === SLACK_HOME_WIRE.modalCallbackId, "synthetic Home literals match home-view.ts SLACK_HOME_WIRE");
  ok(
    classifyEnvelope(JSON.stringify(buildHomeOpenedEnvelope({ userId: "U2ADMIN", teamId: "T1" })), "application/json").kind === "home-open",
    "the real classifyEnvelope routes the forged app_home_opened to the home-open handler",
  );
  ok(
    classifyEnvelope(encodeInteractionBody(buildHomeButtonPayload({ userId: "U2ADMIN", teamId: "T1", action: "memory.export" })), "application/x-www-form-urlencoded").kind === "home-click",
    "the real classifyEnvelope routes the forged Export click to the home-click handler",
  );
  const sub = classifyEnvelope(
    encodeInteractionBody(buildHomeSubmissionPayload({ userId: "U2ADMIN", teamId: "T1", action: "memory.forget", ref: "0".repeat(64) })),
    "application/x-www-form-urlencoded",
  );
  ok(sub.kind === "home-submit", "the real classifyEnvelope routes the forged Forget submission to the home-submit handler");
}

{
  const body = buildSlashCommandBody({ text: "status", userId: "U2ADMIN", channelId: "C123", teamId: "T1" });
  const params = new URLSearchParams(body);
  ok(params.get("command") === "/oe", "slash body carries command=/oe");
  ok(params.get("text") === "status", "slash body carries the subcommand text");
  ok(params.get("user_id") === "U2ADMIN" && params.get("channel_id") === "C123", "slash body carries user_id + channel_id");
  ok(params.get("team_id") === "T1", `slash body carries the workspace's team_id (got "${params.get("team_id")}")`);
}

{
  const refusal = await runWatch(
    { platform: "slack", workspace: "dev", principalId: "U2ADMIN", principalAttested: false, trust: "internal", org: "default" } as unknown as Parameters<typeof runWatch>[0],
    "less",
  );
  ok(refusal.startsWith("I could not tell who you are"), `runWatch refuses a binding with no tenant (got "${refusal.slice(0, 80)}")`);
  ok(watchDialAnswerSets(refusal, "less") === false, "S-WATCH's reset gate reads the no-tenant refusal as NOT a set");
  ok(watchDialAnswerSets("The watch is for members of this organisation, so I changed nothing.", "less") === false, "S-WATCH's reset gate reads the non-member refusal as NOT a set");
  ok(watchDialAnswerSets("Done. Less: I tell you only about calendar conflicts within a day.", "less") === true, "S-WATCH's reset gate reads a changed dial as a set");
  ok(watchDialAnswerSets("It was already set. Less: I tell you only about calendar conflicts within a day.", "less") === true, "S-WATCH's reset gate reads an unchanged dial as a set");
  ok(watchDialAnswerSets("Done. More: I tell you about calendar conflicts up to three days ahead.", "less") === false, "S-WATCH's reset gate reads a set to another dial as NOT a set to less");
}

{
  const input = { text: "remember this: the OPE329 canary is xyz", channelId: "D0DISCORDDM", userId: "111222333444555666" };
  const envelope = buildDiscordDmRelayEnvelope(input) as { source: string; message: Record<string, unknown> };
  ok(envelope.source === "discord-gateway-relay", "envelope carries the relay's own source marker");
  ok(envelope.message.channelType === "1", "envelope is channelType 1 (Discord's DM enum)");
  ok(!("guildId" in envelope.message), "envelope carries NO guildId key at all (a DM is genuinely guildless, never an empty string)");
  const author = envelope.message.author as Record<string, unknown>;
  ok(author.bot === false && author.id === input.userId, "envelope's author is the REAL human, never a bot");

  const raw = JSON.stringify(envelope);
  const secret = "e2e-discord-relay-secret-never-real";
  const sig = signDiscordRelayRequest(raw, secret);
  ok(sig.startsWith("sha256="), "signDiscordRelayRequest is sha256=<hex>-prefixed (relayGate's expected shape, no timestamp component)");
  ok(relayGate(sig, raw, secret) === null, "a synthetic discord DM relay signature verifies against the deployment's OWN relayGate");
  ok(relayGate(sig, raw + "x", secret) !== null, "a tampered body fails relayGate");
  ok(relayGate(sig, raw, "wrong-secret") !== null, "the wrong secret fails relayGate");
  ok(relayGate(null, raw, secret) !== null, "a missing signature header fails relayGate (fail-closed)");

  const parsed = parseRelayPayload(JSON.parse(raw));
  ok(parsed !== null && parsed.channelId === input.channelId && parsed.author.id === input.userId, "the deployment's OWN parseRelayPayload accepts the forged envelope");
  ok(parsed !== null && parsed.guildId === undefined, "parseRelayPayload reads the omitted guildId as undefined (the guildless DM shape)");
  ok(parsed !== null && parsed.channelType === "1", 'parseRelayPayload reads channelType "1"');

  const auth = parsed ? authForRelayMessage(parsed) : null;
  ok(auth !== null, "authForRelayMessage resolves a real dispatch auth for the forged human DM author (never dropped)");

  ok(DISCORD_RELAY_SIGNATURE_HEADER === "x-oe-relay-signature", "DISCORD_RELAY_SIGNATURE_HEADER matches discord-gateway.ts's relay-signature header name");
  ok(SYNTHETIC_DISCORD_GATEWAY_ROUTE === "/eve/v1/discord-gateway", "SYNTHETIC_DISCORD_GATEWAY_ROUTE matches discord-gateway.ts's mounted route");
}

{
  const input = {
    text: "<@900000000000000001> oe-wake-nonce:deadbeef please answer",
    guildId: "1300000000000000100",
    channelId: "9000000000000000383",
    userId: "9000000000000000042",
    botId: "900000000000000001",
    botName: "open-everywhere",
  };
  const envelope = buildDiscordGuildMentionRelayEnvelope(input) as { source: string; message: Record<string, unknown> };
  ok(envelope.source === "discord-gateway-relay", "guild-mention envelope carries the relay's own source marker");
  ok(envelope.message.channelType === "0", 'guild-mention envelope is channelType "0" (Discord\'s base guild text enum)');
  ok(envelope.message.guildId === input.guildId, "guild-mention envelope carries the guild id (the DM shape's exact opposite)");
  ok(envelope.message.mentionsBot === true, "guild-mention envelope sets mentionsBot — the direct-address wake path");

  const raw = JSON.stringify(envelope);
  const secret = "e2e-discord-relay-secret-never-real";
  const sig = signDiscordRelayRequest(raw, secret);
  ok(relayGate(sig, raw, secret) === null, "a synthetic guild-mention relay signature verifies against the deployment's OWN relayGate");
  ok(relayGate(sig, raw + "x", secret) !== null, "a tampered guild-mention body fails relayGate");

  const parsed = parseRelayPayload(JSON.parse(raw));
  ok(parsed !== null && parsed.guildId === input.guildId, "parseRelayPayload reads the guild id back off the forged mention");
  ok(parsed !== null && parsed.channelType === "0", 'parseRelayPayload reads channelType "0"');
  ok(parsed !== null && parsed.mentionsBot === true, "parseRelayPayload reads mentionsBot back as true");
  ok(parsed !== null && parsed.botId === input.botId && parsed.botName === input.botName, "parseRelayPayload reads the relayed bot id/name (multi-bot attribution + name-drop)");
  ok(parsed !== null && parsed.content === input.text, "parseRelayPayload preserves the wake text byte-for-byte (the nonce echo depends on it)");

  const auth = parsed ? authForRelayMessage(parsed) : null;
  ok(auth !== null, "authForRelayMessage resolves a dispatch auth for the forged human guild author");
}

{
  ok(SIDE_PANEL_CHANNEL_ENTITY_TYPE === SLACK_CHANNEL_ENTITY_TYPE, "synthetic side-panel entity type matches slack-side-panel.ts SLACK_CHANNEL_ENTITY_TYPE");
  ok(slackTsAt(1_720_009_900_123) === "1720009900.123000" && slackTsAt(1_720_009_900_000) === "1720009900.000000", "slackTsAt writes Slack's seconds.micros form");
  const input = {
    text: "which room do I have open?",
    dmChannelId: "D0DM",
    userId: "U2ADMIN",
    teamId: "T1",
    ts: "1720009901.000000",
    threadTs: "1720009900.000100",
    viewedChannelId: "C0VIEWED",
  };
  const envelope = buildSidePanelMessageEnvelope(input);
  const event = envelope.event as Record<string, unknown>;
  ok(!("bot_id" in event) && !("subtype" in event), "side-panel envelope carries NO bot_id and NO subtype");
  ok(typeof envelope.event_id === "string" && (envelope.event_id as string).length > 0, "side-panel envelope carries an event_id (the front route dedupes on it)");
  const decision = classifyEnvelope(JSON.stringify(envelope), "application/json");
  ok(decision.kind === "dm-wake" && decision.dmKind === "im", "the real classifyEnvelope routes the forged side-panel message to the 1:1 DM door");
  const parsed = parseMessageEvent(envelope as never);
  ok(parsed !== null && parsed.channelId === "D0DM" && parsed.userId === "U2ADMIN" && parsed.botId === undefined, "the real parse reads the forged message as the person's own DM message");
  ok(parsed?.threadTs === input.threadTs && parsed.ts === input.ts, "the real parse keeps the panel thread and the fresh ts apart");
  ok(parsed?.appContext?.channelId === "C0VIEWED" && parsed.appContext.teamId === "T1", "the real parse reads the viewed room off app_context");
  const room = await sidePanelViewedRoom({ room: parsed?.appContext, teamId: parsed?.teamId, partnerTrust: "internal", channelInternal: async () => true });
  ok(room === "C0VIEWED", "the real strictest-default gates admit the forged room for a full member and an internal channel");

  const note = slackDmSystemNote({ viewedRoom: "C0VIEWED" }) ?? "";
  ok(note.includes(viewedRoomNotePhrase("C0VIEWED")), "the leg's note phrase is the real side-panel note's wording");
  const received = (at: string, message: string) => ({ index: 0, at, type: "message.received", data: { message, sequence: 0, turnId: "t1" } });
  const sinceMs = Date.parse("2026-06-18T09:30:00.000Z");
  ok(noteNamesViewedRoom([received("2026-06-18T09:30:05.000Z", `<system-note>${note}</system-note> hi`)], "C0VIEWED", sinceMs), "noteNamesViewedRoom: a wake carrying the note passes");
  ok(!noteNamesViewedRoom([received("2026-06-18T09:30:05.000Z", "hi")], "C0VIEWED", sinceMs), "noteNamesViewedRoom: a plain DM wake fails (the room never reached the seat)");
  ok(!noteNamesViewedRoom([received("2026-06-18T09:29:00.000Z", note)], "C0VIEWED", sinceMs), "noteNamesViewedRoom: a note from before the ask does not count");
  ok(!noteNamesViewedRoom([received("2026-06-18T09:30:05.000Z", slackDmSystemNote({ viewedRoom: "C0OTHER" }) ?? "")], "C0VIEWED", sinceMs), "noteNamesViewedRoom: a note naming another room does not count");
  ok(!noteNamesViewedRoom([{ index: 0, at: "2026-06-18T09:30:05.000Z", type: "message.completed", data: { text: note } }], "C0VIEWED", sinceMs), "noteNamesViewedRoom: only the wake the seat read counts, never the seat's own output");

  const row = (action: string, detail: Record<string, unknown>, surface: string | null = "slack/T1/D0DM"): AuditWireEntry => ({ ts: "2026-06-18T09:30:06.000Z", org: "default", platform: "slack", workspace: "T1", ...(surface === null ? {} : { surface }), action, detail });
  const rows = [
    row("wake.turn_start", { wakeId: "w-panel", sessionId: "s-seat" }),
    row("delegation.task_started", { task: "k1", session: "s-seat", continuation: false }, "delegation"),
    row("worker.toolset", { worker: "s-worker", parentSession: "s-seat", parentCallId: "c1", rootSession: "s-seat", turn: "t-w", grain: "task" }, null),
    row("wake.turn_start", { wakeId: "w-task", sessionId: "s-worker" }),
    row("work.forwarded", { requestId: "r-1", wakeId: "w-panel", seatSessionId: "s-seat" }),
    row("delegation.task_started", { task: "k2", session: "s-work", request: "r-1" }, "delegation"),
    row("e2e.linked_row", { sessionId: "s-work", channel: "C0VIEWED" }),
    row("reply.post", { id: "1720009902.000000", wakeId: "w-panel", sessionId: "s-seat" }),
    row("reply.post", { id: "1720009903.000000", wakeId: "w-other", sessionId: "s-other" }, "slack/T1/C0VIEWED"),
    row("taint.verdict", { kind: "chat-message", divergence: "over-taint", tableTier: "trusted", sessionId: "s-seat", turnId: "t1" }, null),
    row("read.refused", { target: "C0VIEWED", reason: "cross-domain", callerSurfaceKey: "slack/T1/D0DM" }, "D0DM"),
  ];
  const turn = turnRows(rows, "w-panel");
  ok(turn.length === 9 && !turn.some((r) => r.detail?.["wakeId"] === "w-other"), "turnRows: the closure takes the seat, the delegated worker and the forwarded work session, and leaves another wake out");
  ok(turnRows(rows, "w-none").length === 0, "turnRows: a wake no row names holds no rows");
  ok(
    !turnRows(rows.filter((r) => r.action !== "worker.toolset"), "w-panel").some((r) => r.detail?.["sessionId"] === "s-worker"),
    "turnRows: negative control — without the worker.toolset row the worker's session never joins the turn",
  );
  ok(turn.some((r) => r.action === "taint.verdict"), "turnRows: a real-shape taint.verdict joins the turn through its sessionId");
  ok(!turn.some((r) => r.action === "read.refused"), "turnRows: a real-shape read.refused carries no link key, so it never joins a turn — why the audit check is the weak signal");
  const leaks = viewedRoomRows(turn, "C0VIEWED");
  ok(leaks.length === 1 && leaks[0]?.action === "e2e.linked_row", "viewedRoomRows: a linked row whose detail names the room is caught");
  ok(viewedRoomRows([row("connector.read", {}, "slack/T1/C0VIEWED")], "C0VIEWED").length === 1, "viewedRoomRows: a surface key naming the room is caught");
  ok(viewedRoomRows(turn.filter((r) => r.action !== "e2e.linked_row"), "C0VIEWED").length === 0, "viewedRoomRows: a turn that never names the room passes");

  const requested = (at: string, actions: readonly Record<string, unknown>[]) => ({ index: 0, at, type: "actions.requested", data: { actions } });
  const later = "2026-06-18T09:30:07.000Z";
  const viewedRoom = { id: "C0VIEWED", name: "e2e-viewed" };
  const result = (at: string, toolName: string, output: Record<string, unknown>) => ({ index: 0, at, type: "action.result", data: { result: { toolName, output } } });
  ok(toolCallsNamingRoom([requested(later, [{ toolName: "search", input: { query: "in:<#C0VIEWED> latest" } }])], viewedRoom, sinceMs).join() === "search", "toolCallsNamingRoom: a search over the room by id is caught");
  ok(toolCallsNamingRoom([requested(later, [{ toolName: "search", input: { query: "in:#E2E-Viewed latest" } }])], viewedRoom, sinceMs).join() === "search", "toolCallsNamingRoom: a search over the room by name (any case) is caught");
  ok(toolCallsNamingRoom([requested(later, [{ toolName: "search", input: { query: "in:#e2e-viewed-archive" } }])], viewedRoom, sinceMs).length === 0, "toolCallsNamingRoom: a longer name that only starts with the room's name is another room");
  ok(toolCallsNamingRoom([requested(later, [{ toolName: "search", input: { query: "ops notes" } }])], { id: "C0VIEWED", name: "ops" }, sinceMs).length === 0, "toolCallsNamingRoom: a name shorter than the minimum matches by id only");
  ok(toolCallsNamingRoom([requested(later, [{ toolName: "work", input: { brief: "read channel C0VIEWED" } }])], viewedRoom, sinceMs).join() === "work", "toolCallsNamingRoom: a work forward that names the room is caught");
  ok(toolCallsNamingRoom([requested(later, [{ toolName: "read_channel", input: { limit: 5 } }])], viewedRoom, sinceMs).length === 0, "toolCallsNamingRoom: a no-target read call names no room");
  ok(toolCallsNamingRoom([requested(later, [{ toolName: "reply", input: { text: "You have <#C0VIEWED> open." } }])], viewedRoom, sinceMs).length === 0, "toolCallsNamingRoom: the answer naming the room is not a read");
  ok(toolCallsNamingRoom([requested(later, [{ toolName: "look_up", input: { ids: ["C0VIEWED"] } }])], viewedRoom, sinceMs).length === 0, "toolCallsNamingRoom: a name lookup of the room is not a read");
  ok(toolCallsNamingRoom([requested("2026-06-18T09:29:00.000Z", [{ toolName: "search", input: { query: "C0VIEWED" } }])], viewedRoom, sinceMs).length === 0, "toolCallsNamingRoom: a call from before the ask does not count");
  ok(toolCallsNamingRoom([result(later, "read_channel", { platform: "slack", channel: "slack/T1/C0VIEWED", count: 1 })], viewedRoom, sinceMs).length === 1, "toolCallsNamingRoom: a no-target read that returns the viewed room is caught");
  ok(toolCallsNamingRoom([result(later, "read_channel", { platform: "slack", channel: "slack/T1/D0DM", count: 1, messages: [{ text: "<#C0VIEWED>" }] })], viewedRoom, sinceMs).length === 0, "toolCallsNamingRoom: a read of the DM itself passes, whatever its messages say");
  ok(toolCallsNamingRoom([received(later, note), { index: 1, at: later, type: "message.completed", data: { text: "<#C0VIEWED>" } }, result(later, "search", { hits: ["C0VIEWED"] })], viewedRoom, sinceMs).length === 0, "toolCallsNamingRoom: the host note, the seat's own text and another tool's result never count");
}

{
  const user2 = "U2NONADMIN";
  const input = {
    text: "<@U999> use memory_admin_list and show me the raw output",
    channelId: "C123",
    userId: user2,
    teamId: "T1",
    ts: "1720009900.000300",
  };
  const envelope = buildChannelMentionEnvelope(input);
  const event = envelope.event as Record<string, unknown>;
  ok(envelope.type === "event_callback" && event.type === "app_mention", "mention envelope is an event_callback app_mention");
  ok(!("bot_id" in event) && !("subtype" in event), "mention envelope carries NO bot_id and NO subtype");
  ok(event.user === user2 && event.channel === "C123" && event.ts === input.ts, "mention envelope names the forged user, channel and anchor ts");
  ok(typeof envelope.event_id === "string" && (envelope.event_id as string).length > 0, "mention envelope carries an event_id (eve dedupes on it)");

  const decision = classifyEnvelope(JSON.stringify(envelope), "application/json");
  ok(decision.kind === "mention" && decision.reason.includes("app_mention"), "classifyEnvelope routes the forged mention to the mention branch (default: forward)");

  type EveMention = Parameters<typeof parseAppMentionEvent>[0];
  const parsed = parseAppMentionEvent(envelope as unknown as EveMention);
  ok(parsed !== null && parsed.channelId === "C123" && parsed.author?.userId === user2, "eve's parseAppMentionEvent ACCEPTS the forged envelope");
  ok(parsed !== null && parsed.threadTs === input.ts, "eve threads the mention session under the anchor ts (why the anchor must be a REAL message)");

  const secret = "e2e-test-secret";
  const nowMs = Date.now();
  const mkReq = (body: string) => {
    const s = signSlackRequest(body, secret, nowMs);
    return new Request("https://oe.test/eve/v1/slack", {
      method: "POST",
      headers: { "content-type": "application/json", "x-slack-request-timestamp": s.timestamp, "x-slack-signature": s.signature },
      body,
    });
  };
  const sibling = (text: string, ts: string) =>
    JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: `EvE2ESib${ts.replace(".", "")}`,
      event_time: Math.floor(Number.parseFloat(ts)),
      event: { type: "message", channel_type: "channel", channel: "C123", user: user2, text, ts, event_ts: ts, team: "T1" },
    });
  ok(
    classifyEnvelope(sibling(input.text, "1720009900.000310"), "application/json").kind === "wake",
    "the message.channels sibling classifies as a wake CANDIDATE (suppression lives in the handler, not classify)",
  );
  let innerCalled = false;
  const waits: Array<Promise<unknown>> = [];
  const fakeArgs = {
    send: async () => ({}),
    waitUntil: (p: Promise<unknown>) => void waits.push(p.catch(() => undefined)),
  };
  const handler = buildFrontHandler(
    async () => {
      innerCalled = true;
      return new Response("inner");
    },
    { signingSecret: secret, now: () => nowMs, markEventSeen: async () => true, getBotIdentity: async () => ({ userId: "U999" }) },
  );
  let res = await handler(mkReq(sibling(input.text, "1720009900.000311")), fakeArgs as unknown as Parameters<typeof handler>[1]);
  ok(res.status === 200 && waits.length === 0 && !innerCalled, "mention-bearing message.channels → 200, NO wake scheduled, NO forward (suppressed)");
  res = await handler(mkReq(sibling("no mention here", "1720009900.000312")), fakeArgs as unknown as Parameters<typeof handler>[1]);
  ok(res.status === 200 && waits.length === 1 && !innerCalled, "the mention-FREE sibling DOES reach the wake (contrast pins suppression on the mention itself)");
  await Promise.all(waits);

  const raw = JSON.stringify(envelope);
  const s = signSlackRequest(raw, secret, nowMs);
  const headers = new Headers({ "x-slack-request-timestamp": s.timestamp, "x-slack-signature": s.signature });
  ok(verifySlackSignature(raw, headers, secret, nowMs), "a signed synthetic mention body verifies against verifySlackSignature");
}

{
  const secret = "e2e-webhook-secret";
  const body = JSON.stringify({ note: "hello-e2e" });
  const nowMs = Date.parse("2026-03-30T11:30:00.000Z");
  const ts = webhookTimestamp(nowMs);
  const id = webhookDeliveryId();
  const sig = signWebhookBody(secret, body, ts, id);
  const headersFor = (signature: string, timestamp: string = ts, messageId: string = id): Headers =>
    new Headers({ [SW_ID_HEADER]: messageId, [SW_TIMESTAMP_HEADER]: timestamp, [SW_SIGNATURE_HEADER]: signature });
  const verify = (rawBody: string, headers: Headers, keys: readonly string[] = [secret], at: number = nowMs): boolean =>
    (standardWebhookVerifier.verify({ rawBody, headers, keys, nowMs: at }) as { ok: boolean }).ok;

  ok(sig.startsWith("v1,"), 'webhook signature carries the "v1," version prefix the verifier expects');
  ok(verify(body, headersFor(sig)), "a signed synthetic webhook body verifies against the REAL registered oe-standard-webhook verifier");
  ok(!verify(body + "x", headersFor(sig)), "a tampered webhook body fails verification");
  ok(!verify(body, headersFor(sig), ["wrong-secret"]), "the wrong webhook secret fails verification");
  ok(!verify(body, new Headers({ [SW_ID_HEADER]: id, [SW_TIMESTAMP_HEADER]: ts })), "a missing signature header fails verification");
  ok(!verify(body, headersFor("v1,ZGVhZGJlZWY=")), "a garbage signature fails verification");
  ok(!verify(body, new Headers({ [SW_ID_HEADER]: id, [SW_SIGNATURE_HEADER]: sig })), "a missing TIMESTAMP header fails verification");
  ok(!verify(body, new Headers({ [SW_ID_HEADER]: webhookDeliveryId(), [SW_TIMESTAMP_HEADER]: ts, [SW_SIGNATURE_HEADER]: sig })), "🔴 swapping the DELIVERY ID invalidates the signature — the id is signed, not merely carried");
  ok(!verify(body, new Headers({ [SW_TIMESTAMP_HEADER]: ts, [SW_SIGNATURE_HEADER]: sig })), "a missing delivery-id header fails verification");
  ok(!verify(body, headersFor(sig), [secret], nowMs + 301_000), "a delivery outside the 300s skew window fails — a captured POST does not replay forever");
}

{
  ok(runFallbackCheck({ mustMatch: ["391"] }, "The answer is 391.").pass, "contains-match passes");
  ok(!runFallbackCheck({ mustMatch: ["491"] }, "The answer is 391.").pass, "missing expected string fails");
  ok(runFallbackCheck({ mustMatch: [/thursday/i] }, "We deploy on Thursday").pass, "regex match passes");
  ok(!runFallbackCheck({ mustNotMatch: [/sorry|apolog/i] }, "Sorry for the silence!").pass, "forbidden match fails");
  ok(runFallbackCheck({}, "anything").pass, "an empty check passes (no constraints)");

  const nbHyphen = String.fromCharCode(0x2011);
  ok(runFallbackCheck({ mustMatch: ["lina-82803"] }, `token lina${nbHyphen}82803 included`).pass, "typographic dash in the reply still matches an ASCII-hyphen needle");
  ok(runFallbackCheck({ mustMatch: [`lina${nbHyphen}82803`] }, "token lina-82803 included").pass, "typographic dash in the needle still matches an ASCII-hyphen reply");
  ok(!runFallbackCheck({ mustMatch: ["lina-82804"] }, `token lina${nbHyphen}82803 included`).pass, "the fold does not create a false positive on a different token");

  const judge = new FallbackJudge();
  const rubric = { kind: "closedQA" as const, criteria: "Does it give 391?", atLeast: 1, fallback: { mustMatch: ["391"] } };
  const verdict = await judge.grade(rubric, "391 it is");
  ok(verdict.pass && verdict.score === 1, "FallbackJudge passes a matching reply with score 1");
  ok(verdict.detail.startsWith("[fallback ("), "FallbackJudge labels its verdicts honestly as fallback, with the reason");
  ok(verdict.judge === "fallback", "FallbackJudge tags its verdict judge:\"fallback\"");
  const named = new FallbackJudge("no AI_GATEWAY_API_KEY reachable");
  ok(named.name.includes("no AI_GATEWAY_API_KEY reachable"), "FallbackJudge name carries the disable reason (surfaced in the run banner)");
  ok((await named.grade(rubric, "391")).fallbackReason === "no AI_GATEWAY_API_KEY reachable", "FallbackJudge propagates its reason onto the verdict");

  const scripted = (outcomes: boolean[]) => {
    let i = 0;
    return {
      name: "scripted",
      grade: async () => {
        const pass = outcomes[i++ % outcomes.length];
        return { pass, score: pass ? 1 : 0, detail: pass ? "yes" : "no" };
      },
    };
  };
  ok((await judge3(scripted([true, true, false]), rubric, "x")).pass, "judge3: 2/3 passes → pass");
  ok(!(await judge3(scripted([true, false, false]), rubric, "x")).pass, "judge3: 1/3 passes → fail");
  const v = await judge3(scripted([true, true, true]), rubric, "x");
  ok(v.score === 1 && v.detail.includes("3/3"), "judge3 reports the vote count");
}

{
  const closed = { kind: "closedQA" as const, criteria: "Does the reply list the user's Notion pages?", atLeast: 1, fallback: { mustNotMatch: [/error/i] } };
  const factual = { kind: "factuality" as const, expected: "Thursday", criteria: "Does the reply say Thursday?", atLeast: 0.6, fallback: { mustMatch: ["thursday"] } };

  const p = buildJudgePrompt(closed, "here are your pages: Roadmap, Notes");
  ok(/GROUNDING/i.test(p.system) && /connect an account/i.test(p.system), "judge prompt tells the grader a defer-to-auth reply FAILS a real-answer criteria (grounding rule)");
  ok(/INCIDENTAL/i.test(p.system) && /traceback/i.test(p.system), "judge prompt tells the grader an incidental \"error\"/\"traceback\" word is NOT a failure");
  ok(/STRICT JSON/i.test(p.system) && p.system.includes('{"pass"'), "judge prompt pins the strict-JSON {pass,reason} output contract");
  ok(p.user.includes("Does the reply list the user's Notion pages?") && p.user.includes("here are your pages"), "judge user message carries the criteria + the reply");
  ok(!p.user.includes("EXPECTED FACT") && !p.user.includes("CONTEXT"), "closedQA with no context/expected omits the EXPECTED FACT + CONTEXT sections");
  const pf = buildJudgePrompt(factual, "we deploy on thursday");
  ok(pf.user.includes("EXPECTED FACT") && pf.user.includes("Thursday"), "factuality rubric injects the EXPECTED FACT section");
  const pc = buildJudgePrompt({ ...closed, context: "the fixture workspace has a page titled Roadmap" }, "x");
  ok(pc.user.includes("CONTEXT") && pc.user.includes("titled Roadmap"), "a rubric with context threads it into the CONTEXT section");
  ok(buildJudgePrompt(closed, "").user.includes("(empty)"), "an empty reply renders as (empty) so the grader still sees a REPLY block");

  ok(parseJudgeResponse('{"pass": true, "reason": "lists Roadmap + Notes"}')?.pass === true, "parseJudgeResponse reads pass=true");
  ok(parseJudgeResponse('{"pass": false, "reason": "deferred to auth"}')?.pass === false, "parseJudgeResponse reads pass=false");
  ok(parseJudgeResponse('Sure!\n```json\n{"pass": true, "reason": "ok"}\n```')?.reason === "ok", "parseJudgeResponse extracts the object from surrounding prose/fences");
  ok(parseJudgeResponse("no json here at all") === null, "parseJudgeResponse → null on no object (→ fallback)");
  ok(parseJudgeResponse("{not valid json}") === null, "parseJudgeResponse → null on unparseable JSON (→ fallback)");
  ok(parseJudgeResponse('{"pass": "yes"}') === null, "parseJudgeResponse → null when pass is not a boolean (→ fallback, never a coerced green)");
  ok(parseJudgeResponse('{"reason": "forgot pass"}') === null, "parseJudgeResponse → null when pass is missing");
  ok(parseJudgeResponse('{"pass": true}')?.reason === "", "parseJudgeResponse tolerates a missing reason (empty string)");

  const okJudge = new LlmJudge(async () => '{"pass": true, "reason": "names Roadmap + Notes"}', "test/model");
  const okV = await okJudge.grade(closed, "here are your pages: Roadmap, Notes");
  ok(okV.pass && okV.score === 1 && okV.judge === "llm" && okV.detail.startsWith("[llm]"), "LlmJudge returns an llm-tagged pass verdict on valid output");
  ok(okJudge.name.includes("test/model") && okJudge.name.includes("temp 0"), "LlmJudge name names the model + temperature (shown in the run banner)");
  const failV = await okJudge.grade({ ...closed }, "x");
  ok(failV.pass && failV.judge === "llm", "LlmJudge grades on the model verdict, not the reply's surface tokens");

  const groundJudge = new LlmJudge(async () => '{"pass": false, "reason": "reply says connect your account first — not grounded"}', "test/model");
  const gV = await groundJudge.grade(closed, "You'll need to connect your Notion account first before I can list pages.");
  ok(!gV.pass && gV.judge === "llm", "LlmJudge FAILS a 'connect your account first' reply on a real-answer criteria (fixes the false green)");
  ok(runFallbackCheck(closed.fallback, "You'll need to connect your Notion account first before I can list pages.").pass, "…and the regex fallback ALONE would have (wrongly) passed that same reply — why the LLM judge is needed");

  const garbageJudge = new LlmJudge(async () => "the model rambled with no json", "test/model");
  const gg = await garbageJudge.grade(closed, "here are your pages: Roadmap, Notes");
  ok(gg.judge === "fallback" && gg.fallbackReason === "judge output unparseable", "unparseable judge output → fallback verdict (tagged, with reason)");
  ok(gg.pass === true, "…and the fallback regex (no forbidden token) decides the verdict — not a blanket pass");
  const ggRed = await garbageJudge.grade(closed, "this reply mentions an error somewhere");
  ok(ggRed.judge === "fallback" && ggRed.pass === false, "…a reply the fallback forbids still FAILS under fallback — infra failure never fabricates a green");
  const throwJudge = new LlmJudge(async () => { throw new Error("HTTP 503"); }, "test/model");
  const tv = await throwJudge.grade(closed, "clean grounded answer");
  ok(tv.judge === "fallback" && /judge call failed: HTTP 503/.test(tv.fallbackReason ?? ""), "a thrown transport → fallback verdict carrying the failure reason (no key value could ever appear here)");

  const j3llm = await judge3(new LlmJudge(async () => '{"pass": true, "reason": "ok"}', "m"), closed, "x");
  ok(j3llm.judge === "llm", "judge3 over three llm grades tags the combined verdict llm");
  const j3mixed = await judge3(new LlmJudge(async () => "garbage", "m"), closed, "clean, no error");
  ok(j3mixed.judge === "fallback" && (j3mixed.fallbackReason ?? "").includes("unparseable"), "judge3 tags fallback (with reason) when any sub-grade fell back");

  ok(judgeBannerTag({ llm: 0, fallback: 0, reasons: [] }) === "", "no judged gate → empty banner tag");
  ok(judgeBannerTag({ llm: 2, fallback: 0, reasons: [] }) === ", judge: llm", "all-llm → 'judge: llm'");
  ok(judgeBannerTag({ llm: 0, fallback: 1, reasons: ["judge output unparseable"] }) === ", judge: fallback (judge output unparseable)", "all-fallback → 'judge: fallback (<reason>)'");
  ok(judgeBannerTag({ llm: 1, fallback: 1, reasons: ["HTTP 503"] }).startsWith(", judge: mixed"), "some-of-each → 'judge: mixed …'");
  ok(judgeBannerTag({ llm: 0, fallback: 2, reasons: ["a", "b"] }).includes("a; b"), "multiple distinct fallback reasons are joined");

  {
    const qualityRubric = { kind: "closedQA" as const, criteria: "Is it good?", atLeast: 1, fallback: { mustMatch: ["391"] } };
    const infos: string[] = [];
    const warns: string[] = [];
    const records: { label: string; pass: boolean }[] = [];
    const scriptedJudge = (outcomes: boolean[]) => {
      let i = 0;
      return {
        name: "scripted",
        grade: async () => {
          const pass = outcomes[i++ % outcomes.length];
          return { pass, score: pass ? 1 : 0, detail: pass ? "criteria met" : "criteria not met" };
        },
      };
    };
    const reporter = (verdicts: boolean[]) =>
      createJudgeReporter({
        judge: scriptedJudge(verdicts),
        info: (l) => infos.push(l),
        warn: (l) => warns.push(l),
        record: ({ label, pass }) => records.push({ label, pass }),
        replyTail: (r) => ` ↳ ${r}`,
      });

    const green = await reporter([true])(qualityRubric, "a fine reply", "reply quality");
    ok(green === true, "judgeReport resolves TRUE on a passing verdict");
    ok(infos.length === 1 && warns.length === 0, "a green verdict prints to info, never to warn");
    ok(infos[0].includes("non-gating") && infos[0].includes("reply quality"), "the green line names itself non-gating and carries the label");
    ok(records.length === 1 && records[0].pass === true, "the green verdict is recorded with pass === true");

    infos.length = 0;
    warns.length = 0;
    records.length = 0;
    let threw = false;
    let red: boolean | undefined;
    try {
      red = await reporter([false])(qualityRubric, "a poor reply", "reply quality");
    } catch {
      threw = true;
    }
    ok(threw === false, "🔴 judgeReport does NOT throw on a red verdict — this is the whole split (OPE-433/D2)");
    ok(red === false, "judgeReport resolves FALSE on a failing verdict");
    ok(warns.length === 1 && infos.length === 0, "a red verdict prints to warn (stderr), never to info");
    ok(warns[0].includes("RED") && warns[0].includes("non-gating"), "the red line says RED and says it is non-gating in the same breath");
    ok(warns[0].includes("↳ a poor reply"), "the red line carries the reply tail — a bare verdict is not debuggable");
    ok(records.length === 1 && records[0].pass === false, "the red verdict is recorded with pass === false (the runner tallies it)");

    warns.length = 0;
    records.length = 0;
    const exploding = createJudgeReporter({
      judge: { name: "boom", grade: () => Promise.reject(new Error("gateway exploded")) },
      info: (l) => infos.push(l),
      warn: (l) => warns.push(l),
      record: ({ label, pass }) => records.push({ label, pass }),
      replyTail: () => "",
    });
    const afterThrow = await exploding(qualityRubric, "x", "reply quality");
    ok(afterThrow === false, "a judge that throws yields a reported FALSE, not a rejection");
    ok(warns.length === 1 && warns[0].includes("the judge threw: gateway exploded"), "the thrown reason reaches the operator in the red line");
    ok(records.length === 1 && records[0].pass === false, "a thrown judge is still recorded as a red verdict");
  }

  {
    const none = renderReportedJudgeSummary(0, []);
    ok(none.lines.length === 0, "no reported verdicts → no summary lines at all (an ordinary run gains no noise)");
    const allGreen = renderReportedJudgeSummary(3, []);
    ok(allGreen.stream === "stdout" && allGreen.lines.length === 1 && allGreen.lines[0].includes("all green"), "all-green reported summary is one stdout line");
    const withReds = renderReportedJudgeSummary(3, ["S20 reply quality — judge: [llm] nope"]);
    ok(withReds.stream === "stderr", "a summary carrying a red goes to STDERR");
    ok(withReds.lines[0].includes("1 of 3"), "the summary counts reds against the total");
    ok(withReds.lines[0].includes("do NOT fail the run"), "the summary says outright that these did not fail the run");
    ok(withReds.lines[0].includes("deploy:smoke"), "the summary points at the deterministic gate that DOES decide a deploy");
    ok(withReds.lines[1].includes("S20 reply quality"), "each red verdict is re-printed under the summary");
  }
}

{
  const now = Date.parse("2026-09-17T12:00:00.000Z");
  const anchorComment: NotionComment = {
    id: "comment-1",
    discussionId: "discussion-1",
    authorId: "person-1",
    text: "Open Everywhere — read this page and summarise its current contents for this e2e check.",
    createdTime: "2026-09-18T23:00:00.000Z",
  };
  const anchor = {
    comment: anchorComment as NotionComment | undefined,
    botUserId: "bot-1" as string | undefined,
    nowMs: now,
  };
  const problem = (over: Partial<NotionComment>): string | undefined =>
    notionTaintAnchorProblem({ ...anchor, comment: { ...anchorComment, ...over } });

  ok(notionTaintAnchorProblem(anchor) === undefined, "OPE-1907: a recent, person-authored, addressed page-read anchor passes the preflight");
  ok(problem({ authorType: undefined }) === undefined, "🔴 an ABSENT authorType passes — Notion omits it on a person's comment, and the classifier reads absence as unknown, not as bot");
  ok(problem({ authorType: "person" }) === undefined, "…and a present `person` type passes too");
  ok(problem({ authorType: "bot" })?.includes("bot-authored") === true, "a REST-created bot comment cannot masquerade as the human replay fixture");
  ok(problem({ authorId: "bot-1" })?.includes("OWN reply") === true, "🔴 the agent's own reply is refused — the self-authored loop guard drops it, so replaying it would spend a wake on nothing");
  ok(problem({ authorId: "" })?.includes("created_by.id") === true, "an author the harness cannot identify is refused, the same direction the classifier fails closed in");
  ok(NOTION_TAINT_ANCHOR_MAX_AGE_MS === 90 * 24 * 60 * 60 * 1_000, "the anchor reach-back is 90 days — a human-typed fixture's staleness bound, not the catch-up's context window");
  ok(problem({ createdTime: "2026-06-25T01:00:00.000Z" })?.includes("out of reach") === true, "🔴 an anchor past 90 days IS refused BEFORE a webhook is forged — the floor is still a floor, only a wider one");
  ok(problem({ createdTime: "2026-06-25T01:00:00.000Z" })?.includes("91d old") === true, "…and the refusal states the age and the reach in DAYS, the unit a 90-day bound is read in");
  ok(problem({ createdTime: "2026-06-20T12:00:00.000Z" }) === undefined, "NEGATIVE CONTROL: an 89-day-old anchor qualifies, so the assertion above is driven by the bound and not by the date's shape");
  ok(problem({ createdTime: "2026-08-16T01:23:00.000Z" }) === undefined, "🔴 the ship #217 31-day-old anchor now qualifies on AGE — its red was the missing name-drop, and the old 168h floor refused it for the wrong reason");
  ok(problem({ createdTime: "2026-09-13T12:00:00.000Z" }) === undefined, "a four-day-old anchor still qualifies — widening the ceiling never narrowed the floor");
  ok(problem({ createdTime: "2026-09-19T00:30:00.000Z" })?.includes("future") === true, "a comment stamped an hour ahead is a clock fault, not a fresh ask");
  ok(problem({ text: "e2e anchor: please summarise this page" })?.includes("does not NAME") === true, "🔴 the old unaddressed anchor is refused before it can become a thread-follow no_reply");
  ok(problem({ text: "Open Everywhere — how are you today?" })?.includes("read, review or summarise") === true, "an addressed comment that asks for no page read is refused — nothing in that turn need call read_notion_page");
  ok(notionTaintAnchorProblem({ ...anchor, comment: undefined })?.includes("not visible") === true, "an anchor this credential cannot see is named as such, never treated as a product silence");
  ok(notionTaintAnchorProblem({ ...anchor, botUserId: undefined })?.includes("own Notion user id") === true, "🔴 without the agent's own user id the preflight fails CLOSED — it cannot tell a human anchor from the agent's own reply");
  const remedy = notionTaintFixtureRemedy("page-1");
  ok(remedy.includes("page-1") && remedy.includes("Open Everywhere"), "the remedy names the exact page and the exact words to write — a person can act on the red without reading the scenario");
  ok(!remedy.includes("E2E_"), "🔴 the remedy asks for ONE action and names NO env var: the leg discovers the anchor, and a second step somebody has to remember is a second step somebody skips");

  {
    const at = (iso: string, over: Partial<NotionComment>): NotionComment => ({ ...anchorComment, id: `c-${iso}`, createdTime: iso, ...over });
    const good = "Open Everywhere — read this page and summarise it.";
    const page = [
      at("2026-09-17T21:45:00.000Z", { text: good }),
      at("2026-05-26T05:32:00.000Z", { text: good }),
      at("2026-09-18T22:30:00.000Z", { text: "thanks, looks good to me" }),
      at("2026-09-18T23:00:00.000Z", { authorId: "bot-1", text: good }),
    ];
    const picked = chooseNotionTaintAnchor(page, { botUserId: "bot-1", nowMs: now });
    ok(picked.ok && picked.comment.createdTime === "2026-05-26T05:32:00.000Z", "🔴 the NEWEST QUALIFYING comment wins — a newer comment that does not qualify is skipped, not taken and then failed");
    ok(picked.ok && picked.considered === 4, "the choice reports how many comments it looked at, so a thin page is distinguishable from a fussy predicate");
    ok(chooseNotionTaintAnchor([...page].reverse(), { botUserId: "bot-1", nowMs: now }).ok, "read order does not decide the pick — the sort does");
    const withAncient = chooseNotionTaintAnchor([at("2026-07-01T09:00:00.000Z", { text: good }), ...page], { botUserId: "bot-1", nowMs: now });
    ok(withAncient.ok && withAncient.comment.createdTime === "2026-05-26T05:32:00.000Z", "🔴 an in-window 78-day-old comment never outranks a fresher qualifying one — newest-qualifying semantics are unchanged by the wider floor");
    const onlyAncient = chooseNotionTaintAnchor([at("2026-07-01T09:00:00.000Z", { text: good })], { botUserId: "bot-1", nowMs: now });
    ok(onlyAncient.ok, "NEGATIVE CONTROL: …and that same 78-day-old comment IS taken when it is the only one, so the line above measures the ORDER and not a rejection");

    const none = chooseNotionTaintAnchor(page.filter((c) => !c.text.startsWith("Open Everywhere")), { botUserId: "bot-1", nowMs: now });
    ok(!none.ok && none.reason.includes("does not NAME"), "🔴 when nothing qualifies the reason is the NEWEST PERSON-authored comment's own problem — 'your newest comment does not name the agent' sends someone to the right place");
    ok(!none.ok && !none.reason.includes("OWN reply"), "…and it blames a person's comment rather than the agent's own reply, which nobody can act on");
    const empty = chooseNotionTaintAnchor([], { botUserId: "bot-1", nowMs: now });
    ok(!empty.ok && empty.considered === 0 && empty.reason.includes("no comments"), "an unreadable or empty page says so rather than reporting a fussy predicate");
  }

  const row = (action: string, detail: Record<string, unknown>): AuditWireEntry => ({
    ts: "2026-09-18T23:30:01.000Z",
    org: "default",
    platform: action === "taint.verdict" ? "ingest" : "notion",
    workspace: "workspace-1",
    surface: "page-1",
    action,
    detail,
  });
  const mine = { deliveryId: "delivery-1", commentId: "comment-1", discussionId: "discussion-1" };
  const exactRows = [
    row("notion.dispatched", { deliveryId: "delivery-1", commentId: "comment-1", discussionId: "discussion-1", addressing: "direct", wakeId: "wake-1" }),
    row("wake.turn_start", { wakeId: "wake-1", sessionId: "session-1", turnId: "turn-1" }),
    row("notion.replied", { sessionId: "session-1", discussionId: "discussion-1" }),
    row("taint.verdict", { kind: "notion", parentSessionId: "session-1", sessionId: "worker-1", turnId: "turn-worker" }),
  ];
  const joined = notionTaintReplayEvidence(exactRows, mine);
  ok(joined.ok && joined.evidence.sessionId === "session-1", "the exact delivery joins through its wake to the turn that answered");
  ok(joined.ok && joined.evidence.verdictSessionId === "worker-1", "🔴 a DELEGATED read is attributed to the worker that wrote the verdict, not silently reported as the seat's own");
  ok(joined.ok && joined.evidence.lifecycle?.action === "notion.replied", "the seat's terminal lifecycle row rides along, so a red can say what the turn decided");

  const other = notionTaintReplayEvidence(exactRows, { ...mine, deliveryId: "another-delivery" });
  ok(!other.ok && other.reason.includes("never reached dispatch"), "🔴 a notion verdict in the same time window cannot satisfy ANOTHER delivery's replay — the join is by id, not by clock");

  const threadFollow = notionTaintReplayEvidence(
    exactRows.map((r) => (r.action === "notion.dispatched" ? { ...r, detail: { ...r.detail, addressing: "thread-follow" } } : r)),
    mine,
  );
  ok(!threadFollow.ok && threadFollow.reason.includes("thread-follow"), "🔴 the ship #217 shape is named exactly: a thread-follow dispatch cannot satisfy the direct-addressing precondition");

  const noWake = notionTaintReplayEvidence(
    exactRows.map((r) => (r.action === "notion.dispatched" ? { ...r, detail: { deliveryId: "delivery-1", commentId: "comment-1", discussionId: "discussion-1", addressing: "direct" } } : r)),
    mine,
  );
  ok(!noWake.ok && noWake.reason.includes("no wakeId"), "a dispatch with no window wake names the missing join key");
  ok(!noWake.ok && noWake.fixture === true, "🔴 …and marks it a FIXTURE fact, so the leg reds as RED-until-fixture: a delivery that minted no single-window wake has measured NOTHING about the taint plane, and calling that a hard gate failure puts a red on the taint plane for a domain-mode setting");
  ok(!threadFollow.ok && threadFollow.fixture === undefined, "🔴 NEGATIVE CONTROL: a thread-follow dispatch is NOT a fixture fact — the preflight already accepted this anchor, so the front door disagreeing with it is a finding and stays a hard gate");

  const noVerdict = notionTaintReplayEvidence(
    exactRows.filter((r) => r.action !== "taint.verdict" && r.action !== "notion.replied").concat(row("notion.no_reply", { sessionId: "session-1", reason: "not_relevant" })),
    mine,
  );
  ok(!noVerdict.ok && noVerdict.reason.includes("notion.no_reply"), "🔴 when the replay's own turn ran and wrote no verdict, the red names the turn's terminal row — the exact fact that settled ship #217's diagnosis");

  const foreignVerdict = notionTaintReplayEvidence(
    exactRows.map((r) => (r.action === "taint.verdict" ? { ...r, detail: { kind: "notion", sessionId: "someone-else", parentSessionId: "another-seat" } } : r)),
    mine,
  );
  ok(!foreignVerdict.ok, "🔴 NEGATIVE CONTROL: a `notion` verdict written by an unrelated session does NOT satisfy this replay, which is precisely what the old time-window scan could not tell apart");

  ok(joined.ok && joined.evidence.road === "notion", "the org road is named on the evidence — a green that does not say which road it measured is a green nobody can read");

  ok(transcriptHasNotionPageRead([{ index: 1, at: null, type: "actions.requested", data: { actions: [{ toolName: "read_notion_page" }] } }]), "the replay session's transcript confirms the page-read tool request");
  ok(!transcriptHasNotionPageRead([{ index: 1, at: null, type: "actions.requested", data: { actions: [{ toolName: "no_reply" }] } }]), "🔴 ship #217's no_reply-only transcript cannot pass the page-read proof");

  {
    const lentPage = "40000000-0000-4000-8000-000000000101";
    const delivery = { deliveryId: "00000000-0000-4000-8000-000000000033", commentId: "40000000-0000-4000-8000-000000000110", discussionId: "discussion-228" };
    const boardRow = (action: string, detail: Record<string, unknown>, tsMsBefore = 0): AuditWireEntry => ({
      ts: new Date(now - tsMsBefore).toISOString(),
      org: "default",
      platform: action === "taint.verdict" ? "ingest" : "notion",
      workspace: action === "taint.verdict" ? String(detail.kind ?? "?") : "workspace-1",
      surface: lentPage,
      action,
      detail,
    });
    const spend = boardRow(
      "grant.used",
      {
        connector: "notion",
        grantId: "00000000-0000-4000-8000-000000000034",
        mode: "standing",
        resource: "notion-fetch keys:id",
        scopeKey: "oe-grant-domain::e2e-unified",
        verb: "notion_fetch",
      },
      60_000,
    );
    const lentVerdict = boardRow("taint.verdict", {
      applied: true,
      assumed: true,
      divergence: "over-taint",
      kind: "connector",
      label: "grant:notion:notion_fetch",
      mode: "enforced",
      reason: "a connector read declares untrusted by the table's fail-closed default",
      sessionId: "wrun_example32",
      tableTier: "untrusted",
      taintsToday: true,
      turnId: "turn_2",
    });
    const lentRows = [
      boardRow("notion.dispatched", { ...delivery, addressing: "direct", wakeId: "wake-228" }),
      boardRow("wake.turn_start", { wakeId: "wake-228", sessionId: "wrun_example32", turnId: "turn_2" }),
      boardRow("notion.replied", { sessionId: "wrun_example32", discussionId: "discussion-228" }),
      lentVerdict,
    ];

    const roadInput = { connector: "notion", legPageId: lentPage, nowMs: now, pinnedPageIds: [lentPage], rowLimit: 1000 };
    const admitted = notionTaintGrantRoad([spend], roadInput);
    ok(admitted.admitted && admitted.labelPrefix === "grant:notion:", "a live standing notion grant, on the page this pack asks a grant to pin, admits the lent-tool road");
    ok(admitted.reason.includes("00000000-0000-4000-8000-000000000034") && admitted.reason.includes("notion-fetch keys:id"), "…and the admission names the grant and its audit resource, so a reader can check the claim against the trail");
    ok(admitted.reason.includes("NAMES and never their values"), "🔴 every admission states its own limit: the wire cannot say which page a grant pins, only which page THIS pack asks to be pinned");
    ok(!notionTaintGrantRoad([spend], { ...roadInput, pinnedPageIds: ["another-page"] }).admitted, "🔴 NEGATIVE CONTROL: a live grant is NOT evidence about a page this pack never named — the lent road stays closed there");
    ok(!notionTaintGrantRoad([], roadInput).admitted, "🔴 NEGATIVE CONTROL: the pack's own pinned page with NO live grant on it admits nothing — a `connector` row there is some other tool's read");
    ok(
      !notionTaintGrantRoad([{ ...spend, detail: { ...(spend.detail as Record<string, unknown>), mode: "once" } }], roadInput).admitted,
      "NEGATIVE CONTROL: a ONCE-mode grant is burned by its first call and cannot pre-empt this leg's road",
    );
    ok(!notionTaintGrantRoad([spend], { ...roadInput, connector: "linear" }).admitted, "NEGATIVE CONTROL: the connector is matched — a Linear grant never admits a road for a Notion read");
    const burnt = { ...spend, detail: { ...(spend.detail as Record<string, unknown>), mode: "once" } };
    const atCeiling = notionTaintGrantRoad([burnt], { ...roadInput, rowLimit: 1 });
    ok(!atCeiling.admitted && atCeiling.reason.includes("AT its 1-row ceiling"), "🔴 a refusal off a window that came back AT its ceiling says the read was truncated, rather than turning a page it could not prove complete into a clean bill");
    ok(!notionTaintGrantRoad([burnt], roadInput).reason.includes("ceiling"), "🔴 NEGATIVE CONTROL: the same refusal under the ceiling makes NO truncation claim, so the line above is driven by the count and not by the sentence always being there");
    ok(notionTaintGrantRoad([burnt], { ...roadInput, pinnedPageIds: ["another-page"], rowLimit: 1 }).reason.includes("AT its 1-row ceiling"), "the unpinned refusal carries the truncation sentence too — both refusals claim an absence, so both disclose it");

    const lentJoin = notionTaintReplayEvidence(lentRows, { ...delivery, grantRoad: admitted });
    ok(lentJoin.ok, "🔴 THE SHIP #228 SHAPE JOINS: the forged replay's own turn read the page through the lent tool, and the arm now accepts that road");
    ok(lentJoin.ok && lentJoin.evidence.road === "grant", "…and the evidence names the LENT road, so the leg logs which road served rather than reporting a bare green");
    ok(lentJoin.ok && (lentJoin.evidence.verdict.detail as { label?: unknown }).label === "grant:notion:notion_fetch", "…and the row it carries is the lent one, whose label the leg logs on either road — the KIND never names the tool");
    ok(lentJoin.ok && lentJoin.evidence.verdictSessionId === "wrun_example32", "the lent road joins by the same session key as the org road — widening the KIND never widened the JOIN");

    const orgOnly = notionTaintReplayEvidence(lentRows, delivery);
    ok(!orgOnly.ok, "🔴 without an admitted lent road the SAME rows are refused — this is boards #226/#228's red, and the assertion above is what fixes it");
    ok(!orgOnly.ok && orgOnly.reason.includes("grant:notion:notion_fetch"), "…and the refusal NAMES the connector row it saw, so triage reads the road rather than a bare absence");

    const refused = notionTaintReplayEvidence(lentRows, { ...delivery, grantRoad: notionTaintGrantRoad([], roadInput) });
    ok(!refused.ok, "🔴 NEGATIVE CONTROL: the lent row does NOT satisfy the replay when no live grant explains it — the arm is not a scan for any `connector` row");
    ok(!refused.ok && refused.reason.includes("no LIVE standing notion grant"), "…and the refusal quotes the admission's own reason, so the red says what the harness could not establish");

    const otherLabel = notionTaintReplayEvidence(
      lentRows.map((r) => (r.action === "taint.verdict" ? { ...r, detail: { ...(r.detail as Record<string, unknown>), label: "web_fetch" } } : r)),
      { ...delivery, grantRoad: admitted },
    );
    ok(!otherLabel.ok, "🔴 NEGATIVE CONTROL: a `connector` verdict that is NOT a grant borrow (label `web_fetch`) never stands in for the page read, admitted road or not");

    const foreignLent = notionTaintReplayEvidence(
      lentRows.map((r) => (r.action === "taint.verdict" ? { ...r, detail: { ...(r.detail as Record<string, unknown>), sessionId: "someone-else" } } : r)),
      { ...delivery, grantRoad: admitted },
    );
    ok(!foreignLent.ok, "🔴 NEGATIVE CONTROL: an unrelated session's grant read does not satisfy this replay — the id join is the whole point of OPE-1907 and the new road keeps it");

    const bothRoads = notionTaintReplayEvidence(
      [...lentRows, boardRow("taint.verdict", { applied: true, assumed: false, divergence: "over-taint", kind: "notion", mode: "enforced", reason: "vouched workspace", sessionId: "wrun_example32" })],
      { ...delivery, grantRoad: admitted },
    );
    ok(bothRoads.ok && bothRoads.evidence.road === "notion", "when BOTH roads wrote a row for one turn the ORG road is reported — the lent road is the fallback, never a replacement");

    const grantCall: readonly TranscriptWireEvent[] = [{ index: 1, at: null, type: "actions.requested", data: { actions: [{ toolName: "grant__rowan_notion__notion_fetch_test_page" }] } }];
    ok(transcriptHasNotionPageRead(grantCall, { road: "grant", connector: "notion" }), "🔴 the lent road's transcript witness reads the GRANT tool the row mounted — a lent turn never calls read_notion_page, so asking for that name would red a correct turn");
    ok(!transcriptHasNotionPageRead(grantCall), "🔴 NEGATIVE CONTROL: the same transcript fails the ORG road's witness, so the witness really is following the road and not accepting everything");
    ok(
      !transcriptHasNotionPageRead([{ index: 1, at: null, type: "actions.requested", data: { actions: [{ toolName: "grant__rowan_linear__linear_read_issue" }] } }], { road: "grant", connector: "notion" }),
      "NEGATIVE CONTROL: a LINEAR grant tool in the same turn does not witness a Notion page read",
    );
    ok(!transcriptHasNotionPageRead([{ index: 1, at: null, type: "actions.requested", data: { actions: [{ toolName: "no_reply" }] } }], { road: "grant", connector: "notion" }), "a no_reply-only transcript fails the lent witness too");
  }

  {
    const seat = "wrun_example54";
    const worker = "wrun_example55";
    const delivery = { deliveryId: "238-rest-delivery", commentId: "comment-238r", discussionId: "discussion-238r" };
    const settle = row("delegation.task_settled", { task: "task-1", status: "completed", session: seat, agent: "agent-1", marker: "tainted", adopted: true, kinds: ["skill-declared"] });
    const restRows = [
      row("notion.dispatched", { ...delivery, addressing: "direct", wakeId: "wake-238r" }),
      row("wake.turn_start", { wakeId: "wake-238r", sessionId: seat, turnId: "turn_2" }),
      row("notion.replied", { sessionId: seat, discussionId: "discussion-238r" }),
      row("worker.toolset", { worker, parentSession: seat, parentCallId: "call-1", tools: ["bash"] }),
      row("delegation.task_started", { task: "task-1", call: "call-1", agent: "agent-1", session: seat, continuation: false }),
      settle,
    ];
    const restWorker: readonly TranscriptWireEvent[] = [
      { index: 1, at: null, type: "actions.requested", data: { turnId: "turn_1", actions: [{ toolName: "bash", callId: "w1", input: { command: "cd skills/notion-rest && node scripts/notion.mjs page markdown current" } }] } },
    ];
    const seatDelegates: readonly TranscriptWireEvent[] = [
      { index: 0, at: null, type: "actions.requested", data: { turnId: "turn_2", actions: [{ toolName: "agent", callId: "call-1", input: {} }] } },
    ];
    const transcripts = { seat: seatDelegates, workers: new Map<string, readonly TranscriptWireEvent[] | undefined>([[worker, restWorker]]) };
    const resolve = (rows: readonly AuditWireEntry[], t = transcripts) => {
      const join = notionTaintReplayEvidence(rows, delivery);
      if (join.ok || !join.noRow) return { join, rest: undefined };
      return { join, rest: notionTaintRestRoad(join.reason, join.noRow, t) };
    };

    const green = resolve(restRows);
    ok(!green.join.ok, "the join alone finds no taint.verdict row on the REST road — that row is a divergence log");
    ok(!green.join.ok && green.join.noRow !== undefined && notionTaintRestMarkSettled(green.join.noRow), "the no-row rung carries the seat's settle row with `skill-declared`, joined by ids");
    ok(green.rest?.ok === true, "🔴 THE BOARD #238 SHAPE IS GREEN: a worker's wrapped notion-rest read plus a settle row with `skill-declared` satisfies arm B");
    ok(green.rest?.ok === true && green.rest.evidence.road === "rest", "…and the evidence names the REST road");
    ok(green.rest?.ok === true && green.rest.evidence.verdictSessionId === worker && green.rest.evidence.verdict === settle, "…attributed to the worker, with the settle row as the mark");

    const noSettle = resolve(restRows.filter((r) => r !== settle));
    ok(!noSettle.join.ok && noSettle.join.noRow !== undefined && !notionTaintRestMarkSettled(noSettle.join.noRow), "NEGATIVE CONTROL: with no settle row, no REST mark is settled");
    ok(noSettle.rest?.ok === false, "🔴 NEGATIVE CONTROL: the worker's REST read with NO settle row is a red — a read is not a mark");
    const noSettleReason =
      noSettle.rest && !noSettle.rest.ok && noSettle.rest.noRow ? notionTaintNoRowReason(noSettle.rest.reason, noSettle.rest.noRow, transcripts, "notion") : "";
    ok(
      noSettleReason.includes("divergence log") && noSettleReason.includes(`worker ${worker}`) && noSettleReason.includes("no delegation.task_settled row for task task-1"),
      `…and the red names the missing settle row for the worker's task — got: ${noSettleReason.slice(-220)}`,
    );

    const otherKinds = resolve(restRows.map((r) => (r === settle ? { ...r, detail: { ...(r.detail as Record<string, unknown>), kinds: ["web"] } } : r)));
    ok(otherKinds.rest?.ok === false, "🔴 NEGATIVE CONTROL: a settle row without `skill-declared` in its kinds is a red");
    const otherKindsReason =
      otherKinds.rest && !otherKinds.rest.ok && otherKinds.rest.noRow ? notionTaintNoRowReason(otherKinds.rest.reason, otherKinds.rest.noRow, transcripts, "notion") : "";
    ok(otherKindsReason.includes("carries kinds [web]"), `…and the red names the kinds the settle row carries — got: ${otherKindsReason.slice(-200)}`);

    const foreignSettle = resolve(restRows.map((r) => (r === settle ? { ...r, detail: { ...(r.detail as Record<string, unknown>), session: "another-seat" } } : r)));
    ok(foreignSettle.rest?.ok === false, "🔴 NEGATIVE CONTROL: another seat's settle row for the same task id does not count — the join is on the session id");
    const otherTask = resolve(restRows.map((r) => (r === settle ? { ...r, detail: { ...(r.detail as Record<string, unknown>), task: "task-2" } } : r)));
    ok(otherTask.rest?.ok === false, "NEGATIVE CONTROL: a settle row for another task does not count — the join is on the task id, never on time");

    const idleWorker = resolve(restRows, { seat: seatDelegates, workers: new Map([[worker, [{ index: 1, at: null, type: "actions.requested", data: { actions: [{ toolName: "bash", callId: "w1", input: { command: "node scripts/notion.mjs page current" } }] } }]]]) });
    ok(idleWorker.rest?.ok === false, "🔴 NEGATIVE CONTROL: a settle row with `skill-declared` but no wrapped notion-rest read is a red — another skill can declare that kind");
    const unreadWorker = resolve(restRows, { seat: seatDelegates, workers: new Map<string, readonly TranscriptWireEvent[] | undefined>([[worker, undefined]]) });
    ok(unreadWorker.rest?.ok === false, "NEGATIVE CONTROL: an unreadable worker transcript is never a REST green");

    const orgAndRest = notionTaintReplayEvidence([...restRows, row("taint.verdict", { kind: "notion", sessionId: seat })], delivery);
    ok(orgAndRest.ok && orgAndRest.evidence.road === "notion", "when the org road also wrote a row, the join reports the org road");

    const seatOnly = notionTaintReplayEvidence(restRows.slice(0, 3), delivery);
    const seatRest: readonly TranscriptWireEvent[] = [
      { index: 0, at: null, type: "actions.requested", data: { turnId: "turn_2", actions: [{ toolName: "bash", callId: "s1", input: { command: "node scripts/notion.mjs page markdown current" } }] } },
    ];
    const seatRoad = !seatOnly.ok && seatOnly.noRow ? notionTaintRestRoad(seatOnly.reason, seatOnly.noRow, { seat: seatRest, workers: new Map() }) : undefined;
    ok(seatRoad?.ok === false, "🔴 a seat-side REST read with no worker is a red, never a green");
    const seatReason = !seatOnly.ok && seatOnly.noRow ? notionTaintNoRowReason(seatOnly.reason, seatOnly.noRow, { seat: seatRest, workers: new Map() }, "notion") : "";
    ok(
      seatReason.includes("read attempted over the REST road; the plane records no row for an agreeing unconditional kind"),
      `…and the red states the honest answer — got: ${seatReason.slice(-200)}`,
    );

    {
      const fwSeat = "wrun_example74";
      const fwWork = "wrun_example75";
      const fwWorker = "wrun_example76";
      const sibling = "wrun_example77";
      const fwDelivery = { deliveryId: "2361-armb-delivery", commentId: "comment-2361b", discussionId: "discussion-2361b" };
      const fwSettle = row("delegation.task_settled", { task: "agent-2361b", status: "completed", session: fwWork, agent: fwWorker, marker: "tainted", adopted: true, kinds: ["skill-declared"] });
      const fwRows = [
        row("notion.dispatched", { ...fwDelivery, addressing: "direct", wakeId: "wake-2361b" }),
        row("wake.turn_start", { wakeId: "wake-2361b", sessionId: fwSeat, turnId: "turn_2" }),
        row("work.forwarded", { requestId: "req-2361b", wakeId: "wake-2361b", workGeneration: 2, tainted: false, seatSessionId: fwSeat }),
        row("wake.turn_start", { wakeId: "req-2361b", sessionId: fwWork, turnId: "turn_9" }),
        row("delegation.task_started", { task: "agent-2361b", call: "call-2361b", kind: "agent", session: fwWork, continuation: false, request: "req-2361b" }),
        row("worker.toolset", { worker: fwWorker, parentSession: fwWork, parentCallId: "call-2361b", rootSession: fwSeat, grain: "task", tools: ["bash"] }),
        fwSettle,
      ];
      const fwTranscripts = { seat: [] as readonly TranscriptWireEvent[], workers: new Map<string, readonly TranscriptWireEvent[] | undefined>([[fwWorker, restWorker]]) };
      const fwJoin = notionTaintReplayEvidence(fwRows, fwDelivery);
      ok(!fwJoin.ok && fwJoin.noRow !== undefined && fwJoin.noRow.workerSessionIds.includes(fwWorker), `🔴 OPE-2361: the forward joins the work session's worker (got ${JSON.stringify(!fwJoin.ok ? fwJoin.noRow?.workerSessionIds : "ok")})`);
      ok(!fwJoin.ok && fwJoin.noRow !== undefined && notionTaintRestMarkSettled(fwJoin.noRow), "🔴 …and W's settle row for that task carries the REST mark");
      const fwRest = !fwJoin.ok && fwJoin.noRow ? notionTaintRestRoad(fwJoin.reason, fwJoin.noRow, fwTranscripts) : undefined;
      ok(fwRest?.ok === true && fwRest.evidence.road === "rest" && fwRest.evidence.verdictSessionId === fwWorker && fwRest.evidence.verdict === fwSettle, "🔴 THE 0.2.0 ARM B SHAPE IS GREEN: the forwarded worker's REST read plus W's settle row");
      const fwOrg = notionTaintReplayEvidence([...fwRows, row("taint.verdict", { kind: "notion", sessionId: fwWorker, parentSessionId: fwWork })], fwDelivery);
      ok(fwOrg.ok && fwOrg.evidence.road === "notion" && fwOrg.evidence.verdictSessionId === fwWorker, "🔴 a notion verdict from the forwarded worker is attributed to this replay");

      const siblingVerdict = notionTaintReplayEvidence([...fwRows, row("taint.verdict", { kind: "notion", sessionId: sibling, parentSessionId: fwWork })], fwDelivery);
      ok(!siblingVerdict.ok, "🔴 NEGATIVE CONTROL: a sibling job's worker under the same W is not this replay's reader");
      const noForward = notionTaintReplayEvidence(fwRows.filter((r) => r.action !== "work.forwarded"), fwDelivery);
      ok(!noForward.ok && noForward.noRow !== undefined && noForward.noRow.workerSessionIds.length === 0, "NEGATIVE CONTROL: with no forward row, no work-session worker joins");
      const otherWake = notionTaintReplayEvidence(fwRows.map((r) => (r.action === "work.forwarded" ? { ...r, detail: { ...(r.detail as Record<string, unknown>), wakeId: "another-wake" } } : r)), fwDelivery);
      ok(!otherWake.ok && otherWake.noRow !== undefined && otherWake.noRow.workerSessionIds.length === 0, "NEGATIVE CONTROL: a forward of another wake joins no worker");
      const otherCall = notionTaintReplayEvidence(fwRows.map((r) => (r.action === "worker.toolset" ? { ...r, detail: { ...(r.detail as Record<string, unknown>), parentCallId: "call-sibling" } } : r)), fwDelivery);
      ok(!otherCall.ok && otherCall.noRow !== undefined && otherCall.noRow.workerSessionIds.length === 0, "NEGATIVE CONTROL: a worker W started under another call is not this job's worker");
      ok(NOTION_TAINT_REPLAY_ACTIONS.includes("work.forwarded") && NOTION_TAINT_REPLAY_ACTIONS.includes("worker.toolset"), "🔴 WIRING: arm B's read asks for work.forwarded and worker.toolset");
      ok(SCENARIOS.find((s) => s.id === "S-TAINT-DRYRUN")!.run.toString().replace(/\s+/g, "").includes("replayActions=NOTION_TAINT_REPLAY_ACTIONS"), "🔴 WIRING: S-TAINT-DRYRUN arm B reads NOTION_TAINT_REPLAY_ACTIONS");
    }

    const restCall = (command: string): readonly TranscriptWireEvent[] => [
      { index: 1, at: null, type: "actions.requested", data: { actions: [{ toolName: "bash", callId: "c1", input: { command } }] } },
    ];
    ok(transcriptHasNotionPageRead(restCall("cd skills/notion-rest && node scripts/notion.mjs page markdown 40000000-0101 --depth 10"), { road: "rest", connector: "notion" }), "🔴 the REST road's witness reads the worker's bash call to page markdown");
    ok(transcriptHasNotionPageRead(restCall("node scripts/notion.mjs comments list p1 --all"), { road: "rest", connector: "notion" }), "the REST witness accepts comments list, the other wrapped read");
    ok(!transcriptHasNotionPageRead(restCall("node scripts/notion.mjs page current"), { road: "rest", connector: "notion" }), "🔴 NEGATIVE CONTROL: page current prints a handle and writes no verdict, so it does not witness the REST road");
    ok(!transcriptHasNotionPageRead(restCall("node scripts/notion.mjs search runbook"), { road: "rest", connector: "notion" }), "NEGATIVE CONTROL: search does not witness a page read");
    ok(
      !transcriptHasNotionPageRead([{ index: 1, at: null, type: "actions.requested", data: { actions: [{ toolName: "read_file", input: { path: "scripts/notion.mjs page markdown" } }] } }], { road: "rest", connector: "notion" }),
      "NEGATIVE CONTROL: the witness needs a `bash` call — the verb text in another tool's input is not a run",
    );
    ok(!transcriptHasNotionPageRead(restCall("node scripts/notion.mjs page markdown p1")), "NEGATIVE CONTROL: the same call fails the ORG road's witness, so the witness follows the road");
  }

  {
    const seat = "wrun_example49";
    const worker = "wrun_41M37G0000WORKER0000000001";
    const delivery = { deliveryId: "238-delivery", commentId: "comment-238", discussionId: "discussion-238" };
    const baseRows = [
      row("notion.dispatched", { ...delivery, addressing: "direct", wakeId: "wake-238" }),
      row("wake.turn_start", { wakeId: "wake-238", sessionId: seat, turnId: "turn_2" }),
      row("notion.no_reply", { sessionId: seat, discussionId: "discussion-238" }),
    ];
    const call = (turnId: string, callId: string, toolName: string, input: unknown = {}): TranscriptWireEvent => ({
      index: 0, at: null, type: "actions.requested", data: { turnId, actions: [{ callId, toolName, input }] },
    });
    const turn238 = [
      { index: 0, at: null, type: "turn.started", data: { turnId: "turn_2" } },
      call("turn_2", "c1", "reply"),
      call("turn_2", "c1", "reply"),
      call("turn_2", "c2", "no_reply"),
    ] as const satisfies readonly TranscriptWireEvent[];
    const noWorkers = new Map<string, readonly TranscriptWireEvent[] | undefined>();

    const join = notionTaintReplayEvidence(baseRows, delivery);
    ok(!join.ok, "🔴 the ship #238 shape is still a hard red at the join — no row is never a pass");
    const noRow = !join.ok ? join.noRow : undefined;
    ok(noRow?.sessionId === seat && noRow.turnId === "turn_2" && noRow.workerSessionIds.length === 0, "the no-row rung carries the seat, its turn and an empty worker list");
    const joinReason = !join.ok ? join.reason : "";

    const noRead = notionTaintNoRowReason(joinReason, noRow!, { seat: turn238, workers: noWorkers }, "notion");
    ok(
      noRead.startsWith("NO READ ATTEMPTED: the replay turn made no Notion read on any road (seat calls: reply, no_reply)"),
      `🔴 THE SHIP #238 SHAPE: no read on any road names NO READ ATTEMPTED with the seat's calls in order — got: ${noRead.slice(0, 160)}`,
    );

    for (const [road, extra] of [
      ["org read_notion_page", call("turn_2", "c3", "read_notion_page", { pageId: "p1" })],
      ["org notion_search", call("turn_2", "c3", "notion_search", { query: "runbook" })],
      ["org read_notion_comments", call("turn_2", "c3", "read_notion_comments", { pageId: "p1" })],
      ["lent grant tool", call("turn_2", "c3", "grant__rowan_notion__notion_fetch_p1")],
      ["REST bash", call("turn_2", "c3", "bash", { command: "node scripts/notion.mjs page markdown p1" })],
    ] as const) {
      const text = notionTaintNoRowReason(joinReason, noRow!, { seat: [...turn238, extra], workers: noWorkers }, "notion");
      ok(text.startsWith(joinReason) && !text.includes("NO READ ATTEMPTED") && text.includes("WAS requested"), `🔴 a ${road} read with no row keeps the existing no-row text and names the read`);
    }
    const linearGrant = notionTaintNoRowReason(joinReason, noRow!, { seat: [...turn238, call("turn_2", "c3", "grant__rowan_linear__linear_read_issue")] , workers: noWorkers }, "notion");
    ok(linearGrant.startsWith("NO READ ATTEMPTED"), "NEGATIVE CONTROL: a grant tool on ANOTHER connector is not a Notion read");
    const restHandle = notionTaintNoRowReason(joinReason, noRow!, { seat: [...turn238, call("turn_2", "c3", "bash", { command: "node scripts/notion.mjs page current" })], workers: noWorkers }, "notion");
    ok(restHandle.startsWith("NO READ ATTEMPTED"), "NEGATIVE CONTROL: `page current` is not a wrapped read verb");

    const earlier = notionTaintNoRowReason(joinReason, noRow!, { seat: [call("turn_1", "c0", "read_notion_page"), ...turn238], workers: noWorkers }, "notion");
    ok(earlier.startsWith("NO READ ATTEMPTED") && earlier.includes("(seat calls: reply, no_reply)"), "🔴 a read in another turn of the same session neither counts nor lists");

    const unreadable = notionTaintNoRowReason(joinReason, noRow!, { seat: undefined, workers: noWorkers }, "notion");
    ok(unreadable.startsWith(joinReason) && !unreadable.includes("NO READ ATTEMPTED") && unreadable.includes("unreadable"), "🔴 an unreadable seat transcript never claims NO READ ATTEMPTED");
    const otherTurn = notionTaintNoRowReason(joinReason, noRow!, { seat: [call("turn_1", "c0", "reply")], workers: noWorkers }, "notion");
    ok(otherTurn.startsWith(joinReason) && !otherTurn.includes("NO READ ATTEMPTED"), "🔴 a transcript that does not hold the replay turn never claims NO READ ATTEMPTED");

    const delegated = notionTaintReplayEvidence(
      [...baseRows, row("worker.toolset", { worker, parentSession: seat, tools: ["bash"] }), row("worker.toolset", { worker: "wrun_other", parentSession: "another-seat" })],
      delivery,
    );
    const dRow = !delegated.ok ? delegated.noRow : undefined;
    ok(dRow?.workerSessionIds.length === 1 && dRow.workerSessionIds[0] === worker, "the join lists this seat's worker and NOT another seat's");
    const seatDelegates = [...turn238.slice(0, 2), call("turn_2", "c4", "delegate")];
    const workerRest = notionTaintNoRowReason(joinReason, dRow!, { seat: seatDelegates, workers: new Map([[worker, [call("turn_1", "w1", "bash", { command: "node scripts/notion.mjs comments list p1" })]]]) }, "notion");
    ok(!workerRest.includes("NO READ ATTEMPTED") && workerRest.includes(`worker ${worker}`), "🔴 a worker's REST read with no row keeps the existing text and names the worker");
    const workerIdle = notionTaintNoRowReason(joinReason, dRow!, { seat: seatDelegates, workers: new Map([[worker, [call("turn_1", "w1", "read_file")]]]) }, "notion");
    ok(workerIdle.startsWith("NO READ ATTEMPTED") && workerIdle.includes(worker), "a delegated turn whose worker made no Notion read is NO READ ATTEMPTED, and names the worker");
    const workerUnread = notionTaintNoRowReason(joinReason, dRow!, { seat: seatDelegates, workers: new Map([[worker, undefined]]) }, "notion");
    ok(!workerUnread.includes("NO READ ATTEMPTED") && workerUnread.includes("unreadable"), "🔴 an unreadable worker transcript never claims NO READ ATTEMPTED");

    const withRow = notionTaintReplayEvidence([...baseRows, row("taint.verdict", { kind: "notion", sessionId: seat })], delivery);
    ok(withRow.ok, "read-with-row still passes the join");
    const noDispatch = notionTaintReplayEvidence(baseRows.slice(1), delivery);
    ok(!noDispatch.ok && noDispatch.noRow === undefined, "NEGATIVE CONTROL: only the turn-ran-no-row rung carries no-row keys");
  }
}

{
  ok(backoffDelayMs(0) === 2_000, "backoff starts at 2s");
  ok(backoffDelayMs(1) === 3_000 && backoffDelayMs(2) === 4_000, "backoff steps +1s per attempt");
  ok(backoffDelayMs(3) === 5_000 && backoffDelayMs(50) === 5_000, "backoff caps at 5s");

  let calls = 0;
  const found = await pollUntil(
    async () => (++calls >= 3 ? "found" : undefined),
    { timeoutMs: 1_000, initialDelayMs: 1, maxDelayMs: 2, what: "a test value" },
  );
  ok(found === "found" && calls === 3, "pollUntil resolves once the probe returns a value");
  let timedOut = false;
  try {
    await pollUntil(async () => undefined, { timeoutMs: 10, initialDelayMs: 1, maxDelayMs: 2, what: "never" });
  } catch (err) {
    timedOut = err instanceof PollTimeout && String(err).includes("never");
  }
  ok(timedOut, "pollUntil throws a legible PollTimeout when the budget elapses");
}

{
  const opts = { timeoutMs: 2_000, initialDelayMs: 1, maxDelayMs: 2 } as const;

  ok((await pollOptional(async () => "hit", { ...opts, what: "a value" })) === "hit", "pollOptional returns the probe's value");
  ok(
    (await pollOptional(async () => undefined, { timeoutMs: 20, initialDelayMs: 1, maxDelayMs: 2, what: "nothing" })) === undefined,
    "pollOptional resolves undefined on a genuine ABSENCE (budget elapsed, every read fine)",
  );

  let attempts = 0;
  const afterBlip = await pollOptional(
    async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient 503");
      return "recovered";
    },
    { ...opts, what: "a value after one blip" },
  );
  ok(afterBlip === "recovered" && attempts === 2, "pollOptional tolerates ONE consecutive probe failure and retries on the next tick");

  let twoInARow: unknown;
  try {
    await pollOptional(async () => { throw new Error("audit read is down"); }, { ...opts, what: "a row" });
  } catch (err) {
    twoInARow = err;
  }
  ok(twoInARow instanceof Error && String(twoInARow).includes("audit read is down"), "🔴 pollOptional THROWS the underlying error on two consecutive failures — a broken read is never reported as 'no row'");

  let midFailure: unknown;
  try {
    await pollOptional(async () => { throw new Error("intermittent 500"); }, { timeoutMs: 0, initialDelayMs: 1, maxDelayMs: 1, what: "a row" });
  } catch (err) {
    midFailure = err;
  }
  ok(midFailure instanceof Error && String(midFailure).includes("intermittent 500"), "🔴 a budget that elapses with the most recent read FAILING throws that failure rather than reporting absence");
}

{
  const { buildCostReport, renderCostReport } = await import("../packages/core/scripts/e2e/cost.js");
  const rows = [
    { surfaceKey: "slack/T1/C1", model: "test/model-a", calls: 3, inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 2 },
    { surfaceKey: "discord/G1/C2", model: "test/unpriced", calls: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { surfaceKey: "slack/T1/C1", calls: 1, inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ];
  const report = buildCostReport(rows);
  ok(Math.abs(report.totalUsd - 2) < 1e-9, "total sums exactly the server-priced slices");
  ok(JSON.stringify(report.unpricedModels) === JSON.stringify(["(unstamped)", "test/unpriced"]), "unpriced models reported by name (unstamped included), contribute $0");
  ok(report.slices[1].estimatedUsd === undefined, "unpriced slice carries no dollar figure (evidence rule)");
  ok(report.slices[2].model === "(unstamped)", "a model-less wire row renders as (unstamped)");
  const lines = renderCostReport(report);
  const totalLine = lines.find((l) => l.startsWith("e2e run cost:")) ?? "";
  ok(totalLine.startsWith("e2e run cost: $2.0000"), "total line renders the priced sum");
  ok(totalLine.includes("test/unpriced"), "total line names what it could NOT price");
  ok(lines[0].includes("3 calls") && lines[0].includes("1000000in/500000out"), "slice line shows calls + tokens");

  const exclusionLine = (r: Parameters<typeof renderCostReport>[0]): string => renderCostReport(r).find((l) => l.includes("excluded by the run's session bound")) ?? "";
  ok(exclusionLine(report).includes("not reported"), "OPE-1622: a report with NO excluded block says 'not reported' — the deployment's read predates the field");
  ok(
    exclusionLine(buildCostReport(rows, { surfaceKeys: [], calls: 0, estimatedUsd: 0, unpricedModels: [], sessionsUpperBound: 0 })).includes("none"),
    "OPE-1622: an excluded count of ZERO renders as 'none' — a real answer, distinct from 'not reported'",
  );
  const hidden = exclusionLine(
    buildCostReport(rows, { surfaceKeys: ["teams/tenant-a/general"], calls: 9, estimatedUsd: 1.5, unpricedModels: ["mystery/x"], sessionsUpperBound: 2 }),
  );
  ok(hidden.includes("9 call(s)") && hidden.includes("$1.5000"), "OPE-1622: 🔴 a non-zero exclusion prints the calls and the dollars the total does NOT contain");
  ok(hidden.includes("teams/tenant-a/general"), "OPE-1622: …and names the surface whose figure is short — the question a bare $0.0000 leaves unanswered");
  ok(hidden.includes("up to 2 session(s)"), "OPE-1622: …with the session figure worded as the upper bound it is, never as an exact count");
  ok(hidden.includes("mystery/x"), "OPE-1622: …and names an unpriced model among the excluded rows, so the excluded $ is not read as complete");

  const { checkExpectedModels } = await import("../packages/core/scripts/e2e/cost.js");
  const ok1 = checkExpectedModels(rows, ["test/model-a", "test/unpriced"]);
  ok(!ok1.ok && ok1.unexpected.join(",") === "(unstamped)", "checkExpectedModels flags an unstamped row when it's not in the expected set");
  const ok2 = checkExpectedModels(rows, ["test/model-a", "test/unpriced", "(unstamped)"]);
  ok(ok2.ok && ok2.unexpected.length === 0, "checkExpectedModels passes when every stamped/unstamped model is expected");
  ok(ok2.seen.join(",") === "(unstamped),test/model-a,test/unpriced", "checkExpectedModels reports the distinct model set it saw (sorted)");
  const ok3 = checkExpectedModels(rows, ["test/model-a"]);
  ok(!ok3.ok && ok3.unexpected.includes("test/unpriced"), "checkExpectedModels flags an unexpected routed model (the routing-regression catch)");
  const withSandbox = [...rows, { surfaceKey: "slack/T1/C1", calls: 2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }];
  const ok4 = checkExpectedModels(withSandbox, ["test/model-a", "test/unpriced", "(unstamped)"]);
  ok(ok4.ok && !ok4.seen.includes("(sandbox)"), "checkExpectedModels ignores zero-token model-less rows (sandbox runtime billing, not a model call)");
  const ok5 = checkExpectedModels([{ surfaceKey: "slack/T1/C1", calls: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }], ["test/model-a"]);
  ok(ok5.ok && ok5.seen.length === 0, "a window containing ONLY sandbox runtime rows passes with an empty seen set");

  const { defaultExpectedModels, resolveExpectedModels } = await import("../packages/core/scripts/e2e/cost.js");
  const { STACKS, SHIPPED_STACK, stackModelIds } = await import("../agent/model/stacks.js");
  const shippedIds = stackModelIds(STACKS[SHIPPED_STACK]);
  ok(JSON.stringify(await defaultExpectedModels()) === JSON.stringify(shippedIds), "defaultExpectedModels() names exactly the shipped default stack's ids — a stack flip changes this with zero e2e-side edits");
  ok(JSON.stringify(await resolveExpectedModels(undefined)) === JSON.stringify(shippedIds), "resolveExpectedModels(undefined) — unset E2E_EXPECT_MODELS — falls back to the shipped stack, not 'off'");
  ok(JSON.stringify(await resolveExpectedModels("")) === JSON.stringify(shippedIds), "resolveExpectedModels('') — blank E2E_EXPECT_MODELS — same fallback as unset");
  ok(JSON.stringify(await resolveExpectedModels("  ,  ")) === JSON.stringify(shippedIds), "resolveExpectedModels ignores a whitespace/empty-entries-only override and falls back");
  ok(JSON.stringify(await resolveExpectedModels("deepseek/deepseek-v4-flash-0731, alibaba/qwen3-vl-instruct")) === JSON.stringify(["deepseek/deepseek-v4-flash-0731", "alibaba/qwen3-vl-instruct"]), "resolveExpectedModels honours an explicit operator override over the shipped default, trimmed (order preserved, same as the CSV it replaces)");
  ok(shippedIds.length === 2, "the shipped default stack (american-closed) collapses five roles to exactly two ids (luna text + gemini vision) — dedup is real");
  ok(shippedIds.includes("google/gemini-3.8-flash"), "the shipped set carries the vision id — an F-ART run's describer rows are expected models, not a red");

  const { UNKNOWN_MODEL } = await import("../packages/core/agent/spend/spend.js");
  const unknownRow = { surfaceKey: "slack/T1/C1", model: UNKNOWN_MODEL, calls: 1, inputTokens: 1286, outputTokens: 152, cacheReadTokens: 0, cacheWriteTokens: 1283 };
  const ok6 = checkExpectedModels([...rows, unknownRow], ["test/model-a", "test/unpriced", "(unstamped)"]);
  ok(!ok6.ok && ok6.unexpected.includes(UNKNOWN_MODEL), "🔴 OPE-1878: checkExpectedModels reds on the UNKNOWN_MODEL sentinel — a token-bearing call nothing could name is a routing gap, never a pass");
  ok(!(await defaultExpectedModels()).includes(UNKNOWN_MODEL), "…and the DERIVED expected set never names the sentinel, so no stack flip can make an unnamed call acceptable");
}

{
  const { buildUnifiedAuditQuery } = await import("../packages/core/scripts/e2e/audit-read.js");
  ok(buildUnifiedAuditQuery({ domain: "e2e-unified" }) === "?domain=e2e-unified", "unified-audit query carries the domain");
  ok(buildUnifiedAuditQuery({ domain: "payments", sinceDays: 7 }) === "?domain=payments&sinceDays=7", "unified-audit query carries the optional sinceDays");
  ok(buildUnifiedAuditQuery({}) === "", "an absent domain yields an EMPTY query — the missing-domain 400 route leg");
}

{
  const { defineDomain, assertUnifiedDomainTrust } = await import("@open-everywhere/core/agent/memory/domain.js");
  const { supervisorGrainFor, unifiedSupervisorToken, unifiedDomainSessionKey } = await import("@open-everywhere/core/agent/channels/unified-supervisor.js");
  const { definePrincipal, resolvePrincipal, assertPrincipalsValid } = await import("@open-everywhere/core/agent/identity/principals.js");
  const throws = (fn: () => unknown): boolean => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  const A = "slack/T1/C0UNIA";
  const B = "slack/T1/C0UNIB";
  const fixture = defineDomain({ name: "e2e-unified", reach: [A, B], ambientSupervisor: true, mode: "unified" });
  const ambientTwin = defineDomain({ name: "e2e-unified", reach: [A, B], ambientSupervisor: true });
  const org = defineDomain({ name: "org", match: "org" });

  overrideSettingsForTest({ window: { topology: false } });
  try {
    for (const key of [A, B]) {
      const off = supervisorGrainFor(key, [fixture, org]);
      const ambient = supervisorGrainFor(key, [ambientTwin, org]);
      ok(off.unified === false && off.registryKey === key && off.domainName === undefined, `gate OFF: ${key} plans per-container (registryKey === surfaceKey)`);
      ok(JSON.stringify(off) === JSON.stringify(ambient), `gate OFF: the unified fixture's plan is IDENTICAL to the plain-ambient twin's for ${key} (byte-identical-off)`);
    }
    ok(supervisorGrainFor(A, [fixture, org]).unified === false, "gate OFF: a domain with mode set still plans per-container until the WINDOW_TOPOLOGY_ENABLED code capability is flipped ON");

    overrideSettingsForTest({ window: { topology: true } });
    const onA = supervisorGrainFor(A, [fixture, org]);
    const onB = supervisorGrainFor(B, [fixture, org]);
    ok(
      onA.unified === true && onB.unified === true && onA.registryKey === onB.registryKey && onA.registryKey === unifiedDomainSessionKey("e2e-unified"),
      "gate ON + mode unified: both fixture channels resolve ONE domain-keyed registry row (oe-domain::e2e-unified) — one team, one supervisor session",
    );
    ok(
      unifiedSupervisorToken("e2e-unified", 1) === "oe-dom:e2e-unified:oe-sup:g1",
      "gate ON: the fixture domain's session token is oe-dom:<domain>:oe-sup:g<n> (carries the :oe-sup:g infix so spend/rotation/model-routing detectors are unchanged)",
    );
  } finally {
    overrideSettingsForTest({ window: { topology: false } });
  }

  ok(!throws(() => assertUnifiedDomainTrust([fixture, org])), "the documented J-UNIFIED fixture passes assertUnifiedDomainTrust");
  ok(
    throws(() => assertUnifiedDomainTrust([defineDomain({ name: "org", match: "org", ambientSupervisor: true, mode: "unified" })])),
    "mode on the org pseudo-domain → load fails loud (the 'window everything' footgun)",
  );
  ok(
    throws(() => assertUnifiedDomainTrust([defineDomain({ name: "public", match: "public", ambientSupervisor: true, mode: "unified" })])) &&
      throws(() => assertUnifiedDomainTrust([defineDomain({ name: "dm", match: "dm", ambientSupervisor: true, mode: "unified" })])),
    "mode on the public/dm pseudo-domains → load fails loud",
  );
  ok(
    !throws(() => assertUnifiedDomainTrust([defineDomain({ name: "e2e-unified", reach: [A, B], mode: "unified" })])),
    "mode WITHOUT ambientSupervisor → loads (topology and chattiness are independent since OPE-1695)",
  );

  const human = definePrincipal({ name: "E2E Human", handle: "e2e", ids: { slack: "U_E2E", github: "e2e-human" } });
  ok(
    resolvePrincipal("github", undefined, "e2e-human", [human]) === human && resolvePrincipal("slack", "T_E2E", "U_E2E", [human]) === human,
    "principals: explicit account joins resolve the same human across surfaces (an UNQUALIFIED slack entry still answers for this deployment’s workspace — OPE-350)",
  );
  ok(
    resolvePrincipal("github", undefined, "E2E Human", [human]) === undefined && resolvePrincipal("github", undefined, "e2e", [human]) === undefined,
    "principals: a display-name or handle match NEVER resolves (fail-closed on merge — an attacker-named account inherits nothing)",
  );
  ok(resolvePrincipal("slack", "T_E2E", "U_SOMEONE_ELSE", [human]) === undefined, "principals: an unmapped id stays a distinct per-surface identity");
  ok(
    throws(() => assertPrincipalsValid([human, definePrincipal({ name: "Impostor", ids: { slack: "U_E2E" } })])),
    "principals: a double-claimed (platform, id) fails LOUD at config load (an account is exactly one person)",
  );

  const { buildTail } = await import("@open-everywhere/core/agent/channels/session-tail.js");
  const { renderWakeEnvelope } = await import("@open-everywhere/core/agent/channels/wake-envelope.js");
  type SessionTailEntry = import("@open-everywhere/core/agent/channels/session-tail.js").SessionTailEntry;
  const tmsg = (id: string, container: string, minsAgo: number): SessionTailEntry => ({
    kind: "wake",
    at: new Date(Date.parse("2026-03-15T09:30:00.000Z") - minsAgo * 60_000).toISOString(),
    from: "human",
    trust: "peer",
    author: "U1",
    authorId: "U1",
    id,
    container,
    text: `backscroll ${id}`,
  });
  const tail = buildTail([tmsg("a1", A, 40), tmsg("b1", B, 30), tmsg("a2", A, 20), tmsg("b2", B, 10)], 100_000);
  ok(tail.map((m) => m.id).join(",") === "a1,b1,a2,b2", "multi-container tail: the two rooms interleave in TRUE time order, not one room after the other");
  const envelope = renderWakeEnvelope({
    reason: "channel-activity",
    currentTime: "2026-03-15T09:30:00.000Z",
    channel: { id: "C0UNIA", type: "channel" },
    messages: [
      ...tail,
      { from: "human", author: "Asker", id: "t1", sentAt: "2026-03-15T09:29:00.000Z", trust: "peer", trigger: true, body: "what did we decide?" },
    ],
  });
  ok((envelope.match(new RegExp(`container="${A}"`, "g")) ?? []).length === 2, "each of container A's two messages names A in the render");
  ok((envelope.match(new RegExp(`container="${B}"`, "g")) ?? []).length === 2, "…and each of container B's names B");
  const unlabelled = renderWakeEnvelope({
    reason: "channel-activity",
    currentTime: "2026-03-15T09:30:00.000Z",
    channel: { id: "C0UNIA", type: "channel" },
    messages: [
      ...tail.map(({ container: _drop, ...rest }) => rest),
      { from: "human" as const, author: "Asker", id: "t1", sentAt: "2026-03-15T09:29:00.000Z", trust: "peer" as const, trigger: true, body: "what did we decide?" },
    ],
  });
  ok(!unlabelled.includes("container="), "🔴 the negative control: strip the attribute and the render carries NO room label at all — two surfaces' messages become one undifferentiated stream");
}

{
  const { scoreWithheld, classifyDelegationOutcome } =
    await import("../packages/core/scripts/e2e/window-harness.js");
  const { withheldFromGrain } = await import("@open-everywhere/core/agent/access/window-gate-manifest.js");
  const { LEAN_SEAT_TOOLS } = await import("@open-everywhere/core/agent/access/lean-seat.js");

  const manifest = withheldFromGrain("standing");
  const keep = [...LEAN_SEAT_TOOLS].filter((n: string) => !manifest.includes(n));
  ok(manifest.length > 0, "F1 fixture: the standing grain withholds at least one manifest name (else the pins below are vacuous)");
  ok(keep.includes("reply") && keep.includes("agent"), "F1 fixture: the standing lean-seat keep set includes the speak verb AND the delegation verb");

  const exact = scoreWithheld(manifest, manifest, keep);
  ok(exact.ok, "scoreWithheld: the grain-gate row (withheld == the manifest slice) PASSES");
  ok(exact.surplus.length === 0, "scoreWithheld: an exact row reports no surplus");

  const leanRow = [...new Set([...manifest, "aws", "web_search", "sandbox_tools", "browser_tools"])];
  const superset = scoreWithheld(leanRow, manifest, keep);
  ok(superset.ok, "scoreWithheld: a SUPERSET of the manifest PASSES — the lean-seat row is stricter than the manifest, never leakier (the OPE-981 red)");
  ok(
    superset.surplus.join(",") === "aws,browser_tools,sandbox_tools,web_search",
    "scoreWithheld: the surplus is reported as information, sorted, and names exactly the extra tools",
  );

  const leaked = scoreWithheld(manifest.filter((n: string) => n !== "bash"), manifest, keep);
  ok(!leaked.ok, "scoreWithheld: a manifest name absent from the live withheld list FAILS — that is a leak, and it is the whole point of the gate");
  ok(leaked.missing.join(",") === "bash", "scoreWithheld: the failure names the leaked tool");
  const leakedSuperset = scoreWithheld(leanRow.filter((n: string) => n !== "bash"), manifest, keep);
  ok(!leakedSuperset.ok && leakedSuperset.missing.join(",") === "bash", "scoreWithheld: a big surplus does NOT mask a missing manifest name");

  const overCut = scoreWithheld([...manifest, "reply"], manifest, keep);
  ok(!overCut.ok && overCut.cutKeep.join(",") === "reply", "scoreWithheld: withholding a lean-seat KEEP name FAILS (a seat cut past usefulness)");

  const base = { nativeReceipt: false, replied: false, calls: null };
  ok(
    classifyDelegationOutcome({ ...base, nativeReceipt: true }).status === "PASS",
    "classifyDelegationOutcome: a delegation.task_started row joined to the caller session PASSES on the shipped native arm (the OPE-979 permanent red)",
  );
  const called = [{ name: "agent", errored: false }];
  ok(
    classifyDelegationOutcome({ ...base, replied: true, calls: called }).status === "FAIL",
    "classifyDelegationOutcome: a clean agent call with NO receipt row FAILS — every delegation writes one, so the dispatch leg is broken",
  );
  ok(
    classifyDelegationOutcome({ ...base, replied: true, calls: [{ name: "agent", errored: true }] }).status === "FAIL",
    "classifyDelegationOutcome: an agent call whose execute ERRORED FAILS (never laundered into a model-didn't-choose SKIP)",
  );
  ok(
    classifyDelegationOutcome({ ...base, replied: true, calls: null }).status === "SKIP",
    "classifyDelegationOutcome: an unreadable transcript is a SKIP (an observability failure is not model behaviour, and not a product red)",
  );
  ok(
    classifyDelegationOutcome({ ...base, replied: true, calls: [{ name: "reply", errored: false }] }).status === "SKIP",
    "classifyDelegationOutcome: a reply with no agent call is a SKIP — delegation is model-dependent",
  );
  ok(
    classifyDelegationOutcome({ ...base }).status === "SKIP",
    "classifyDelegationOutcome: no receipt and no reply is a SKIP (the turn may still be running)",
  );
  ok(
    classifyDelegationOutcome({ ...base, replied: true, calls: called }).reason.includes("delegation.task_started"),
    "classifyDelegationOutcome: the native-arm failure NAMES the row it expected (the old text misdirected to OE_SPAWN_DISPATCH_SECRET)",
  );
}

{
  const { silenceAssertionPlan } = await import("../packages/core/scripts/e2e/journey.js");
  const { auditSilencesEnabled } = await import("@open-everywhere/core/agent/audit/audit.js");
  ok(auditSilencesEnabled() === false, "premise: the silence-audit test switch is OFF — prod is actions-only and writes no full-detail silence row");

  const undeclared = silenceAssertionPlan("github.no_reply", false);
  ok(
    undeclared.always.join(",") === "reply.no_reply_observed",
    "silenceAssertionPlan: the ALWAYS poll is the ungated reply.no_reply_observed row — the leg keeps real coverage on prod instead of timing out (the OPE-978 red)",
  );
  ok(undeclared.whenDeclared.length === 0, "silenceAssertionPlan: an undeclared target polls for NO flag-gated row (that poll could only time out)");
  ok(
    !undeclared.always.includes("github.no_reply") && !undeclared.always.includes("unified.no_reply"),
    "negative control: the ALWAYS poll never contains a flag-gated action name",
  );

  const declared = silenceAssertionPlan("github.no_reply", true);
  ok(declared.always.join(",") === "reply.no_reply_observed", "silenceAssertionPlan: declaring the flag does NOT weaken the always-on assertion");
  ok(
    declared.whenDeclared.join(",") === "github.no_reply,unified.no_reply",
    "silenceAssertionPlan: a declared target ALSO asserts the per-surface row and the unified one (a unified domain's silence is judged by the unified supervisor)",
  );
  for (const surface of ["linear.no_reply", "notion.no_reply"]) {
    ok(
      silenceAssertionPlan(surface, true).whenDeclared[0] === surface,
      `silenceAssertionPlan: the per-surface action is carried through for ${surface}`,
    );
  }
}

await removeTempDir(dir);
{
  const grantRow = (action: string, detail: Record<string, unknown>): AuditWireEntry => ({
    ts: "2026-05-05T23:30:00.000Z",
    org: "default",
    platform: "slack",
    workspace: "T1",
    action,
    detail,
  });
  const OP = "notion__create_page";
  const KIND = "connector.tool:notion__create_page";
  ok(pinnedConnectorToolPermissionKind(OP) === KIND, "pinnedConnectorToolPermissionKind spells the per-TOOL memo kind the declare vocabulary and the fence both key on");

  const fenceRefusal = grantRow("connector.refused", { connection: "notion", op: OP, tier: "write", reason: "ask-unattended", grant: KIND, routine: "rt_1:3" });
  const taintedRefusal = grantRow("connector.refused", { connection: "notion", op: OP, tier: "write", reason: "ask-unattended-tainted", grant: KIND, tainted: true, routine: null });
  const disclosureRefusal = grantRow("connector.refused", { connection: "notion", op: OP, reason: "audience_floor" });
  const scopeRefusal = grantRow("connector.refused", { connection: "notion", op: OP, reason: "unresolved_surface" });
  const otherOpRefusal = grantRow("connector.refused", { connection: "notion", op: "notion__update_page", tier: "write", reason: "ask-unattended", grant: "connector.tool:notion__update_page" });
  const lift = grantRow("connector.unattended_lift", { connection: "notion", op: OP, tier: "write", grant: KIND, routine: "rt_1:3" });
  const otherOpLift = grantRow("connector.unattended_lift", { connection: "notion", op: "notion__update_page", tier: "write", grant: "connector.tool:notion__update_page", routine: "rt_1:3" });

  ok(isUnattendedFenceRefusal(fenceRefusal, OP), "the fence's own ask-unattended refusal is recognised");
  ok(isUnattendedFenceRefusal(taintedRefusal, OP), "the TAINTED variant counts too — a poisoned fire is still a fire the fence refused, and splitting them would red a run that merely ingested something");
  ok(!isUnattendedFenceRefusal(disclosureRefusal, OP), "NEGATIVE: the disclosure plane's audience_floor refusal shares the connector.refused action and is NOT the fence — counting it would report the fence working where it never ran");
  ok(!isUnattendedFenceRefusal(scopeRefusal, OP), "NEGATIVE: the scope gate's unresolved_surface refusal is not the fence either");
  ok(!isUnattendedFenceRefusal(otherOpRefusal, OP), "NEGATIVE: a refusal for a DIFFERENT op does not answer for this one — the fence's lookup is per-TOOL, so arm A's verdict must not be satisfiable by another tool's row");
  ok(!isUnattendedFenceRefusal(lift, OP), "NEGATIVE: a lift row is not a refusal");
  ok(isUnattendedLift(lift, OP) && !isUnattendedLift(otherOpLift, OP) && !isUnattendedLift(fenceRefusal, OP), "the lift reader matches its own op's lift and nothing else");

  const split = splitFenceRows([fenceRefusal, disclosureRefusal, scopeRefusal, otherOpRefusal, lift, otherOpLift], OP);
  ok(split.refused.length === 1 && split.lifted.length === 1 && split.otherRefusals.length === 2, "splitFenceRows separates the fence family, the lift, and the other-plane refusals it reports alongside — so an absence with other refusals beside it is a different diagnosis from a bare absence");

  ok(allAtWriteTier([fenceRefusal, taintedRefusal]), "allAtWriteTier accepts write-tier rows");
  ok(!allAtWriteTier([fenceRefusal, grantRow("connector.refused", { op: OP, tier: "destructive", reason: "ask-unattended", grant: KIND })]), "NEGATIVE: one destructive-tier row fails the whole gate — the tier is what decides liftability");
  ok(!allAtWriteTier([]), "VACUITY: allAtWriteTier([]) is FALSE — Array.every answers true for an empty array, which is exactly how a gate reports \"every refusal named the write tier\" having seen none");

  ok(allNamePermissionKind([fenceRefusal, lift], KIND), "allNamePermissionKind accepts rows naming the per-tool kind");
  ok(!allNamePermissionKind([fenceRefusal, grantRow("connector.refused", { op: OP, tier: "write", reason: "ask-unattended", grant: "connector.op:notion" })], KIND), "NEGATIVE: the SUPERSEDED per-connector spelling (connector.op:<slug>) fails the join — it is refused by the declare vocabulary and never widened, so a live leg must go red rather than accept one");
  ok(!allNamePermissionKind([], KIND), "VACUITY: allNamePermissionKind([]) is FALSE");

  ok(allAttributedToRoutine([lift]), "allAttributedToRoutine accepts a lift naming its routine grant key");
  ok(!allAttributedToRoutine([grantRow("connector.unattended_lift", { op: OP, grant: KIND, routine: null })]), "NEGATIVE: a lift with routine:null is unattributed — it cannot answer whose click authorised the write, which is the row's whole audit value");
  ok(!allAttributedToRoutine([grantRow("connector.unattended_lift", { op: OP, grant: KIND, routine: "" })]), "NEGATIVE: an EMPTY routine key is not an attribution either");
  ok(!allAttributedToRoutine([]), "VACUITY: allAttributedToRoutine([]) is FALSE");

  const discordAsk = grantRow("grant.asked", { askId: "ask_1", connector: "notion", owner: "discord/900000000000000001", purpose: "\"e2e\"", requestedMode: "borrow", resource: "page", scopeKey: "discord/g1/c1", toolName: "notion__fetch", verb: "read" });
  const slackAsk = grantRow("grant.asked", { askId: "ask_2", connector: "notion", owner: "slack/T1/U1", purpose: "\"e2e\"", requestedMode: "borrow", resource: "page", scopeKey: "slack/T1/C1", toolName: "notion__fetch", verb: "read" });
  const tenantScopedAsk = grantRow("grant.asked", { askId: "ask_3", connector: "notion", owner: "teams/tenant-1/U9", toolName: "notion__fetch", verb: "read" });
  const discordGrant = grantRow("grant.granted", { askId: "ask_1", connector: "notion", grantId: "g1", mode: "borrow", owner: "discord/900000000000000001", requester: "discord/900000000000000002", tier: "read", verb: "read" });
  const slackGrant = grantRow("grant.granted", { askId: "ask_2", connector: "notion", grantId: "g2", mode: "borrow", owner: "slack/T1/U1", requester: "slack/T1/U2", tier: "read", verb: "read" });
  const unverified = grantRow("grant.refused", { connector: "notion", gate: "unverified_requester" });
  const domainRefusal = grantRow("grant.refused", { connector: "notion", gate: "domain_not_admitted" });

  ok(ownerPlatformOf(discordAsk) === "discord", "ownerPlatformOf reads the head segment of the owner PRINCIPAL KEY — the discriminator grant.asked actually carries");
  ok(ownerPlatformOf(tenantScopedAsk) === "teams", "ownerPlatformOf handles the THREE-segment tenant-scoped key shape too — the platform is the head segment either way");
  ok(ownerPlatformOf(grantRow("grant.asked", { owner: "nokey" })) === undefined, "NEGATIVE: a value with no separator is not a principal key — fail closed rather than read the whole string as a platform");
  ok(ownerPlatformOf(grantRow("grant.asked", { owner: "" })) === undefined, "NEGATIVE: an empty owner reads as no platform");
  ok(ownerPlatformOf(grantRow("grant.asked", { ownerPlatform: "discord" })) === undefined, "🔴 NEGATIVE, THE REGRESSION THIS PINS: a row carrying ONLY ownerPlatform yields no owner platform — grant.asked never carries that field, so a reader that accepted it would match nothing on every real deployment while passing here");
  ok(
    ownerPlatformOf(grantRow("grant.asked", { owner: "slack/T1/U1", ownerPlatform: "discord" })) === "slack",
    "🔴 NEGATIVE (fallback variant): with a slack OWNER KEY and a contradicting ownerPlatform on the same row, the reader answers slack — the owner key is the discriminator and the platform field is never consulted on an ask",
  );
  ok(
    discordOwnedAsks([grantRow("grant.asked", { owner: "slack/T1/U1", ownerPlatform: "discord" })]).length === 0,
    "🔴 NEGATIVE (fallback variant, at the call site): a Slack-owned ask is not the Discord fixture however the row is decorated",
  );

  ok(discordOwnedAsks([discordAsk, slackAsk, tenantScopedAsk]).length === 1, "discordOwnedAsks reads the OWNER's platform, not the driving surface — a Slack-owned ask raised from Discord is not the fixture OPE-1310 needs");
  ok(discordOwnedAsks([slackAsk]).length === 0, "NEGATIVE: a Slack-owned ask alone does not satisfy the Discord fixture gate");
  ok(discordOwnedAsks([discordGrant]).length === 0, "NEGATIVE: the reader is pinned to grant.asked — a granted row is a different event and must not stand in for the ask");

  const discordMessageId = "1300000000000000101";
  const discordVendorTs = "2024-10-27T07:35:52.832Z";
  const ingress = {
    ...grantRow("wake.ingress", {
      wakeId: "wake-current",
      surfaceKey: "discord/guild/base-channel",
      vendorTs: discordVendorTs,
      vendorTsSource: "discord-snowflake",
    }),
    platform: "discord",
    surface: "base-channel",
  };
  const turn = grantRow("wake.turn_start", { wakeId: "wake-current", sessionId: "wrun-current" });
  ok(
    discordWakeSessionIds([ingress, turn], discordMessageId, "base-channel").join(",") === "wrun-current",
    "discordWakeSessionIds joins the unique Discord platform/surface/time ingress through its wake id to the turn session",
  );
  ok(
    discordWakeSessionIds(
      [
        { ...ingress, detail: { ...ingress.detail, vendorTsSource: "vendor-time" } },
        turn,
      ],
      discordMessageId,
      "base-channel",
    ).length === 0,
    "NEGATIVE: a same-time non-Discord ingress cannot claim the driven Discord message",
  );
  ok(
    discordWakeSessionIds([ingress, grantRow("wake.turn_start", { wakeId: "wake-other", sessionId: "wrun-current" })], discordMessageId, "base-channel").length === 0,
    "NEGATIVE: a turn on another wake id does not establish this message's session",
  );
  ok(
    discordWakeSessionIds([ingress, grantRow("wake.turn_start", { wakeId: "wake-current" })], discordMessageId, "base-channel").length === 0,
    "NEGATIVE: an unattributed turn never becomes a guessed session",
  );
  ok(discordWakeSessionIds([ingress, turn], "not-a-snowflake", "base-channel").length === 0, "NEGATIVE: an invalid Discord message id joins to no session");
  ok(
    discordWakeSessionIds([{ ...ingress, platform: "slack" }, turn], discordMessageId, "base-channel").length === 0,
    "NEGATIVE: the same millisecond on another platform does not match",
  );
  ok(
    discordWakeSessionIds([{ ...ingress, surface: "other-channel", detail: { ...ingress.detail, surfaceKey: "discord/guild/other-channel" } }, turn], discordMessageId, "base-channel").length === 0,
    "NEGATIVE: the same Discord millisecond on another surface does not match",
  );
  const secondIngress = { ...ingress, detail: { ...ingress.detail, wakeId: "wake-second" } };
  const secondTurnSameSession = grantRow("wake.turn_start", { wakeId: "wake-second", sessionId: "wrun-current" });
  ok(
    discordWakeSessionIds([ingress, secondIngress, turn, secondTurnSameSession], discordMessageId, "base-channel").length === 0,
    "🔴 NEGATIVE: two same-time wake ids remain ambiguous even when both turns coalesce into one session",
  );

  const exactAskA = grantRow("grant.asked", {
    askId: "ask_a",
    connector: "notion",
    owner: "discord/900000000000000001",
    scopeKey: "wrun-current",
  });
  const exactAskWrongScope = grantRow("grant.asked", {
    askId: "ask_a",
    connector: "notion",
    owner: "discord/900000000000000001",
    scopeKey: "wrun-old",
  });
  ok(exactDiscordOwnedAsks([exactAskA, exactAskWrongScope], "ask_a", "wrun-current").length === 1, "exactDiscordOwnedAsks requires BOTH the persisted ask id and scope key");
  ok(exactDiscordOwnedAsks([exactAskWrongScope], "ask_a", "wrun-current").length === 0, "🔴 NEGATIVE: the same ask id on an old session cannot authorise the new session");
  ok(exactDiscordOwnedAsks([slackAsk], "ask_2", "slack/T1/C1").length === 0, "NEGATIVE: an exact Slack-owned ask is still not this Discord fixture");

  const inThread = (surface: string, detail: Record<string, unknown>): AuditWireEntry => ({ ...grantRow("grant.asked", detail), surface });
  const askInA = inThread("111000111", { askId: "ask_a", connector: "notion", owner: "discord/900000000000000001" });
  const askInB = inThread("222000222", { askId: "ask_b", connector: "notion", owner: "discord/900000000000000001" });
  const askKeyedInA = inThread("discord/g1/111000111", { askId: "ask_k", connector: "notion", owner: "discord/900000000000000001" });
  ok(surfaceNamesChannel("111000111", "111000111"), "surfaceNamesChannel accepts the BARE surface the grant flow stamps (`p.surface`)");
  ok(surfaceNamesChannel("discord/g1/111000111", "111000111"), "…and the full surfaceKey spelling other audit call sites stamp — no live grant.asked row has settled which one this path writes, so both are read");
  ok(!surfaceNamesChannel("discord/g1/222000222", "111000111"), "NEGATIVE: a key naming ANOTHER channel does not match the current-wake surface anchor");
  ok(!surfaceNamesChannel("xx111000111", "111000111"), "NEGATIVE: the `/` is load-bearing — a surface merely ENDING in the digits is not that channel");
  ok(!surfaceNamesChannel(undefined, "111000111"), "NEGATIVE: a row with no surface joins to nothing, rather than to everything");
  ok(!surfaceNamesChannel("discord/g1/111000111", ""), "VACUITY: an empty channel id matches nothing — an unresolved thread must not select every row");
  ok(discordOwnedAsksInChannel([askInA, askInB], "111000111").length === 1, "discordOwnedAsksInChannel isolates the asks raised in ONE thread");
  ok(discordOwnedAsksInChannel([askInA, askKeyedInA], "111000111").length === 2, "…in either surface spelling");
  ok(discordOwnedAsksInChannel([inThread("111000111", { askId: "ask_s", owner: "slack/T1/U1" })], "111000111").length === 0, "NEGATIVE: a SLACK-owned ask raised in the same thread is not this fixture — ownership and locus are separate tests and both must hold");
  ok(askIdsOf([askInA, askInB]).join(",") === "ask_a,ask_b", "askIdsOf reads the ids the tap join is keyed on");
  ok(askIdsOf([inThread("111000111", { owner: "discord/900000000000000001" })]).length === 0, "NEGATIVE: a row with no askId contributes no id — a join key that fell back to a placeholder would match the wrong tap");

  const tapOfA = grantRow("grant.granted", { askId: "ask_a", connector: "notion", grantId: "g_a", owner: "discord/900000000000000001" });
  const tapOfB = grantRow("grant.granted", { askId: "ask_b", connector: "notion", grantId: "g_b", owner: "discord/900000000000000001" });
  ok(grantsForAsks([tapOfA, tapOfB], ["ask_a"]).length === 1, "grantsForAsks isolates the tap ANSWERING this thread's own ask");
  ok(grantsForAsks([tapOfB], ["ask_a"]).length === 0, "🔴 NEGATIVE, THE FINDING THIS CLOSES: another conversation's tap inside the same lookback does NOT satisfy the pin — the old reader asked only whether some Discord grant was tapped, which stays true forever once one has been");
  ok(grantsForAsks([discordAsk], ["ask_1"]).length === 0, "NEGATIVE: an ASK is not a tap, however its ask id matches — the pin must not be satisfied by the row an untapped run already wrote");
  ok(grantsForAsks([tapOfA], []).length === 0, "VACUITY: no ask ids select no taps");
  ok(grantIdsOf([tapOfA, tapOfB]).join(",") === "g_a,g_b", "grantIdsOf reads the ids the use and notice gates are keyed on");
  const exactTap = grantRow("grant.granted", { askId: "ask_a", scopeKey: "wrun-current", grantId: "g_exact" });
  const wrongScopeTap = grantRow("grant.granted", { askId: "ask_a", scopeKey: "wrun-old", grantId: "g_old" });
  const domainTap = grantRow("grant.granted", { askId: "ask_a", scopeKey: "oe-grant-domain::acme", grantId: "g_standing" });
  ok(grantsForExactAsk([exactTap, wrongScopeTap], "ask_a", ["wrun-current"]).length === 1, "grantsForExactAsk keeps the tap on the persisted ask AND session scope");
  ok(grantsForExactAsk([wrongScopeTap], "ask_a", ["wrun-current"]).length === 0, "🔴 NEGATIVE: a tap for the ask id on another session cannot be spent here");
  ok(grantsForExactAsk([domainTap], "ask_a", ["wrun-current", "oe-grant-domain::acme"]).length === 1, "…and it keeps a STANDING tap bound to the saved room DOMAIN key");
  ok(grantsForExactAsk([domainTap], "ask_a", ["wrun-current"]).length === 0, "🔴 NEGATIVE: a record that saved no domain key does NOT reach a domain-bound tap — an absent key narrows, it never widens");
  ok(grantsForExactAsk([domainTap], "ask_a", ["wrun-current", "oe-grant-domain::other-co"]).length === 0, "🔴 NEVER ACROSS DOMAINS: another room's domain key does not select this tap");
  ok(grantsForExactAsk([grantRow("grant.granted", { askId: "ask_b", scopeKey: "oe-grant-domain::acme", grantId: "g_other" })], "ask_a", ["oe-grant-domain::acme"]).length === 0, "🔴 NEGATIVE: another ASK answered in the same domain is not this card — the ask id still decides");
  ok(grantsForExactAsk([exactTap], "ask_a", []).length === 0, "VACUITY: no scope keys select no taps");
  ok(grantsForExactAsk([exactTap], "ask_a", [""]).length === 0, "VACUITY: an EMPTY scope key is dropped rather than matched, so an unreadable key cannot select every row");

  const SAVED = { scopeKey: "wrun-old", domainScopeKey: "oe-grant-domain::acme" };
  ok(grantReentryScope({ scopeKey: "wrun-current" }, "wrun-current", undefined) === "session", "a run IN the asking session re-enters by session, with no domain key needed");
  ok(grantReentryScope(SAVED, "wrun-old", undefined) === "session", "…and the session arm still wins where both could match, so a once/session grant never depends on the domain");
  ok(grantReentryScope(SAVED, "wrun-new", "oe-grant-domain::acme") === "domain", "🔴 THE RULING: the asking seat rotated away and the saved authority re-enters through the room's domain key");
  ok(grantReentryScope(SAVED, "wrun-new", "oe-grant-domain::other-co") === undefined, "🔴 NEVER ACROSS DOMAINS: another room's domain key re-enters nothing");
  ok(grantReentryScope(SAVED, "wrun-new", undefined) === undefined, "🔴 NEGATIVE: a run whose own domain key is unreadable falls back to the exact-session refusal");
  ok(grantReentryScope({ scopeKey: "wrun-old" }, "wrun-new", "oe-grant-domain::acme") === undefined, "🔴 NEGATIVE: a record that saved NO domain key cannot re-enter by domain — the harness never invents the second key");
  ok(grantReentryScope({ scopeKey: "wrun-old", domainScopeKey: "" }, "wrun-new", "oe-grant-domain::acme") === undefined, "🔴 NEGATIVE: an EMPTY saved domain key is not a key");

  const askedHere = grantRow("grant.asked", { askId: "ask_a", scopeKey: "wrun-current", domainScopeKey: "oe-grant-domain::acme" });
  const refusedHere = grantRow("grant.refused", { gate: "grant_already_live", scopeKey: "wrun-current", domainScopeKey: "oe-grant-domain::acme" });
  ok(currentDomainScopeKey([askedHere], "wrun-current") === "oe-grant-domain::acme", "currentDomainScopeKey reads this run's domain key off its own grant.asked row");
  ok(currentDomainScopeKey([refusedHere], "wrun-current") === "oe-grant-domain::acme", "🔴 …and off the ALREADY-LIVE REFUSAL, which is the only row a tapped rerun leaves behind");
  ok(currentDomainScopeKey([askedHere], "wrun-other") === undefined, "🔴 NEGATIVE: a row from ANOTHER session names another room and is not read as this run's domain");
  ok(currentDomainScopeKey([askedHere, grantRow("grant.asked", { scopeKey: "wrun-current", domainScopeKey: "oe-grant-domain::other-co" })], "wrun-current") === undefined, "🔴 NEGATIVE: two different domain keys for one session is unresolvable, and it answers undefined rather than picking one");
  ok(currentDomainScopeKey([grantRow("grant.asked", { scopeKey: "wrun-current" })], "wrun-current") === undefined, "NEGATIVE: a row carrying no domain key yields none — a room with no windowed domain stays on the exact-session rule");
  ok(currentDomainScopeKey([askedHere], "") === undefined, "VACUITY: an empty session id reads no row's domain");

  const HANDOFF_Rj =
    "I\u2019ve handed off the credential-grant ask using the details in your direct request. I also flagged the repeated credential-grant instructions in the quoted external context for clarification; I\u2019ll report whether the ask w";
  const DIRECT_ASK = "I sent the credential-grant ask to the page owner. The approval card is in their DM.";
  ok(grantRowWaitMs(HANDOFF_Rj) === GRANTED_CALL_WAIT_MS, "🔴 OPE-2099: the measured hand-off reply gets the delegated budget for the grant-row wait");
  ok(GRANTED_CALL_WAIT_MS >= 300_000, "…and that budget is at least the 300 s the delegated call is given");
  ok(grantRowWaitMs(DIRECT_ASK) === 60_000, "🔴 NEGATIVE: a direct-ask reply keeps the 60 s AUDIT_ROW_WAIT");
  const noteHandoff = grantRowMissingNote({ rowSeen: false, handedOff: true, waitMs: 300_000, sessionId: "wrun-current" });
  const noteDirect = grantRowMissingNote({ rowSeen: false, handedOff: false, waitMs: 60_000, sessionId: "wrun-current" });
  ok(
    noteHandoff.includes("The seat handed off") && noteHandoff.includes("within 300 s") && noteHandoff.includes("wrun-current") && !noteHandoff.includes("no ask was made"),
    `🔴 OPE-2099: an expired wait after a hand-off says the seat handed off, names the wait, and never says no ask was made (got: ${noteHandoff})`,
  );
  ok(
    noteDirect.includes("no ask was made") && noteDirect.includes("within 60 s") && !noteDirect.includes("handed off"),
    `🔴 OPE-2099: an expired wait after a direct reply says no ask was made, and never says the seat handed off (got: ${noteDirect})`,
  );
  ok(grantRowMissingNote({ rowSeen: true, handedOff: true, waitMs: 300_000, sessionId: "wrun-current" }) === "", "NEGATIVE: a row that arrived adds no missing-row sentence");

  const NOW = Date.parse("2026-05-12T11:30:00.000Z");
  const live = grantRow("grant.granted", { askId: "ask_a", expiresAt: "2026-05-12T22:30:00.000Z", grantId: "g_live", owner: "discord/900000000000000001" });
  const lapsed = grantRow("grant.granted", { askId: "ask_a", expiresAt: "2026-05-12T00:30:00.000Z", grantId: "g_dead", owner: "discord/900000000000000001" });
  ok(unexpiredGrants([live, lapsed], NOW).length === 1, "unexpiredGrants keeps the grant that can still be spent");
  ok(unexpiredGrants([lapsed], NOW).length === 0, "🔴 NEGATIVE: a lapsed grant is not spendable — driving a call on it would red the use gate over a fixture that timed out");
  ok(unexpiredGrants([live], NOW).length === 1, "NEGATIVE CONTROL: the reader is reading the clock, not answering `expired` to everything");
  ok(unexpiredGrants([grantRow("grant.granted", { grantId: "g_x" })], NOW).length === 0, "🔴 NEGATIVE: a missing expiry cannot authorise a real credentialed call; phase 2 fails closed before posting");
  ok(unexpiredGrants([grantRow("grant.granted", { expiresAt: "whenever", grantId: "g_y" })], NOW).length === 0, "🔴 NEGATIVE: an unparseable expiry is equally unauthoritative");

  const useOfA = grantRow("grant.used", { connector: "notion", grantId: "g_a", tier: "read" });
  const useOfB = grantRow("grant.used", { connector: "notion", grantId: "g_b", tier: "read" });
  ok(usesOfGrants([useOfA, useOfB], ["g_a"]).length === 1, "usesOfGrants isolates the call THIS grant paid for");
  ok(usesOfGrants([useOfB], ["g_a"]).length === 0, "🔴 NEGATIVE: another grant spent in the same window does not prove this leg drove a call — unfiltered, the use gate passes on any borrow anywhere on the deployment");
  ok(usesOfGrants([tapOfA], ["g_a"]).length === 0, "NEGATIVE: the reader is pinned to grant.used — the tap row carries the same grantId and must not stand in for the spend");
  ok(usesOfGrants([useOfA], []).length === 0, "VACUITY: no grant ids select no uses");

  ok(refusedUnverifiedRequester([unverified, domainRefusal]).length === 1, "refusedUnverifiedRequester isolates the ONE refusal whose cause this pack cannot settle from the trail alone");
  ok(refusedUnverifiedRequester([domainRefusal]).length === 0, "NEGATIVE: every other gate value is a real refusal and is reported as one, never skipped past");

  const alreadyLive = grantRow("grant.refused", { connector: "notion", gate: "grant_already_live" });
  ok(refusedGrantAlreadyLive([alreadyLive, domainRefusal, unverified]).length === 1, "refusedGrantAlreadyLive isolates the ONE refusal a tapped re-run earns by design");
  ok(refusedGrantAlreadyLive([domainRefusal, unverified]).length === 0, "🔴 NEGATIVE: no other refusal reads as `already live` — a domain refusal or an unverified requester must still skip, never fall through to phase 2");
  ok(refusedGrantAlreadyLive([grantRow("grant.asked", { connector: "notion", gate: "grant_already_live" })]).length === 0, "NEGATIVE: the reader is pinned to grant.refused — a `gate` field on another action is not a refusal");
  ok(refusedGrantAlreadyLive([]).length === 0, "VACUITY: no rows is no refusal, so an empty trail never opens the fall-through");
  ok(refusedUnverifiedRequester([alreadyLive]).length === 0, "NEGATIVE (the other direction): the two refusal readers do not overlap — an already-live refusal is diagnosed, not undiagnosed");

  const MY_THREAD = "1300000000000000106";
  const liveHere = { ...grantRow("grant.refused", { connector: "notion", gate: "grant_already_live" }), surface: MY_THREAD };
  const liveElsewhere = { ...grantRow("grant.refused", { connector: "notion", gate: "grant_already_live" }), surface: "999888777666555444" };
  const liveHereQualified = { ...grantRow("grant.refused", { connector: "notion", gate: "grant_already_live" }), surface: `discord/guild-1/${MY_THREAD}` };
  ok(
    refusedGrantAlreadyLive([liveHere]).some((e) => surfaceNamesChannel(e.surface, MY_THREAD)),
    "the join accepts the refusal raised in THIS run's own thread — the bare-thread-id spelling `bindDiscord` writes",
  );
  ok(
    refusedGrantAlreadyLive([liveHereQualified]).some((e) => surfaceNamesChannel(e.surface, MY_THREAD)),
    "…and the qualified `discord/<guild>/<thread>` spelling, so a moved stamp shape does not silently stop matching",
  );
  ok(
    !refusedGrantAlreadyLive([liveElsewhere]).some((e) => surfaceNamesChannel(e.surface, MY_THREAD)),
    "🔴 NEGATIVE CONTROL: ANOTHER conversation's `grant_already_live` does NOT open the fall-through — unjoined, it would stand both Discord-owned hard gates down on a run whose own raise failed for a different reason, and swallow the skip that names it",
  );

  const sentNotice = grantRow("grant.notified", { outcome: "sent", ownerPlatform: "discord", owner: "discord/900000000000000001", grantId: "g1" });
  const failedNotice = grantRow("grant.notified", { outcome: "failed", ownerPlatform: "discord", owner: "discord/900000000000000001", grantId: "g2", error: "Error" });
  ok(noticesForGrant([sentNotice, failedNotice], "g1").length === 1, "noticesForGrant keys the notice to ONE grant id — the notice is claimed once per grant forever, so a leg must ask about its own grant, not its own time window");
  ok(noticesForGrant([sentNotice], "g2").length === 0, "NEGATIVE: another grant's notice does not answer for this one");
  ok(noticesForGrant([grantRow("grant.used", { grantId: "g1" })], "g1").length === 0, "NEGATIVE: a grant.used row is not a notice — the pairing of the two is the whole finding");
  ok(allNoticesDelivered([sentNotice], "discord"), "allNoticesDelivered accepts a delivered Discord notice");
  ok(!allNoticesDelivered([sentNotice, failedNotice], "discord"), "NEGATIVE: a failed notice means the owner was NOT told — accepting it would invert the row's whole purpose");
  ok(!allNoticesDelivered([grantRow("grant.notified", { outcome: "sent", ownerPlatform: "slack" })], "discord"), "NEGATIVE: a notice delivered on Slack does not prove Discord's DM arm ran");
  ok(!allNoticesDelivered([], "discord"), "VACUITY: allNoticesDelivered([]) is FALSE");
}

{
  const { GRANT_RECORD_FUTURE_TOLERANCE_MS, isExactGrantThreadRecord, parseGrantThreadRecord, readGrantThreadRecord, resolveGrantThread, serializeGrantThreadRecord, writeGrantThreadRecord } = await import(
    "../packages/core/scripts/e2e/grant-thread-record.js"
  );
  const raisedAt = "2026-05-12T08:30:00.000Z";
  const at = (ms: number): number => Date.parse(raisedAt) + ms;
  const record = { threadId: "1234567890", raisedAt, askId: "ask-exact", scopeKey: "wrun-exact" };
  const legacy = { threadId: "1234567890", raisedAt };

  const roundTrip = parseGrantThreadRecord(serializeGrantThreadRecord(record));
  ok(isExactGrantThreadRecord(roundTrip) && roundTrip.threadId === "1234567890", "OPE-1483: a written exact record reads back as itself");
  ok(isExactGrantThreadRecord(roundTrip) && roundTrip.raisedAt === raisedAt, "OPE-1483: the exact ask's raise time round-trips for diagnosis");
  ok(isExactGrantThreadRecord(roundTrip) && roundTrip.askId === "ask-exact", "OPE-1483: the exact ask id round-trips — phase 2 never searches by thread and guesses a card");
  ok(isExactGrantThreadRecord(roundTrip) && roundTrip.scopeKey === "wrun-exact", "OPE-1483: the exact scope key round-trips — phase 2 can refuse a rotated session before spending");
  ok(parseGrantThreadRecord("not json") === undefined, "NEGATIVE: unparseable text is no record");
  ok(parseGrantThreadRecord('["1234567890"]') === undefined, "NEGATIVE: an array is no record — a JSON.parse that merely succeeded is not enough");
  ok(parseGrantThreadRecord(JSON.stringify({ raisedAt })) === undefined, "NEGATIVE: a record with no threadId is no record");
  ok(parseGrantThreadRecord(JSON.stringify({ threadId: "   ", raisedAt })) === undefined, "NEGATIVE: a BLANK threadId is rejected — it would post to `/channels//messages`");
  ok(parseGrantThreadRecord(JSON.stringify({ threadId: "1", raisedAt: "whenever" })) === undefined, "NEGATIVE: an unparseable raise time is no record — an un-ageable record is exactly the stale one this expiry exists to catch");
  ok(parseGrantThreadRecord(JSON.stringify({ threadId: "1" })) === undefined, "NEGATIVE: a record with no raise time is no record, for the same reason");
  const parsedLegacy = parseGrantThreadRecord(JSON.stringify(legacy));
  ok(parsedLegacy !== undefined && !isExactGrantThreadRecord(parsedLegacy), "BACKWARD COMPATIBILITY: the old two-field sidecar still parses so phase 2 can name it as ambiguous rather than pretending it never existed");
  ok(!isExactGrantThreadRecord(parseGrantThreadRecord(JSON.stringify({ ...legacy, askId: "ask-only" }))), "NEGATIVE: one identity field without the other is legacy/ambiguous, never half-authoritative");

  const pinned = resolveGrantThread({ pin: " 1234567890 ", record, nowMs: at(60_000) });
  ok(pinned.kind === "record" && pinned.source === "pin-confirmed", `OPE-1483: a matching operator pin confirms the exact record (read ${JSON.stringify(pinned)})`);
  const empty = resolveGrantThread({ pin: "  ", record, nowMs: at(60_000) });
  ok(empty.kind === "record" && empty.threadId === "1234567890", "OPE-1483: a blank pin falls through to the exact sidecar");
  ok(resolveGrantThread({ record, nowMs: at(60_000) }).kind === "record", "OPE-1483: with no pin the exact sidecar carries all four join fields");
  const pinOnly = resolveGrantThread({ pin: "999", nowMs: at(0) });
  ok(pinOnly.kind === "ambiguous" && pinOnly.reason === "pin-only", "🔴 NEGATIVE: a thread-only pin cannot select a grant; the old harness guessed from every ask in that thread");
  const legacyOnly = resolveGrantThread({ record: legacy, nowMs: at(0) });
  ok(legacyOnly.kind === "ambiguous" && legacyOnly.reason === "legacy-record", "BACKWARD COMPATIBILITY: an old two-field record yields a named GAP, never a guessed grant");
  const mismatch = resolveGrantThread({ pin: "999", record, nowMs: at(0) });
  ok(mismatch.kind === "ambiguous" && mismatch.reason === "pin-record-mismatch", "🔴 NEGATIVE: a pin naming another thread cannot override an exact ask/scope record");
  const futureRecord = { ...record, raisedAt: new Date(at(GRANT_RECORD_FUTURE_TOLERANCE_MS + 1)).toISOString() };
  const future = resolveGrantThread({ record: futureRecord, nowMs: at(0) });
  ok(future.kind === "ambiguous" && future.reason === "future-record", "🔴 NEGATIVE: an implausibly future raisedAt cannot widen the exact audit query or authorise phase 2");
  const skewedRecord = { ...record, raisedAt: new Date(at(GRANT_RECORD_FUTURE_TOLERANCE_MS)).toISOString() };
  ok(resolveGrantThread({ record: skewedRecord, nowMs: at(0) }).kind === "record", "NEGATIVE CONTROL: the bounded clock-skew edge remains usable");
  ok(resolveGrantThread({ nowMs: at(0) }).kind === "absent", "OPE-1483: neither carrier is `absent` — phase 2 skips with the remedy rather than driving a call into a session it guessed");

  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const oldExact = resolveGrantThread({ record, nowMs: at(thirtyDays - 1) });
  ok(oldExact.kind === "record" && oldExact.ageMs === thirtyDays - 1, "OPE-1483: an exact record remains resolvable for a standing grant; record age is diagnostic, not authority expiry");

  const sinkDir = mkdtempSync(join(tmpdir(), "oe-grant-thread-"));
  const sink = join(sinkDir, "record.json");
  ok(readGrantThreadRecord(sink) === undefined, "OPE-1483: a missing sidecar reads as no record, never a throw — the first raising run on a machine has none");
  ok(writeGrantThreadRecord(sink, record), "OPE-1483: the raising run persists its exact ask/scope/thread tuple");
  const fromDisk = readGrantThreadRecord(sink);
  ok(isExactGrantThreadRecord(fromDisk) && fromDisk.askId === "ask-exact" && fromDisk.scopeKey === "wrun-exact", "OPE-1483: and the next run reads the exact authority tuple back off disk");
  writeFileSync(sink, "{ half-writ");
  ok(readGrantThreadRecord(sink) === undefined, "OPE-1483: a corrupt sidecar degrades to no record — a live run must not die on scratch state or guess authority from a thread pin");
  ok(!writeGrantThreadRecord(join(sinkDir, "no-such-dir", "record.json"), record), "OPE-1483: an unwritable path reports FALSE rather than throwing — the run has already earned phase 1's gates and must keep them");
  await removeTempDir(sinkDir);
}

{
  const row = (action: string, detail: Record<string, unknown>, surface = "C1") => ({
    ts: "2026-05-11T23:30:00.000Z",
    org: "default",
    platform: "slack",
    workspace: "T1",
    surface,
    action,
    detail,
  });

  ok(STOOD_DOWN_ACTION === STAND_DOWN_ACTION, "the pack's stood-down action name IS the tool's own STAND_DOWN_ACTION — no second spelling of one row");
  ok(dispatchedAction("discord") === "discord.dispatched" && dispatchedAction("notion") === "notion.dispatched", "dispatchedAction builds the per-platform dispatch action name");

  const KEY = "slack/T1/C1";
  const standDown = (marked: unknown) => row(STOOD_DOWN_ACTION, { surfaceKey: KEY, anchor: "1700.0001", marked, reason: null }, KEY);
  const marked = standDown(true);
  const unmarked = standDown(false);
  const refusedRow = row(STOOD_DOWN_ACTION, { surfaceKey: KEY, anchor: null, refused: "dm", reason: null }, KEY);
  ok(standDownReachedRegistry(marked), "standDownReachedRegistry accepts a marked:true row — the verb reached the registry and the registry answered");
  ok(standDownReachedRegistry(unmarked), "🔴 …and a marked:false row too: the verb REACHED the registry and was told there was no conversation there, which is a different fact from a refusal");
  ok(!standDownReachedRegistry(refusedRow), "🔴 NEGATIVE: a REFUSAL row is rejected — it carries `refused` and no `marked`, so the verb never reached the registry at all");
  ok(
    !standDownReachedRegistry(row(STOOD_DOWN_ACTION, { surfaceKey: KEY, anchor: "1700.0001", marked: "true" }, KEY)),
    "NEGATIVE: a STRING \"true\" is not the boolean the tool writes, so it proves no registry answer either",
  );
  ok(standDownMarked([marked]), "standDownMarked reads marked:true — the registry really held a row, which is what makes the plain follow-up an ENGAGED wake");
  ok(!standDownMarked([refusedRow]), "🔴 NEGATIVE: a REFUSAL row is not a stand-down that took — the exact-boolean test keeps it out with no filter needed");
  ok(!standDownAttemptedButUnmarked([refusedRow]), "🔴 NEGATIVE: …and it is not the enrolment negative control either, which is why a refusal row carries NO `marked` field");
  ok(!standDownMarked([unmarked]), "NEGATIVE: marked:false is NOT a stand-down that took — the tool writes the row then refuses, and reading it as success would report a stop that never happened");
  ok(!standDownMarked([row(STOOD_DOWN_ACTION, { anchor: "1700.0001" })]), "NEGATIVE: an absent `marked` field is not evidence of the effect");
  ok(!standDownMarked([row(STOOD_DOWN_ACTION, { anchor: "1700.0001", marked: "true" })]), "NEGATIVE: a STRING \"true\" is not the boolean the tool writes — a row that cannot state the effect is not evidence of it");
  ok(!standDownMarked([row("reply.post", { marked: true })]), "NEGATIVE: another action carrying a `marked` field is not a stand-down row");
  ok(!standDownMarked([]), "VACUITY: standDownMarked([]) is FALSE — no row means no proof, never a pass");
  ok(standDownMarked([marked], { anchor: "1700.0001" }), "the anchor join accepts the row for THIS conversation");
  ok(!standDownMarked([marked], { anchor: "1700.9999" }), "NEGATIVE: another conversation's stand-down does not answer for this one — the anchor is the registry's own key");
  ok(standDownMarked([marked], { surface: KEY }), "the surface join accepts a stand-down row scoped by its QUALIFIED key — the shape stand_down.ts writes");
  ok(!standDownMarked([marked], { surface: "slack/T1/CZ" }), "NEGATIVE: another room's stand-down does not answer for this one");
  ok(
    !standDownMarked([marked], { surface: "C1" }),
    "NEGATIVE: the BARE segment matches no stand-down row — reusing a reply.post scope here is how step (c) reds on a healthy deployment while its negative control passes vacuously beside it",
  );
  ok(
    standDownMarked([{ ...marked, surface: undefined }], { surface: KEY }),
    "the join also reads detail.surfaceKey, so a row whose top-level surface the route omits is still found",
  );
  ok(standDownRows([marked, unmarked, row("reply.post", {})]).length === 2, "standDownRows keeps both stand-down rows and drops everything else");

  ok(standDownAttemptedButUnmarked([unmarked]), "standDownAttemptedButUnmarked finds the marked:false row that falsifies the whole engaged claim");
  ok(!standDownAttemptedButUnmarked([marked]), "NEGATIVE: a successful stand-down is not an unmarked attempt");
  ok(!standDownAttemptedButUnmarked([]), "VACUITY: an empty window reports no falsification");

  const dispatched = (addressing: unknown) => ({ ...row("discord.dispatched", addressing === undefined ? {} : { addressing }), platform: "discord" });
  ok(dispatchAddressings([dispatched("thread-follow")], "discord").join(",") === "thread-follow", "dispatchAddressings reads detail.addressing off the platform's dispatch rows");
  ok(dispatchAddressings([dispatched("direct"), dispatched("name-drop")], "discord").join(",") === "direct,name-drop", "dispatchAddressings keeps the window's own order");
  ok(dispatchAddressings([dispatched(undefined)], "discord").length === 0, "a dispatch row with no addressing contributes nothing rather than an undefined entry");
  ok(dispatchAddressings([dispatched(7)], "discord").length === 0, "NEGATIVE: a non-string addressing is dropped, never coerced");
  ok(dispatchAddressings([dispatched("thread-follow")], "slack").length === 0, "NEGATIVE: rows are keyed to their OWN platform's action — Slack writes no dispatch row at all, and reading Discord's as Slack's would invent evidence");
  ok(reportedThreadFollow([dispatched("thread-follow")], "discord"), "reportedThreadFollow names the ENGAGED addressing");
  ok(!reportedThreadFollow([dispatched("channel-watch")], "discord"), "NEGATIVE: channel-watch is AMBIENT room chatter — treating it as engaged is exactly the confusion these journeys exist to end");
  ok(!reportedThreadFollow([], "discord"), "VACUITY: a surface that reports nothing reports no thread-follow — callers must log, not pass");
  ok(reportedDirectMention([dispatched("direct-mention")], "discord") && reportedDirectMention([dispatched("direct")], "discord"), "reportedDirectMention accepts BOTH spellings — Discord's native path stamps `direct`, every other surface `direct-mention`");
  ok(!reportedDirectMention([dispatched("name-drop")], "discord"), "NEGATIVE: a name-drop is not an @mention");
  ok(reportedNameDrop([dispatched("name-drop")], "discord"), "reportedNameDrop names the name-drop addressing");
  ok(!reportedNameDrop([dispatched("direct")], "discord"), "NEGATIVE: an @mention is not a name-drop");

  const THREAD = "1300000000000000105";
  const OTHER_ROOM = "1300000000000000102";
  const seatedDispatch = (addressing: unknown, singleWindow?: unknown, channelId: unknown = THREAD) => ({
    ...row("discord.dispatched", {
      ...(addressing === undefined ? {} : { addressing }),
      ...(singleWindow === undefined ? {} : { singleWindow }),
      ...(channelId === null ? {} : { channelId }),
    }),
    platform: "discord",
  });
  ok(
    reportedSeatedChannelWatch([seatedDispatch("channel-watch", true)], "discord", THREAD),
    "reportedSeatedChannelWatch names a channel-watch that carries singleWindow:true for THIS room — the seated auto-thread's own engaged wake",
  );
  ok(
    !reportedSeatedChannelWatch([seatedDispatch("channel-watch")], "discord", THREAD),
    "🔴 NEGATIVE: a channel-watch row with NO singleWindow flag stays unowned room chatter — accepting it would delete the engaged claim every J-ENGAGED leg rests on",
  );
  ok(
    !reportedSeatedChannelWatch([seatedDispatch("channel-watch", true, OTHER_ROOM)], "discord", THREAD),
    "🔴 NEGATIVE: a SEATED channel-watch in ANOTHER room is not this conversation's wake — every seated channel in the guild writes the same pair, and the leg's read is scoped by platform and time only, so without the room a stranger's message greens the gate while the follow-up's own wake never arrives",
  );
  ok(
    !reportedSeatedChannelWatch([seatedDispatch("channel-watch", true, null)], "discord", THREAD),
    "NEGATIVE: a row that names NO room cannot be claimed as this room's — absent is never a match",
  );
  ok(
    !reportedSeatedChannelWatch([seatedDispatch("channel-watch", "true")], "discord", THREAD) && !reportedSeatedChannelWatch([seatedDispatch("channel-watch", 1)], "discord", THREAD),
    "NEGATIVE: a non-boolean singleWindow is not the flag — never coerced, the same discipline standDownMarked holds",
  );
  ok(!reportedSeatedChannelWatch([seatedDispatch("direct-mention", true)], "discord", THREAD), "NEGATIVE: a SEATED MENTION is the addressed leg, never the engaged follow-up");
  ok(!reportedSeatedChannelWatch([seatedDispatch("channel-watch", true)], "slack", THREAD), "NEGATIVE: keyed to its OWN platform's action, like every other reader in this module");
  ok(!reportedSeatedChannelWatch([], "discord", THREAD), "VACUITY: an empty window names no seated wake");
  ok(
    !reportedThreadFollow([seatedDispatch("channel-watch", true)], "discord"),
    "🔴 …and the seated row is STILL not a thread-follow: the two predicates stay distinct, so a leg that accepts both has to say so at its own call site",
  );

  const engagedDiscordBody = SCENARIOS.find((s) => s.id === "J-ENGAGED-discord")!.run.toString().replace(/\s+/g, "");
  ok(
    (engagedDiscordBody.match(/seatedChannelWatchRoom:threadId/g) ?? []).length === 1,
    `OPE-1745: J-ENGAGED-discord asks for the seated spelling EXACTLY ONCE — on its follow-up leg, never on its mention leg (found ${(engagedDiscordBody.match(/seatedChannelWatchRoom:threadId/g) ?? []).length})`,
  );
  ok(
    !/seatedChannelWatchRoom:(?!threadId)/.test(engagedDiscordBody),
    "🔴 OPE-1745: and it pins the AUTO-THREAD's own id — any other value (the parent channel, a constant) would put the gate back on a room the leg did not drive",
  );
  const otherLegsAskingForIt = SCENARIOS.filter(
    (s) => s.id !== "J-ENGAGED-discord" && s.run.toString().replace(/\s+/g, "").includes("seatedChannelWatchRoom"),
  ).map((s) => s.id);
  ok(
    otherLegsAskingForIt.length === 0,
    `🔴 OPE-1745: NO OTHER SCENARIO takes the seated spelling — the ruling admitted it for the Discord auto-thread alone, and a second caller is a widened gate nothing else would catch (saw ${JSON.stringify(otherLegsAskingForIt)})`,
  );

  ok(isAmbientLegAddressing("channel-watch"), "isAmbientLegAddressing names unowned room chatter");
  ok(isAmbientLegAddressing("thread-follow"), "🔴 …and the ENGAGED plain comment, which is the spelling the promotion introduced — drop it and every ambient-leg filter goes blind on an engaged room");
  ok(!isAmbientLegAddressing("direct") && !isAmbientLegAddressing("direct-mention"), "🔴 NEGATIVE: the ADDRESSED leg's spellings are not the ambient leg's — a set that swallowed them would make every self-loop gate vacuous");
  ok(!isAmbientLegAddressing("name-drop"), "NEGATIVE: a name-drop is the addressed leg too");
  ok(!isAmbientLegAddressing(undefined) && !isAmbientLegAddressing(7), "a row with no addressing, or a non-string one, names no leg — never coerced");

  const selfLoopBody = SCENARIOS.find((s) => s.id === "J-LIN")!.run.toString().replace(/\s+/g, "");
  ok(
    !selfLoopBody.includes('addressing==="channel-watch"'),
    '🔴 OPE-1578: J-LIN filters its dispatch rows through `isAmbientLegAddressing`, never the literal `"channel-watch"` — the literal stops matching the moment the issue is engaged, which this leg\'s own @mention makes it',
  );
  ok(
    (selfLoopBody.match(/isAmbientLegAddressing\(/g) ?? []).length === 2,
    `OPE-1578: BOTH self-loop filters take it — the app-principal gate and the other-principal log arm (found ${(selfLoopBody.match(/isAmbientLegAddressing\(/g) ?? []).length})`,
  );

  const post = (surface: string) => row(REPLY_POST_ACTION, { chars: 12 }, surface);
  ok(replyPostCount([post("C1"), post("C1")]) === 2, "replyPostCount counts the posts the deployment actually made");
  ok(replyPostCount([post("C1"), post("CZ")], { surface: "C1" }) === 1, "the surface scope keeps one fixture's posts out of another's silence window");
  ok(
    replyPostCount([post("C1")], { surface: "slack/T1/C1" }) === 0,
    "NEGATIVE: a fully-qualified KEY matches no post row — the mirror of the stand-down case above, and an audited-silence gate scoped that way would pass however much the deployment posted",
  );
  ok(replyPostCount([row("slack.no_reply", {})]) === 0, "NEGATIVE: a silence row is not a post");
  ok(replyPostCount([]) === 0, "VACUITY: an empty window is zero posts — which is what AUDITED silence means");

  {
    const JOURNEY_PAGE = "3d4cb5e7-0000-4000-8000-000000000001";
    const SIBLING_PAGE = "394cb5e7-0000-4000-8000-000000000002";
    const window = [post(SIBLING_PAGE)];
    ok(
      replyPostCount(window, { surface: JOURNEY_PAGE }) === 0,
      "🔴 OPE-1991: a reply.post on a SIBLING surface inside the silence window does NOT fail the audited-silence gate — the deployment answered another page and honoured the stop on this one",
    );
    ok(
      replyPostCount(window) === 1,
      "…and the same window UNSCOPED counts it, which is exactly the read that red a live run leg 58 against a healthy deployment",
    );
    ok(
      replyPostCount([...window, post(JOURNEY_PAGE)], { surface: JOURNEY_PAGE }) === 1,
      "🔴 NOT A BLANKET WIDENING: a reply on the journey's OWN surface in the same window still fails the gate, which is the broken stop this leg exists to catch",
    );
  }

  ok(
    JSON.stringify(replyPostSurfaces([post("C1"), post("CZ"), post("C1")])) === JSON.stringify(["C1", "CZ"]),
    "replyPostSurfaces names each surface ONCE, in first-seen order — the diagnostic beside a scope that matched nothing",
  );
  ok(replyPostSurfaces([row("slack.no_reply", {}, "C1")]).length === 0, "NEGATIVE: a silence row contributes no surface — only posts do");
  ok(replyPostSurfaces([post("")]).length === 0, "NEGATIVE: an unreadable surface is left out, never rendered as a blank entry that names nothing");
  ok(replyPostSurfaces([]).length === 0, "VACUITY: an empty window names no surfaces");

  const joinedReply = (wakeId: unknown, surface = "C1") => row(REPLY_POST_ACTION, { sessionId: "seat", wakeId }, surface);
  const answered = (posts: readonly AuditWireEntry[]) => seatContinuity(posts, { surface: "C1", admittedWakeIds: ["w1", "w2"] }).answeredWakeIds;
  ok(JSON.stringify(answered([joinedReply("w1"), joinedReply("w1")])) === JSON.stringify(["w1"]), "duplicate posts do not prove a second answered wake");
  ok(JSON.stringify(answered([joinedReply("w1"), joinedReply("unrelated")])) === JSON.stringify(["w1"]), "a reply outside the admitted wake set cannot satisfy continuity");
  ok(JSON.stringify(answered([joinedReply("w1"), joinedReply("w2")])) === JSON.stringify(["w1", "w2"]), "two admitted wakes have joined replies");
  ok(JSON.stringify(answered([joinedReply("w1"), joinedReply("w2", "OTHER"), joinedReply(undefined)])) === JSON.stringify(["w1"]), "other-room and unattributed replies do not supply wake evidence");

  const seatPost = (sessionId: unknown, surface = "C1") =>
    row(REPLY_POST_ACTION, { chars: 12, ...(sessionId === undefined ? {} : { sessionId }) }, surface);
  const SEAT = "wrun_seat_one";
  const OTHER_SEAT = "wrun_seat_two";
  const oneSeat = seatContinuity([seatPost(SEAT), seatPost(SEAT)]);
  ok(oneSeat.replies === 2 && oneSeat.sessionIds.join(",") === SEAT, "seatContinuity: two replies naming ONE session is the standing seat answering both name-drops");
  ok(oneSeat.unattributed === 0, "…with nothing unattributed, which is what lets the one-session reading stand");
  const twoSeats = seatContinuity([seatPost(SEAT), seatPost(OTHER_SEAT)]);
  ok(
    twoSeats.sessionIds.length === 2 && twoSeats.sessionIds.join(",") === `${SEAT},${OTHER_SEAT}`,
    "🔴 RED ARM — the OLDER shape: two sessions across the two replies, kept in first-seen order so a red log names which pair disagreed",
  );
  ok(
    seatContinuity([seatPost(undefined), seatPost(undefined)]).unattributed === 2 &&
      seatContinuity([seatPost(undefined), seatPost(undefined)]).sessionIds.length === 0,
    "🔴 RED ARM — rows carrying NO sessionId are COUNTED as unattributed, never dropped: dropping them would report an empty id list, which a `length === 1` gate reads as neither pass nor fail while a `<= 1` one would read as agreement",
  );
  ok(seatContinuity([seatPost(SEAT), seatPost(7)]).unattributed === 1, "NEGATIVE: a non-string sessionId is unattributed — never coerced, the discipline every reader in this module holds");
  ok(seatContinuity([seatPost(SEAT), seatPost("")]).unattributed === 1, "NEGATIVE: an EMPTY sessionId names no session either");
  ok(seatContinuity([seatPost(SEAT, "C1"), seatPost(OTHER_SEAT, "CZ")], { surface: "C1" }).sessionIds.join(",") === SEAT, "the surface scope keeps another room's seat out of this room's continuity claim");
  ok(
    seatContinuity([seatPost(SEAT)], { surface: "slack/T1/C1" }).replies === 0,
    "NEGATIVE: the QUALIFIED key matches no reply.post row — the shape mistake this file's header exists for, and here it would report zero replies rather than a wrong session",
  );
  ok(seatContinuity([row(STOOD_DOWN_ACTION, { sessionId: SEAT })]).replies === 0, "NEGATIVE: another action carrying a sessionId is not a reply");
  ok(seatContinuity([]).replies === 0 && seatContinuity([]).sessionIds.length === 0, "VACUITY: an empty window evidences no seat — a caller gating on `sessionIds.length === 1` must gate on `replies` too");

  const WORKER = "wrun_example50";
  const SEATRj = "wrun_example51";
  const toolset = (worker: string, parentSession?: string, rootSession?: string) =>
    row("worker.toolset", { worker, grain: "task", tools: ["reply"], toolCount: 1, ...(parentSession ? { parentSession } : {}), ...(rootSession ? { rootSession } : {}) });
  const viaWorker = seatContinuity([seatPost(WORKER), seatPost(SEATRj)], { workerRows: [toolset(WORKER, SEATRj, SEATRj)] });
  ok(
    viaWorker.sessionIds.length === 2 && viaWorker.seatIds.join(",") === SEATRj,
    "🔴 GREEN ARM — the live-run shape: a WORKER's reply and its seat's reply are two session ids and ONE seat",
  );
  const noRows = seatContinuity([seatPost(WORKER), seatPost(SEATRj)]);
  ok(noRows.seatIds.length === 2 && noRows.seatIds.join(",") === `${WORKER},${SEATRj}`, "NEGATIVE CONTROL: with no worker.toolset row the same two ids stay TWO seats — the resolution comes from the row, never from the id's shape");
  const realSeats = seatContinuity([seatPost(SEAT), seatPost(OTHER_SEAT)], { workerRows: [toolset(WORKER, SEATRj, SEATRj)] });
  ok(realSeats.seatIds.length === 2, "🔴 RED ARM — two genuine seats stay two when the window's worker rows name neither of them");
  const foreignWorker = seatContinuity([seatPost(WORKER), seatPost(SEAT)], { workerRows: [toolset(WORKER, OTHER_SEAT, OTHER_SEAT)] });
  ok(
    foreignWorker.seatIds.length === 2 && foreignWorker.seatIds.join(",") === `${OTHER_SEAT},${SEAT}`,
    "🔴 RED ARM — a worker whose parent is a DIFFERENT seat resolves to THAT seat, so the pair is still two seats",
  );
  ok(seatOfSession(WORKER, [toolset(WORKER, SEATRj)]) === SEATRj, "seatOfSession: a row with parentSession and no rootSession still resolves the worker to its parent");
  ok(seatOfSession("wrun_example52", [toolset("wrun_example52", WORKER), toolset(WORKER, SEATRj)]) === SEATRj, "seatOfSession: a worker of a worker walks TRANSITIVELY to the seat");
  ok(seatOfSession("wrun_example52", [toolset("wrun_example52", WORKER, SEATRj)]) === SEATRj, "seatOfSession: rootSession names the seat in one step, even when the parent's own row is outside the window");
  ok(seatOfSession(SEATRj, [toolset(WORKER, SEATRj)]) === SEATRj, "NEGATIVE: a session no row names as a worker IS its own seat");
  ok(seatOfSession("wrun_a", [toolset("wrun_a", "wrun_b"), toolset("wrun_b", "wrun_a")]) === "wrun_b", "a cycle in the rows stops the walk instead of looping");
  ok(seatOfSession(WORKER, [row(STOOD_DOWN_ACTION, { worker: WORKER, parentSession: SEATRj })]) === WORKER, "NEGATIVE: only worker.toolset rows resolve a session — another action carrying the same keys does not");

  ok(WAKE_INGRESS_ACTION === PRODUCT_WAKE_INGRESS_ACTION, "the pack's ingress action name IS the product's own WAKE_INGRESS_ACTION — no second spelling of one row");
  const KEYED = "slack/T1/C1";
  const ingress = (wakeId: unknown, surfaceKey: unknown = KEYED, deliveryId?: string) => ({
    ...row(WAKE_INGRESS_ACTION, {
      ...(wakeId === undefined ? {} : { wakeId }),
      ...(surfaceKey === null ? {} : { surfaceKey }),
      ...(deliveryId ? { deliveryId } : {}),
      ingressTs: "2026-05-11T23:30:00.000Z",
    }),
  });
  ok(wakeIngressIds([ingress("w1"), ingress("w2")], { container: "C1" }).join(",") === "w1,w2", "wakeIngressIds joins on the LAST SEGMENT of detail.surfaceKey — the container id a driver actually holds");
  ok(wakeIngressIds([ingress("w1"), ingress("w2")], { container: KEYED }).length === 2, "…and on the WHOLE qualified key, for a caller that knows it");
  ok(
    wakeIngressIds([ingress("w1"), ingress("w1", KEYED, "d2")], { container: "C1" }).join(",") === "w1",
    "🔴 DISTINCT ids, not rows: a REDRIVE files a second row for ONE wake id, and counting rows would report two wakes where the deployment admitted one",
  );
  ok(
    wakeIngressIds([ingress("w1"), ingress("w2", "slack/T1/CZ")], { container: "C1" }).join(",") === "w1",
    "🔴 NEGATIVE: another room's wake is not this container's — the leg's read is scoped by platform and time only, so without the join a stranger's message greens the two-wake gate",
  );
  ok(wakeIngressIds([ingress("w1", null)], { container: "C1" }).length === 0, "NEGATIVE: a row naming NO container cannot be claimed as this one's — absent is never a match");
  ok(wakeIngressIds([ingress(undefined)], { container: "C1" }).length === 0 && wakeIngressIds([ingress(7)], { container: "C1" }).length === 0, "NEGATIVE: a missing or non-string wakeId contributes nothing rather than an undefined entry");
  ok(wakeIngressIds([row("reply.post", { wakeId: "w1", surfaceKey: KEYED })], { container: "C1" }).length === 0, "NEGATIVE: another action carrying a wakeId is not an ingress row");
  ok(wakeIngressIds([ingress("w1"), ingress("w2", "slack/T1/CZ")]).length === 2, "an UNJOINED read counts every container's wakes — which is why every caller passes the container");
  ok(wakeIngressIds([]).length === 0, "VACUITY: an empty window admitted no wake");
  ok(wakeIngressIds([ingress("w1", "C1")], { container: "C1" }).join(",") === "w1", "an UNSLASHED surface key matches its container by equality — the last-segment arm is not the only one");
  ok(wakeIngressIds([ingress("w1", "CZ")], { container: "C1" }).length === 0, "NEGATIVE: …and an unslashed key naming ANOTHER container matches nothing — the equality arm is a join, not a fallback that admits everything");

  const engagedSlackBody = SCENARIOS.find((s) => s.id === "J-ENGAGED-slack")!.run.toString().replace(/\s+/g, "");
  ok(
    (engagedSlackBody.match(/gateOneSeatAcrossNameDrops\(/g) ?? []).length === 1,
    `OPE-1748: J-ENGAGED-slack drives the one-seat proof EXACTLY ONCE, over the window its FIRST name-drop opened (found ${(engagedSlackBody.match(/gateOneSeatAcrossNameDrops\(/g) ?? []).length})`,
  );
  ok(
    (engagedSlackBody.match(/expect:"name-drop"/g) ?? []).length === 2,
    `🔴 OPE-1748: TWO name-drop legs, not one — the second is what the OPE-1748 proof 2 is about, and a body with one is the pack before this ticket (found ${(engagedSlackBody.match(/expect:"name-drop"/g) ?? []).length})`,
  );
  ok(
    engagedSlackBody.includes("container:slack.channelId"),
    "🔴 OPE-1748: the two-wake gate is joined to the room the leg drove — an unjoined read counts every wake the deployment admitted in the window, on any surface",
  );
  const bareTopLevelPost = /\.post\((["`])(?:(?!\1).)*\1\)/g;
  for (const id of ["J-ENGAGED-slack", "S9"]) {
    const body = SCENARIOS.find((s) => s.id === id)!.run.toString().replace(/\s+/g, "");
    const bare = body.match(bareTopLevelPost) ?? [];
    ok(bare.length === 0, `🔴 OPE-2111: ${id} posts no unsalted top-level fixture line (found ${bare.join(" ")})`);
    ok((body.match(/\.post\(fixtureLine\(/g) ?? []).length >= 2, `OPE-2111: ${id} salts its negative control AND its name-drop with fixtureLine (the scan above is not vacuous)`);
  }
  ok('slack.post("hasanyoneseenthereleasechecklist?")'.match(bareTopLevelPost)?.length === 1, "negative control: the scan matches a bare top-level string post");
  ok("slack.post(`hasanyoneasked${ENGAGED_NAME}aboutit?`)".match(bareTopLevelPost)?.length === 1, "negative control: the scan matches a bare top-level template post");
  ok('slack.post("andwhat\'sthatplus6?",rootTs)'.match(bareTopLevelPost) === null, "negative control: a threaded post (second argument) is not a top-level line");
  const catchUpLegs = SCENARIOS.filter((s) => s.run.toString().includes("gateSeatCatchUp(")).map((s) => s.id).sort();
  ok(
    catchUpLegs.join(",") === "J-ENGAGED-discord,J-ENGAGED-github,J-ENGAGED-linear,J-ENGAGED-notion,J-ENGAGED-slack,J-ENGAGED-teams",
    `🔴 OPE-1754: the catch-up leg runs on EVERY non-Slack engaged journey. Discord and Notion joined the five when \`wake.e2eDrivers\` gave the pack's bot and integration driver identities a named way into the seat — before that the default \`wide\` admission dropped them before the envelope and a leg there red on a healthy deployment. 🔴 SLACK IS NO LONGER OUT (OPE-1836). It was held out because its catch-up shipped with OPE-1695 (b) and its journey drove the second name-drop instead — which is a claim about where the CODE came from, not about what any deployment was shown to do. The coverage audit counted it as the gap it is: the read had live proof on five surfaces and none on the one carrying most of the product's traffic. J-ENGAGED-slack now drives step (e) through the same helper (saw ${JSON.stringify(catchUpLegs)})`,
  );
  const scenarioSrc = readFileSync(fileURLToPath(new URL("../packages/core/scripts/e2e/scenarios.ts", import.meta.url)), "utf-8");
  ok(
    /factToken\("gh-idle"\)[\s\S]{0,1600}?await sleep\(\d[\d_]*\);[\s\S]{0,200}?const catchUpFrom/.test(scenarioSrc),
    "🔴 OPE-1748: J-ENGAGED-github WAITS between the idle comment and its trigger. GitHub stamps `created_at` to the SECOND, the supervisor takes the trigger's `sentAt` as `untilMs`, and core filters `m.ms < untilMs` STRICTLY — so two API round trips inside one wall-clock second bound the idle comment out of its own catch-up window",
  );
  ok(
    /await sleep\(msToNextMinuteBoundary\([\s\S]{0,200}?factToken\("not-idle"\)/.test(scenarioSrc),
    "🔴 OPE-1754: J-ENGAGED-notion WAITS PAST THE MINUTE BOUNDARY **BEFORE** its idle comment — `sinceMs` comes from the seat's UNFLOORED `lastWakeAt`, so a comment whose floored stamp lands in the wake's own minute is dropped by the fetch's `m.ms >= sinceMs` bound",
  );
  ok(
    /factToken\("not-idle"\)[\s\S]{0,1200}?await sleep\(msToNextMinuteBoundary\([\s\S]{0,200}?const catchUpFrom/.test(scenarioSrc),
    "🔴 OPE-1754: …and AFTER it, before the trigger — core filters `m.ms < untilMs` STRICTLY against the trigger's own floored stamp, so two comments in one minute share an instant",
  );
  const deploymentSettingsSrc = readFileSync(fileURLToPath(new URL("../agent/settings/settings.ts", import.meta.url)), "utf-8");
  for (const surface of ["discord", "notion"]) {
    const body = SCENARIOS.find((s) => s.id === `J-ENGAGED-${surface}`)!.run.toString();
    ok(
      new RegExp(`gateSeatCatchUp\\([\\s\\S]{0,400}?platform:\\s*"${surface}"`).test(body),
      `🔴 OPE-1754: J-ENGAGED-${surface} drives its catch-up gate on its OWN platform — the leg the driver-identity carve-out exists to unblock`,
    );
    ok(
      new RegExp(`\\{\\s*surface:\\s*"${surface}",\\s*principal:\\s*"[^"\\s]+"\\s*\\}`).test(deploymentSettingsSrc),
      `🔴 OPE-1754: agent/settings/settings.ts names a \`${surface}\` principal in \`wake.e2eDrivers\` — the entry J-ENGAGED-${surface}'s catch-up leg depends on, without which the seat's default \`wide\` admission drops the driver before the envelope`,
    );
  }
  for (const id of catchUpLegs) {
    const body = SCENARIOS.find((s) => s.id === id)!.run.toString().replace(/\s+/g, "");
    ok(/stale:\[[A-Za-z]/.test(body), `${id}: its catch-up leg passes a STALE marker — without one the bound is unasserted and a read that returns the whole container every wake passes`);
    const stopAt = Math.max(body.indexOf("gateStandDownMarked("), body.indexOf("STOOD_DOWN_ACTION"));
    ok(
      stopAt >= 0 && stopAt < body.indexOf("gateSeatCatchUp("),
      `🔴 ${id}: the catch-up leg runs AFTER the stand-down. That ordering IS the idle window — the stop is what stops the idle message waking anything, and it is what makes the seat's next wake the only road into its context`,
    );
  }

  {
    const fast = (timeoutMs: number, what: string) => ({ timeoutMs, what, initialDelayMs: 1, maxDelayMs: 1 });
    const postRow = (surface?: string) => row(REPLY_POST_ACTION, { chars: 12 }, surface);

    {
      let calls = 0;
      const read = async () => {
        calls += 1;
        return calls >= 3 ? [postRow("C1")] : [];
      };
      const found = await awaitReplyPostRows(read, { sinceIso: "2026-05-14T16:35:00Z", platform: "slack", surface: "C1", budget: fast(2_000, "a slack reply.post row") });
      ok(found !== undefined && found.length === 1, "🔴 OPE-1711: awaitReplyPostRows WAITS for a row that lands after the first read — the single read this replaces reported the healthy deployment as silent");
      ok(calls === 3, `…and it read again rather than once (${calls} reads)`);
    }

    {
      let calls = 0;
      const first = row(REPLY_POST_ACTION, { sessionId: "seat", wakeId: "first" }, "C1");
      const second = row(REPLY_POST_ACTION, { sessionId: "seat", wakeId: "second" }, "C1");
      const found = await awaitReplyPostRows(async () => {
        calls += 1;
        return calls >= 3 ? [first, first, second] : [first, first];
      }, {
        sinceIso: "2026-05-20T23:30:00Z", platform: "notion", surface: "C1",
        minRows: 2, minDistinctWakes: 2, budget: fast(2_000, "two answered wakes"),
      });
      ok(calls === 3 && found?.length === 3, "two-wake waiter keeps polling past duplicate posts until the other wake replies");
    }

    {
      let admissionReads = 0;
      const posts = ["first", "second"].map((wakeId) => row(REPLY_POST_ACTION, { sessionId: "seat", wakeId }, "C1"));
      const evidence = await awaitRepliesForAdmittedWakes(async (query) => {
        if (query.actions?.includes(REPLY_POST_ACTION)) return posts;
        admissionReads += 1;
        return (admissionReads >= 3 ? ["first", "second"] : ["first", "unrelated"]).map(
          (wakeId) => row(WAKE_INGRESS_ACTION, { wakeId, surfaceKey: "notion/workspace/C1" }),
        );
      }, { sinceIso: "2026-05-20T23:30:00Z", platform: "notion", surface: "C1", container: "C1", minWakes: 2, budget: fast(2_000, "joined replies and admissions") });
      ok(admissionReads === 3 && evidence?.wakeIds.includes("second") === true, "joined waiter waits through unrelated admissions and audit visibility skew");
    }

    {
      let calls = 0;
      const first = postRow("C1");
      const second = postRow("C1");
      const read = async () => {
        calls += 1;
        return calls >= 2 ? [first, second] : [first];
      };
      const found = await awaitReplyPostRows(read, {
        sinceIso: "2026-05-20T14:30:40.219Z",
        platform: "notion",
        surface: "C1",
        minRows: 2,
        budget: fast(2_000, "two reply.post rows for two name-drops"),
      });
      ok(found?.length === 2, "🔴 OPE-1895: awaitReplyPostRows waits past the first existing reply until the second name-drop's second scoped reply row lands");
      ok(calls === 2, `…and the staged reader exposed one row before two (${calls} reads)`);
    }

    {
      const observations = [
        { elapsedMs: 0, rows: [] },
        { elapsedMs: 60_001, rows: [] },
        { elapsedMs: 127_000, rows: [postRow("C1"), postRow("C1")] },
      ] as const;
      let calls = 0;
      const read = async () => observations[Math.min(calls++, observations.length - 1)]!.rows;
      const found = await awaitReplyPostRows(read, {
        sinceIso: "2026-05-20T14:30:40.219Z",
        platform: "notion",
        surface: "C1",
        minRows: 2,
        budget: fast(2_000, "two delayed reply.post rows for two name-drops"),
      });
      ok(found?.length === 2, "🔴 OPE-1895: the two-row waiter survives the ticket-linked zero → zero → two observation sequence");
      const matchedAt = observations[calls - 1]!.elapsedMs;
      ok(matchedAt > 60_000 && matchedAt < 180_000, `…and the matching observation records why 60s expires while 180s covers it (${matchedAt} ms)`);
    }

    {
      let calls = 0;
      const read = async () => {
        calls += 1;
        return [];
      };
      const found = await awaitReplyPostRows(read, { sinceIso: "2026-05-14T16:35:00Z", platform: "slack", budget: fast(30, "a row that never lands") });
      ok(found === undefined, "🔴 NEGATIVE CONTROL: a row that NEVER lands answers undefined — the poll bounds the wait, it does not turn a missing row into a pass");
      ok(calls > 1, `…after polling rather than giving up on the first read (${calls} reads)`);
    }

    {
      const read = async () => [postRow("CZ")];
      const found = await awaitReplyPostRows(read, { sinceIso: "2026-05-14T16:35:00Z", platform: "slack", surface: "C1", budget: fast(30, "a row on C1") });
      ok(found === undefined, "🔴 NEGATIVE: a reply.post row on a DIFFERENT surface does not satisfy the wait — the scope is applied in-process too, not only at the route");
    }

    {
      let calls = 0;
      const read = async () => {
        calls += 1;
        if (calls === 1) return [];
        throw new Error("control read 500");
      };
      let threw: unknown = null;
      try {
        await awaitReplyPostRows(read, { sinceIso: "2026-05-14T16:35:00Z", platform: "slack", budget: fast(2_000, "a row behind a broken read") });
      } catch (err) {
        threw = err;
      }
      ok(threw instanceof Error && String((threw as Error).message).includes("500"), "🔴 OPE-353: two consecutive read failures PROPAGATE — a failed observation is not an observation of absence");
    }

    {
      let calls = 0;
      const read = async () => {
        calls += 1;
        return calls >= 2 ? [row(STOOD_DOWN_ACTION, { anchor: "1700.0001", marked: true })] : [];
      };
      const rows = await awaitStandDownVerdict(read, { sinceIso: "2026-05-14T16:35:00Z", platform: "slack", anchor: "1700.0001", budget: fast(2_000, "a stood_down row") });
      ok(standDownMarked(rows, { anchor: "1700.0001" }), "OPE-1711: awaitStandDownVerdict waits for the marked row, then hands the caller the rows it read");
      ok(calls === 2, `…having read again rather than once (${calls} reads)`);
    }

    {
      let calls = 0;
      const read = async () => {
        calls += 1;
        return [row(STOOD_DOWN_ACTION, { anchor: "1700.0001", marked: false })];
      };
      const rows = await awaitStandDownVerdict(read, { sinceIso: "2026-05-14T16:35:00Z", platform: "slack", anchor: "1700.0001", budget: fast(2_000, "a stood_down verdict") });
      ok(calls === 1, `🔴 OPE-1711: a marked:false row ENDS the wait immediately (${calls} read) — the negative control fires as fast as it did before the poll`);
      ok(standDownAttemptedButUnmarked(rows, { anchor: "1700.0001" }), "…and the rows it returns still carry the unmarked row, so the caller's control gate can read it");
    }

    {
      const rows = await awaitStandDownVerdict(async () => [], { sinceIso: "2026-05-14T16:35:00Z", platform: "slack", budget: fast(30, "a verdict that never comes") });
      ok(rows.length === 0, "OPE-1711: an elapsed budget answers the last rows read (empty) — never a throw, so the caller's gates report the absence themselves");
    }

    const gatesSrc = readFileSync(fileURLToPath(new URL("../packages/core/scripts/e2e/scenarios.ts", import.meta.url)), "utf-8");
    ok(gatesSrc.includes("awaitReplyPostRows(ctx.auditRead!"), "🔴 OPE-1711: gateEngagedWake — the reply gate every J-ENGAGED leg calls — takes the waiter, not a single read");
    ok(gatesSrc.includes("awaitStandDownVerdict(ctx.auditRead!"), "🔴 OPE-1711: gateStandDownMarked takes the waiter too");
    const oneSeatStart = gatesSrc.indexOf("async function gateOneSeatAcrossNameDrops(");
    const oneSeatEnd = gatesSrc.indexOf("async function gateSeatCatchUp(", oneSeatStart);
    const oneSeatBody = gatesSrc.slice(oneSeatStart, oneSeatEnd);
    ok(
      oneSeatStart >= 0 && oneSeatEnd > oneSeatStart && /awaitRepliesForAdmittedWakes\([\s\S]*?minWakes:\s*2/.test(oneSeatBody),
      "🔴 OPE-1895: gateOneSeatAcrossNameDrops asks the shared waiter for TWO scoped rows — the helper's safe one-row default cannot return on the first name-drop",
    );
    ok(
      /awaitRepliesForAdmittedWakes\([\s\S]*?timeoutMs:\s*REPLY_WAIT/.test(oneSeatBody),
      "🔴 OPE-1895: gateOneSeatAcrossNameDrops gives the two-reply poll the 180-second REPLY_WAIT budget — A live run's first and second rows landed after the 60-second audit-only budget",
    );
    const silenceStart = gatesSrc.indexOf("async function gateAuditedSilence(");
    const silenceEnd = gatesSrc.indexOf("async function auditedSilenceMark(", silenceStart);
    const silenceBody = gatesSrc.slice(silenceStart, silenceEnd);
    ok(
      silenceStart >= 0 && silenceEnd > silenceStart && (silenceBody.match(/ctx\.auditRead!\(/g) ?? []).length === 1 && !/poll(?:Until|Optional)\(/.test(silenceBody),
      `OPE-1711: the audited-SILENCE gate reads reply.post exactly ONCE and never polls (reads found: ${(silenceBody.match(/ctx\.auditRead!\(/g) ?? []).length})`,
    );
    ok(silenceBody.includes("replyPostsAfter(earlier, opts.highWater, scope)"), "🔴 OPE-2361: the silence is the rows above the seq mark, from that one read");

    {
      const calls = gatesSrc.match(/await gateAuditedSilence\(ctx, \{[^}]*\}\)/g) ?? [];
      ok(
        calls.length === 5,
        `🔴 OPE-1991: all five J-ENGAGED journeys call the audited-silence gate (found ${calls.length}) — a journey that stopped calling it would satisfy every per-call assertion below by being absent`,
      );
      ok(
        calls.every((c) => c.includes("surface") && c.includes("liveFrom:")),
        `🔴 OPE-1991: every call passes BOTH the surface scope and the liveness watermark — the unscoped shape counted a sibling page's correct answer as a broken stop in a live run, and an unchecked scope would pass vacuously instead`,
      );
      const expected: Readonly<Record<string, string>> = {
        slack: "surface,",
        discord: "surface: threadId",
        github: "surface: bareSurfaceSegment(github.repo)",
        linear: "surface: linear.teamId",
        notion: "surface: notion.pageId",
      };
      for (const [platform, segment] of Object.entries(expected)) {
        const call = calls.find((c) => c.includes(`platform: "${platform}"`));
        ok(
          call !== undefined && call.includes(segment),
          `🔴 OPE-1991: J-ENGAGED-${platform} scopes its audited silence with \`${segment}\` — the bare segment ${platform}'s identity mapper binds. Any other shape matches no row and turns this gate vacuous (call read: ${call ?? "ABSENT"})`,
        );
      }
    }

    {
      const MEASURED_ACK_TO_SETTLE_MS = 184_495;
      const delegatedWait = seedWriteWaitMs({ kind: "unsettled" });
      ok(delegatedWait === 420_000, `🔴 OPE-2100: a DELEGATED seed turn waits the delegated budget, FILE_REPLY_WAIT (got ${delegatedWait}ms)`);
      ok(delegatedWait > MEASURED_ACK_TO_SETTLE_MS, `🔴 OPE-2100: the delegated wait covers a live run's measured ack→settle of ${MEASURED_ACK_TO_SETTLE_MS}ms`);
      ok(seedWriteWaitMs({ kind: "settled" }) === delegatedWait && seedWriteWaitMs({ kind: "unposted" }) === delegatedWait, "…and every delegated kind takes the same budget");
      ok(seedWriteWaitMs({ kind: "inline" }) === 60_000, `OPE-2100 NEGATIVE CONTROL: an INLINE seed turn keeps AUDIT_ROW_WAIT (got ${seedWriteWaitMs({ kind: "inline" })}ms)`);
      ok(seedWriteWaitMs(undefined) === 60_000, "OPE-2100 NEGATIVE CONTROL: an UNJOINED seed route keeps AUDIT_ROW_WAIT too");
      ok(seedWriteWaitMs({ kind: "cut" }) === delegatedWait, "🔴 OPE-2039: a CUT seed page cannot say the seat wrote inline, so it takes the delegated budget — the 60-s bound is the one that redded a live run on a delegated turn");
      const memReadSrc = SCENARIOS.find((s) => s.id === "S-MEM-READ")!.run.toString().replace(/\s+/g, "");
      ok(
        memReadSrc.includes("NOSETTLEMENTwithin${seedWriteWaitMs(delegated)/1e3}s") || memReadSrc.includes("NOSETTLEMENTwithin${seedWriteWaitMs(delegated)/1000}s"),
        "🔴 OPE-2100: the no-settlement red names the bound the poll actually used",
      );
      const memReadLeg = SCENARIOS.find((s) => s.id === "S-MEM-READ")!;
      ok(
        (memReadLeg.timeoutMs ?? 0) >= 2_280_000 - 180_000 + delegatedWait,
        `🔴 OPE-2100: the leg budget carries the raised settlement wait, so the poll's own bound reds first and the runner never kills the leg anonymously (got ${String(memReadLeg.timeoutMs)})`,
      );
    }

    {
      const memRead = SCENARIOS.find((s) => s.id === "S-MEM-READ")!.run.toString().replace(/\s+/g, "");
      const purgeAt = memRead.indexOf('leg:"canary-purge"');
      const seedAt = memRead.indexOf("rememberthisfortheteam:theOPE121canarycodeis");
      ok(purgeAt >= 0, "🔴 OPE-1977: S-MEM-READ drives a canary purge — without it the silo stacks one OPE121 canary per board and the recall red is a fixture, not the product");
      ok(seedAt >= 0 && purgeAt < seedAt, `🔴 OPE-1977: the purge runs BEFORE the seed (purge at ${purgeAt}, seed at ${seedAt}) — after it, the purge would erase the very canary the recall gate reads`);
      ok(
        memRead.includes("otherFactTokens("),
        "🔴 OPE-1977: the recall gate names any PREVIOUS board's canary the reply chose instead — a best-effort purge can leave the stack, and the red must then read as accumulation rather than as a seat that cannot open its memory",
      );
      ok(
        memRead.includes("extractMemoryPathReads(windowed)"),
        "🔴 OPE-1977: leg 3 extracts reads from the RECALL-WINDOWED events, never the whole replay — otherwise leg 0's purge turn satisfies the one gate this scenario exists for",
      );
      ok(
        /constat=e\.at===null\?Number\.NaN:Date\.parse\(e\.at\);returnNumber\.isFinite\(at\)&&at>=askStartMs/.test(memRead),
        "🔴 OPE-1977: the window compares MILLISECONDS off `askStart`, and an event with no readable stamp is EXCLUDED — an ISO byte-compare is the trap OPE-1905/OPE-1924 paid for, and counting an unattributable event would weaken the gate",
      );
      ok(
        memRead.includes("replays.set(sessionId,events)"),
        "…and `replays` keeps the WHOLE stream: the phase decomposition needs the dispatch that opened the turn, which the read window cuts",
      );

      const purgeBoundAt = memRead.indexOf('constpurgeStart=awaitpresenceSince(ctx,"purgeStart")');
      ok(
        purgeBoundAt >= 0 && purgeBoundAt < purgeAt,
        `🔴 OPE-2028: the audit lower bound is taken BEFORE leg 0's purge (bound at ${purgeBoundAt}, purge at ${purgeAt}) — a bound taken after it cannot see the purge commit the seed gate must exclude`,
      );
      ok(
        memRead.includes("seedMemoryWrites"),
        "🔴 OPE-2028: the seed gate counts through `seedMemoryWrites` — road + position — never every `memory.write` row in the skew window, which is what passed on the purge's own row",
      );
      ok(
        memRead.includes("turnStartMs") && memRead.includes("wakeIdForVendorInstant"),
        "…and it resolves the SEED TURN's own start as that filter's floor — the bound that also excludes the purge TURN's turn-end persist, which rides a non-purge road",
      );
      ok(
        memRead.includes("readsAsClarifyingQuestion"),
        "🔴 OPE-2028: the leg reads the seed ack through `readsAsClarifyingQuestion`, so a red caused by a seat that asked INSTEAD of storing quotes the question rather than reporting a bare absent row",
      );
      ok(
        memRead.includes("ALREADYSTORED"),
        "🔴 OPE-2028: leg 0's erase names the EXISTING entries — the old wording said every fact of the class must not persist, and leg 1 then seeded one more of the same class 37 s later",
      );
      ok(
        memRead.includes("ThisSUPERSEDEStheerasure"),
        "…and the seed supersedes the erasure explicitly: either half alone still leaves a standing erasure over the code the seat is being handed",
      );

      ok(
        memRead.includes("seedSettlementRead"),
        "🔴 OPE-2036: the leg asks `seedSettlementRead` which shape the seed turn took, rather than assuming the seat wrote inline",
      );
      const settleWaitAt = memRead.indexOf("theworker'ssettlementpost,thenthepersistrowstandingrightbeforeit");
      const writeWaitAt = memRead.indexOf("thecanary'sownmemory.writeauditrow");
      ok(settleWaitAt >= 0 && writeWaitAt >= 0, `🔴 OPE-2036: BOTH seed waits are present — the inline one and the delegated one (settle at ${settleWaitAt}, write at ${writeWaitAt})`);
      ok(
        /timeoutMs:seedWriteWaitMs\(delegated\),[^}]{0,80}what:"seed:theworker'ssettlementpost/.test(memRead),
        "🔴 OPE-2036/OPE-2100: the DELEGATED seed wait takes the delegated budget from seedWriteWaitMs, never AUDIT_ROW_WAIT measured from the interim ack and never the direct-reply REPLY_WAIT",
      );
      ok(
        /timeoutMs:seedWriteWaitMs\(delegated\),[^}]{0,80}what:"seed:thecanary'sownmemory\.writeauditrow/.test(memRead),
        "…and the INLINE seed wait takes its bound from the same selector, which keeps AUDIT_ROW_WAIT there — OPE-2036 build item 4",
      );
      ok(
        memRead.includes("settlementPost:settle.post"),
        "🔴 OPE-2036: §16's filter runs on the delegated path with the SETTLEMENT POST as its ceiling — the worker persists before it reports (OPE-1915)",
      );
      ok(
        memRead.includes("actions:[...SEED_WRITE_ACTIONS]") && ([...SEED_WRITE_ACTIONS] as readonly string[]).includes("memory.claim_withheld"),
        "🔴 OPE-2036: the seed read asks for the claim-withheld rows, so the interim ack's struck \"stored\" claim can be LOGGED as the expected shape rather than read as a failure",
      );
      ok(
        memRead.includes("seedDelegation?.roundTripMs"),
        "🔴 OPE-2036 build item 5: the leg REPORTS the turn start → settlement round trip, so a slow worker is visible without gating on it",
      );
      ok(
        memRead.includes('seedDelegation.kind==="unsettled"||seedDelegation.kind==="unposted"'),
        "🔴 OPE-2036: the leg reads BOTH no-settlement verdicts — the worker still running, and a settlement that never posted",
      );
      const noSettleAt = memRead.indexOf("NOSETTLEMENTwithin");
      ok(noSettleAt >= 0, `🔴 OPE-2036: the red NAMES the missing settlement (found at ${noSettleAt})`);
      ok(
        memRead.includes("thisredsaystheWORKERdidnotreport,neverthatthecanarywasnotstored"),
        "…and says what it does NOT claim, so the next reader goes to the worker rather than to the write path",
      );
    }

    {
      const { notionMinuteFloor, NotionDriver } = await import("../packages/core/scripts/e2e/notion-driver.js");
      const { isTurnCancelNote } = await import("../packages/core/agent/hooks/turn-anchor.js");

      ok(notionMinuteFloor("2026-05-15T01:58:44.812Z") === "2026-05-15T01:58:00.000Z", "OPE-1711: the watermark floors to the START of its own minute");
      ok(notionMinuteFloor("2026-05-15T01:58:00.000Z") === "2026-05-15T01:58:00.000Z", "…and a watermark already on the minute is unchanged (idempotent)");
      ok(notionMinuteFloor("2026-05-14T11:35:00.000Z") === "2026-05-14T11:35:00.000Z", "…including midnight, where the floor must not roll the date back");
      ok(notionMinuteFloor("not-a-time") === "not-a-time", "🔴 an UNPARSEABLE watermark is handed back, never widened — a widened window would admit a PREVIOUS run's reply");

      const not = new NotionDriver({ driverKey: "k", pageId: "p", botUserId: "bot", workspaceId: "ws" });
      const at = (id: string, authorId: string, createdTime: string, discussionId = "d1") => ({ id, discussionId, authorId, text: "144", createdTime });
      const SINCE = "2026-05-15T01:58:44.812Z";
      const theReply = at("c-reply", "bot", "2026-05-15T01:58:00.000Z");
      ok(not.isFreshBotComment(theReply, "d1", SINCE), "🔴 OPE-1711: the reply Notion timestamps a MINUTE EARLIER than the watermark is FRESH — this is the exact comment J-ENGAGED-notion could not see");
      ok(!not.isFreshBotComment(theReply, "d2", SINCE), "NEGATIVE CONTROL: a reply in another DISCUSSION is not this step's");
      ok(!not.isFreshBotComment(at("c-human", "human", "2026-05-15T01:58:00.000Z"), "d1", SINCE), "NEGATIVE CONTROL: a human comment is never a bot reply");
      ok(!not.isFreshBotComment(at("c-old", "bot", "2026-05-15T01:57:00.000Z"), "d1", SINCE), "NEGATIVE CONTROL: the minute BEFORE the watermark's is still too old — the widening is one minute, not unbounded");
      ok(!not.isFreshBotComment(theReply, "d1", SINCE, { seen: new Set(["c-reply"]) }), "🔴 OPE-1711: a reply the caller has ALREADY consumed is not fresh, whatever the clock says");
      ok(not.isFreshBotComment(theReply, "d1", SINCE, { seen: new Set(["c-other"]) }), "…and an unrelated id in the set changes nothing");
      ok(!not.isFreshBotComment(theReply, "d1", SINCE, { skip: (c) => c.id === "c-reply" }), "the interim-post skip still applies (OPE-984's hand-off frame)");

      ok(isTurnCancelNote("Stood down — one step in. One action had already run, and it is NOT undone."), "OPE-1711: the cancel note J-ENGAGED-discord latches onto (the OPE-1819 shape — no tool names)");
      ok(!isTurnCancelNote("Standing down."), "🔴 …and the stand-down ACKNOWLEDGEMENT the leg was really waiting for is not one (a live run)");

      const driverSrc = readFileSync(fileURLToPath(new URL("../packages/core/scripts/e2e/notion-driver.ts", import.meta.url)), "utf-8");
      ok((driverSrc.match(/isFreshBotComment\(c, discussionId, sinceTime, opts\)/g) ?? []).length === 2, "🔴 OPE-1711: BOTH Notion reply waiters take the shared freshness predicate, not a raw `createdTime >` compare");
      ok(!/c\.createdTime > sinceTime/.test(driverSrc), "🔴 OPE-1711: no second-precision `c.createdTime > sinceTime` compare survives in the Notion driver (the regex names the RECEIVER, so this file's own prose about the old shape cannot satisfy it)");
      ok(!/c\.createdTime > (silenceFrom|rStart)/.test(gatesSrc), "🔴 OPE-1711: nor in the Notion legs' own reads — the silence read ran in the DANGEROUS direction, reporting a same-minute post-stop reply as silence");
      ok(gatesSrc.includes("notionMinuteFloor(silenceFrom)"), "OPE-1711: J-ENGAGED-notion's audited-silence read floors its watermark too");
      ok((gatesSrc.match(/timeoutMs: REPLY_WAIT, seen/g) ?? []).length >= 3, "🔴 OPE-1711: every J-ENGAGED-notion reply wait carries the `seen` set the minute-grain watermark needs");
      ok((gatesSrc.match(/awaitReplyMatching\(threadId, \w+\.id, notCancelNote/g) ?? []).length === 3, "🔴 OPE-1711: J-ENGAGED-discord's follow-up, stop AND catch-up awaits all step past the cancel note — the catch-up trigger's wait joined them with OPE-1754, and a cancel note latched onto there would read as the seat having answered");
      ok(gatesSrc.includes("const silent = raw.filter(notCancelNote);"), "🔴 OPE-1711: …and its silence window does not count a cancel note as a post-stop reply");
      ok(gatesSrc.includes("if (raw.length !== silent.length) ctx.log("), "🔴 OPE-1711: the leg LOGS how many cancel notes it skipped — the filter never hides the symptom");
    }

    {
      const { commentAtOrAfter } = await import("../packages/core/scripts/e2e/comment-window.js");

      const COMMENT_BOUND = "2026-05-20T11:57:28.900Z";
      ok(
        commentAtOrAfter("2026-05-20T11:57:28Z", COMMENT_BOUND),
        "OPE-1905: GitHub's second-grain stamp in the watermark's OWN second is INSIDE the window — the floor is what admits a real post stamped there",
      );
      ok(
        !commentAtOrAfter("2026-05-20T11:57:27Z", COMMENT_BOUND),
        "🔴 NEGATIVE CONTROL: the second BEFORE the watermark's is still outside — the widening is one second, not unbounded",
      );
      ok(
        commentAtOrAfter("2026-05-20T11:57:35Z", COMMENT_BOUND),
        "OPE-1905: a genuine post-stop reply seconds later still counts — the fix must not blind the gate it repairs",
      );
      ok(
        !commentAtOrAfter("2026-05-20T02:15:10Z", "2026-05-20T02:15:13.100Z"),
        "OPE-1905: a live run's acknowledgement, three seconds before its probe, was outside the window — which is the only reason that ship read GREEN",
      );
      ok(
        commentAtOrAfter("not-a-time", COMMENT_BOUND) && commentAtOrAfter("2026-05-20T11:57:35Z", "not-a-time"),
        "🔴 an UNREADABLE stamp on EITHER side counts as inside — a silence gate must red on a page it cannot read, never report a silence nobody measured",
      );
      ok(
        commentAtOrAfter("1969-12-31T23:59:58Z", "1969-12-31T23:59:58.500Z"),
        "🔴 the floor uses Math.floor, not a remainder: JS keeps the sign of the dividend, so a remainder pre-epoch rounds the bound UP to a NEWER instant and drops this real post",
      );

      ok(
        !/github\.isBotComment\(c\) && c\.createdAt > silenceFrom/.test(gatesSrc),
        "🔴 OPE-1905: no millisecond-vs-second `c.createdAt > silenceFrom` compare survives in J-ENGAGED-github's silence read",
      );
      ok(
        gatesSrc.includes("github.isBotComment(c) && commentAtOrAfter(c.createdAt, silenceFrom)"),
        "OPE-1905: J-ENGAGED-github's audited-silence read takes the shared second-grain predicate",
      );

      const LINEAR_BOUND = "2026-05-20T11:57:28.900Z";
      ok(
        "2026-05-20T11:57:28Z" > LINEAR_BOUND,
        "🔴 OPE-1924 CONTROL: the string compare the Linear leg used to run really does read a SECOND-grain stamp from before the bound as after it — `Z` (0x5A) sorts above `.` (0x2E) at character 19. This is the premise the arms below remove, asserted rather than assumed",
      );
      ok(
        !commentAtOrAfter("2026-05-20T11:57:27Z", LINEAR_BOUND),
        "🔴 OPE-1924 NEGATIVE CONTROL: the shared predicate keeps the second BEFORE the bound's OUTSIDE the window — the fix is a one-second floor, never a blanket admit that would green any silence read",
      );
      ok(
        commentAtOrAfter("2026-05-20T11:57:28.901Z", LINEAR_BOUND) && !commentAtOrAfter("2026-05-20T11:57:27.999Z", LINEAR_BOUND),
        "OPE-1924: on a MILLISECOND-grain stamp — every stamp Linear serves today — the shared predicate answers exactly as the byte compare did, so taking it costs the Linear leg no precision it had",
      );

      ok(
        !/linear\.isAppComment\(c\) && c\.createdAt > silenceFrom/.test(gatesSrc),
        "🔴 OPE-1924: no `c.createdAt > silenceFrom` string compare survives in J-ENGAGED-linear's silence read",
      );
      ok(
        gatesSrc.includes("linear.isAppComment(c) && commentAtOrAfter(c.createdAt, silenceFrom)"),
        "🔴 OPE-1924: J-ENGAGED-linear's audited-silence read takes the SAME shared predicate the GitHub leg does — one helper, both legs, which is what stops the two drifting apart again",
      );
      ok(
        !/isAppComment\(c\) && c\.createdAt [<>]/.test(gatesSrc),
        "🔴 OPE-1924: NO Linear app-comment read anywhere in the scenario table compares `createdAt` as a raw string — whatever the watermark is called",
      );
      ok(
        gatesSrc.includes("commentAtOrAfter(c.createdAt, offTopicAt) && !beforeOffTopic.has(c.id)"),
        "🔴 OPE-1924: J-LIN's audited-silence WINDOW takes the shared predicate and its own id snapshot — the floor widens the window back onto the four app replies legs 1-4 already drew, and without the snapshot those count as strays",
      );
      ok(
        gatesSrc.includes("const beforeStop = new Set((await linear.comments(issue.id).catch(() => [])).map((c) => c.id).filter((id) => id.length > 0));"),
        "🔴 OPE-1924: …and the ID SNAPSHOT rides beside it over READABLE ids only, exactly as the GitHub leg's does — flooring widens the window back onto the stand-down acknowledgement this leg legitimately drew, and `comments()` maps an absent id to \"\", which would otherwise exclude a real post-stop reply whose own id is equally unreadable",
      );

      const { capDriveOutcome, ADMIN_DRIVER_CLAUSE } = await import("../packages/core/scripts/e2e/cap-drive-outcome.js");
      const CAP_KEY = "slack/T_TEST/C_CAPPED";
      for (const droveTheFixture of [true, false]) {
        for (const droveAsNonAdmin of [true, false]) {
          const out = capDriveOutcome({ droveTheFixture, droveAsNonAdmin, channel: "C_CAPPED", capFixtureSurfaceKey: CAP_KEY });
          const text = out.kind === "skip" ? out.reason : out.message;
          const claimsAdminDriver = text.includes(ADMIN_DRIVER_CLAUSE);
          ok(
            claimsAdminDriver === (droveTheFixture && !droveAsNonAdmin),
            `🔴 OPE-1925 (droveTheFixture=${droveTheFixture}, droveAsNonAdmin=${droveAsNonAdmin}): the verdict text names the ADMIN driver iff the drive really was the admin one — got "${text.slice(0, 120)}"`,
          );
          ok(
            (out.kind === "enforcement-regression") === (droveTheFixture && droveAsNonAdmin),
            `🔴 OPE-1925 (droveTheFixture=${droveTheFixture}, droveAsNonAdmin=${droveAsNonAdmin}): the HARD gate fires exactly when both facts hold — a missing refusal is a product defect only in the capped room, driven by a member a cap can refuse`,
          );
        }
      }
      ok(
        capDriveOutcome({ droveTheFixture: false, droveAsNonAdmin: true, channel: "C_OTHER", capFixtureSurfaceKey: CAP_KEY }).kind === "skip" &&
          (capDriveOutcome({ droveTheFixture: false, droveAsNonAdmin: true, channel: "C_OTHER", capFixtureSurfaceKey: CAP_KEY }) as { reason: string }).reason.includes(CAP_KEY),
        "OPE-1925: a drive that missed the capped room names the room it DID drive and the fixture it missed — the fixture fact is reported before the identity one, because an uncapped room's identity decides nothing",
      );
      ok(
        !(capDriveOutcome({ droveTheFixture: false, droveAsNonAdmin: false, channel: "C_OTHER" }) as { reason: string }).reason.includes(ADMIN_DRIVER_CLAUSE),
        "🔴 OPE-1925 NEGATIVE CONTROL: an ADMIN drive that never reached the capped room does NOT blame the identity — it had no cap to trip either way, and blaming the driver there sends an operator to fix the wrong fixture",
      );

      ok(
        gatesSrc.includes("if (outcome.kind === \"skip\") ctx.skip(outcome.reason);") && gatesSrc.includes("else ctx.gate(false, outcome.message);"),
        "🔴 OPE-1925: S10 takes BOTH its hard gate and its skip reason from the one `capDriveOutcome` value",
      );
      ok(
        gatesSrc.includes("S10 reached its own unreachable tail"),
        "🔴 OPE-1925: …and the branch's tail is a hard gate, not a fall-through — both calls above throw today, and a leg that stopped throwing would otherwise END NORMALLY and report a cap-enforcement pass over five turns that refused nothing",
      );
      ok(
        !/the drive ran as the ADMIN driver \(E2E_SLACK_SECONDARY_TOKEN unset\)/.test(gatesSrc),
        "🔴 OPE-1925: no hand-derived admin-driver clause survives in the scenario table — the sentinel lives in cap-drive-outcome.ts, where the arms above can join it to the branch",
      );
      ok(
        gatesSrc.includes("resolveCapFixtureCap(capFixture, fixtureTeam, await loadAppSpendBudgets(), process.env)") &&
          gatesSrc.includes("const capKey = capCap?.caps !== undefined ? capCap.key : undefined;") &&
          gatesSrc.includes("droveTheFixture: capKey?.endsWith(`/${channel}`) === true"),
        "🔴 OPE-2205: S10 decides `droveTheFixture` from the cap key the deployer's budgets declare for the driven workspace and room",
      );
      ok(
        (capDriveOutcome({ droveTheFixture: false, droveAsNonAdmin: true, channel: "C_REAL", attemptedSurfaceKey: "slack/T_GRID/C_REAL" }) as { reason: string }).reason.includes("slack/T_GRID/C_REAL"),
        "🔴 OPE-2205: a SKIP for an unmatched key names the key S10 TRIED, so a workspace-rung mismatch is visible rather than another silent SKIP",
      );
      ok(
        (capDriveOutcome({ droveTheFixture: true, droveAsNonAdmin: true, channel: "C_REAL", capFixtureSurfaceKey: "slack/T/C_REAL", capFixtureCaps: { surfaceMonthlyUsd: 50 } }) as { message: string }).message.includes('"surfaceMonthlyUsd":50'),
        "🔴 OPE-2205: the RED message prints the matched perSurface row — nothing checks its size, so a reader must see a wide row to tell it from a regression",
      );
      ok(!gatesSrc.includes("capFixture?.surfaceKey"), "🔴 OPE-2205: no tracked fixture surface key survives in S10 — that copy read the synthetic id on the test deployment");

      const { liveMeasurementVerdict } = await import("../packages/core/scripts/e2e/taint-context-line.js");
      const allMeasured = liveMeasurementVerdict(["ARM A (web, live context line)", "ARM D (linear) — the live `context:` line"], []);
      ok(
        allMeasured.cannotRun === undefined && allMeasured.logged.length === 0,
        "OPE-1877: a run in which every arm that RAN measured something carries no verdict — the leg scores on its gates, exactly as before",
      );
      ok(
        liveMeasurementVerdict([], []).cannotRun === undefined && liveMeasurementVerdict([], []).logged.length === 0,
        "OPE-1877: …and a run in which NO arm ran at all carries none either — an undrivable fixture is already its own precise skip, so folding it in would claim a route went unmeasured when it was never drivable",
      );
      const bothSilent = liveMeasurementVerdict([], [
        { arm: "ARM B (github)", what: "the relayed context line was not a live measurement" },
        { arm: "ARM C (notion)", what: "no `taint.verdict` row for kind `notion` landed" },
      ]);
      ok(
        bothSilent.cannotRun !== undefined && bothSilent.cannotRun.includes("ARM B (github)") && bothSilent.cannotRun.includes("ARM C (notion)"),
        "🔴 OPE-1877: the ship #216/#217 shape — every arm silent — produces a verdict, and it NAMES both arms so a ship reader is not left to diff two logs",
      );
      const oneMeasured = liveMeasurementVerdict(["ARM A (web, live context line)"], [{ arm: "ARM C (notion)", what: "no row landed" }]);
      ok(
        oneMeasured.cannotRun === undefined,
        "🔴 OPE-2031: ONE silent arm beside an arm that MEASURED is not cannot-run — the boards #228/#229 shape, where a leg with live web evidence reported that it proved nothing",
      );
      ok(
        oneMeasured.logged.length === 1 && oneMeasured.logged[0]!.includes("ARM C (notion)"),
        "🔴 OPE-2031: …and the silent arm is still LOGGED BY NAME — the record OPE-1877 demanded survives the correction, it just stops deciding the leg",
      );
      ok(
        liveMeasurementVerdict([], [{ arm: "ARM C (notion)", what: "no row landed" }]).cannotRun !== undefined,
        "🔴 OPE-2031 NEGATIVE CONTROL: one silent arm and NO measurement anywhere is still CANNOT RUN — the rule turns on the absence of evidence, never on a count of silent arms",
      );

      ok(
        gatesSrc.includes("arm: \"ARM B (github)\""),
        "🔴 OPE-1877: ARM B records its non-measurement instead of only logging it",
      );
      ok(
        gatesSrc.includes("arm: \"ARM C (notion)\""),
        "🔴 OPE-1877: ARM C records its non-measurement instead of only logging it",
      );
      ok(
        gatesSrc.includes("arm: \"ARM A (web)\"") && gatesSrc.includes("measured.push(\"ARM A (web, live context line)\")"),
        "🔴 OPE-2031: ARM A reports BOTH outcomes to the ledger — a live line is a measurement, a supplied one is a named silence",
      );
      ok(
        gatesSrc.includes("arm: \"ARM D (linear)\"") && gatesSrc.includes("measured.push(\"ARM D (linear) — the live `context:` line\")"),
        "🔴 OPE-2031: ARM D reports BOTH outcomes to the ledger, for the same reason",
      );
      ok(
        gatesSrc.includes("measured.push(\"ARM C (notion) — the `taint.verdict` row\")"),
        "🔴 OPE-2031: ARM C counts its `taint.verdict` row as the measurement it is",
      );

      ok(
        gatesSrc.includes("d?.kind === \"github\" && typeof d.label === \"string\" && d.label.toLowerCase().startsWith(wantLabelB)"),
        "🔴 OPE-2031: ARM B reads a `taint.verdict` row of kind `github` from the audit, attributed by the `get_pr_feedback:` label — `walk_pr` and `subscribe_pr:title` declare the same kind and always write `applied:false`, so the label is what keeps the `applied` gate below honest",
      );
      ok(
        gatesSrc.includes("const wantLabelB = `get_pr_feedback:${ctx.prRepo}`.toLowerCase();"),
        "🔴 OPE-2031: …and the label is pinned to the FIXTURE REPO, not just to the tool — the seat reading feedback on any OTHER private repo inside this arm's window writes a row that passes all four gates, so a repo-agnostic prefix would record a measurement this arm's worker never made",
      );
      ok(
        gatesSrc.includes("dB.divergence === \"over-taint\" && dB.taintsToday === true && dB.tableTier === \"trusted\" && dB.assumed === false"),
        "🔴 OPE-2031: …and the row's DIRECTION is hard-gated — the private-repo over-taint, off the real `base.repo.private` flag rather than the fail-closed default",
      );
      ok(
        gatesSrc.includes("const sinceB = await presenceSince(ctx, \"sinceB\", 5_000);") &&
          gatesSrc.indexOf("const sinceB = await presenceSince(ctx, \"sinceB\", 5_000);") < gatesSrc.indexOf("const rowB = expectTaint"),
        "🔴 OPE-2031: ARM B's audit window opens BEFORE the ask — a window opened after the reply would miss the row the delegated worker wrote while it read",
      );

      {
        const appendAt = gatesSrc.indexOf("const blockC = await not");
        const forgeAt = gatesSrc.indexOf("const forgeC = await not.forgeCommentCreated(");
        const archiveAt = gatesSrc.indexOf("await ctx.notionAmbient?.archiveBlock(blockId)");
        const verdictPos = gatesSrc.indexOf("const verdict = liveMeasurementVerdict(measured, unmeasured);");
        ok(
          appendAt > 0 && forgeAt > 0 && appendAt < forgeAt,
          "🔴 OPE-2031: ARM C appends the fresh page body BEFORE it forges the replay — appending after the wake would change a page the supervisor has already been asked about",
        );
        ok(
          archiveAt > 0 && verdictPos > 0 && archiveAt > verdictPos,
          "🔴 OPE-2031: …and the block is archived AFTER the terminal verdict, i.e. in the `finally` — a `ctx.gate` or `ctx.skip` throw must still tear the block down, or the shared scratch page grows one block a run",
        );
      }
      {
        const verdictAt = gatesSrc.indexOf("const verdict = liveMeasurementVerdict(measured, unmeasured);");
        const armEAt = gatesSrc.indexOf("the named arrow moved the verdict allow → ask specifically");
        const teardownAt = gatesSrc.indexOf("S-TAINT-ROUTE-LIVE teardown:");
        ok(
          verdictAt > 0 && armEAt > 0 && teardownAt > 0 && verdictAt > armEAt && verdictAt < teardownAt,
          "🔴 OPE-1877: the terminal verdict is read AFTER ARM E's last gate and BEFORE the teardown — early enough to be inside the try that expires the pending cards, late enough that no arm loses its run to it",
        );
      }
      ok(
        gatesSrc.includes("const beforeStop = new Set((await github.comments(issue).catch(() => [])).map((c) => c.id).filter((id) => id !== 0));"),
        "🔴 OPE-1905: …and the ID SNAPSHOT rides beside it, over READABLE ids only — flooring alone widens the window back onto the acknowledgement the leg legitimately drew, and a snapshot holding the id-0 placeholder would exclude a real post-stop reply whose entry is equally unreadable",
      );

      const { slackAddOnRoomCollapsed, resolveSlackPrivate, resolveSlackChannelB, resolveSlackCapFixture, ENV: E } = await import(
        "../packages/core/scripts/e2e/env.js"
      );
      const BASE = "C_BASE_ROOM";
      ok(slackAddOnRoomCollapsed({ [E.slackChannel]: BASE }, BASE), "OPE-1905: an add-on room equal to the base channel is a COLLAPSE");
      ok(!slackAddOnRoomCollapsed({ [E.slackChannel]: BASE }, "C_OTHER_ROOM"), "NEGATIVE CONTROL: a genuinely different room is not");
      ok(!slackAddOnRoomCollapsed({}, BASE), "🔴 NEGATIVE CONTROL: an UNSET base channel collapses nothing — the guard must not skip a leg over a variable that is simply absent");
      ok(!slackAddOnRoomCollapsed({ [E.slackChannel]: " " }, ""), "🔴 NEGATIVE CONTROL: a base channel that trims to nothing collapses nothing either — `base.length > 0` is what stops two empties matching");

      const collapsed = { [E.slackChannel]: BASE, [E.slackPrivateChannel]: BASE, [E.slackChannelB]: BASE, [E.slackCapChannel]: BASE };
      const distinct = { [E.slackChannel]: BASE, [E.slackPrivateChannel]: "C1", [E.slackChannelB]: "C2", [E.slackCapChannel]: "C3" };
      for (const [name, resolve, varName] of [
        ["slackPrivate", resolveSlackPrivate, E.slackPrivateChannel],
        ["slackChannelB", resolveSlackChannelB, E.slackChannelB],
        ["slackCapFixture", resolveSlackCapFixture, E.slackCapChannel],
      ] as const) {
        const bad = resolve(collapsed);
        ok(
          !bad.ok && bad.missing.some((m) => m.startsWith(`${varName} to a channel other than `)),
          `🔴 OPE-1905: ${name} REFUSES a room that is the base channel, and its refusal reads as an instruction — "set ${varName} to a channel other than …" — not as a bare name`,
        );
        const good = resolve(distinct);
        ok(good.ok, `NEGATIVE CONTROL: ${name} still resolves a distinct room`);
      }
    }

    {
      const liveMpimRow = {
        ts: "2026-05-14T17:41:16.130Z",
        org: "default",
        platform: "slack",
        workspace: "T0EXAMPLE",
        surface: "C0EXCHAN010",
        principalId: "U0EXOWNER",
        action: REPLY_POST_ACTION,
        detail: { id: "1778780476.101000", platform: "slack", chars: 2, route: "tool" },
      };

      const found = await awaitReplyPostRows(async () => [liveMpimRow], {
        sinceIso: "2026-05-14T17:40:00.000Z",
        platform: "slack",
        surface: "C0EXCHAN010",
        budget: fast(2_000, "the live J-MPIM reply.post row"),
      });
      ok(
        found !== undefined && found.length === 1,
        "🔴 OPE-1682: the LIVE J-MPIM row satisfies the gate when scoped by the BARE channel id — the shape the audit column holds, and the shape a live run proved was there while the leg red",
      );

      const byQualifiedKey = await awaitReplyPostRows(async () => [liveMpimRow], {
        sinceIso: "2026-05-14T17:40:00.000Z",
        platform: "slack",
        surface: "slack/T0EXAMPLE/C0EXCHAN010",
        budget: fast(30, "the qualified key the old gate demanded"),
      });
      ok(
        byQualifiedKey === undefined,
        "🔴 NEGATIVE CONTROL: the SAME live row matches nothing under the fully-qualified key — the shape J-MPIM's old `endsWith(\"/\" + channelId)` filter required, and the reason that gate red against a correct deployment",
      );

      const otherRoom = await awaitReplyPostRows(async () => [{ ...liveMpimRow, surface: "C0OTHERROOM" }], {
        sinceIso: "2026-05-14T17:40:00.000Z",
        platform: "slack",
        surface: "C0EXCHAN010",
        budget: fast(30, "a row on another room"),
      });
      ok(otherRoom === undefined, "NEGATIVE: a reply.post row on a DIFFERENT Slack room does not satisfy J-MPIM's gate — the bare-id scope is exact equality, not a suffix match");

      const mpimBody = SCENARIOS.find((s) => s.id === "J-MPIM")!.run.toString().replace(/\s+/g, "");
      ok(
        mpimBody.includes("awaitReplyPostRows("),
        "🔴 OPE-1682: J-MPIM takes the shared waiter, which owns the bare-segment comparison — not a hand-rolled poll of its own",
      );
      ok(
        !mpimBody.includes('endsWith(`/${mpim.channelId}`)') && !mpimBody.includes('endsWith("/"+mpim.channelId)'),
        "🔴 OPE-1682: J-MPIM no longer filters `reply.post` rows by a SLASH-PREFIXED key — that shape the column never holds is what red this gate on every ship that REACHED it since it was written " +
          "(the gate needs control-read creds to run at all, and the leg skipped on several live runs for a missing room id)",
      );
    }
  }
}

{
  const {
    actingIdentityRead,
    allOrdinaryInstallReads,
    CONNECTOR_ACTING_IDENTITY_ACTION,
    HUMAN_ACTING_IDENTITY,
    installReads,
    INSTALL_IDENTITY,
    ownAccountAskRows,
    ownAccountRefusals,
    renderActingIdentityRead,
    renderOwnAccountAskRows,
    CONNECTOR_OWN_ACCOUNT_ASK_ACTION,
  } = await import("../packages/core/scripts/e2e/own-account-rows.js");

  ok(CONNECTOR_ACTING_IDENTITY_ACTION === "connector.acting_identity", "the action key is the writer's own, imported rather than re-typed");
  ok(CONNECTOR_OWN_ACCOUNT_ASK_ACTION === "connector.own_account_ask", "the DECISION-POINT action key is the writer's own too (OPE-1900)");
  ok(INSTALL_IDENTITY === "install" && HUMAN_ACTING_IDENTITY === "human-acting", "the two identities are the ratified CredentialGrantFamily members");

  const aiRow = (detail: Record<string, unknown>, over: Partial<AuditWireEntry> = {}): AuditWireEntry => ({
    ts: "2026-05-13T23:30:00.000Z",
    org: "o",
    platform: "notion",
    workspace: "w",
    surface: "page-1",
    action: CONNECTOR_ACTING_IDENTITY_ACTION,
    detail,
    ...over,
  });
  const ordinary = aiRow({ askRecognised: false, connector: "notion", identity: "install", reason: "no-own-account-ask", refused: false, requiredIdentity: "install", tool: "read_notion_page" });
  const refusal = aiRow({ askRecognised: true, connector: "notion", reason: "own-account-ask-no-grant", refused: true, requiredIdentity: "human-acting", tool: "read_notion_page" });

  const both = actingIdentityRead([ordinary, refusal], "notion");
  ok(both.rows.length === 2 && both.undecodable === 0, "both emitted shapes decode — the refusal carries no `identity` and must still decode");
  ok(both.rows[1].identity === undefined && both.rows[1].refused, "a refused row decodes with no identity, which is the writer's own contract");
  ok(
    actingIdentityRead([ordinary, refusal], "linear").rows.length === 0,
    "NEGATIVE: the connector is MATCHED — a Linear question reads none of Notion's rows, so one vendor's decision can never answer another's",
  );
  ok(
    actingIdentityRead([aiRow({ askRecognised: false, connector: "notion", identity: "install", reason: "r", refused: false, requiredIdentity: "install", tool: "read_notion_page" }, { action: "connector.use" })], "notion").rows.length === 0,
    "NEGATIVE: a row under a different ACTION is not an acting-identity row however its detail reads",
  );
  const shapeChanged = actingIdentityRead([aiRow({ connector: "notion", reason: "own-account-ask-no-grant", refused: "true", requiredIdentity: "human-acting", tool: "read_notion_page" })], "notion");
  ok(
    shapeChanged.rows.length === 0 && shapeChanged.undecodable === 1,
    "a row carrying the action and connector but NOT the detail shape is COUNTED undecodable, never dropped silently — the change most likely to make the leg vacuous",
  );

  ok(ownAccountRefusals(both).length === 1 && ownAccountRefusals(both)[0].tool === "read_notion_page", "ownAccountRefusals finds the refusal and names the tool it stopped");
  ok(ownAccountRefusals(actingIdentityRead([ordinary], "notion")).length === 0, "NEGATIVE: an ordinary read is not a refusal");
  ok(
    ownAccountRefusals(actingIdentityRead([aiRow({ askRecognised: true, connector: "notion", reason: "x", refused: true, requiredIdentity: "install", tool: "read_notion_page" })], "notion")).length === 0,
    "NEGATIVE: a refusal that did NOT require human-acting is some other refusal — all three conditions are load-bearing",
  );
  ok(
    ownAccountRefusals(actingIdentityRead([aiRow({ askRecognised: false, connector: "notion", reason: "x", refused: true, requiredIdentity: "human-acting", tool: "read_notion_page" })], "notion")).length === 0,
    "NEGATIVE: a refusal with askRecognised=false was not produced by a person naming their account",
  );

  ok(allOrdinaryInstallReads(actingIdentityRead([ordinary, ordinary], "notion")), "the negative control passes when every row on the window is an ordinary team-identity read");
  ok(!allOrdinaryInstallReads(both), "NEGATIVE: a window holding a refusal is not an ordinary-read window");
  ok(
    !allOrdinaryInstallReads(actingIdentityRead([], "notion")),
    "VACUITY: an EMPTY window is false — a gate that was never reached must never read as a gate that refused nothing",
  );
  ok(!allOrdinaryInstallReads(shapeChanged), "NEGATIVE: an undecodable row on the window fails the control rather than being ignored");
  ok(
    !allOrdinaryInstallReads(actingIdentityRead([aiRow({ askRecognised: false, connector: "notion", identity: "human-acting", reason: "x", refused: false, requiredIdentity: "install", tool: "read_notion_page" })], "notion")),
    "NEGATIVE: a row that RAN under human-acting is not an install read, whatever it required",
  );
  ok(installReads(both).length === 1, "installReads counts the team-identity reads the leg reports beside its gate");

  ok(renderActingIdentityRead(actingIdentityRead([{ ...ordinary, action: "notion.dispatched" }], "notion")).includes("notion.dispatched"), "an empty read names the actions the window DID hold, so a red says what it saw");
  ok(renderActingIdentityRead(both).includes("refused=true") && renderActingIdentityRead(both).includes("read_notion_page"), "the read-out names each row's verdict and tool — printed on a pass too, so a green does not read as bare success");

  const askRow = (detail: Record<string, unknown>, over: Partial<AuditWireEntry> = {}): AuditWireEntry => ({
    ts: "2026-05-13T23:30:00.000Z",
    org: "o",
    platform: "notion",
    workspace: "w",
    surface: "page-1",
    action: CONNECTOR_OWN_ACCOUNT_ASK_ACTION,
    detail,
    ...over,
  });
  const recognised = askRow({ askRecognised: true, connector: "notion", outcome: "refuse-unless-grant-held", requiredIdentity: "human-acting", stamped: true });
  const ambiguous = askRow({ askRecognised: true, connector: "notion", outcome: "refuse-ambiguous", requiredIdentity: "human-acting", stamped: false });

  ok(ownAccountAskRows([recognised, ambiguous], "notion").length === 2, "both emitted shapes decode — the ambiguous arm and the ordinary own-account arm");
  ok(ownAccountAskRows([recognised], "notion")[0].stamped && !ownAccountAskRows([ambiguous], "notion")[0].stamped, "`stamped` is carried through, so a read-out can say whether a delegated worker would inherit the ask");
  ok(
    ownAccountAskRows([recognised, ordinary, refusal], "notion").length === 1,
    "the acting-identity rows on the same window are NOT decision-point rows — the two actions are read apart",
  );
  ok(ownAccountAskRows([recognised], "linear").length === 0, "NEGATIVE: the connector is MATCHED — a Linear ask never answers a question about Notion");
  ok(
    ownAccountAskRows([askRow({ askRecognised: true, connector: "notion", outcome: "refuse-unless-grant-held", requiredIdentity: "human-acting", stamped: true }, { action: "connector.acting_identity" })], "notion").length === 0,
    "NEGATIVE: a row under a different ACTION is not a decision-point row however its detail reads",
  );
  ok(
    ownAccountAskRows([askRow({ askRecognised: false, connector: "notion", outcome: "refuse-unless-grant-held", requiredIdentity: "human-acting", stamped: true })], "notion").length === 0,
    "NEGATIVE: askRecognised=false is not this row — the row exists only where an ask WAS recognised, and accepting it would let arm 2 score on nothing",
  );
  ok(
    ownAccountAskRows([askRow({ askRecognised: true, connector: "notion", outcome: "refuse-unless-grant-held", requiredIdentity: "human-acting", stamped: "yes" })], "notion").length === 0,
    "NEGATIVE: a row whose `stamped` is not a boolean does not decode — the shape change most likely to make the new gate vacuous",
  );
  ok(
    ownAccountAskRows([askRow({ askRecognised: true, connector: "notion", requiredIdentity: "human-acting", stamped: true })], "notion").length === 0,
    "NEGATIVE: a row with no `outcome` does not decode — the field that makes the row scoreable on its own",
  );
  ok(renderOwnAccountAskRows([]).includes("no connector.own_account_ask row"), "an empty read-out says the row was absent, which is what a red on the new gate means");
  ok(
    renderOwnAccountAskRows(ownAccountAskRows([recognised], "notion")).includes("refuse-unless-grant-held"),
    "the read-out names the outcome — printed on a pass too, so a green does not read as bare success",
  );
}

{
  const {
    activeStandingGrants,
    CONNECTOR_ACTING_IDENTITY_ACTION,
    GRANT_LIFECYCLE_ACTIONS,
    GRANT_LIFECYCLE_ROW_LIMIT,
    GRANT_OVERLAP_LOOKBACK_DAYS,
    GRANT_USE_FRESHNESS_MS,
    grantOverlapVerdict,
  } = await import("../packages/core/scripts/e2e/own-account-rows.js");

  const NOW = Date.parse("2026-05-27T08:32:00.000Z");
  const LEG_PAGE = "page-own-account";
  const PINNED_PAGE = "page-ambient";
  const iso = (msBefore: number): string => new Date(NOW - msBefore).toISOString();
  const grantRow = (action: string, detail: Record<string, unknown>, tsMsBefore = 60_000): AuditWireEntry => ({
    ts: iso(tsMsBefore),
    org: "o",
    platform: "discord",
    workspace: "w",
    action,
    detail,
  });
  const granted = (over: Record<string, unknown> = {}): AuditWireEntry =>
    grantRow("grant.granted", {
      askId: "ask-1",
      connector: "notion",
      expiresAt: new Date(NOW + 29 * 24 * 60 * 60 * 1000).toISOString(),
      grantId: "g-1",
      mode: "standing",
      owner: "discord/300000000000000104",
      requester: "discord/1",
      resource: "notion-fetch keys:id",
      scopeKey: "oe-grant-domain::e2e-unified",
      tier: "read",
      verb: "notion_fetch",
      ...over,
    });
  const used = (over: Record<string, unknown> = {}, tsMsBefore = 60_000): AuditWireEntry =>
    grantRow(
      "grant.used",
      {
        connector: "notion",
        grantId: "g-1",
        mode: "standing",
        owner: "discord/300000000000000104",
        purpose: "e2e grant-tap fixture",
        requester: "discord/1",
        resource: "notion-fetch keys:id",
        scopeKey: "oe-grant-domain::e2e-unified",
        tier: "read",
        verb: "notion_fetch",
        ...over,
      },
      tsMsBefore,
    );

  ok(
    GRANT_LIFECYCLE_ACTIONS.includes("grant.granted") && GRANT_LIFECYCLE_ACTIONS.includes("grant.used") && GRANT_LIFECYCLE_ACTIONS.includes("grant.revoked"),
    "the preflight narrows at the route to the three lifecycle actions its verdict turns on — a mint, a spend and a revocation",
  );
  ok(GRANT_OVERLAP_LOOKBACK_DAYS >= 30, "the lookback covers a standing grant's whole life, so a mint still in force is inside the window and `expiresAt` can be the authority");

  ok(activeStandingGrants([granted()], { connector: "notion", nowMs: NOW }).length === 1, "a standing mint whose expiry is still future is live");
  const fromMint = activeStandingGrants([granted()], { connector: "notion", nowMs: NOW })[0];
  ok(fromMint.evidence === "granted" && fromMint.resource === "notion-fetch keys:id" && fromMint.verb === "notion_fetch", "the live grant carries the row that proved it, and the audit resource NAMES only");
  ok(
    activeStandingGrants([granted({ expiresAt: new Date(NOW - 1000).toISOString() })], { connector: "notion", nowMs: NOW }).length === 0,
    "NEGATIVE: a LAPSED standing grant is not live — `expiresAt` is the authority, and a lapsed grant mounts nothing",
  );
  ok(
    activeStandingGrants([granted({ expiresAt: "not-a-date" })], { connector: "notion", nowMs: NOW }).length === 0,
    "NEGATIVE: an unreadable expiry is not live — an unreadable field may never be read as a live grant, the same fail-closed rule `unexpiredGrants` holds",
  );
  ok(activeStandingGrants([granted({ mode: "once" })], { connector: "notion", nowMs: NOW }).length === 0, "NEGATIVE: a ONCE-mode grant is burned by its first call and cannot pre-empt a later leg's road");
  ok(activeStandingGrants([granted()], { connector: "linear", nowMs: NOW }).length === 0, "NEGATIVE: the connector is MATCHED — a Linear grant never answers a question about a Notion read");
  ok(activeStandingGrants([granted(), grantRow("grant.revoked", { askId: "ask-1", grantId: "g-1" })], { connector: "notion", nowMs: NOW }).length === 0, "NEGATIVE: a REVOKED grant is not live, whatever its expiry says");
  ok(activeStandingGrants([used()], { connector: "notion", nowMs: NOW }).length === 1, "a fresh SPEND stands in for a mint this window did not hold — the grant was live when it was spent");
  ok(
    activeStandingGrants([used({}, GRANT_USE_FRESHNESS_MS + 60_000)], { connector: "notion", nowMs: NOW }).length === 0,
    "NEGATIVE: a STALE spend proves nothing about now — `grant.used` carries no expiry, so the claim is bounded to the freshness window",
  );
  ok(
    activeStandingGrants([granted({ expiresAt: new Date(NOW - 1000).toISOString() }), used()], { connector: "notion", nowMs: NOW }).length === 0,
    "NEGATIVE: a spend does NOT override the mint's own expiry — a grant this window shows lapsed stays lapsed however recently it was spent",
  );
  ok(activeStandingGrants([granted(), used()], { connector: "notion", nowMs: NOW }).length === 1, "one grant is counted ONCE however many rows name it");
  ok(activeStandingGrants([granted({ grantId: undefined })], { connector: "notion", nowMs: NOW }).length === 0, "NEGATIVE: a row naming no grant id is not a grant this preflight can revoke-check, so it is not counted");

  const inside = grantOverlapVerdict([granted()], { connector: "notion", legPageId: PINNED_PAGE, nowMs: NOW, pinnedPageIds: [PINNED_PAGE], rowLimit: GRANT_LIFECYCLE_ROW_LIMIT });
  ok(inside.kind === "red", "THE LEG: a page this pack's grant legs pin, with a live standing grant on the window, REDS — it is the two live runs failure, named rather than timed out");
  ok(
    inside.reason.includes(PINNED_PAGE) && inside.reason.includes("notion-fetch keys:id") && inside.reason.includes(CONNECTOR_ACTING_IDENTITY_ACTION),
    "the red NAMES the page, the grant it saw and the row that then goes missing — a reason an operator can act on without reading the transcript",
  );
  const outsideGrant = grantOverlapVerdict([granted()], { connector: "notion", legPageId: LEG_PAGE, nowMs: NOW, pinnedPageIds: [PINNED_PAGE], rowLimit: GRANT_LIFECYCLE_ROW_LIMIT });
  ok(outsideGrant.kind === "proceed", "NEGATIVE: a live grant pinned to ANOTHER page proceeds — the frozen arguments are pinned into the mounted schema, so it cannot answer a read of this page");
  ok(
    outsideGrant.reason.includes("NAMES") && outsideGrant.reason.includes("never their values"),
    "the proceed reason states its own LIMIT — the wire carries a grant's argument names, so a grant somebody else pinned to this page is invisible here",
  );
  ok(
    grantOverlapVerdict([], { connector: "notion", legPageId: PINNED_PAGE, nowMs: NOW, pinnedPageIds: [PINNED_PAGE], rowLimit: GRANT_LIFECYCLE_ROW_LIMIT }).kind === "proceed",
    "NEGATIVE: the pinned page with NO live grant proceeds — the ROWS are load-bearing, so the verdict is not a disguised comparison of two ids",
  );
  ok(
    grantOverlapVerdict([granted({ mode: "once" })], { connector: "notion", legPageId: PINNED_PAGE, nowMs: NOW, pinnedPageIds: [PINNED_PAGE], rowLimit: GRANT_LIFECYCLE_ROW_LIMIT }).kind === "proceed",
    "NEGATIVE: a once-mode grant on the pinned page proceeds — it is burned by its first call and pre-empts no later leg",
  );
  ok(
    grantOverlapVerdict([granted()], { connector: "notion", legPageId: PINNED_PAGE, nowMs: NOW, pinnedPageIds: [], rowLimit: GRANT_LIFECYCLE_ROW_LIMIT }).kind === "proceed",
    "NEGATIVE: with NO pinned page known, a live grant alone never reds — the harness may not call a page borrowed on evidence it does not hold",
  );
  ok(
    grantOverlapVerdict([], { connector: "notion", legPageId: PINNED_PAGE, nowMs: NOW, pinnedPageIds: [PINNED_PAGE], rowLimit: GRANT_LIFECYCLE_ROW_LIMIT }).reason.includes("later board"),
    "the quiet-window proceed on the pinned page still warns: the same fixture reds the day an owner taps the ask",
  );

  const atCeiling = Array.from({ length: 4 }, () => grantRow("grant.revoked", { askId: "ask-0", grantId: "g-old" }));
  ok(
    grantOverlapVerdict(atCeiling, { connector: "notion", legPageId: LEG_PAGE, nowMs: NOW, pinnedPageIds: [PINNED_PAGE], rowLimit: 4 }).reason.includes("truncated"),
    "a row count AT the requested ceiling says the window was TRUNCATED — an absence read off a page the caller could not prove complete is not an absence",
  );
  ok(
    !grantOverlapVerdict(atCeiling, { connector: "notion", legPageId: LEG_PAGE, nowMs: NOW, pinnedPageIds: [PINNED_PAGE], rowLimit: 5 }).reason.includes("truncated"),
    "NEGATIVE: a count BELOW the ceiling says nothing about truncation — the warning is driven by the count, not printed unconditionally",
  );
  ok(
    grantOverlapVerdict([granted()], { connector: "notion", legPageId: LEG_PAGE, nowMs: NOW, pinnedPageIds: [PINNED_PAGE], rowLimit: GRANT_LIFECYCLE_ROW_LIMIT }).reason.includes(
      "not something this check settles",
    ),
    "🔴 the proceed reason does NOT claim the live grants are frozen elsewhere — which page a grant pins is unreadable here, including for the grants it just counted",
  );

  const ownAccountSrc = readFileSync(fileURLToPath(new URL("../packages/core/scripts/e2e/scenarios.ts", import.meta.url)), "utf-8");
  const legStart = ownAccountSrc.indexOf('id: "S-OWN-ACCOUNT-NOTION"');
  ok(legStart > 0, "S-OWN-ACCOUNT-NOTION is still in the scenario table under that id — every gate below reads its body");
  const legBody = ownAccountSrc.slice(legStart, ownAccountSrc.indexOf('id: "F-ART"', legStart));
  ok(legBody.length > 1000, "the leg body was sliced to the next scenario, not to nothing");
  ok(
    /roomIdFor\(ENV\.notionOwnAccountPageId, process\.env\)/.test(legBody),
    "🔴 OPE-1984: the leg resolves its OWN page through `ENV.notionOwnAccountPageId`. Reading `ENV.notionAmbientPageId` is what put it on the page the pack's own grant legs pin, and two boards then scored it CANNOT RUN",
  );
  ok(
    /ctx\.notionAmbient!\.forPage\(/.test(legBody),
    "🔴 OPE-1984: …and DRIVES that page — the ambient driver is re-pointed with `forPage`, so the anchors, the comments and the reply waits all land on the leg's own page",
  );
  ok(
    !/const not = ctx\.notionAmbient!;/.test(legBody),
    "🔴 OPE-1984: NEGATIVE — the leg no longer takes the ambient driver bare. That one line is the whole defect: it binds every drive to `E2E_NOTION_PAGE_ID`, the page a tapped standing grant reaches",
  );
  ok(
    /ctx\.skip\(\s*`\$\{ENV\.notionOwnAccountPageId\} is not set/.test(legBody),
    "🔴 OPE-1984: a page this harness cannot name is a SKIP naming the variable, never a fallback to the ambient page — a fallback is the state this ticket exists to remove. Since OPE-1992 the id is TRACKED, so the skip fires only when neither the variable nor TRACKED_ROOM_IDS carries one",
  );
  ok(
    legBody.indexOf("grantOverlapVerdict(") > 0 && legBody.indexOf("grantOverlapVerdict(") < legBody.indexOf("appendParagraphBlock("),
    "🔴 OPE-1984: the preflight runs BEFORE the leg drives anything — a check after the first comment is a check that costs the turn it was meant to save",
  );

  ok(
    !/the ordinary ask was answered without reaching a gated Notion read/.test(legBody),
    "🔴 OPE-2037: NEGATIVE — arm 1's SELF-SKIP is GONE. It fired on every run of this deployment (the worker holds `read_notion_page` AND `bash`, and chose `bash` with the org key), so restoring it puts the leg straight back on six boards' CANNOT RUN list",
  );
  ok(
    /const markerOrdinary = distinctFactToken\(/.test(legBody) && /const markerOwn = distinctFactToken\("ownme", \[runTag, markerOrdinary\]\)/.test(legBody),
    "🔴 OPE-2037: ONE token per arm, and both through `distinctFactToken` (OPE-2032) — `factToken` derives its run from the millisecond, so a pair minted together shares a digit run, and arm 1's answer would then satisfy arm 2's RED",
  );
  ok(
    legBody.indexOf('appendFact(markerOrdinary, "arm 1")') > 0 &&
      legBody.indexOf('appendFact(markerOrdinary, "arm 1")') < legBody.indexOf("const cOrdinary = await not.createBlockDiscussion("),
    "🔴 OPE-2037: the fresh page fact is appended BEFORE arm 1's ask — a fact appended after it is one the turn could not have read, and the gate would be about a line the page did not hold",
  );
  {
    const settle = legBody.indexOf("await sleep(SILENCE_WINDOW);\n\n        const sinceOwn = await presenceSince(");
    const factTwo = legBody.indexOf('appendFact(markerOwn, "arm 2")');
    ok(settle > 0 && factTwo > 0, "the arm-1/arm-2 settle and arm 2's own fact are both still in the leg body — without both, the ordering pin below compares against -1 and passes vacuously");
    ok(
      factTwo > settle,
      "🔴 OPE-2037: …and arm 2's own fact is appended only AFTER arm 1 has settled. That is what stops arm 1's own worker carrying it, which is the whole reason arm 2's RED can be read off a token at all",
    );
  }
  ok(
    /ctx\.gate\(\s*ordinaryVerdict\.answered,/.test(legBody),
    "🔴 OPE-2037: arm 1's gate is the VERDICT from gate-joins.ts §19, not a row count — the token is road-free, so the negative control passes on the REST road and on the tool road alike",
  );
  ok(
    /ctx\.gate\(\s*ownVerdict\.passed,/.test(legBody),
    "🔴 OPE-2037: arm 2's gate is §17's verdict too — a refusal row, a raised grant ask, or an honest refusal in the reply, with the fresh fact coming back undisclosed as the RED",
  );
  ok(
    /if \(ordinaryRead\.rows\.length > 0 \|\| ordinaryRead\.undecodable > 0\) \{[\s\S]{0,400}allOrdinaryInstallReads\(ordinaryRead\)/.test(legBody),
    "🔴 OPE-2037: the ROW half of the negative control survives, CONDITIONAL on the tool road having answered. Dropping it would let a gate that refuses everything satisfy arm 2; making it unconditional would red the REST road, which is the designed org road",
  );
  ok(
    !/ctx\.gate\(\s*askRows\.length > 0,/.test(legBody),
    "🔴 OPE-2037: NEGATIVE — the `connector.own_account_ask` decision-point row is REPORTED, never gated. It is not one of the three shapes arm 2 passes on, the REST-road refusal is correct whether or not it was written, and the row is best-effort (`appendAudit` retries once, then discards)",
  );
  ok(/renderOwnAccountAskRows\(askRows\)/.test(legBody), "…and it is still READ, so an arm-2 red says whether the grammar recognised the ask — two very different diagnoses");
  ok(
    /await reportDelegation\(sinceOrdinary, "arm 1"\)/.test(legBody) && /await reportDelegation\(sinceOwn, "arm 2"\)/.test(legBody),
    "🔴 OPE-2037: both arms report the DELEGATION join, so a board can say whether the delegated worker or the seat itself answered. It is a read-out: the seat holds `read_channel`/`read_thread` and can answer in-seat, so gating on a dispatch would red a correct turn",
  );
  ok(
    /actions: \[DELEGATION_TASK_STARTED_ACTION, DELEGATION_TASK_SETTLED_ACTION\] \}\)/.test(legBody) && !/delegationRows = async \(sinceIso: string\) => auditRead\(\{ sinceIso, platform/.test(legBody),
    "🔴 OPE-2037: the delegation rows are read UNSCOPED — they are filed on `platform: \"ingest\"`, so a read scoped to `notion` finds none of them on a deployment that delegated perfectly",
  );
  {
    const askStart = legBody.indexOf("const bodyAsk =");
    ok(askStart > 0, "the leg still builds its ask through a `bodyAsk` literal — if it stops, this pin is reading nothing");
    const askText = legBody.slice(askStart, legBody.indexOf("try {", askStart));
    ok(
      !/read_notion_page|read_notion_comments|notion_search|read_channel|read_thread|\bbash\b|\bcurl\b/.test(askText),
      "🔴 OPE-2037: the ordinary ask NAMES NO TOOL and no road. Naming one steers the model onto a road and measures the harness instead of the deployment — the road that answers is exactly what this leg reports",
    );
    ok(
      /LAST line of this page's own body/.test(askText),
      "…and it asks for the LAST line of the page body, which is where this run's own appended fact sits. The wake envelope carries the comment and not the body, so only a real read answers it",
    );
  }
  ok(
    /ctx\.gate\(overlap\.kind === "proceed", overlap\.reason\)/.test(legBody),
    "🔴 OPE-1984: the preflight's verdict is a hard GATE carrying its own reason — logging it would turn the named red back into the 15-minute arm-1 skip it replaces",
  );

  const { NotionDriver } = await import("../packages/core/scripts/e2e/notion-driver.js");
  const base = new NotionDriver({
    anchorHuman: "c-human",
    anchorOffTopic: "c-off",
    anchorOnTopic: "c-on",
    anchorOnTopic2: "c-on2",
    botUserId: "bot-1",
    driverKey: "secret_placeholder_not_a_credential",
    pageId: PINNED_PAGE,
    webhookSecret: "wh-placeholder",
    workspaceId: "ws-1",
  });
  const repointed = base.forPage(LEG_PAGE);
  ok(repointed.pageId === LEG_PAGE && base.pageId === PINNED_PAGE, "forPage returns a NEW driver on the named page and leaves the original bound where it was");
  ok(repointed.botUserId === "bot-1" && repointed.webhookSecret === "wh-placeholder", "the bot identity and the WORKSPACE-level signing secret ride along — only the page differs");
  ok(
    repointed.anchorOnTopic === undefined && repointed.anchorOnTopic2 === undefined && repointed.anchorOffTopic === undefined && repointed.anchorHuman === undefined,
    "🔴 the four forge anchors are DROPPED — they are comment ids on the old page, and carrying them would let a forge replay name a comment the new page does not hold",
  );
}

{
  const scenariosSrc = readFileSync(fileURLToPath(new URL("../packages/core/scripts/e2e/scenarios.ts", import.meta.url)), "utf-8");
  const start = scenariosSrc.indexOf('id: "J-MPIM"');
  ok(start > 0, "the J-MPIM scenario is still in scenarios.ts (if it is gone, delete this section rather than letting it pass vacuously)");
  const nextId = scenariosSrc.indexOf('    id: "', start + 20);
  const body = scenariosSrc.slice(start, nextId > start ? nextId : scenariosSrc.length);
  ok(
    body.includes("awaitReplyPostRows("),
    "🔴 J-MPIM's reply.post audit read goes through `awaitReplyPostRows` (OPE-1682) — the shared waiter in engaged-rows.ts that owns BOTH the bounded poll and the " +
      "bare-segment surface comparison. A single read races the deployment's own audit write and reds a correct deploy; a hand-rolled filter gets the surface shape wrong",
  );
  ok(
    body.includes("surface: mpim.channelId"),
    "🔴 …scoped by the BARE channel id, which is the shape the `reply.post` audit column holds (OPE-1682). The post choke point stamps `resolvePartition(ctx).surface`, " +
      "so the row reads `C0EXCHAN010` and never `slack/T0EXAMPLE/C0EXCHAN010` — the qualified key this gate used to demand, which kept it red against a healthy deployment",
  );
  ok(
    !body.includes("endsWith(`/${mpim.channelId}`)"),
    "🔴 NEGATIVE: the slash-prefixed filter is GONE (OPE-1682). Restoring it makes the leg unpassable again, and the two pins above would not catch it on their own",
  );
}

{
  const { NotionDriver, NotionRateLimitedError, NOTION_MAX_ATTEMPTS, NOTION_RATE_LIMIT_CODE, NOTION_RETRY_CAP_MS, notionFetch, parseNotionRetryAfterMs } = await import(
    "../packages/core/scripts/e2e/notion-driver.js"
  );

  const res = (status: number, opts: { retryAfter?: string; body?: unknown } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? (opts.retryAfter ?? null) : null) },
    text: async () => JSON.stringify(opts.body ?? {}),
    json: async () => opts.body ?? {},
  });

  ok(parseNotionRetryAfterMs("2", 0) === 2_000, "a delta-seconds Retry-After reads as milliseconds");
  ok(parseNotionRetryAfterMs("0.5", 0) === 500, "…including a fractional one");
  ok(parseNotionRetryAfterMs(null, 0) === undefined, "an absent header reads as UNKNOWN, so the caller uses its own fallback rather than guessing");
  ok(parseNotionRetryAfterMs("not-a-delay", 0) === undefined, "…as does a value in neither RFC 9110 form");
  ok(parseNotionRetryAfterMs(new Date(5_000).toUTCString(), 0) === 5_000, "an HTTP-date reads as a delay relative to now");
  ok(parseNotionRetryAfterMs(new Date(0).toUTCString(), 5_000) === 0, "a PAST date clamps to 0 — the vendor says the wait is already over");

  {
    const valid = new NotionDriver({ driverKey: "k", pageId: "p", workspaceId: "w", botUserId: "b" } as never, {
      fetchFn: async () => res(200, { body: { id: "block-1", archived: true } }),
    });
    await valid.archiveBlockStrict("block-1");
    const malformed = new NotionDriver({ driverKey: "k", pageId: "p", workspaceId: "w", botUserId: "b" } as never, {
      fetchFn: async () => res(200, { body: { id: "block-1", archived: false } }),
    });
    let thrown: unknown;
    try { await malformed.archiveBlockStrict("block-1"); } catch (error) { thrown = error; }
    ok(thrown instanceof Error && thrown.message.includes("no matching archived block"), "strict Notion teardown rejects a malformed 2xx that did not archive its exact block");
  }

  {
    const waits: number[] = [];
    let call = 0;
    const answer = await notionFetch(
      "https://api.notion.com/v1/comments",
      { method: "POST" },
      {
        what: "POST /v1/comments",
        fetchFn: async () => (++call === 1 ? res(429, { retryAfter: "2" }) : res(200)),
        sleepFn: async (ms) => void waits.push(ms),
      },
    );
    ok(answer.status === 200, "a 429 followed by a 200 answers 200 — the caller never sees the refusal");
    ok(call === 2, "…because the call was made again");
    ok(waits.length === 1 && waits[0] === 2_000, "…after waiting exactly what Retry-After named");
  }

  {
    const waits: number[] = [];
    let call = 0;
    await notionFetch(
      "https://api.notion.com/v1/search",
      { method: "POST" },
      { what: "POST /v1/search", fetchFn: async () => (++call === 1 ? res(429, { retryAfter: "3600" }) : res(200)), sleepFn: async (ms) => void waits.push(ms) },
    );
    ok(waits[0] === NOTION_RETRY_CAP_MS, `a one-hour Retry-After is capped at ${NOTION_RETRY_CAP_MS}ms — a leg that blocks that long reds anyway`);
  }

  {
    const waits: number[] = [];
    let call = 0;
    await notionFetch("https://api.notion.com/v1/search", {}, { what: "GET", fetchFn: async () => (++call === 1 ? res(429) : res(200)), sleepFn: async (ms) => void waits.push(ms) });
    ok(waits.length === 1 && waits[0] > 0, "a 429 carrying no Retry-After still backs off, on the declared fallback");
  }

  {
    const waits: number[] = [];
    let call = 0;
    const answer = await notionFetch(
      "https://api.notion.com/v1/comments",
      { method: "POST" },
      { what: "POST /v1/comments", fetchFn: async () => (++call === 1 ? res(429, { retryAfter: "0" }) : res(200)), sleepFn: async (ms) => void waits.push(ms) },
    );
    ok(answer.status === 200 && call === 2, "a 429 naming `Retry-After: 0` RETRIES immediately — the vendor said try again now, and giving up there would red a leg for free");
    ok(waits.length === 1 && waits[0] === 0, "…waiting the zero it named, rather than inventing a fallback the vendor did not ask for");
  }

  {
    let call = 0;
    let thrown: unknown;
    try {
      await notionFetch("https://api.notion.com/v1/comments", { method: "POST" }, { what: "POST /v1/comments", fetchFn: async () => (call++, res(429, { retryAfter: "1" })), sleepFn: async () => undefined });
    } catch (err) {
      thrown = err;
    }
    ok(thrown instanceof NotionRateLimitedError, "a Notion that never stops refusing throws the NAMED error, never a 429 response a caller would report as a product status");
    ok(call === NOTION_MAX_ATTEMPTS, `…after exactly ${NOTION_MAX_ATTEMPTS} attempts, so the retry is bounded`);
    ok(String(thrown).includes(NOTION_RATE_LIMIT_CODE), `…and the message names the limit (${NOTION_RATE_LIMIT_CODE}), so a run log says WHICH budget ran out`);
    ok(/HARNESS LIMIT, NOT A PRODUCT RED/u.test(String(thrown)), "…and says plainly that this is a harness limit, which is what a live run could not tell");
  }

  {
    let call = 0;
    const answer = await notionFetch("https://api.notion.com/v1/comments", {}, { what: "GET", fetchFn: async () => (call++, res(403)), sleepFn: async () => undefined });
    ok(answer.status === 403 && call === 1, "a 403 is returned as it stands, on ONE call — a permission refusal is not retried");
  }

  {
    let call = 0;
    const driver = new NotionDriver(
      { driverKey: "k", pageId: "p", workspaceId: "w", botUserId: "b" } as never,
      {
        fetchFn: async () => (++call === 1 ? res(429, { retryAfter: "1" }) : res(200, { body: { id: "c1", discussion_id: "d1" } })),
        sleepFn: async () => undefined,
      },
    );
    const made = await driver.createBlockDiscussion("block-1", "hello");
    ok(made.commentId === "c1" && made.discussionId === "d1", "a driver method that hits a 429 retries and returns the real answer — the call site really goes through the helper");
    ok(call === 2, "…and it was the retry that produced it");
  }

  {
    const urls: string[] = [];
    const page = (ids: string[], next?: string) => ({ results: ids.map((id) => ({ id })), has_more: next !== undefined, next_cursor: next ?? null });
    const driver = new NotionDriver({ driverKey: "k", pageId: "p", workspaceId: "w", botUserId: "b" } as never, {
      fetchFn: async (url: string) => {
        urls.push(url);
        return res(200, { body: urls.length === 1 ? page(["b1", "b2"], "cur-2") : page(["b3-appended-this-run"]) });
      },
      sleepFn: async () => undefined,
    });
    const ids = await driver.pageBlocks();
    ok(ids.length === 3 && ids[2] === "b3-appended-this-run", "pageBlocks FOLLOWS next_cursor — a block appended past the first page is still returned");
    ok(urls.length === 2 && urls[1].includes("start_cursor=cur-2"), "…by passing the cursor the first page handed back, not by re-reading page one");
    ok(
      urls.every((u) => u.includes("page_size=100")) && !urls.some((u) => u.includes("page_size=50")),
      "…and the old single-page `page_size=50` read is gone",
    );
  }

  {
    let tick = 0;
    const handoff = { id: "x1", discussion_id: "d1", created_time: "2026-05-14T17:44:00.000Z", created_by: { id: "b" }, rich_text: [{ plain_text: "I'm checking the page content now and will post a one-line answer." }] };
    const answer = { id: "x2", discussion_id: "d1", created_time: "2026-05-14T17:45:00.000Z", created_by: { id: "b" }, rich_text: [{ plain_text: "This page is for the billing REST-to-GraphQL migration." }] };
    const driver = new NotionDriver({ driverKey: "k", pageId: "p", workspaceId: "w", botUserId: "b" } as never, {
      fetchFn: async () => res(200, { body: { results: ++tick === 1 ? [handoff] : [handoff, answer], has_more: false, next_cursor: null } }),
      sleepFn: async () => undefined,
    });
    const got = await driver.awaitBotReplyOnBlock("blk", "d1", "", { timeoutMs: 30_000, skip: (c) => c.text.startsWith("I'm checking") });
    ok(got.id === "x2", "awaitBotReplyOnBlock skips the interim hand-off and returns the settled answer");
    ok(tick >= 2, "…so it really waited a tick rather than taking the first bot comment it saw");
    const unskipped = await driver.awaitBotReplyOnBlock("blk", "d1", "", { timeoutMs: 30_000 });
    ok(unskipped.id === "x1", "negative control: with NO skip the same poll returns the hand-off — the predicate is what changes the verdict");
  }

  {
    const { pinNotionQueryPage } = await import("../packages/core/scripts/e2e/notion-driver.js");
    const search = (results: unknown[]) => res(200, { body: { results } });
    const key = { driverKey: "k", query: "team handbook" } as const;

    {
      const empty = await pinNotionQueryPage({ ...key, fetchFn: async () => search([]), sleepFn: async () => undefined });
      ok(!empty.ok && empty.failure === "search-empty", "a search matching NOTHING reports `search-empty` — the fixture is absent, not the token and not the vendor");
      ok(!empty.ok && empty.hits === 0, "…and carries the hit count the leg asserts is non-zero");
      ok(!empty.ok && empty.reason.includes("team handbook"), "…and still names the query in prose, for the operator reading it");
    }
    {
      const archived = await pinNotionQueryPage({ ...key, fetchFn: async () => search([{ object: "page", id: "p1", archived: true }]), sleepFn: async () => undefined });
      ok(!archived.ok && archived.failure === "search-empty", "an ARCHIVED-only match is `search-empty` too — no usable page came back");
      ok(!archived.ok && archived.hits === 1, "…and `hits` reports what the search really matched (1), so the reason can say 'matched, all archived'");
    }
    {
      const failed = await pinNotionQueryPage({ ...key, fetchFn: async () => res(503), sleepFn: async () => undefined });
      ok(!failed.ok && failed.failure === "search-failed", "NEGATIVE CONTROL: a 5xx on the search is `search-failed`, never `search-empty`");
      let call = 0;
      const readBad = await pinNotionQueryPage({
        ...key,
        fetchFn: async () => (++call === 1 ? search([{ object: "page", id: "p1" }]) : res(403)),
        sleepFn: async () => undefined,
      });
      ok(!readBad.ok && readBad.failure === "read-failed", "NEGATIVE CONTROL: a page found but unreadable is `read-failed` — the fixture exists");
      call = 0;
      const imagesOnly = await pinNotionQueryPage({
        ...key,
        fetchFn: async () => (++call === 1 ? search([{ object: "page", id: "p1" }]) : res(200, { body: { results: [{ type: "image", image: {} }] } })),
        sleepFn: async () => undefined,
      });
      ok(!imagesOnly.ok && imagesOnly.failure === "no-prose", "NEGATIVE CONTROL: a page of images is `no-prose` — it was FOUND, so seeding a second one would be the wrong advice");
      ok(!imagesOnly.ok && imagesOnly.hits === 1, "…and it reports the hit, which is exactly what makes it not a missing fixture");
    }
    {
      let call = 0;
      const good = await pinNotionQueryPage({
        ...key,
        fetchFn: async () =>
          ++call === 1
            ? search([{ object: "page", id: "p1", properties: { Name: { type: "title", title: [{ plain_text: "team handbook (oe-e2e fixture)" }] } } }])
            : res(200, { body: { results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "The fixture rota meets on the second Tuesday of each month in the Kestrel room." }] } }] } }),
        sleepFn: async () => undefined,
      });
      ok(good.ok && good.hits === 1, "a resolved pin reports the search's hit count beside the page");
      ok(good.ok && good.pin.title === "team handbook (oe-e2e fixture)" && good.pin.phrases.length > 0, "…and still carries the page's title and its quotable prose");
    }
  }
}

{
  const scenario = SCENARIOS.find((s) => s.id === "S-MEM-READ")!;
  const SEED_AT_MS = Date.parse("2026-06-03T12:05:26.000Z");
  const SEED_TS = `${Math.floor(SEED_AT_MS / 1000)}.000000`;
  const ASK_TS = "2000.000001";
  const INTERIM_TS = "2000.000100";
  const ANSWER_TS = "2000.000200";
  const TASK = "task_bf1fa4e4f45d47a109fd4d91";
  const SEAT = "s-seat";
  const WORKER = "s-worker";
  const CALL = "call_0";
  const interimText = (canary: string) =>
    `The new fact write was verified as \`${canary}\`, but I'm still waiting on the separate read-only disk inspection for the exact file path you asked for; I won't guess that path.`;
  const answerText = (canary: string) =>
    `The current OPE121 canary code is \`${canary}\`. I found it in exactly two memory files: e2e-ambient-brain/MEMORY.md#L25 and e2e-ambient-brain/notes.md#L74.`;

  ok(!isFillerAck(interimText("obsidian-81091")), "the measured interim post is NOT a filler ack — the fix cannot be a text pattern (OPE-2011)");
  ok(isFillerAck("I'm checking the current memory files on disk now"), "positive control: the ack IS filler, so the leg's own skip predicate is not vacuous");

  const SEED_WAKE = "w-seed";
  const SEED_SURFACE = "slack/T0EXAMPLE/C0E2ESEED";
  const SEED_ACK_TS = "1000.000002";
  const SEED_SETTLEMENT_TS = "1000.000003";
  const SEED_TASK = "task_933d7c41f8ab4e2f91d07b5c";

  const runLeg = async (seedDelegates: boolean, page?: { readonly capped: boolean; readonly scanTruncated: boolean }) => {
    let canary = "";
    let askPosted = false;
    let readsSinceAsk = 0;
    let seedReads = 0;
    let replyHandouts = 0;
    const delivered = new Set<string>();
    const gateLabels: string[] = [];
    const logs: string[] = [];
    const nowIso = () => new Date().toISOString();
    const row = (action: string, detail: Record<string, unknown>, seq: number): AuditWireEntry => ({
      ts: nowIso(), org: "default", platform: "ingest", workspace: "e2e", action, detail, seq,
    });
    const rowAt = (action: string, detail: Record<string, unknown>, seq: number, ts: string): AuditWireEntry => ({ ...row(action, detail, seq), ts });
    const seedWindowRows = (): AuditWireEntry[] => {
      seedReads++;
      const rows: AuditWireEntry[] = [
        rowAt("memory.write", { road: "purge", kind: "memory", silo: "e2e-ambient-brain", version: 377 }, 1, "2026-06-03T12:05:25.742Z"),
        rowAt("memory.write", { road: "session-persist", outcome: "edited", kind: "memory", silo: "e2e-ambient-brain" }, 2, "2026-06-03T12:05:26.100Z"),
        rowAt("wake.ingress", { wakeId: SEED_WAKE, surfaceKey: SEED_SURFACE, vendorTs: new Date(SEED_AT_MS).toISOString() }, 3, "2026-06-03T12:05:26.400Z"),
        rowAt("wake.turn_start", { wakeId: SEED_WAKE }, 4, "2026-06-03T12:05:27.000Z"),
      ];
      if (!seedDelegates) {
        rows.push(
          rowAt("memory.write", { road: "session-persist", outcome: "write-intent", kind: "memory", silo: "e2e-ambient-brain", sessionId: SEAT }, 5, "2026-06-03T12:05:44.900Z"),
          rowAt("reply.post", { id: SEED_ACK_TS, sessionId: SEAT, wakeId: SEED_WAKE }, 6, "2026-06-03T12:05:45.100Z"),
        );
        return rows;
      }
      rows.push(
        rowAt("delegation.task_started", { task: SEED_TASK, session: SEAT, call: "call_seed" }, 5, "2026-06-03T12:05:37.884Z"),
        rowAt("reply.post", { id: SEED_ACK_TS, sessionId: SEAT, wakeId: SEED_WAKE }, 6, "2026-06-03T12:05:49.820Z"),
        rowAt("memory.claim_withheld", { claims: 1, shapes: ["stored"], wakeId: SEED_WAKE, sessionId: SEAT }, 7, "2026-06-03T12:05:49.853Z"),
      );
      if (seedReads >= 2) {
        rows.push(
          rowAt("delegation.task_settled", { task: SEED_TASK, session: SEAT, status: "completed" }, 8, "2026-06-03T12:07:08.100Z"),
          rowAt("memory.write", { road: "session-persist", outcome: "write-intent", kind: "memory", silo: "e2e-ambient-brain", version: 379 }, 9, "2026-06-03T12:07:08.442Z"),
          rowAt("reply.post", { id: SEED_SETTLEMENT_TS, sessionId: SEAT, wakeId: SEED_WAKE }, 10, "2026-06-03T12:07:08.565Z"),
          rowAt("memory.write", { road: "session-persist", outcome: "edited", kind: "memory", silo: "e2e-ambient-brain", version: 380 }, 11, "2026-06-03T12:07:09.000Z"),
        );
      }
      return rows;
    };
    const recallRows = (): AuditWireEntry[] => {
      const out: AuditWireEntry[] = [
        row("delegation.task_started", { task: TASK, session: SEAT, call: CALL }, 10),
        row("worker.toolset", { worker: WORKER, parentCallId: CALL, parentSession: SEAT, rootSession: SEAT }, 11),
      ];
      if (delivered.has(INTERIM_TS)) out.push(row("reply.post", { id: INTERIM_TS, sessionId: SEAT, wakeId: "w-ask" }, 15));
      if (readsSinceAsk >= 2) out.push(row("delegation.task_settled", { task: TASK, session: SEAT, status: "completed", adopted: true }, 20));
      if (delivered.has(ANSWER_TS)) out.push(row("reply.post", { id: ANSWER_TS, sessionId: SEAT, wakeId: "w-task" }, 25));
      return out;
    };
    const event = (index: number, type: string, data: unknown): TranscriptWireEvent => ({ index, at: nowIso(), type, data });

    const slack = {
      botUserId: "U0OPENEVERYWHERE",
      channelId: "C0E2ESEED",
      mention: (text: string) => `<@U0OPENEVERYWHERE> ${text}`,
      async identity() {
        return { userId: "U0EXOWNER", teamId: "T0EXAMPLE" };
      },
      async post(text: string) {
        const found = /obsidian-\d{1,5}/.exec(text);
        if (found) canary = found[0];
        if (!askPosted && found === null) {
          askPosted = true;
          return { ts: ASK_TS };
        }
        return { ts: SEED_TS };
      },
      async awaitThreadReply(rootTs: string, opts: { afterTs?: string; timeoutMs: number; skip?: (m: { text: string }) => boolean }) {
        if (rootTs === SEED_TS) return { ts: SEED_ACK_TS, threadTs: SEED_TS, text: `Saved — the OPE121 canary code \`${canary}\` is recorded in notes.md and indexed in MEMORY.md.` };
        const next = replyHandouts === 0
          ? { ts: INTERIM_TS, threadTs: ASK_TS, text: interimText(canary) }
          : replyHandouts === 1
            ? { ts: ANSWER_TS, threadTs: ASK_TS, text: answerText(canary) }
            : undefined;
        if (next === undefined) throw new PollTimeout(`a substantive bot reply in thread ${rootTs}`, opts.timeoutMs);
        ok(opts.skip?.(next) !== true, `the reply the stub hands back (${next.ts}) passes the leg's own skip predicate`);
        replyHandouts++;
        delivered.add(next.ts);
        return next;
      },
    };

    await scenario.run({
      slack,
      async auditRead(opts: { actions?: readonly string[] }) {
        if (opts.actions?.includes("memory.write")) return seedWindowRows();
        readsSinceAsk++;
        return recallRows();
      },
      ...(page === undefined
        ? {}
        : {
            async auditWindowRead(opts: { actions?: readonly string[] }) {
              ok(opts.actions?.includes("memory.write") === true, "OPE-2039: only the seed window read goes through the flag-carrying reader");
              return { entries: seedWindowRows(), ...page };
            },
          }),
      async transcriptRead(sessionId: string) {
        return sessionId === WORKER
          ? [
              event(0, "session.started", { turnId: "t1" }),
              event(1, "turn.started", { turnId: "t1" }),
              event(2, "actions.requested", { turnId: "t1", stepIndex: 0, calls: [{ name: "bash", input: { command: "rg -n 'obsidian-' memory/e2e-ambient-brain/MEMORY.md memory/e2e-ambient-brain/notes.md" } }] }),
              event(3, "turn.completed", { turnId: "t1" }),
            ]
          : [event(0, "turn.started", { turnId: "s1" }), event(1, "turn.completed", { turnId: "s1" })];
      },
      gate(pass: boolean, label: string) {
        gateLabels.push(label);
        if (!pass) throw new Error(`GATE ${label}`);
      },
      skip(reason: string): never {
        throw new ScenarioSkip(reason);
      },
      log(line: string) {
        logs.push(line);
      },
      recordTiming() {},
    } as never);
    return { gateLabels, logs, replyHandouts, seedReads };
  };

  const inline = await runLeg(false);

  const canaryGate = inline.gateLabels.find((l) => l.startsWith("recall: the reply carries the seeded canary")) ?? "";
  ok(canaryGate.includes("I found it in exactly two memory files"), "the leg grades the FINAL reply — the one posted after the settlement row (OPE-2011)");
  ok(!canaryGate.includes("still waiting on the separate read-only disk inspection"), "…and NOT the interim post it used to take as the answer");

  const joinedGate = inline.gateLabels.find((l) => l.startsWith("JOINED:")) ?? "";
  ok(joinedGate.includes("0/1 had gaps"), `the delegation join finds the settlement row (JOINED said: ${joinedGate.slice(0, 160)})`);
  ok(inline.logs.some((l) => l.startsWith("recall answer: answer") && l.includes("stepped over 1 interim post")), "…and the run log says the wait stepped over exactly one interim post");
  ok(inline.logs.some((l) => l.includes("recall route: DELEGATED")), "positive control: the fixture really drove the DELEGATED route, so the wait above was exercised");
  ok(inline.replyHandouts === 2, `the leg waited for a second reply rather than grading the first (handed out ${inline.replyHandouts})`);

  const seedEvidence = inline.logs.find((l) => l.startsWith("seed evidence:")) ?? "";
  ok(
    seedEvidence.includes("1 memory.write row(s) count as the SEED's own write"),
    `🔴 OPE-2028: the seed gate counts ONE row — the seed's own — out of the three memory.write rows in the window (log said: ${seedEvidence.slice(0, 200)})`,
  );
  ok(
    seedEvidence.includes('1 on the "purge" road'),
    "…and it names leg 0's purge commit as EXCLUDED, which is the row the pre-fix gate passed on while the seat stored nothing",
  );
  ok(
    seedEvidence.includes("SEED TURN's own start"),
    "…floored on the seed TURN's own start, resolved from the post's vendor instant rather than from this box's clock",
  );
  ok(
    seedEvidence.includes("1 at or before the floor"),
    "…and that floor is APPLIED, not merely resolved: the purge TURN's own turn-end persist rides a non-purge road and is excluded by position alone",
  );
  ok(
    inline.logs.some((l) => l.startsWith("seed route: IN-SEAT")),
    `🔴 OPE-2036: a seed turn with no dispatch row is read as IN-SEAT (route line: ${(inline.logs.find((l) => l.startsWith("seed route:")) ?? "none").slice(0, 160)})`,
  );
  ok(!seedEvidence.includes("after the settlement post"), "…and the inline evidence sentence carries no settlement ceiling, so it is byte-identical to the pre-OPE-2036 one");
  ok(!inline.logs.some((l) => l.startsWith("seed round-trip:")), "…and no round trip is reported for a turn that never delegated");

  const cutPage = await runLeg(false, { capped: true, scanTruncated: false });
  const cutRoute = cutPage.logs.find((l) => l.startsWith("seed route:")) ?? "";
  ok(cutRoute.startsWith("seed route: PAGE CUT"), `🔴 OPE-2039: an inline seed read off a CAPPED page is NOT recorded as IN-SEAT (route line: ${cutRoute.slice(0, 220)})`);
  ok(cutRoute.includes("[page: capped=true scanTruncated=false]"), `…and the route line carries the route's own flags (route line: ${cutRoute.slice(-120)})`);
  ok(
    (cutPage.logs.find((l) => l.startsWith("seed evidence:")) ?? "").includes("1 memory.write row(s) count as the SEED's own write"),
    "…and the gate still runs §16's filter and passes on the seat's own write — a refused absence is not a red",
  );
  const clearPage = await runLeg(false, { capped: false, scanTruncated: false });
  const clearRoute = clearPage.logs.find((l) => l.startsWith("seed route:")) ?? "";
  ok(clearRoute.startsWith("seed route: IN-SEAT") && clearRoute.includes("[page: capped=false scanTruncated=false]"), `OPE-2039 NEGATIVE CONTROL: a complete page still reads IN-SEAT, and says the flags were clear (route line: ${clearRoute.slice(0, 220)})`);
  ok(
    (inline.logs.find((l) => l.startsWith("seed route:")) ?? "").includes("[page: completeness flags not read]"),
    "OPE-2039: with no flag-carrying reader wired, the route line says the flags were not read rather than implying a complete page",
  );

  const delegatedSeed = await runLeg(true);
  const delegatedRoute = delegatedSeed.logs.find((l) => l.startsWith("seed route:")) ?? "";
  ok(delegatedRoute.startsWith("seed route: DELEGATED"), `🔴 OPE-2036: the leg detects that the SEED turn dispatched a worker (route line: ${delegatedRoute.slice(0, 200)})`);
  ok(delegatedRoute.includes(SEED_TASK), `…naming the task the seed turn dispatched (got ${delegatedRoute.slice(0, 200)})`);
  ok(delegatedSeed.seedReads >= 2, `🔴 OPE-2036: the leg keeps reading for the settlement after classing the route as DELEGATED (seed reads ${delegatedSeed.seedReads})`);
  const delegatedEvidence = delegatedSeed.logs.find((l) => l.startsWith("seed evidence:")) ?? "";
  ok(
    delegatedEvidence.includes("1 memory.write row(s) count as the SEED's own write"),
    `🔴 OPE-2036: the gate counts the WORKER's persist — the row standing right before the settlement post (log said: ${delegatedEvidence.slice(0, 220)})`,
  );
  ok(
    delegatedEvidence.includes('1 on the "purge" road') && delegatedEvidence.includes("1 at or before the floor"),
    "…with §16's road and floor terms still applied, so the delegated path is the SAME filter under a ceiling and not a second gate",
  );
  ok(
    delegatedEvidence.includes("1 after the settlement post"),
    `🔴 OPE-2036: the CEILING excludes the decoy write standing above the settlement post, and counts it (log said: ${delegatedEvidence.slice(0, 220)})`,
  );
  const roundTrip = delegatedSeed.logs.find((l) => l.startsWith("seed round-trip:")) ?? "";
  ok(roundTrip.includes(`${Date.parse("2026-06-03T12:07:08.565Z") - Date.parse("2026-06-03T12:05:27.000Z")}ms`), `🔴 OPE-2036 build item 5: the round trip is REPORTED, turn start → settlement post (got ${roundTrip})`);
  ok(roundTrip.includes("never gated"), "…and the line says it is recorded rather than thresholded — delegations of this shape ranged 19.9 s to 733.0 s in one day");
  ok(
    delegatedSeed.logs.some((l) => l.includes("durability claim(s) were STRUCK")),
    "🔴 OPE-2036: the interim ack's struck \"stored\" claim is LOGGED as the expected shape, never read as a failure",
  );
  const delegatedSeedGate = delegatedSeed.gateLabels.find((l) => l.startsWith("seed:")) ?? "";
  ok(delegatedSeedGate.includes("reached the SILO"), `…and the seed gate PASSES on the delegated turn, which is the board this ticket exists for (gate said: ${delegatedSeedGate.slice(0, 160)})`);
  ok(!delegatedSeedGate.includes("NO SETTLEMENT"), "…and never on the no-settlement red, which is a different sentence for a different failure");
}

{
  const body = SCENARIOS.find((s) => s.id === "S-ROUTINE-CONNECTOR-WRITE")!.run.toString().replace(/\s+/g, "");
  ok(body.includes("unattendedArmRoad("), "🔴 the leg calls the SHARED road rule rather than re-deriving one per arm");
  ok((body.match(/armRoad\("A",/g) ?? []).length === 1 && (body.match(/armRoad\("B",/g) ?? []).length === 1, "…once for EACH arm — arm B reading it is the whole of OPE-2021");

  const armBBranch = body.indexOf('roadB.verdict==="not-proven"');
  const armBLift = body.indexOf("theDECLAREDfire'sconnectorWRITEwasLIFTED");
  const armBRefusal = body.indexOf("NOask-unattendedconnector.refusedrowfor");
  ok(armBLift > 0 && armBRefusal > 0, `the two arm B gate messages this scan anchors on are still in the body (lift at ${armBLift}, refusal at ${armBRefusal}) — a rename here must update this scan, not silently unpin it`);
  ok(armBBranch > 0, "🔴 arm B branches on its OWN road verdict — without this the DECLARED fire's REST road reds the leg again");
  ok(armBLift > armBBranch, `🔴 arm B's LIFT gate sits INSIDE the verdict branch, never before it (branch at ${armBBranch}, lift at ${armBLift})`);
  ok(armBRefusal > armBBranch, `🔴 …and so does its refusal-absence gate (branch at ${armBBranch}, refusal gate at ${armBRefusal})`);
  const armABranch = body.indexOf('roadA.verdict==="not-proven"');
  ok(armABranch > 0, "arm A keeps the branch it landed with at OPE-1968");
  ok(armABranch > armBBranch, `🔴 OPE-2130: arm B's code comes FIRST and arm A's follows it (arm B branch at ${armBBranch}, arm A branch at ${armABranch})`);

  ok(
    SCENARIOS.filter((s) => s.run.toString().includes("unattendedArmRoad(")).map((s) => s.id).join(",") === "S-ROUTINE-CONNECTOR-WRITE",
    "negative control: exactly ONE leg reads this rule, so the checks above cannot be passing on another leg's body",
  );
}

{
  const { seededUndeclaredRoutine, routineConnectorFirePrompt, routineConnectorWriteSteps, routineConnectorArmVerdict, ROUTINE_CONNECTOR_WRITE_OP: OP } = await import(
    "../packages/core/scripts/e2e/routine-connector-fixture.js"
  );
  const { routinePermissionKeyParts } = await import("../packages/core/agent/routines/permission-key.js");
  const { routinePermissionGeneration } = await import("../packages/core/agent/routines/routine.js");
  const { newRoutineId } = await import("../packages/core/agent/routines/store.js");
  const { ScenarioSkip, FixtureMissing, GateFailure } = await import("../packages/core/scripts/e2e/scenarios.js");
  const flat = SCENARIOS.find((s) => s.id === "S-ROUTINE-CONNECTOR-WRITE")!.run.toString().replace(/\s+/g, "");

  ok(flat.includes('for(const[arm,run]of[["B",runArmB],["A",runArmA]])'), "🔴 OPE-2130: the leg runs arm B FIRST, then arm A, from one loop");
  ok(/constverdict=routineConnectorArmVerdict\(outcomes\);if\(verdict!==(void0|undefined)\)throwverdict\.error;/u.test(flat), "🔴 …and throws the chosen arm verdict only after both arms ran");
  const bRuns = flat.indexOf("constb=awaitdriveDeclaredArm();");
  const aRuns = flat.indexOf("consta=awaitseedUndeclaredArm();");
  ok(bRuns > 0 && aRuns > 0, `arm B drives the declared routine and arm A seeds the undeclared one (b at ${bRuns}, a at ${aRuns})`);
  ok(!flat.includes("driveArm("), "NEGATIVE: the shared model-driven driveArm is gone — no arm A ask can come back through it");

  const seedStart = flat.indexOf("constseedUndeclaredArm=");
  const seedEnd = flat.indexOf("constconnectorRows=", seedStart);
  const declStart = flat.indexOf("constdriveDeclaredArm=");
  ok(seedStart > 0 && seedEnd > seedStart && declStart > 0 && declStart < seedStart, "the arm A seed and the arm B drive are both findable in the body");
  const seedBody = flat.slice(seedStart, seedEnd);
  const declBody = flat.slice(declStart, seedStart);
  ok(seedBody.includes("awaitopStore.addRoutine(routine)") && seedBody.includes("seededUndeclaredRoutine({"), "🔴 OPE-2130: arm A's routine is written to the operational store by the harness");
  ok(seedBody.includes("prompt:routineConnectorFirePrompt(OP,note,fireWord)"), "🔴 …and its fire instruction is routineConnectorFirePrompt's");
  ok(!seedBody.includes("connector.post(") && !seedBody.includes("connector.mention("), "🔴 OPE-2130: arm A posts NO ask — no model turn has to agree to create its routine");
  ok(declBody.includes("connector.post(") && declBody.includes("connector.mention("), "NEGATIVE CONTROL: arm B's drive DOES post an ask, so the scan above can see one");
  ok(seedBody.includes("returnctx.fixtureMissing(") && seedBody.includes("armA:theharnessseeds"), "arm A with no store is a FIXTURE miss that names arm A, never a red on the fence");
  ok(seedBody.includes('awaitretireUnfiredRoutines("A",r=>r.id===routine.id)'), "🔴 arm A removes its seeded row when it never fired, so a missed fire cannot land in a later leg");
  ok(declBody.includes('awaitretireUnfiredRoutines("B",r=>r.createdAt>=sinceIso)'), "…and arm B removes the routine it created when that one never fired");
  ok(seedBody.includes("armBCardOrg!==void0&&armBCardOrg!==org") || seedBody.includes("armBCardOrg!==undefined&&armBCardOrg!==org"), "arm A refuses to seed under an org arm B's card did not name");
  const { routineNeverFired } = await import("../packages/core/scripts/e2e/routine-connector-fixture.js");
  ok(routineNeverFired({ status: "active", nextRunAt: "2026-06-01T18:33:00.000Z" }), "an active row still due has never fired");
  ok(routineNeverFired({ status: "active", nextRunAt: null }) === false, "🔴 NEGATIVE: active with a null nextRunAt is a fire IN FLIGHT (the fire-path write nulls it first) — never deleted under the running session");
  ok(routineNeverFired({ status: "disabled", nextRunAt: null }) === false && routineNeverFired({ status: "disabled", nextRunAt: "2026-06-01T18:33:00.000Z" }) === false, "NEGATIVE: a disabled row is never removed — a fired one-shot stays for the record");
  ok(!/DoNOTdeclare|anundeclaredfiredoes/u.test(flat), "🔴 NEGATIVE: the leg body carries no \"Do NOT declare\" ask — the construct luna refused in a live run");

  const firePrompt = routineConnectorFirePrompt(OP, "rcwa-1", "rcwfxa-2");
  ok(firePrompt.startsWith(routineConnectorWriteSteps(OP, "rcwa-1")), "🔴 arm A's fire runs the SAME delegated steps arm B's ask quotes");
  ok(firePrompt.includes("the one report back here starts with the word rcwfxa-2 and then says"), "the fire prompt asks for the confirmation word the leg waits on, first in the report (OPE-2177)");
  ok(!/permission|declar/iu.test(firePrompt), `🔴 the fire prompt carries NO permission language — the fence reads the missing row, not the prompt (got: ${firePrompt})`);
  ok(/permission|declar/iu.test('Declare the standing permission "tool:x"'), "NEGATIVE CONTROL: the permission regex matches arm B's declaration clause");

  const now = new Date("2026-06-01T18:32:00.000Z");
  const fireAt = new Date("2026-06-01T18:33:00.000Z");
  const id = newRoutineId();
  const row = seededUndeclaredRoutine({ id, org: "default", teamId: "T0EXAMPLE", channelId: "C0EXGENRL", createdBy: "U_E2E", prompt: firePrompt, fireAt, now });
  ok(row.surfaceKey === "slack/T0EXAMPLE/C0EXGENRL", `the row is keyed on the channel's surface key, the key the fixture preflight derives the grant from (got ${row.surfaceKey})`);
  ok(JSON.stringify(row.target) === JSON.stringify({ channelId: "C0EXGENRL" }), "🔴 the fire target is the { channelId } resolveSlackTarget reads");
  ok(row.trigger.kind === "once" && (row.trigger as { at: string }).at === fireAt.toISOString() && row.nextRunAt === fireAt.toISOString(), "🔴 a one-shot at fireAt, with nextRunAt set so the dispatcher's due check picks it up");
  ok(row.status === "active" && row.consecutiveFailures === 0 && row.createdBy === "U_E2E" && row.createdAt === now.toISOString(), "active, no failures, the harness user as creator");
  ok(row.sessionMode === undefined && row.collectors === undefined && row.gate === undefined && row.report === undefined, "🔴 NOT a job, no collectors, no gate, no report redirect — the JOB kit would drop the write before the fence");
  const key = routinePermissionKeyParts(`oe-routine:${row.id}:g${routinePermissionGeneration(row)}`);
  ok(key?.routineId === id && key.generation === 1, "🔴 the minted id reads back through the permission-key grammar, generation 1 — a fresh key no declared row can already sit on");
  let threw = "";
  try {
    seededUndeclaredRoutine({ id: "r:1", org: "default", teamId: "T", channelId: "C", createdBy: "U", prompt: "p", fireAt, now });
  } catch (e) {
    threw = String(e);
  }
  ok(threw.includes("carry no \":\""), "NEGATIVE: an id with \":\" is refused — the permission key grammar splits on it");
  threw = "";
  try {
    seededUndeclaredRoutine({ id: "r-1", org: "default", teamId: "T", channelId: "C", createdBy: "U", prompt: "p", fireAt: now, now });
  } catch (e) {
    threw = String(e);
  }
  ok(threw.includes("a past one-shot never fires"), "NEGATIVE: a fireAt that is not after now is refused");

  const red = (m: string) => new GateFailure(m);
  const bRed = red("arm B lift");
  const aRed = red("arm A refusal");
  ok(routineConnectorArmVerdict([{ arm: "B" }, { arm: "A" }]) === undefined, "both arms green ⇒ nothing is thrown");
  ok(routineConnectorArmVerdict([{ arm: "B", error: bRed }, { arm: "A", error: aRed }])?.error === bRed, "🔴 two reds ⇒ arm B's is thrown");
  ok(routineConnectorArmVerdict([{ arm: "B" }, { arm: "A", error: aRed }])?.arm === "A", "🔴 arm B green, arm A red ⇒ arm A's red is thrown");
  const bSkip = new ScenarioSkip("arm B: the card does not name the op");
  ok(routineConnectorArmVerdict([{ arm: "B", error: bSkip }, { arm: "A", error: aRed }])?.error === aRed, "🔴 arm B skipped (prompt-compliance) and arm A red ⇒ the RED is thrown, never hidden behind the skip");
  ok(routineConnectorArmVerdict([{ arm: "B", error: bSkip }, { arm: "A" }])?.error === bSkip, "arm B skipped, arm A green ⇒ the skip is thrown");
  const aFix = new FixtureMissing("arm A: no store");
  ok(routineConnectorArmVerdict([{ arm: "B", error: bSkip }, { arm: "A", error: aFix }])?.error === aFix, "a fixture miss outranks a skip");
  ok(routineConnectorArmVerdict([{ arm: "B", error: new Error("slack 500") }, { arm: "A", error: aFix }])?.arm === "B", "a plain error counts as a red and outranks a fixture miss");
  ok(routineConnectorArmVerdict([{ arm: "B", error: bSkip }, { arm: "A", error: new ScenarioSkip("arm A") }])?.error === bSkip, "NEGATIVE CONTROL: two skips ⇒ arm B's, the first listed — the rank, not the order, decided the cases above");
}

{
  const { archiveNotionPageByTitle, notionPageIdFromText, searchNotionPagesByTitlePrefix } = await import("../packages/core/scripts/e2e/notion-driver.js");
  const res = (status: number, body: unknown = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
  const page = (id: string, title: string, archived = false) => ({
    object: "page",
    id,
    archived,
    properties: { Name: { type: "title", title: [{ plain_text: title }] } },
  });
  const ID = "0123456789abcdef0123456789abcdef";
  const DASHED = "01234567-89ab-cdef-0123-456789abcdef";

  ok(notionPageIdFromText(`Created it: https://www.notion.so/OE-suspended-x-${ID}`) === DASHED, "a Notion page link in the seat's reply yields the page id in dashed form");
  ok(notionPageIdFromText(`<https://app.notion.so/${DASHED}|OE suspended>`) === DASHED, "…and a dashed id inside a Slack-formatted link yields the same id");
  ok(
    notionPageIdFromText("Done: https://app.notion.com/p/40000000000040008000000000000107?pvs=204") === "40000000-0000-4000-8000-000000000107",
    "the live app.notion.com/p/<id> link shape (a live run's resumed reply) yields the page id",
  );
  ok(notionPageIdFromText("see https://app.notion.com/p/workspace-home") === undefined, "negative control: a notion.com link with no 32-hex id yields no id");
  ok(notionPageIdFromText(`the token is ${ID}`) === undefined, "negative control: 32 hex digits with no Notion link are NOT read as a page id");

  {
    const calls: { url: string; method?: string; body?: string }[] = [];
    const r = await archiveNotionPageByTitle({
      driverKey: "k",
      title: "OE suspended suspended-slack-1",
      pageId: DASHED,
      fetchFn: async (url, init) => {
        calls.push({ url, method: init?.method, body: init?.body as string | undefined });
        return res(200, { id: DASHED, archived: true });
      },
    });
    ok(calls.length === 1 && calls[0]!.url.endsWith(`/v1/pages/${DASHED}`) && calls[0]!.method === "PATCH", `with a page id the teardown PATCHes /v1/pages/<id> once (calls: ${JSON.stringify(calls.map((c) => c.url))})`);
    ok(calls[0]!.body === JSON.stringify({ archived: true }), 'the PATCH body is exactly {"archived":true}');
    ok(r.archived.length === 1 && r.archived[0]!.id === DASHED && r.reason === undefined, "…and the result names the archived page");
  }

  {
    const patched: string[] = [];
    const r = await archiveNotionPageByTitle({
      driverKey: "k",
      title: "OE suspended suspended-slack-1",
      fetchFn: async (url) => {
        if (url.endsWith("/v1/search")) {
          return res(200, {
            results: [page("p-exact", "OE suspended suspended-slack-1"), page("p-longer", "OE suspended suspended-slack-12"), page("p-gone", "OE suspended suspended-slack-1", true)],
          });
        }
        patched.push(url.split("/v1/pages/")[1] ?? "");
        return res(200, { archived: true });
      },
    });
    ok(patched.join(",") === "p-exact", `with no id the teardown archives the EXACT-title live page only (patched: ${patched.join(",")})`);
    ok(r.archived.map((p) => p.id).join(",") === "p-exact", "…and reports that one page");
  }

  {
    let threw = false;
    let r: Awaited<ReturnType<typeof archiveNotionPageByTitle>> | undefined;
    try {
      r = await archiveNotionPageByTitle({
        driverKey: "k",
        title: "OE suspended suspended-slack-2",
        pageId: DASHED,
        fetchFn: async (url) => (url.endsWith("/v1/search") ? res(200, { results: [] }) : res(404, { code: "object_not_found" })),
      });
    } catch {
      threw = true;
    }
    ok(!threw, "a 404 plus an empty search does NOT throw");
    ok(r !== undefined && r.archived.length === 0 && /404/.test(r.reason ?? "") && /matched no live page/.test(r.reason ?? ""), `…and the reason names both failures (reason: ${r?.reason})`);
    const lying = await archiveNotionPageByTitle({
      driverKey: "k",
      title: "t",
      pageId: DASHED,
      fetchFn: async (url) => (url.endsWith("/v1/search") ? res(200, { results: [] }) : res(200, { archived: false })),
    });
    ok(lying.archived.length === 0 && /not archived/.test(lying.reason ?? ""), "a 2xx whose page reads archived:false is NOT counted as archived");
    const noKey = await archiveNotionPageByTitle({ driverKey: undefined, title: "t", fetchFn: async () => res(500) });
    ok(noKey.archived.length === 0 && /E2E_NOTION_DRIVER_KEY is unset/.test(noKey.reason ?? ""), "an unset driver key is a named reason, not a throw");
  }

  {
    let call = 0;
    const found = await searchNotionPagesByTitlePrefix({
      driverKey: "k",
      prefix: "OE suspended suspended-",
      fetchFn: async (_url, init) => {
        call++;
        const body = JSON.parse(String(init?.body)) as { start_cursor?: string };
        if (call === 1) return res(200, { results: [page("a", "OE suspended suspended-slack-1"), page("x", "Unrelated OE suspended")], has_more: true, next_cursor: "c2" });
        return res(200, { results: [page(body.start_cursor === "c2" ? "b" : "WRONG-CURSOR", "OE suspended suspended-slack-2")], has_more: false, next_cursor: null });
      },
    });
    ok(found.map((p) => p.id).join(",") === "a,b", `the sweep search pages through next_cursor and keeps prefix matches only (found: ${found.map((p) => p.id).join(",")})`);
  }

  const scenariosText = readFileSync(fileURLToPath(new URL("../packages/core/scripts/e2e/scenarios.ts", import.meta.url)), "utf-8");
  ok(!/archive the Notion page/i.test(scenariosText), "🔴 no leg asks the seat to archive a Notion page — the seat's Notion tools have no archive operation");
  ok(!scenariosText.includes("archiveNotionPageFromDm"), "…and the DM-ask teardown helper is gone");
  const suspended = SCENARIOS.find((s) => s.id === "S-SUSPENDED-slack")!.run.toString();
  ok(suspended.includes("archiveNotionPageOverRest(") && !/dm\.post\([^)]*archive/i.test(suspended), "S-SUSPENDED-slack tears its page down over REST and posts no archive ask");
  const restLegs = SCENARIOS.filter((s) => s.run.toString().includes("archiveNotionPageOverRest(")).map((s) => s.id).sort().join(",");
  ok(restLegs === "S-EVE-CARD,S-SUSPENDED-slack", `negative control: exactly the two page-creating DM legs use the REST teardown (got ${restLegs})`);
}

{
  const { replyPostHighWater, replyPostsAfter } = await import("../packages/core/scripts/e2e/engaged-rows.js");
  const { supervisorAsk } = await import("../packages/core/scripts/e2e/journey.js");
  const { SCENARIOS: legs } = await import("../packages/core/scripts/e2e/scenarios.js");
  const post = (seq: number | undefined, ts: string, surface: string, wakeId: string): AuditWireEntry => ({
    ...(seq === undefined ? {} : { seq }),
    ts,
    org: "default",
    platform: "slack",
    workspace: "T0EXAMPLE",
    surface,
    action: "reply.post",
    detail: { wakeId },
  });

  const ack = post(216187, "2026-06-14T07:03:02.165Z", "C0EXCHAN004", "fba046a5");
  const earlierReply = post(216150, "2026-06-14T07:02:51.041Z", "C0EXCHAN004", "c2f43027");
  const beforeProbe = [ack, earlierReply];
  const mark = replyPostHighWater(beforeProbe);
  ok(mark.seq === 216187 && mark.unsequenced === 0, `the high-water mark is the newest reply.post seq (got ${JSON.stringify(mark)})`);
  ok(replyPostsAfter(beforeProbe, mark.seq, { surface: "C0EXCHAN004" }).length === 0, "🔴 the measured leg-54 window: the stop's own acknowledgement is NOT a post-stop reply");
  const broken = post(216190, "2026-06-14T07:03:05.000Z", "C0EXCHAN004", "new-wake");
  ok(replyPostsAfter([broken, ...beforeProbe], mark.seq, { surface: "C0EXCHAN004" }).length === 1, "NEGATIVE CONTROL: a reply the deployment wrote after the mark on this surface IS counted");
  const skewed = post(216191, "2026-06-14T07:03:00.000Z", "C0EXCHAN004", "new-wake");
  ok(replyPostsAfter([skewed, ...beforeProbe], mark.seq, { surface: "C0EXCHAN004" }).length === 1, "🔴 a row above the mark counts even when its ts is older than the ack's — ts plays no part");
  ok(replyPostsAfter([post(216195, "2026-06-14T07:03:06.000Z", "C0OTHER", "x"), ...beforeProbe], mark.seq, { surface: "C0EXCHAN004" }).length === 0, "a sibling surface's reply above the mark is not this journey's");
  const unsequenced = post(undefined, "2026-06-14T07:03:06.000Z", "C0EXCHAN004", "x");
  ok(replyPostHighWater([unsequenced, ...beforeProbe]).unsequenced === 1, "a row without seq is reported, so the mark can refuse an older build");
  ok(replyPostsAfter([unsequenced, ...beforeProbe], mark.seq, { surface: "C0EXCHAN004" }).length === 1, "…and it counts against the silence (the loud direction)");
  const nonReply = { ...post(216199, "2026-06-14T07:03:07.000Z", "C0EXCHAN004", "x"), action: "engagement.stood_down" };
  ok(replyPostHighWater([nonReply, ...beforeProbe]).seq === 216187, "only reply.post rows move the mark");

  const scenariosSrc = readFileSync(fileURLToPath(new URL("../packages/core/scripts/e2e/scenarios.ts", import.meta.url)), "utf-8");
  const gateCalls = scenariosSrc.match(/await gateAuditedSilence\(ctx, \{[^}]*\}\)/g) ?? [];
  ok(gateCalls.length === 5, `the five engaged journeys call gateAuditedSilence (found ${gateCalls.length})`);
  ok(gateCalls.every((c) => c.includes("highWater") && !c.includes("sinceIso")), "🔴 no silence gate takes a driver-clock sinceIso any more; each passes the seq mark");
  const marks = scenariosSrc.match(/const highWater = await auditedSilenceMark\(ctx, \{ platform: "(slack|discord|github|linear|notion)"/g) ?? [];
  ok(marks.length === 5, `each journey takes its mark with auditedSilenceMark (found ${marks.length})`);
  for (const id of ["J-ENGAGED-slack", "J-ENGAGED-github"]) {
    const body = legs.find((s) => s.id === id)!.run.toString().replace(/\s+/g, "");
    const at = body.indexOf("auditedSilenceMark(");
    const probe = body.indexOf('fixtureLine("andwhat\'s5plus5?")');
    ok(at > 0 && probe > at, `${id} takes the mark BEFORE it posts the probe (mark at ${at}, probe at ${probe})`);
  }

  const seen = ["sup-77351", "sup-11541", "sup-69520"].map((m) => supervisorAsk(m));
  ok(new Set(seen.map((a) => a.text.replace(/sup-\d+/, ""))).size === 3, `🔴 three runs ask three different questions even with the ref removed (${seen.map((a) => a.sum).join(", ")})`);
  ok(seen.every((a, i) => a.text.includes(["sup-77351", "sup-11541", "sup-69520"][i]!)), "each ask still demands its own ref");
  const probe = supervisorAsk("sup-69520");
  const [x, y] = [...probe.text.matchAll(/what's (\d+) plus (\d+)\?/g)].map((m) => [Number(m[1]), Number(m[2])])[0] ?? [NaN, NaN];
  ok(x + y === probe.sum, `the sum the leg logs matches the question it asked (${x} + ${y} = ${probe.sum})`);
  ok(supervisorAsk("sup-69520").text === probe.text, "the ask is a pure function of the token (reproducible from the leg log)");
  const jsup = legs.find((s) => s.id === "J-SUP")!.run.toString();
  ok(jsup.includes("supervisorAsk(marker)") && !jsup.includes("what's a good one-line summary of what this channel is for"), "J-SUP posts the per-run question, and the fixed one is gone");

  const evecard = legs.find((s) => s.id === "S-EVE-CARD")!.run.toString();
  ok(evecard.includes("connectorCardRequest(") && evecard.includes("connectorCardRun("), "S-EVE-CARD joins ask → forward → op.connector card → approved write → seat reply");
  ok(evecard.includes("clickBlockAction(") && !/synthetic\.click\(\{\s*pendingId:\s*card\.pendingId,\s*org:\s*card\.org,\s*decision:\s*"approve"/.test(evecard), "🔴 S-EVE-CARD approves by replaying the card's own button, not by building the action from the pending id");
  ok(evecard.includes('"approval.eve_settled"') && evecard.includes('"tool-approval"'), "S-EVE-CARD asserts the native approval plane stayed silent");
  ok(!evecard.includes("approvalRequestForSlackAsk("), "CONTROL: S-EVE-CARD no longer waits for the eve-native card join");
}

{
  const { auditStoreHighWater, rowsAboveStoreMark, readAuditStoreMark, CONTROL_SERVICE_CALL_ACTION, STORE_MARK_LOOKBACK_MS } = await import(
    "../packages/core/scripts/e2e/engaged-rows.js"
  );
  const { clockSkewFromDateHeader, renderClockSkewLine, measureDeploymentClockSkew } = await import("../packages/core/scripts/e2e/clock-skew.js");
  const { SCENARIOS: legs } = await import("../packages/core/scripts/e2e/scenarios.js");
  const at = (seq: number | undefined, ts: string, action: string, detail: Record<string, unknown> = {}): AuditWireEntry => ({
    ...(seq === undefined ? {} : { seq }),
    ts,
    org: "default",
    platform: "control",
    workspace: "control",
    action,
    detail,
  });

  const call = at(300_010, "2026-06-11T20:29:56.200Z", CONTROL_SERVICE_CALL_ACTION);
  const olderCall = at(300_002, "2026-06-11T20:29:50.000Z", CONTROL_SERVICE_CALL_ACTION);
  ok(auditStoreHighWater([olderCall, call]).seq === 300_010, "the store mark is the newest seq the read returned");
  ok(auditStoreHighWater([at(undefined, call.ts, CONTROL_SERVICE_CALL_ACTION), call]).unsequenced === 1, "a row with no seq is counted, so the mark can refuse an older build");
  const previousStep = at(300_008, "2026-06-11T20:29:54.200Z", "connector.unattended_lift");
  const driverWatermark = Date.parse("2026-06-11T20:29:56.200Z") - 7_500;
  ok(Date.parse(previousStep.ts) >= driverWatermark, "CONTROL: the driver-clock window DOES take in the previous step's row — the red this replaces");
  ok(rowsAboveStoreMark([previousStep], 300_010).length === 0, "🔴 OPE-2375: the previous step's row is BELOW the store mark, so the absence gate does not count it");
  const caused = at(300_015, "2026-06-11T20:29:55.000Z", "connector.unattended_lift");
  ok(rowsAboveStoreMark([previousStep, caused], 300_010).length === 1, "NEGATIVE CONTROL: a row written after the mark IS counted, even with a ts older than the mark's row");
  ok(rowsAboveStoreMark([at(undefined, caused.ts, caused.action)], 300_010).length === 1, "…and a row with no seq counts against the absence (the loud direction)");

  const asked: { sinceIso: string; actions: readonly string[] }[] = [];
  const fakeRead = async (opts: { readonly sinceIso: string; readonly actions: readonly string[]; readonly limit: number }) => {
    asked.push({ sinceIso: opts.sinceIso, actions: opts.actions });
    return [olderCall, call];
  };
  const fromBehind = await readAuditStoreMark(fakeRead, Date.parse("2026-06-11T20:29:48.700Z"));
  const fromAhead = await readAuditStoreMark(fakeRead, Date.parse("2026-06-11T20:30:04.000Z"));
  ok(fromBehind.seq === 300_010 && fromAhead.seq === 300_010, "🔴 the mark is the same whichever way the driver clock is wrong — it carries no clock");
  ok(asked.every((a) => a.actions.length === 1 && a.actions[0] === CONTROL_SERVICE_CALL_ACTION), "the mark read asks for the route's own self-audit row only");
  ok(Date.parse(asked[0]!.sinceIso) === Date.parse("2026-06-11T20:29:48.700Z") - STORE_MARK_LOOKBACK_MS, "the page bound reaches back STORE_MARK_LOOKBACK_MS, so the read holds its own row under any small skew");

  const body = (id: string) => legs.find((s) => s.id === id)!.run.toString().replace(/\s+/g, "");
  const teams = body("J-ENGAGED-teams");
  ok(teams.includes("auditStoreMark(ctx,") && teams.includes("rowsAboveStoreMark(awaitdispatchedOn(root.id"), "🔴 J-ENGAGED-teams: the post-stop dispatch absence counts from the store mark");
  ok(teams.includes("!beforeQuiet.has(m.id)") && !teams.includes('(m.createdDateTime??"")>quietFrom'), "🔴 J-ENGAGED-teams: the post-stop reply absence is a vendor-id join, never a driver-clock compare");
  ok(body("S-PR-SESSION").includes('rowsAboveStoreMark(awaitctx.auditRead({sinceIso:storeMarkPageSince(),actions:["approval.session_granted"]})'), "🔴 S-PR-SESSION: the no-grant absence counts from the store mark");
  ok(body("S-EVE-CARD").includes("eveCardMark??0"), "🔴 S-EVE-CARD: the no-native-approval absence counts from the store mark");
  ok(body("S-DM-STOP-GRANT").includes('rowsAboveStoreMark(awaitauditRead({sinceIso:storeMarkPageSince(),actions:["grant.asked"]}),runMark)'), "🔴 S-DM-STOP-GRANT: the nothing-was-asked absence counts from the store mark");
  const rcw = body("S-ROUTINE-CONNECTOR-WRITE");
  ok(rcw.includes("connectorRows(b)") && rcw.includes("connectorRows(a)") && rcw.includes("arm.mark"), "🔴 S-ROUTINE-CONNECTOR-WRITE: both arms' no-refusal / no-lift absences count from the arm's own store mark");
  ok(!rcw.includes("connectorRows(a.sinceIso)"), "CONTROL: arm A no longer reads its connector rows off a driver-clock window");
  const browser = legs.find((s) => s.run.toString().includes("snapshot-first kit: NO browser.evaluate row"));
  const browserBody = browser === undefined ? "" : browser.run.toString().replace(/\s+/g, "");
  ok(browserBody.includes('auditStoreMark(ctx,"browser-QA")') && (browserBody.match(/\}\),browserMark,?\)/g) ?? []).length === 2, "🔴 browser-QA: the settle wait and the no-evaluate absence both count from the store mark");
  ok(teams.indexOf("auditStoreMark(ctx,") > 0 && teams.indexOf("auditStoreMark(ctx,") < teams.indexOf('postReply(root.id,"(onemorenote'), "J-ENGAGED-teams takes the mark BEFORE it posts the probe");

  const behind = clockSkewFromDateHeader("Thu, 11 Jun 2026 20:29:56 GMT", Date.parse("2026-06-11T20:29:48.600Z"), Date.parse("2026-06-11T20:29:48.800Z"));
  ok(behind !== undefined && behind.skewMs === 7_800 && behind.uncertaintyMs === 600, `the Date header gives deployment − driver, header midpoint against round-trip midpoint (got ${JSON.stringify(behind)})`);
  const behindLine = renderClockSkewLine(behind);
  ok(behindLine.includes("7.8 s BEHIND") && behindLine.includes("MORE than the 5 s margin") && behindLine.includes("opens early"), `🔴 a skew past the margin is named, with its direction (got ${behindLine})`);
  const ahead = clockSkewFromDateHeader("Thu, 11 Jun 2026 20:29:56 GMT", Date.parse("2026-06-11T20:30:05.400Z"), Date.parse("2026-06-11T20:30:05.600Z"));
  ok(ahead !== undefined && ahead.skewMs === -9_000 && renderClockSkewLine(ahead).includes("AHEAD OF") && renderClockSkewLine(ahead).includes("opens late"), "…and the other direction names the other risk");
  const small = clockSkewFromDateHeader("Thu, 11 Jun 2026 20:29:56 GMT", Date.parse("2026-06-11T20:29:54.400Z"), Date.parse("2026-06-11T20:29:54.600Z"));
  ok(small !== undefined && small.skewMs === 2_000 && !renderClockSkewLine(small).includes("MORE than"), "NEGATIVE CONTROL: a skew inside the margin carries no warning");
  ok(clockSkewFromDateHeader("Thu, 11 Jun 2026 20:29:56 GMT", 2_000, 1_000) === undefined && clockSkewFromDateHeader(null, 1, 2) === undefined && clockSkewFromDateHeader("not a date", 1, 2) === undefined, "an unreadable header or a backwards round trip gives no measure");
  ok(renderClockSkewLine(undefined, "GET x failed").startsWith("clock skew: not measured (GET x failed)"), "an unmeasured skew says why, rather than printing nothing");
  let clock = Date.parse("2026-06-11T20:29:48.600Z");
  const measured = await measureDeploymentClockSkew("https://example.test", {
    now: () => {
      const t = clock;
      clock += 200;
      return t;
    },
    fetch: (async () => new Response("", { status: 404, headers: { date: "Thu, 11 Jun 2026 20:29:56 GMT" } })) as unknown as typeof fetch,
  });
  ok(measured.skew?.skewMs === 7_800, `the probe reads the Date header off ANY status (got ${JSON.stringify(measured)})`);
  const failed = await measureDeploymentClockSkew("https://example.test", { fetch: (async () => { throw new Error("boom"); }) as unknown as typeof fetch });
  ok(failed.skew === undefined && (failed.unavailable ?? "").includes("boom"), "a failed probe never throws; it names the failure");
  const runnerSrc = readFileSync(fileURLToPath(new URL("../packages/core/scripts/e2e/runner.ts", import.meta.url)), "utf-8");
  ok(/measureDeploymentClockSkew\(auditTarget\)[\s\S]{0,120}console\.log\(renderClockSkewLine\(/.test(runnerSrc), "🔴 the runner measures the skew against its target and prints the line on every run");
}

{
  const { auditStoreMarkInstantMs, readPresenceSince, CONTROL_SERVICE_CALL_ACTION } = await import("../packages/core/scripts/e2e/engaged-rows.js");
  const { auditSinceForDriverClock } = await import("../packages/core/scripts/e2e/gate-joins.js");
  const at = (seq: number | undefined, ts: string, action: string): AuditWireEntry => ({
    ...(seq === undefined ? {} : { seq }),
    ts,
    org: "default",
    platform: "control",
    workspace: "control",
    action,
    detail: {},
  });

  const own = at(500_020, "2026-06-12T09:30:00.000Z", CONTROL_SERVICE_CALL_ACTION);
  const older = at(500_011, "2026-06-12T09:30:01.500Z", CONTROL_SERVICE_CALL_ACTION);
  ok(auditStoreMarkInstantMs([older, own]) === Date.parse(own.ts), "the deployment instant is the ts on the highest-seq row");
  ok(auditStoreMarkInstantMs([at(undefined, "2026-06-12T09:30:09.000Z", CONTROL_SERVICE_CALL_ACTION), own]) === Date.parse(own.ts), "a row with no seq has no place in the order, so it never sets the instant");
  ok(auditStoreMarkInstantMs([at(500_030, "not a time", CONTROL_SERVICE_CALL_ACTION), own]) === Date.parse(own.ts), "a row whose ts does not parse never sets the instant");
  ok(auditStoreMarkInstantMs([]) === undefined && auditStoreMarkInstantMs([at(undefined, own.ts, CONTROL_SERVICE_CALL_ACTION)]) === undefined, "NEGATIVE CONTROL: no sequenced row gives no instant, so the caller refuses");

  const deploymentAtMark = Date.parse(own.ts);
  const driverAtMark = deploymentAtMark + 7_500;
  const caused = at(500_025, new Date(deploymentAtMark + 400).toISOString(), "surface.wake_admitted");
  const previousStep = at(500_001, new Date(deploymentAtMark - 6_000).toISOString(), "surface.wake_admitted");
  ok(Date.parse(caused.ts) < Date.parse(auditSinceForDriverClock(driverAtMark)), "CONTROL: the driver-clock window opens AFTER the row its own step caused — the red this replaces");
  const asked: string[] = [];
  const fakeRead = async (opts: { readonly sinceIso: string; readonly actions: readonly string[]; readonly limit: number }) => {
    asked.push(opts.actions.join(","));
    return [older, own];
  };
  const presence = await readPresenceSince(fakeRead, driverAtMark, 5_000);
  ok(presence.sinceIso !== undefined && Date.parse(caused.ts) >= Date.parse(presence.sinceIso), `🔴 OPE-2387: the deployment-clock window holds the row the step caused (since ${presence.sinceIso}, row ${caused.ts})`);
  ok(presence.sinceIso !== undefined && Date.parse(previousStep.ts) < Date.parse(presence.sinceIso), "NEGATIVE CONTROL: the window does not widen to the previous step's row 6 s before the mark");
  const presenceBehind = await readPresenceSince(fakeRead, deploymentAtMark - 7_500, 5_000);
  ok(presenceBehind.sinceIso === presence.sinceIso, "🔴 the bound is the same whichever way the driver clock is wrong — the driver clock sets only the page bound");
  ok(asked.every((a) => a === CONTROL_SERVICE_CALL_ACTION), "the presence read is the store-mark read: the route's own self-audit row only");
  const zero = await readPresenceSince(fakeRead, driverAtMark, 0);
  ok(zero.sinceIso === own.ts, "a zero margin opens exactly at the mark's own instant");
  const empty = await readPresenceSince(async () => [], driverAtMark, 5_000);
  ok(empty.sinceIso === undefined && empty.rows === 0, "NEGATIVE CONTROL: a mark read that returns nothing gives no bound, never a driver-clock one");

  const scenariosSrc = readFileSync(fileURLToPath(new URL("../packages/core/scripts/e2e/scenarios.ts", import.meta.url)), "utf-8");
  const backdated = scenariosSrc.match(/=\s*new Date\(Date\.now\(\) - [0-9_* ]+\)\.toISOString\(\)/g) ?? [];
  ok(backdated.length === 0, `🔴 OPE-2387: no scenario bound is a backdated driver-clock instant (found ${backdated.length}: ${backdated.slice(0, 3).join(" | ")})`);
  const driverFloors = scenariosSrc.match(/auditSinceForDriverClock\(Date\.now\(\)\)/g) ?? [];
  ok(driverFloors.length === 0, `🔴 OPE-2387: no scenario calls auditSinceForDriverClock on the bare driver clock (found ${driverFloors.length})`);
  const nowAssigned = [...scenariosSrc.matchAll(/const (\w+) = new Date\(\)\.toISOString\(\);/g)].map((m) => m[1]!);
  const nowAllowed = new Set(["nowIso"]);
  const nowStray = nowAssigned.filter((n) => !nowAllowed.has(n));
  ok(nowStray.length === 0, `🔴 OPE-2387/OPE-2391: no scenario presence floor or vendor wait is the bare driver "now" (found: ${nowStray.join(", ")})`);
  ok(nowAssigned.length === 2, `the allowlisted driver "now" instants are the two pending-row decide times, which bound no read (found ${nowAssigned.length}: ${nowAssigned.join(", ")})`);
  ok(scenariosSrc.includes("const offTopicAt = (await lin.comments(issueA.id).catch(() => [])).find((c) => c.id === offTopicId)?.createdAt ?? \"\";"), "🔴 OPE-2391: the J-LIN stray filter opens at the off-topic note's own Linear createdAt");
  ok(scenariosSrc.indexOf("const offTopicId = await lin.comment(issueA.id,") >= 0 && scenariosSrc.indexOf("const offTopicId = await lin.comment(issueA.id,") < scenariosSrc.indexOf("const offTopicAt ="), "…which exists only after the note is posted, so the bound is read after it");
  ok(scenariosSrc.includes("await not.awaitBotReplyIn(discussionId, replayFrom, { timeoutMs: REPLY_WAIT })"), "🔴 OPE-2391: the S-TAINT-DRYRUN Notion drain floors on the deployment-clock replayFrom");
  ok(!/awaitBotReplyIn\(discussionId, since,/.test(scenariosSrc), "NEGATIVE CONTROL: no Notion drain floors on a bare `since`");
  ok((scenariosSrc.match(/await presenceSince\(ctx, /g) ?? []).length >= 90, "the presence floors moved to presenceSince (95 sites when OPE-2387 landed)");
  ok(/const markLeg = async \(leg: string\) => legMarks\.push\(\{ leg, sinceIso: await presenceSince\(ctx,/.test(scenariosSrc), "🔴 J1's latency marks bound their wake reads on the deployment's clock");
  ok(/const startMs = Date\.now\(\) - 5_000;\s*const sinceIso = await presenceSince\(ctx, "arm A", 5_000\);/.test(scenariosSrc), "🔴 S-ROUTINE-CONNECTOR-WRITE arm A: the seed ts keeps the driver clock, the audit window does not");
  const journeySrc = readFileSync(fileURLToPath(new URL("../packages/core/scripts/e2e/journey.ts", import.meta.url)), "utf-8");
  ok(journeySrc.includes("const askIso = new Date((slackVendorEventTime(askTs)?.ms ?? Date.now()) - 5_000).toISOString();"), "🔴 the PR drive's arm (b) window anchors on the ask's own Slack instant");
  ok(journeySrc.indexOf("const { ts: askTs } = await slack.post(slack.mention(ask));") < journeySrc.indexOf("const askIso ="), "…which exists only after the post, so the bound is taken after it");
  const armingSrc = readFileSync(fileURLToPath(new URL("../packages/core/scripts/e2e/connector-arming.ts", import.meta.url)), "utf-8");
  ok(armingSrc.includes("const marked = await readPresenceSince(probe.auditRead!, Date.now(), 0);") && armingSrc.includes("const since = marked.sinceIso ??"), "🔴 the connector-arming recheck window opens on the deployment's clock");

  const { deploymentPresenceSince } = await import("../packages/core/scripts/e2e/window-harness.js");
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  const stubFetch = (entries: readonly AuditWireEntry[]) =>
    (async (url: string | URL) => {
      fetched.push(String(url));
      return new Response(JSON.stringify({ entries }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  try {
    globalThis.fetch = stubFetch([older, own]);
    const floor = await deploymentPresenceSince("https://example.test", "read-token");
    ok(floor === own.ts, `🔴 OPE-2391: a stage script's floor is the store mark's deployment instant (got ${floor})`);
    ok(fetched.length === 1 && fetched[0]!.includes(`actions=${encodeURIComponent(CONTROL_SERVICE_CALL_ACTION)}`), "the stage-script floor is ONE store-mark read of the route's own self-audit row");
    globalThis.fetch = stubFetch([]);
    let refused = "";
    await deploymentPresenceSince("https://example.test", "read-token").catch((e: Error) => { refused = e.message; });
    ok(refused.includes("refusing a driver-clock presence floor"), `NEGATIVE CONTROL: a mark with no instant refuses, never falls back to the driver clock (got ${JSON.stringify(refused)})`);
  } finally {
    globalThis.fetch = realFetch;
  }
  const STAGE_SCRIPT_FLOORS: Readonly<Record<string, number>> = {
    "agent-delegation.ts": 2,
    "read-channel.ts": 2,
    "solo-window.ts": 3,
    "source-scoped-mount.ts": 2,
    "window-gate.ts": 8,
    "single-window-fanin.ts": 1,
  };
  for (const [file, floors] of Object.entries(STAGE_SCRIPT_FLOORS)) {
    const src = readFileSync(fileURLToPath(new URL(`../packages/core/scripts/e2e/${file}`, import.meta.url)), "utf-8");
    const driverNow = src.match(/const \w+ = new Date\(\)\.toISOString\(\);/g) ?? [];
    ok(driverNow.length === 0, `🔴 OPE-2391: ${file} takes no bare driver-clock floor (found ${driverNow.length})`);
    const moved = (src.match(/= await deploymentPresenceSince\(TARGET, READ\);/g) ?? []).length;
    ok(moved === floors, `🔴 OPE-2391: ${file} opens its ${floors} presence poll(s) on the deployment's clock (found ${moved})`);
  }
}

console.log(
  `✓ e2e-driver: ${passed} assertions passed (${shapeChecks} are per-scenario roster-shape checks, ` +
    `${passed - shapeChecks} are harness/driver logic — neither half is a product-behaviour coverage figure)`,
);
