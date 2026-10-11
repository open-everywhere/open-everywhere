import { afterAll, expect, test } from "vitest";

import {
  bootAgent,
  disposeLater,
  GITHUB_BOT_SLUG,
  githubIssueCommentPost,
  installNotionApiStub,
  NOTION_PAGE_ID,
  NOTION_PAGE_ID_2,
  NOTION_WORKSPACE_ID,
  auditCursor,
  notionCommentEventPost,
  registerScript,
  rowsSinceCursor,
  seedNotionChannelKey,
  waitFor,
  waitForAuditRows,
  type AuditCursor,
  type ScriptedHandle,
} from "../harness";
import { installDiscordWebApiStub, type DiscordCreateMessageCall } from "../discord-web-api";
import { installHostFetchStub } from "../fetch-stub";

const STARTER_ROUTINE_RULE = "routine-reports-here";

process.env.GITHUB_APP_SLUG = GITHUB_BOT_SLUG;

for (const k of ["GITHUB_TOKEN", "OE_GITHUB_APP_ID", "OE_GITHUB_APP_PRIVATE_KEY", "OE_GITHUB_APP_SLUG", "OE_GITHUB_INSTALLATIONS", "OE_GITHUB_OWNER", "OE_GITHUB_INSTALLATION_ID"]) {
  delete process.env[k];
}

const GITHUB_OWNER = "oe-it-judge-lift";
const GITHUB_REPO_ENFORCE = "arm-a";
const GITHUB_REPO_OFF = "arm-b";
const GITHUB_VENUE_CHANNEL_ID = "1300000001500000006";
const NOTION_VENUE_CHANNEL_ID = "1300000001500000004";

const NOTION_BOT_USER_ID = "it-1894-notion-bot-self";
const NOTION_BOT_NAME = "ottobot";
const NOTION_DISCUSSION_ID = "it-1894-discussion";

const TRIGGER = { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" } as const;

const NOTICE_MARK = "Ran without asking";
const CARD_MARK = "Approval requested";

const cleanups: (() => void)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0)) c();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.resetSettingsForTest();
});

const discord = installDiscordWebApiStub({ captureMessages: true });
cleanups.push(() => discord.uninstall());

const github = installHostFetchStub("https://api.github.com", () => undefined);
cleanups.push(() => github.uninstall());

const notionComments = new Map<string, Record<string, unknown>>();
const notion = installNotionApiStub((call) => {
  if (call.method === "GET" && call.path === "/v1/users/me") return { body: { id: NOTION_BOT_USER_ID, name: NOTION_BOT_NAME, type: "bot" } };
  if (call.method === "GET" && call.path === "/v1/comments") return { body: { results: [] } };
  if (call.method === "GET" && call.path.startsWith("/v1/comments/")) {
    const id = decodeURIComponent(call.path.slice("/v1/comments/".length));
    const found = notionComments.get(id);
    return found ? { body: found } : undefined;
  }
  if (call.method === "POST" && call.path === "/v1/comments") return { body: { id: "it-1894-notion-reply" } };
  return undefined;
});
cleanups.push(() => notion.uninstall());

const reasons: string[] = [];

function consultsSoFar(): number {
  return reasons.length;
}

let armed = false;

async function armSeams(): Promise<void> {
  await bootAgent({ sharedSqlite: true, selfBaseUrl: true, stubbedProviderTransport: true });
  if (armed) return;
  armed = true;
  await seedNotionChannelKey();
  const judge = await import("@open-everywhere/core/agent/access/approval-judge.js");
  judge.registerApprovalJudgeCompletion(async (_prompt, pass) => {
    if (pass === "scrutiny") return "YES";
    const reason = `consult ${reasons.length + 1}`;
    reasons.push(reason);
    return `VERDICT: allow\nREASON: ${reason}\nRULE: ${STARTER_ROUTINE_RULE}`;
  });
  cleanups.push(() => judge.resetApprovalJudgeCompletion());
}

async function armJudgeMode(mode: "enforce" | "off"): Promise<void> {
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ taint: { mode: "on" }, approvals: { judgeMode: mode } });
  expect(settings.getSettings().approvals.judgeMode).toBe(mode);
}

const CARD_CAPABLE_PLATFORMS: ReadonlySet<string> = new Set(["slack", "discord", "teams"]);

