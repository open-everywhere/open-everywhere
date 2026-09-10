process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerConfig, registerIdentityMapper, defineDomain, getOperationalStore, UNADMITTED_TENANT_DROP_REASON, MULTI_TENANT_ENV } from "@open-everywhere/core/agent/adapter-api.js";
import { bindSlack } from "../agent/channels/slack-identity.js";
import { slackTenantAdmission } from "../agent/channels/slack-tenant-fence.js";
import { admitInbound } from "../agent/channels/slack.js";
import { buildFrontHandler, ThreadFifo } from "../agent/channels/slack-front.js";
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
const HOME_GRID = "E0BHOMEGRID";
const FOREIGN_GRID = "E0BOTHERGRID";
const HOME_DM = "D0BHOMEDM";
const FOREIGN_DM = "D0BFOREIGNDM";
const SECRET = "tenant-fence-signing-secret";
const NOW_MS = 1_784_764_600_000;

let domains = [defineDomain({ name: "mapped", reach: [`slack/${HOME_TEAM}/${HOME_CHANNEL}`], memory: "brain" })];

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

  ok(
    slackTenantAdmission(undefined, FOREIGN_GRID) === "unadmitted",
    "🔴 a workspace-less delivery naming a FOREIGN Grid is UNADMITTED — the org-wide install shape that the workspace-only fence admitted",
  );
  ok(
    slackTenantAdmission(FOREIGN_TEAM, FOREIGN_GRID) === "unadmitted",
    "…and so is a foreign workspace under that Grid (both rungs foreign, refused on both)",
  );
  ok(
    slackTenantAdmission(HOME_TEAM, FOREIGN_GRID) === "proceed",
    "CONTROL: the DECLARED workspace still proceeds whatever Grid it names — admission reads the workspace first, so a Grid rung cannot newly refuse a room the operator declared",
  );

  const declaredDomains = domains;
  domains = [defineDomain({ name: "org-wide", reach: [`slack/${HOME_GRID}/${HOME_CHANNEL}`], memory: "brain" })];
  ok(slackTenantAdmission(undefined, HOME_GRID) === "proceed", "a DECLARED Grid admits its own org-wide delivery — the deployment shape the rung exists to serve");
  ok(slackTenantAdmission("T_SIBLING", HOME_GRID) === "proceed", "…and a workspace under it that is declared nowhere else: Slack puts `enterprise_id` beside `team_id`, so the delivery says the workspace belongs to that organisation");
  ok(slackTenantAdmission("T_SIBLING", undefined) === "unadmitted", "🔴 …but a workspace naming NO organisation is still refused against an enterprise-only declaration — the operator's `E…` line does the admitting, not the id shape");

  domains = [];
  ok(slackTenantAdmission(FOREIGN_TEAM) === "proceed", "🔴 a deployment that declares NO Slack channels is INERT — a fresh clone must keep answering everywhere (memory is opt-in)");
  ok(slackTenantAdmission(undefined, FOREIGN_GRID) === "proceed", "…and inert for the Grid rung too — the new rung must not turn an undeclared deployment into a refusing one");
  domains = declaredDomains;
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
  const mkReq = (body: string): Request => {
    const ts = String(Math.floor(NOW_MS / 1000));
    return new Request("https://oe.test/eve/v1/slack", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`,
      },
      body,
    });
  };

  const dmEnvelope = (eventId: string, teamId: string | undefined, channelId: string, ts: string, channelType: "im" | "mpim" = "im"): string =>
    JSON.stringify({
      type: "event_callback",
      event_id: eventId,
      ...(teamId ? { team_id: teamId } : {}),
      event: { type: "message", channel_type: channelType, channel: channelId, user: "U_ASKER", ts, text: "what's the deploy story here?" },
    });

  const runFront = async (body: string) => {
    const seatCalls: string[] = [];
    const waits: Promise<unknown>[] = [];
    const handler = buildFrontHandler(async () => new Response("inner"), {
      signingSecret: SECRET,
      now: () => NOW_MS,
      markEventSeen: async () => true,
      getBotIdentity: async () => ({ userId: "UBOT", botId: "B_OE_SELF" }),
      fifo: new ThreadFifo(() => {}),
      ambientEnabledFor: () => false,
      dmPartnerTrustFor: async () => "internal",
      channelFactsFor: async () => ({ internal: true, channelType: "im", extShared: false, trustChecked: true }),
      authorFactsFor: async () => ({ surfaceInternal: true, refuted: false }),
      resolveDmSeat: async (_org, dm) => {
        seatCalls.push(dm.surfaceKey);
        return { token: `oe-dom:oe-dm/${dm.surfaceKey}:oe-sup:g1`, generation: 1, freshGeneration: false, tail: [] } as never;
      },
      touchDmSeatFn: async () => {},
    });
    const res = await handler(mkReq(body), {
      from: () => ({ send: async () => ({}) }),
      to: () => ({ send: async () => ({}) }),
      waitUntil: (p: Promise<unknown>) => void waits.push(p),
    } as never);
    await Promise.allSettled(waits);
    return { res, seatCalls };
  };

  {
    const ts = "9101.100";
    const r = await runFront(dmEnvelope("Ev_dm_foreign", FOREIGN_TEAM, FOREIGN_DM, ts));
    ok(r.res.status === 200, "the foreign DM still gets its 200 — Slack must not retry a delivery we decided against");
    ok(r.seatCalls.length === 0, "🔴 UNADMITTED WORKSPACE, DM DOOR: NO DM seat is resolved — the wake never enters the road that mints a window token, delegation and memory under an ambiguous identity");
    const rows = await dropRows(ts);
    ok(rows.length === 1, "…and the operator gets ONE surface.wake_dropped row (the DM door used to drop nothing here, because it refused nothing)");
    const d = (rows[0]!.detail ?? {}) as Record<string, unknown>;
    ok(d.reason === UNADMITTED_TENANT_DROP_REASON, "the row names WHY, via the same greppable reason every other door writes");
    ok(d.door === "dm-im", "…and which ingress door refused it, which is the fact that tells a DM drop from a mention drop");
    ok(d.team === FOREIGN_TEAM, "…and WHICH workspace the decision turned on");
  }

  {
    const ts = "9102.100";
    const r = await runFront(dmEnvelope("Ev_dm_home", HOME_TEAM, HOME_DM, ts));
    ok(r.seatCalls.length === 1, "🔴 CONTROL: the IDENTICAL DM from the DECLARED workspace resolves its seat — the fence refuses a workspace, never the DM door");
    ok((await dropRows(ts)).length === 0, "…and writes no wake_dropped row");
  }

  {
    const ts = "9103.100";
    const r = await runFront(dmEnvelope("Ev_mpim_foreign", FOREIGN_TEAM, "G_FOREIGN", ts, "mpim"));
    ok(r.seatCalls.length === 0, "a GROUP DM from the unadmitted workspace is refused on the same road — the mpim family is not a way around the DM fence");
    ok(((await dropRows(ts))[0]?.detail as { door?: unknown } | undefined)?.door === "dm-mpim", "…and its row names the mpim door, so the two families stay distinguishable on the trail");
  }
}

{
  const here = fileURLToPath(new URL(".", import.meta.url));
  const read = (rel: string) => readFileSync(`${here}../agent/channels/${rel}`, "utf8");
  const mentionDoor = read("slack.ts");
  const engagementDoor = read("slack-events.ts");
  const frontDoor = read("slack-front.ts");
  const fence = read("slack-tenant-fence.ts");

  ok(/import \{ slackTenantAdmission \} from "\.\/slack-tenant-fence\.js"/.test(mentionDoor), "MENTION DOOR: slack.ts imports the shared fence helper");
  ok(/slackTenantAdmission\(message\.teamId, mentionEnterpriseId\) === "unadmitted"/.test(mentionDoor), "…and consults it on the delivery's own teamId AND the Grid rung the forward carried (OPE-1645)");
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

  {
    const frontCode = stripComments(frontDoor);
    const dispatchers: { readonly name: string; readonly dispatch: RegExp }[] = [
      { name: "scheduleDmWake", dispatch: /await divertToUnifiedWindow\(/ },
      { name: "scheduleUnownedWake", dispatch: /routeSupervisorEvent\(|routeNameDropEvent\(/ },
    ];
    for (const d of dispatchers) {
      const at = frontCode.indexOf(`const ${d.name} = `);
      ok(at > 0, `TOTALITY(front): ${d.name} is found in the source at all — a renamed dispatcher must red this scan, never silently empty it`);
      const body = frontCode.slice(at, frontCode.indexOf("\n    const schedule", at + 1) > at ? frontCode.indexOf("\n    const schedule", at + 1) : frontCode.length);
      ok(d.dispatch.test(body), `TOTALITY(front): ${d.name} really does dispatch a turn (the premise the fence requirement below rests on)`);
    }
    const dmAt = frontCode.indexOf("const scheduleDmWake = ");
    const dmBody = frontCode.slice(dmAt, frontCode.indexOf("await divertToUnifiedWindow(", dmAt));
    ok(/slackFrontTenantFenceDeclined\(/.test(dmBody), "🔴 TOTALITY(front): scheduleDmWake dispatches a turn onto the DM SEAT, so it must consult the tenant fence — the assertion that was missing when the door had none");
    ok(
      dmBody.indexOf("slackFrontTenantFenceDeclined(") < dmBody.indexOf("resolveDmSeat("),
      "…and ABOVE the seat resolve, so an unadmitted workspace mints no window token, no delegation and no memory",
    );
    ok(/import \{ slackTenantAdmission \} from "\.\/slack-tenant-fence\.js"/.test(read("slack-events.ts")), "the front route's fence call reaches the SHARED helper (slack-events.ts owns the one body, and slack-front.ts imports it) — never a forked copy of the rule at a third door");
    ok(!/classifyTenantAdmission/.test(frontDoor), "…and the front route holds no copy of the core DECISION either");
  }
  ok(!/deps\.wake\(/.test(stripComments("/** talks about `deps.wake(...)` */\nconst x = 1;")), "the comment strip really removes a doc-comment mention (the scan reads code)");
  ok(/deps\.wake\(/.test(stripComments("await deps.wake(input);")), "…and really keeps a genuine call (it is not stripping everything)");
}

console.log(`slack-tenant-fence: ${n} assertions passed`);
