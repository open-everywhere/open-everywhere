process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerConfig, registerIdentityMapper, defineDomain, getOperationalStore, UNADMITTED_TENANT_DROP_REASON, MULTI_TENANT_ENV } from "@open-everywhere/core/agent/adapter-api.js";
import { bindSlack } from "../agent/channels/slack-identity.js";
import { slackTenantAdmission } from "../agent/channels/slack-tenant-fence.js";
import { admitInbound } from "../agent/channels/slack.js";
import { stripComments } from "./_source-scan-utils.js";
import { _resetDeploymentIdentityForTest } from "@open-everywhere/core/agent/adapter-api.js";

_resetDeploymentIdentityForTest();
for (const k of ["OE_PLATFORM", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST", "OE_TEST_DRIVER_IDS", MULTI_TENANT_ENV]) {
  delete process.env[k];
}

const HOME_TEAM = "T0EXAMPLE";
const FOREIGN_TEAM = "T_FOREIGN";
const HOME_CHANNEL = "C0EXCHAN005";
const FOREIGN_CHANNEL = "C0BFOREIGN";

let domains = [defineDomain({ name: "mapped", channels: [`slack/${HOME_TEAM}/${HOME_CHANNEL}`], memory: "brain" })];

registerIdentityMapper("slack", bindSlack);
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [{ name: "brain", provider: "sqlite" }],
  domainsForSurface: ({ surface }) => (surface === HOME_CHANNEL ? ["mapped"] : []),
});

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  ok(slackTenantAdmission(HOME_TEAM) === "proceed", "the declared workspace is admitted");
  ok(slackTenantAdmission(FOREIGN_TEAM) === "unadmitted", "🔴 a second workspace that installed the same app is NOT — nothing else in the tree would have noticed it");
  ok(slackTenantAdmission(undefined) === "proceed", "a delivery naming no team proceeds (the unmapped-channel guard is the tenant-PRESENCE gate; a blank team is not a foreign one)");

  const declared = domains;
  domains = [];
  ok(slackTenantAdmission(FOREIGN_TEAM) === "proceed", "🔴 a deployment that declares NO Slack channels is INERT — a fresh clone must keep answering everywhere (memory is opt-in)");
  domains = declared;
}

function fakeCtx(posts: string[]) {
  const thread = {
    teamId: null as string | null,
    post: async (text: string) => {
      posts.push(text);
    },
    startTyping: async () => {},
  };
  const slack = {
    channelId: undefined as string | undefined,
    threadTs: undefined as string | undefined,
    request: async () => {
      throw new Error("no live slack in a unit test");
    },
  };
  return { thread, slack } as never;
}

const messageIn = (channelId: string, ts: string, teamId: string | undefined) =>
  ({
    channelId,
    ts,
    threadTs: ts,
    markdown: "hey, what's the deploy story here?",
    author: { userId: "U_ASKER", isBot: false },
    teamId,
    raw: { channel_type: "channel", team: teamId },
  }) as never;

async function dropRows(ts: string) {
  const store = getOperationalStore();
  for (let i = 0; i < 20; i++) {
    const rows = await store.readAudit({ org: "default", action: "surface.wake_dropped" });
    const mine = rows.filter((r) => (r.detail as { ts?: unknown } | undefined)?.ts === ts);
    if (mine.length > 0) return mine;
    await new Promise((r) => setTimeout(r, 10));
  }
  return [];
}

{
  const posts: string[] = [];
  const outcome = await admitInbound(fakeCtx(posts), messageIn(FOREIGN_CHANNEL, "9001.1", FOREIGN_TEAM), false);
  ok(outcome === null, "🔴 UNADMITTED WORKSPACE: the wake DROPS — eve dispatches no model turn, so no binding, no principal match, no credential resolution ever happens under an ambiguous identity");
  ok(posts.length === 0, "…and NOTHING is posted back: we cannot safely identify anybody there, and a foreign tenant learning it reached a live deployment is more than it needs to know");

  const rows = await dropRows("9001.1");
  ok(rows.length === 1, "…but the operator gets ONE surface.wake_dropped row (a silent drop is unreadable in a webhook process)");
  const d = (rows[0]!.detail ?? {}) as Record<string, unknown>;
  ok(d.reason === UNADMITTED_TENANT_DROP_REASON, "the row names WHY, via the one greppable reason string");
  ok(d.door === "mention", "…which ingress door refused it");
  ok(d.team === FOREIGN_TEAM, "…and WHICH workspace, which is the fact the whole decision turned on");
}

{
  const posts: string[] = [];
  const outcome = await admitInbound(fakeCtx(posts), messageIn(HOME_CHANNEL, "9002.1", HOME_TEAM), false);
  ok(outcome !== null, "HOME WORKSPACE: the same shape from the declared team is ADMITTED — the fence is not a blanket refusal");
  ok((await dropRows("9002.1")).length === 0, "…and writes no wake_dropped row");
}

