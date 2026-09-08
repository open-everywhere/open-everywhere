import assert from "node:assert/strict";
import {
  registerConfig,
  registerIdentityMapper,
  defineDomain,
  ChannelScopeError,
  TurnOriginFenceError,
  type BindableContext,
  type Domain,
} from "@open-everywhere/core/agent/adapter-api.js";
import { registerLinearProvider } from "../agent/register.js";
import readLinearIssueDefault, { readLinearIssueEntry } from "../agent/tools/read_linear_issue.js";

registerLinearProvider();

registerIdentityMapper("slack", (ctx) => {
  const a = (ctx as BindableContext).session?.auth?.current?.attributes as Record<string, string> | undefined;
  return { workspace: a?.["team_id"], surface: a?.["channel_id"], mode: "channel", visibility: "public", trust: "internal", principalId: a?.["user_id"] };
});

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const ORG = "org-1";
const TEAM_PAY = "team-pay-1111";
const TEAM_ENG = "team-eng-2222";

const ISSUE_PAY = "22222222-2222-4222-8222-222222222222";
const ISSUE_ENG = "33333333-3333-4333-8333-333333333333";

const UNGRANTED_DOMAINS: readonly Domain[] = [
  defineDomain({ name: "payments", reach: [`linear/${ORG}/${TEAM_PAY}`, "slack/T1/CPAY"] }),
  defineDomain({ name: "eng", reach: [`linear/${ORG}/${TEAM_ENG}`] }),
];
const GRANTED_DOMAINS: readonly Domain[] = [
  defineDomain({
    name: "payments",
    reach: [`linear/${ORG}/${TEAM_PAY}`, "slack/T1/CPAY"],
    credentials: [{ connector: "linear", credential: "workspace", use: ORG }],
  }),
  defineDomain({ name: "eng", reach: [`linear/${ORG}/${TEAM_ENG}`] }),
];

function withDomains(domains: readonly Domain[]): void {
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => domains,
    loadSilos: () => [],
    domainsForSurface: () => [],
  });
}

function slackCtx(channelId: string): BindableContext {
  return {
    channel: { kind: "slack" },
    session: {
      auth: { current: { attributes: { team_id: "T1", channel_id: channelId, channel_type: "channel" }, principalId: "U_SLACK", principalType: "slack-user" } },
    },
  } as unknown as BindableContext;
}

function linearCtx(team: string, issueId: string, org = ORG): BindableContext {
  return {
    channel: { kind: "linear" },
    session: {
      auth: { current: { attributes: { organization_id: org, team_id: team, issue_id: issueId }, principalId: "U_LINEAR", principalType: "linear-user" } },
    },
  } as unknown as BindableContext;
}

function linearWorkerCtx(team: string, issueId: string, org = ORG): BindableContext {
  return {
    channel: { kind: "subagent", continuationToken: "subagent:sess-parent:call_1" },
    session: {
      id: "sess-child",
      auth: {
        current: {
          attributes: { oe_platform: "linear", oe_grain: "standing", organization_id: org, team_id: team, issue_id: issueId },
          principalId: "U_LINEAR",
          principalType: "linear-user",
        },
      },
    },
  } as unknown as BindableContext;
}

function slackWorkerCtx(channelId: string): BindableContext {
  return {
    channel: { kind: "subagent", continuationToken: "subagent:sess-parent:call_2" },
    session: {
      id: "sess-child-2",
      auth: {
        current: {
          attributes: { oe_platform: "slack", oe_grain: "standing", team_id: "T1", channel_id: channelId, channel_type: "channel" },
          principalId: "U_SLACK",
          principalType: "slack-user",
        },
      },
    },
  } as unknown as BindableContext;
}

type MountHandler = (event: unknown, ctx: unknown) => unknown;
async function mount(ctx: BindableContext): Promise<unknown> {
  const handler = (readLinearIssueDefault as unknown as { events: Record<string, MountHandler> }).events["session.started"];
  return handler({}, ctx);
}