async function pinVenueContract(platform: string, originSurfaceKey: string, expectedVenueChannelId: string, expectedDomain: string): Promise<void> {
  const { loadDomains } = await import("../../../agent/memory/config/domains");

  expect(CARD_CAPABLE_PLATFORMS.has(platform), `🔴 "${platform}" is now treated as card-capable — this file's whole premise (the card, and therefore the notice, is redirected OUT of the origin room) no longer holds`).toBe(false);

  const home = loadDomains().find((d) => (d.reach ?? []).includes(originSurfaceKey));
  expect(home, `${originSurfaceKey} is in no domain — a wake there reaches no seat and no venue`).toBeDefined();
  expect(home?.name).toBe(expectedDomain);
  expect(home?.ambientSupervisor, `"${home?.name}" does not run an ambient supervisor — the ambient leg stands down and nothing wakes`).toBe(true);
  expect(home?.reportChannel, `"${home?.name}" declares no reportChannel — create_routine refuses outright from a surface that cannot post proactively`).toBeDefined();

  if (platform === "github") {
    const { surfaces } = await import("../../../agent/identity/surfaces");
    const tenantKey = originSurfaceKey.split("/").slice(0, 2).join("/");
    const vouch = surfaces.find((entry) => (entry.key === tenantKey || entry.key === originSurfaceKey) && entry.trust === "internal");
    expect(
      vouch,
      `🔴 "${vouch?.key}" is now vouched internal — a vouched repo mints a window wake, the seat goes standing and LEAN, and it holds no create_routine. Re-home this fixture under an owner no defineSurface names.`,
    ).toBeUndefined();
    const { getSettings } = await import("@open-everywhere/core/agent/settings/settings.js");
    expect(getSettings().identity.blanketTrust, "identity.blanketTrust internal is the blanket vouch — it windows this wake too").not.toBe("internal");
  }

  const roster = (home?.reach ?? []).filter((entry) => entry.split("/").length === 3);
  const venue = roster.find((entry) => CARD_CAPABLE_PLATFORMS.has(entry.split("/")[0] ?? ""));
  expect(venue, `"${home?.name}" has no card-capable channel — create_routine refuses "${platform}" outright and no card or notice is ever posted`).toBeDefined();
  expect(venue?.split("/")[2], `"${home?.name}"'s first card-capable channel is "${venue}", not the venue this file measures`).toBe(expectedVenueChannelId);
}

const APPROVAL_ACTIONS = ["approval.autoapproved", "approval.requested"] as const;

function venueMessages(mark: string): DiscordCreateMessageCall[] {
  return discord.messages.filter((m) => m.content.includes(mark));
}

function buttonsOf(message: DiscordCreateMessageCall): { label?: string; custom_id?: string }[] {
  return message.components.flatMap((rowComponent) => {
    const inner = (rowComponent as { components?: unknown }).components;
    return Array.isArray(inner) ? (inner as { label?: string; custom_id?: string }[]) : [];
  });
}

function originBodies(calls: readonly unknown[]): string {
  return JSON.stringify(calls);
}

function clearTransportLogs(): void {
  (discord.messages as DiscordCreateMessageCall[]).length = 0;
  (github.calls as unknown as unknown[]).length = 0;
  (notion.calls as unknown as unknown[]).length = 0;
}

function seatProposing(ids: string, prompt: string): ScriptedHandle {
  return disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "create_routine", input: { prompt, trigger: TRIGGER }, id: `${ids}-routine` }] }, { say: "proposed" }],
    }),
  );
}

async function awaitProposal(handle: ScriptedHandle, label: string): Promise<void> {
  const first = await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0), `${label}: the wake's first step to be served`);
  expect(
    first.tools,
    `🔴 ${label}: the seat was NOT offered create_routine — it is LEAN, so this wake diverted into a window and no proposal is possible. It was offered [${first.tools.slice().sort().join(", ")}]`,
  ).toContain("create_routine");
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${label}: the wake's terminal step to be served`);
  expect(handle.requests.filter((r) => r.fault !== undefined), `${label}: the scripted model reported a fault`).toEqual([]);
}

async function driveGitHubWake(input: { ids: string; repo: string; issueNumber: number; prompt: string }): Promise<{ handle: ScriptedHandle; cursor: AuditCursor }> {
  const handle = seatProposing(input.ids, input.prompt);
  const cursor = await auditCursor();
  const res = await githubIssueCommentPost({
    owner: GITHUB_OWNER,
    repo: input.repo,
    issueNumber: input.issueNumber,
    body: `ope1894 (${input.ids}) — please set up the routine we agreed`,
    commentId: 1_894_000 + input.issueNumber,
  });
  expect(res.status, `the GitHub front refused the signed delivery: ${res.body.slice(0, 300)}`).toBe(200);
  await awaitProposal(handle, `github/${input.repo}`);
  return { handle, cursor };
}

