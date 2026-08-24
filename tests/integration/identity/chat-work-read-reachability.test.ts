import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import {
  afterThisTest,
  awaitTaskSettlement,
  bootAgent,
  disposeLater,
  discordMentionWake,
  DISCORD_GUILD_ID,
  installLinearApiStub,
  installTeamsJwksStub,
  linearAgentSessionPost,
  LINEAR_UNIFIED_ORG_ID,
  LINEAR_UNIFIED_TEAM_ID,
  registerScript,
  SETTLEMENT_DRAIN_SCRIPT,
  taskIdOfDelegation,
  teamsActivityPost,
  waitFor,
  waitForChildren,
  type ScriptedHandle,
} from "../harness";

const DISCORD_FIXTURE_CHANNEL_ID = "1300000001500000009";
const DISCORD_BOT_MENTION_ID = "9000000000000000001";

const TEAMS_TENANT_ID = "it1064-teams-tenant";
const TEAMS_TEAM_ID = "it1064-teams-team";
const TEAMS_CHANNEL_ID = "it1064-teams-channel";
const TEAMS_CONVERSATION_ID = TEAMS_CHANNEL_ID;
const TEAMS_BOT_RECIPIENT_ID = "28:it1064-teams-bot";
const TEAMS_AUTHOR_ID = "it1064-teams-author";

async function pinFixtureDomainGrant(domainName: string, connector: "discord" | "teams" | "linear"): Promise<void> {
  const { loadDomains } = await import("../../../agent/memory/domains");
  const { domainHoldsSurfaceWorkGrant } = await import("@open-everywhere/core/agent/access/surface-work-grant.js");
  const home = loadDomains().find((d) => d.name === domainName);
  expect(home, `the "${domainName}" domain is missing from agent/memory/domains.ts — this arm cannot measure a mount`).toBeDefined();
  expect(
    domainHoldsSurfaceWorkGrant(home, connector),
    `"${domainName}" declares NO ${connector} work role — restore its \`credentials\` entry before re-running this arm`,
  ).toBe(true);
}

async function driveDelegationAndReadWorker(wake: () => Promise<void>, label: string): Promise<ScriptedHandle> {
  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "take it from here" }, id: `ope1064-${label}-delegate` }] },
        { say: "handed off" },
      ],
      child: [{ say: "reported" }],
    }),
  );

  await wake();

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${label}: the dispatch turn's own terminal step`);
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: `${label}: the worker's terminal step` });
  expect(handle.requests.filter((r) => r.fault !== undefined), `${label}: the scripted model reported a fault`).toEqual([]);

  const taskId = taskIdOfDelegation(handle, `the ${label} delegation`);
  const drained = await awaitTaskSettlement({ dispatched: handle, taskId, script: SETTLEMENT_DRAIN_SCRIPT, label: `${label}: the worker's settlement wake` });
  disposeLater(drained.handle);
  expect(drained.handle.requests.filter((r) => r.fault !== undefined), `${label}: a straggling worker crossed into the drain`).toEqual([]);
  drained.handle.dispose();

  return handle;
}

function assertWorkerHoldsWorkReads(handle: ScriptedHandle, label: string): void {
  const worker = handle.requests.find((r) => r.role === "child");
  expect(worker, `${label}: no worker request was recorded — the delegation never reached a child`).toBeDefined();

  for (const verb of ["read_work_channel", "read_work_thread"]) {
    expect(
      worker!.tools,
      `🔴 ${label}: the worker was NOT offered ${verb} — the granted work read never mounted on a real ${label} wake. It was offered [${worker!.tools.slice().sort().join(", ")}]`,
    ).toContain(verb);
  }

  const seat = handle.requests.find((r) => r.role === "parent")!;
  for (const verb of ["read_work_channel", "read_work_thread"]) {
    expect(seat.tools, `🔴 ${label}: the SEAT was offered ${verb} — the work plane is not the worker's any more`).not.toContain(verb);
  }
}