const execute = (readLinearIssueEntry as unknown as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute;

const SAVED: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined): void {
  if (!(name in SAVED)) SAVED[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
setEnv("LINEAR_AGENT_ACCESS_TOKEN", "test-token");
for (const k of ["LINEAR_ACCESS_TOKEN", "LINEAR_API_KEY", "LINEAR_API_TOKEN", "LINEAR_ORGANIZATION_ID", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"]) {
  setEnv(k, undefined);
}

const savedFetch = globalThis.fetch;
function stubIssue(team: string): void {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: {
          issue: {
            id: "internal-id",
            identifier: "PAY-1",
            title: "A ticket",
            description: "the body",
            state: { name: "Todo", type: "unstarted" },
            comments: { nodes: [], pageInfo: { hasNextPage: false } },
            team: { id: team, private: false },
          },
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}
stubIssue(TEAM_PAY);

try {
  {
    withDomains(UNGRANTED_DOMAINS);
    ok((await mount(slackCtx("CPAY"))) === null, "read_linear_issue does NOT mount on an ungranted Slack session with no Linear source");

    withDomains(GRANTED_DOMAINS);
    ok((await mount(slackCtx("CPAY"))) !== null, "🔴 THE WORK ARM: read_linear_issue MOUNTS on a Slack session whose domain holds the Linear work grant");

    withDomains(UNGRANTED_DOMAINS);
    ok(
      (await mount(linearCtx(TEAM_PAY, ISSUE_PAY))) === null,
      "🔴 NEGATIVE CONTROL: a CONVERSATIONAL Linear-origin session does NOT mount it with no grant — the chat plane speaks generic verbs",
    );
    ok(
      (await mount(linearWorkerCtx(TEAM_PAY, ISSUE_PAY))) !== null,
      "🔴 THE CHAT ARM: a DELEGATED WORKER from that same Linear conversation DOES mount it with no grant — its only container read on an UNGRANTED domain",
    );
    ok(
      (await mount(slackWorkerCtx("CPAY"))) === null,
      "🔴 NEGATIVE CONTROL: a worker delegated from an UNGRANTED Slack conversation mounts nothing — the worker grain is not a grant",
    );
    withDomains(GRANTED_DOMAINS);
    ok((await mount(slackWorkerCtx("CPAY"))) !== null, "the WORK arm is grain-blind — a granted Slack-delegated worker mounts it too");
  }

  {
    withDomains(UNGRANTED_DOMAINS);
    let ungrantedErr: unknown;
    try {
      await execute({ issue: ISSUE_PAY }, slackCtx("CPAY"));
    } catch (e) {
      ungrantedErr = e;
    }
    ok(ungrantedErr instanceof TurnOriginFenceError, "an ungranted Slack turn is refused by the ORIGIN fence, unchanged");

    withDomains(GRANTED_DOMAINS);
    stubIssue(TEAM_PAY);
    const res = (await execute({ issue: ISSUE_PAY }, slackCtx("CPAY"))) as { identifier?: string; description?: string };
    ok(res.identifier === "PAY-1" && res.description === "the body", "🔴 THE FIX: a GRANTED Slack turn reads a Linear issue in its own domain end to end");

    withDomains(GRANTED_DOMAINS);
    stubIssue(TEAM_ENG);
    let crossErr: unknown;
    try {
      await execute({ issue: ISSUE_ENG }, slackCtx("CPAY"));
    } catch (e) {
      crossErr = e;
    }
    ok(crossErr instanceof ChannelScopeError, "even a granted Slack turn cannot read an issue on ANOTHER domain's team — the cross-domain wall survives the grant");
    ok(!(crossErr instanceof TurnOriginFenceError), "…and the refusal is the DOMAIN fence, not the origin fence (the grant DID admit it past the origin check)");
  }
} finally {
  globalThis.fetch = savedFetch;
  for (const [name, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

assert.ok(passed > 0);
console.log(`✓ linear-read-work-grant: ${passed} assertions passed`);