async function driveNotionWake(input: { ids: string; pageId: string; prompt: string }): Promise<{ handle: ScriptedHandle; cursor: AuditCursor }> {
  const handle = seatProposing(input.ids, input.prompt);
  const triggerId = `it-1894-trigger-${input.ids}`;
  notionComments.set(triggerId, {
    id: triggerId,
    discussion_id: NOTION_DISCUSSION_ID,
    parent: { page_id: input.pageId },
    rich_text: [{ plain_text: `ope1894 (${input.ids}) — please set up the routine we agreed` }],
    created_by: { id: `it-1894-author-${input.ids}`, type: "person" },
    created_time: new Date().toISOString(),
  });
  const cursor = await auditCursor();
  const res = await notionCommentEventPost({ workspaceId: NOTION_WORKSPACE_ID, commentId: triggerId });
  expect(res.status, `the Notion front refused the delivery: ${res.body.slice(0, 300)}`).toBe(200);
  await awaitProposal(handle, `notion/${input.pageId}`);
  return { handle, cursor };
}

async function expectLiftedNoticeOnVenue(input: {
  readonly cursor: AuditCursor;
  readonly label: string;
  readonly originSurfaceKey: string;
  readonly venueChannelId: string;
  readonly prompt: string;
  readonly originCalls: readonly unknown[];
  readonly consultsBefore: number;
}): Promise<void> {
  const rows = await waitForAuditRows({
    probe: async () => {
      const got = await rowsSinceCursor(input.cursor, APPROVAL_ACTIONS);
      return got.some((r) => r.action === "approval.autoapproved") ? got : undefined;
    },
    label: `${input.label}: this turn's approval.autoapproved row to land`,
    actions: APPROVAL_ACTIONS,
    cursor: input.cursor,
  });
  const lifted = rows.filter((r) => r.action === "approval.autoapproved");
  expect(lifted, `${input.label}: expected exactly one lift row`).toHaveLength(1);
  expect(lifted[0]!.detail?.resolvedBy).toBe("judge");
  expect(rows.filter((r) => r.action === "approval.requested"), `${input.label}: a card was requested on a lifted act`).toEqual([]);
  expect(reasons.length, `${input.label}: the injected judge transport was never consulted`).toBeGreaterThan(input.consultsBefore);
  const wedgeRowId = String(lifted[0]!.detail?.id);
  expect(wedgeRowId.length).toBeGreaterThan(0);

  const message = await waitFor(() => venueMessages(NOTICE_MARK)[0], `${input.label}: the judge-lift notice to reach the ${input.venueChannelId} venue`);
  expect(venueMessages(NOTICE_MARK), `${input.label}: the venue got more than one notice`).toHaveLength(1);
  expect(venueMessages(CARD_MARK), `${input.label}: a pending card was posted beside the notice`).toEqual([]);
  expect(message.channelId).toBe(input.venueChannelId);
  expect(message.content).toContain("Ran without asking: routine.create");
  expect(message.content).toContain("Auto-approved by the approval judge");
  expect(message.content).toContain(input.prompt);
  const { placeWords } = await import("@open-everywhere/core/agent/channels/friendly-ids.js");
  expect(message.content).toContain(`Target: ${placeWords({ key: input.originSurfaceKey })}`);
  expect(message.content).not.toContain(input.originSurfaceKey);
  expect(lifted[0]!.detail?.scopeKey, `${input.label}: the lift row does not name the origin room`).toBe(input.originSurfaceKey);
  expect(message.content).not.toContain(CARD_MARK);
  expect(message.content).not.toContain("expires");

  const buttons = buttonsOf(message);
  expect(buttons, `${input.label}: the notice carried ${buttons.length} buttons`).toHaveLength(1);
  expect(buttons[0]!.label).toBe("This should not have run");
  const customId = String(buttons[0]!.custom_id);
  expect(customId.startsWith(`oe-approval:${wedgeRowId}:contradict:`), `${input.label}: the button is not bound to this turn's wedge row (${customId})`).toBe(true);
  expect(customId).not.toContain(":approve:");
  expect(customId).not.toContain(":reject:");

  const origin = originBodies(input.originCalls);
  expect(origin, `${input.label}: the judge-lift notice leaked to the origin transport`).not.toContain(NOTICE_MARK);
  expect(origin, `${input.label}: an approval card leaked to the origin transport`).not.toContain(CARD_MARK);
}

async function expectCardOnVenueAndNoNotice(input: {
  readonly cursor: AuditCursor;
  readonly label: string;
  readonly venueChannelId: string;
  readonly originCalls: readonly unknown[];
  readonly consultsBefore: number;
}): Promise<void> {
  const rows = await waitForAuditRows({
    probe: async () => {
      const got = await rowsSinceCursor(input.cursor, APPROVAL_ACTIONS);
      return got.some((r) => r.action === "approval.requested") ? got : undefined;
    },
    label: `${input.label}: this turn's approval.requested row to land`,
    actions: APPROVAL_ACTIONS,
    cursor: input.cursor,
  });
  expect(rows.filter((r) => r.action === "approval.autoapproved"), `${input.label}: something lifted with the judge off`).toEqual([]);
  expect(reasons.length, `${input.label}: the judge was consulted with the mode off`).toBe(input.consultsBefore);

  const card = await waitFor(() => venueMessages(CARD_MARK)[0], `${input.label}: the pending card to reach the ${input.venueChannelId} venue`);
  expect(card.channelId).toBe(input.venueChannelId);
  expect(venueMessages(NOTICE_MARK), `${input.label}: a judge-lift notice was posted with the judge off`).toEqual([]);

  const origin = originBodies(input.originCalls);
  expect(origin, `${input.label}: an approval card leaked to the origin transport`).not.toContain(CARD_MARK);
  expect(origin, `${input.label}: a judge-lift notice leaked to the origin transport`).not.toContain(NOTICE_MARK);
}