{
  process.env[MULTI_TENANT_ENV] = "1";
  const posts: string[] = [];
  const outcome = await admitInbound(fakeCtx(posts), messageIn(FOREIGN_CHANNEL, "9003.1", FOREIGN_TEAM), false);
  ok(outcome !== null, `${MULTI_TENANT_ENV}=1 admits the second workspace at the WAKE DOOR too — one switch, both fences, so config and runtime can never disagree about the topology`);
  delete process.env[MULTI_TENANT_ENV];
}

{
  const here = fileURLToPath(new URL(".", import.meta.url));
  const read = (rel: string) => readFileSync(`${here}../agent/channels/${rel}`, "utf8");
  const mentionDoor = read("slack.ts");
  const engagementDoor = read("slack-events.ts");
  const fence = read("slack-tenant-fence.ts");

  ok(/import \{ slackTenantAdmission \} from "\.\/slack-tenant-fence\.js"/.test(mentionDoor), "MENTION DOOR: slack.ts imports the shared fence helper");
  ok(/slackTenantAdmission\(message\.teamId\) === "unadmitted"/.test(mentionDoor), "…and consults it on the delivery's own teamId");
  ok(/classifyTenantAdmission/.test(fence) && !/classifyTenantAdmission/.test(mentionDoor) && !/classifyTenantAdmission/.test(engagementDoor), "the DECISION lives in core and reaches both doors through one helper — never a forked copy of the rule at a door");

  {
    const body = mentionDoor.slice(mentionDoor.indexOf("async function onInbound("));
    ok(body.indexOf("slackTenantAdmission(") < body.indexOf("await slackSpendGate("), "the fence runs ABOVE the spend gate — an unadmitted tenant is not a budget question; that turn must not run at any price");
    ok(body.indexOf("slackTenantAdmission(") < body.indexOf("classifyWakeMapping("), "…and above the unmapped-channel nudge, so a foreign workspace is never handed our config-hole copy");
    ok(/=== "unadmitted"\) \{[\s\S]{0,600}?return DROP;/.test(body), "the unadmitted branch returns the REAL drop (`DROP`), never `{ auth: null }` — that dispatches an auth-less turn");
  }

  for (const route of ["routeMessageEvent", "routeNameDropEvent", "routeSupervisorEvent"]) {
    const body = engagementDoor.slice(engagementDoor.indexOf(`export async function ${route}(`));
    const end = body.indexOf("\nexport ", 1);
    const scoped = end > 0 ? body.slice(0, end) : body;
    ok(/tenantFenceDeclined\(ev, "/.test(scoped), `${route} consults the fence before dispatching a turn`);
    ok(scoped.indexOf("tenantFenceDeclined(") < scoped.indexOf("await slackWakeSpendGate("), `…and above ${route}'s spend gate, for the same reason the mention door does`);
    if (scoped.includes("await wakeAfterArm(")) {
      ok(
        scoped.indexOf("tenantFenceDeclined(") < scoped.indexOf("await wakeAfterArm("),
        `…and above ${route}'s wake-arm consult — an unadmitted tenant's text never reaches a consumer's arm`,
      );
    }
  }
  ok(/await wakeAfterArm\(/.test(engagementDoor), "control: the engagement door really does host a wake-arm consult for the ordering check to constrain");
  ok(/auditJoinWakeDropped\(ev, p, UNADMITTED_TENANT_DROP_REASON\)/.test(engagementDoor), "the channel-JOIN door carries it too — an intro is a model turn, and being invited from a foreign workspace is exactly the delivery to refuse");

  const engagementCode = stripComments(engagementDoor);
  const fnRe = /export async function (\w+)\(/g;
  const starts: { name: string; at: number }[] = [];
  for (let m = fnRe.exec(engagementCode); m; m = fnRe.exec(engagementCode)) starts.push({ name: m[1]!, at: m.index });
  let dispatching = 0;
  for (let i = 0; i < starts.length; i++) {
    const body = engagementCode.slice(starts[i]!.at, starts[i + 1]?.at ?? engagementCode.length);
    if (!/deps\.wake\(/.test(body)) continue;
    dispatching++;
    ok(/tenantFenceDeclined\(|slackTenantAdmission\(/.test(body), `TOTALITY: ${starts[i]!.name} dispatches a turn, so it must consult the tenant fence`);
  }
  ok(dispatching >= 4, `…and the scan actually found the dispatching routes (${dispatching}) — an empty scan would pass vacuously`);
  ok(!/deps\.wake\(/.test(stripComments("/** talks about `deps.wake(...)` */\nconst x = 1;")), "the comment strip really removes a doc-comment mention (the scan reads code)");
  ok(/deps\.wake\(/.test(stripComments("await deps.wake(input);")), "…and really keeps a genuine call (it is not stripping everything)");
}

console.log(`slack-tenant-fence: ${n} assertions passed`);