test("Discord: a delegated worker in it-work-read-fixture-discord holds read_work_channel/read_work_thread", async () => {
  await bootAgent();
  await pinFixtureDomainGrant("it-work-read-fixture-discord", "discord");
  expect(DISCORD_GUILD_ID, "the fixture channel must sit under the vouched test guild").toBe("1300000000000000100");

  const handle = await driveDelegationAndReadWorker(
    () =>
      discordMentionWake({
        channelId: DISCORD_FIXTURE_CHANNEL_ID,
        text: `<@${DISCORD_BOT_MENTION_ID}> ope1064 please read this channel`,
      }),
    "discord",
  );

  assertWorkerHoldsWorkReads(handle, "discord");
}, 420_000);

test("Teams: a delegated worker in it-work-read-fixture-teams holds read_work_channel/read_work_thread", async () => {
  await bootAgent();
  await pinFixtureDomainGrant("it-work-read-fixture-teams", "teams");

  process.env.OE_TRUST = "internal";

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ window: { topology: true } });

  const jwks = installTeamsJwksStub();
  try {
    const activity = {
      type: "message",
      id: `it1064-teams-act-${Date.now()}`,
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      from: { id: TEAMS_AUTHOR_ID, name: "OPE-1064 Fixture Author" },
      recipient: { id: TEAMS_BOT_RECIPIENT_ID, name: "OE Bot" },
      conversation: { id: TEAMS_CONVERSATION_ID, conversationType: "channel", tenantId: TEAMS_TENANT_ID },
      channelData: {
        tenant: { id: TEAMS_TENANT_ID },
        team: { id: TEAMS_TEAM_ID },
        channel: { id: TEAMS_CHANNEL_ID, membershipType: "standard" },
      },
      entities: [{ type: "mention", text: "<at>OE Bot</at>", mentioned: { id: TEAMS_BOT_RECIPIENT_ID, name: "OE Bot" } }],
      text: "<at>OE Bot</at> ope1064 please read this channel",
    };

    const handle = await driveDelegationAndReadWorker(async () => {
      const res = await teamsActivityPost({ activity });
      expect(res.status, `the Teams front refused the signed delivery: ${res.body.slice(0, 300)}`).toBe(200);
    }, "teams");

    assertWorkerHoldsWorkReads(handle, "teams");
  } finally {
    jwks.uninstall();
    delete process.env.OE_TRUST;
  }
}, 420_000);

test("Linear: a delegated worker in e2e-unified holds read_work_channel/read_work_thread", async () => {
  await bootAgent();
  await pinFixtureDomainGrant("e2e-unified", "linear");

  process.env.LINEAR_APP_USER_ID = "it-linear-app-actor";
  process.env.LINEAR_APP_NAME = "OE Bot";

  const nonce = randomBytes(6).toString("hex");
  const authorId = `it-linear-work-read-author-${nonce}`;
  const agentSessionId = `it-linear-work-read-session-${nonce}`;
  const commentId = `it-linear-work-read-comment-${nonce}`;
  const issueId = `it-linear-work-read-issue-${nonce}`;

  const stub = installLinearApiStub((call) => {
    if (call.operation === "OeAmbientComment" && call.variables.id !== undefined) {
      return {
        data: {
          comment: {
            id: call.variables.id,
            body: "@OE Bot ope1071 please read this issue",
            createdAt: new Date().toISOString(),
            user: { id: authorId, guest: false },
            issue: { id: issueId, identifier: "IT-WR-1", title: "fixture issue", team: { id: LINEAR_UNIFIED_TEAM_ID, private: false } },
          },
        },
      };
    }
    if (call.operation === "AgentActivityCreate") {
      return { data: { agentActivityCreate: { success: true, agentActivity: { id: "it-linear-work-read-activity" } } } };
    }
    return undefined;
  });
  afterThisTest(() => stub.uninstall());

  const handle = await driveDelegationAndReadWorker(async () => {
    const res = await linearAgentSessionPost({
      agentSessionId,
      organizationId: LINEAR_UNIFIED_ORG_ID,
      teamId: LINEAR_UNIFIED_TEAM_ID,
      issueId,
      commentId,
    });
    expect(res.status, `the Linear front refused the signed delivery: ${res.body.slice(0, 300)}`).toBe(200);
  }, "linear");

  assertWorkerHoldsWorkReads(handle, "linear");
}, 420_000);