test("① a judge lift on a GITHUB-origin routine posts its notice into the in-domain Discord venue, and nothing of it reaches api.github.com", async () => {
  await armSeams();
  await armJudgeMode("enforce");
  await pinVenueContract("github", `github/${GITHUB_OWNER}/${GITHUB_REPO_ENFORCE}`, GITHUB_VENUE_CHANNEL_ID, "it-judge-lift-github");
  clearTransportLogs();

  const prompt = "post the ope1894 github standup digest every weekday morning";
  const consultsBefore = consultsSoFar();
  const { cursor } = await driveGitHubWake({ ids: "gh-lift", repo: GITHUB_REPO_ENFORCE, issueNumber: 1894, prompt });

  await expectLiftedNoticeOnVenue({
    cursor,
    label: "github/enforce",
    originSurfaceKey: `github/${GITHUB_OWNER}/${GITHUB_REPO_ENFORCE}`,
    venueChannelId: GITHUB_VENUE_CHANNEL_ID,
    prompt,
    originCalls: github.calls,
    consultsBefore,
  });
});

test("② 🔴 with the judge OFF the same GITHUB-origin proposal posts an ordinary CARD to that venue, no notice, and still nothing to api.github.com", async () => {
  await armSeams();
  await armJudgeMode("off");
  await pinVenueContract("github", `github/${GITHUB_OWNER}/${GITHUB_REPO_OFF}`, GITHUB_VENUE_CHANNEL_ID, "it-judge-lift-github");
  clearTransportLogs();

  const consultsBefore = consultsSoFar();
  const { cursor } = await driveGitHubWake({
    ids: "gh-carded",
    repo: GITHUB_REPO_OFF,
    issueNumber: 1895,
    prompt: "post the ope1894 github release notes every weekday afternoon",
  });

  await expectCardOnVenueAndNoNotice({ cursor, label: "github/off", venueChannelId: GITHUB_VENUE_CHANNEL_ID, originCalls: github.calls, consultsBefore });
});

test("③ a judge lift on a NOTION-origin routine posts its notice into the in-domain Discord venue, and nothing of it reaches api.notion.com", async () => {
  await armSeams();
  await armJudgeMode("enforce");
  await pinVenueContract("notion", `notion/${NOTION_WORKSPACE_ID}/${NOTION_PAGE_ID}`, NOTION_VENUE_CHANNEL_ID, "it-notion-withhold");
  clearTransportLogs();

  const prompt = "post the ope1894 notion standup digest every weekday morning";
  const consultsBefore = consultsSoFar();
  const { cursor } = await driveNotionWake({ ids: "nt-lift", pageId: NOTION_PAGE_ID, prompt });

  await expectLiftedNoticeOnVenue({
    cursor,
    label: "notion/enforce",
    originSurfaceKey: `notion/${NOTION_WORKSPACE_ID}/${NOTION_PAGE_ID}`,
    venueChannelId: NOTION_VENUE_CHANNEL_ID,
    prompt,
    originCalls: notion.calls,
    consultsBefore,
  });

  expect(notion.calls.length, "the Notion route made no REST call at all — the origin log proves nothing").toBeGreaterThan(0);
});

test("④ 🔴 with the judge OFF the same NOTION-origin proposal posts an ordinary CARD to that venue, no notice, and still nothing to api.notion.com", async () => {
  await armSeams();
  await armJudgeMode("off");
  await pinVenueContract("notion", `notion/${NOTION_WORKSPACE_ID}/${NOTION_PAGE_ID_2}`, NOTION_VENUE_CHANNEL_ID, "it-notion-withhold");
  clearTransportLogs();

  const consultsBefore = consultsSoFar();
  const { cursor } = await driveNotionWake({
    ids: "nt-carded",
    pageId: NOTION_PAGE_ID_2,
    prompt: "post the ope1894 notion release notes every weekday afternoon",
  });

  await expectCardOnVenueAndNoNotice({
    cursor,
    label: "notion/off",
    venueChannelId: NOTION_VENUE_CHANNEL_ID,
    originCalls: notion.calls,
    consultsBefore,
  });
});
