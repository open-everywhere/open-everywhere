process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  registerConfig,
  registerIdentityMapper,
  defineDomain,
  getOperationalStore,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";
import { bindSlack } from "../agent/channels/slack-identity.js";
import { slackSpendGate, spendRefusalCopy, spendBypassWarnCopy, type SpendGateAuditRow } from "../agent/channels/slack-spend-gate.js";
import { admitInbound } from "../agent/channels/slack.js";
import { parseMessageEvent, routeSupervisorEvent, supervisorToken, type SupervisorRouteDeps } from "../agent/channels/slack-events.js";
import { stripComments } from "./_source-scan-utils.js";
import { _resetDeploymentIdentityForTest } from "@open-everywhere/core/agent/adapter-api.js";

_resetDeploymentIdentityForTest();
for (const k of ["OE_PLATFORM", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST", "OE_TEST_DRIVER_IDS"]) {
  delete process.env[k];
}

let domains = [defineDomain({ name: "transactions", reach: ["slack/T_ENG/C_TXN"], memory: "txn" })];

registerIdentityMapper("slack", bindSlack);
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [{ name: "txn", provider: "sqlite" }],
  domainsForSurface: ({ surface }) => (surface === "C_TXN" ? ["transactions"] : []),
});

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const BINDABLE: BindableContext = {
  channel: { kind: "slack" },
  session: {
    auth: {
      current: {
        attributes: { team_id: "T_ENG", channel_id: "C_TXN", channel_type: "channel", is_ext_shared: "false", trust_checked: "true" },
        principalId: "U_ASKER",
        principalType: "slack-user",
      },
    },
  },
};

async function run(opts: {
  verdict?: { over: boolean; reason?: string };
  throwCheck?: boolean;
  bypass?: { warn: boolean } | null;
  throwAudit?: boolean;
  throwPost?: boolean;
  door?: "mention" | "engagement" | "join";
  principalId?: string;
  mode?: "channel" | "dm" | "mpim";
}): Promise<{ decision: string; posts: string[]; audits: SpendGateAuditRow[] }> {
  const posts: string[] = [];
  const audits: SpendGateAuditRow[] = [];
  const decision = await slackSpendGate({
    bindable: BINDABLE,
    mode: opts.mode ?? "channel",
    principalId: "principalId" in opts ? opts.principalId : "U_ASKER",
    teamId: "T_ENG",
    door: opts.door ?? "mention",
    post: async (text) => {
      if (opts.throwPost) throw new Error("slack post failed");
      posts.push(text);
    },
    checkOverBudget: async () => {
      if (opts.throwCheck) throw new Error("budget read exploded");
      return opts.verdict ?? { over: false };
    },
    bypassFor: async () => opts.bypass ?? null,
    appendGateAudit: async (row) => {
      if (opts.throwAudit) throw new Error("audit sink down");
      audits.push(row);
    },
  });
  return { decision, posts, audits };
}

{
  const seen: { enterprise?: string }[] = [];
  const gate = (attrs: Record<string, string>) =>
    slackSpendGate({
      bindable: {
        channel: { kind: "slack" },
        session: {
          auth: {
            current: {
              attributes: { team_id: "T_ENG", channel_id: "C_TXN", channel_type: "channel", is_ext_shared: "false", trust_checked: "true", ...attrs },
              principalId: "U_ASKER",
              principalType: "slack-user",
            },
          },
        },
      },
      mode: "channel",
      principalId: "U_ASKER",
      teamId: "T_ENG",
      door: "mention",
      post: async () => undefined,
      checkOverBudget: async () => ({ over: true, reason: "over cap" }),
      bypassFor: async (input) => {
        seen.push({ ...(input.enterprise === undefined ? {} : { enterprise: input.enterprise }) });
        return null;
      },
      appendGateAudit: async () => undefined,
    });
  await gate({ enterprise_id: "E_GRID" });
  ok(seen[0]?.enterprise === "E_GRID", "🔴 OPE-2400: the spend gate hands the delivery's Grid id to the admin bypass");
  await gate({});
  ok(seen[1]?.enterprise === undefined, "OPE-2400 NEGATIVE CONTROL: a delivery with no Grid hands none");
}

{
  const r = await run({ verdict: { over: false } });
  ok(r.decision === "proceed", "under cap → proceed");
  ok(r.posts.length === 0, "under cap posts nothing");
  ok(r.audits.length === 0, "under cap writes NO spend.gate row (narrowed post-S10-green: a row means the cap bit)");
}

{
  const r = await run({ verdict: { over: true, reason: "this channel is over its $5.00 monthly cap" } });
  ok(r.decision === "declined", "over cap + no bypass → declined");
  ok(r.posts.length === 1 && r.posts[0]!.startsWith(":no_entry:"), "over cap posts the :no_entry: refusal");
  ok(r.posts[0]!.includes("slack/T_ENG/C_TXN"), "the refusal names this surface's scope key (a DM'd model has no other way to learn it)");
  ok(r.posts[0]!.includes("slack/T_ENG`"), "the refusal names the whole-workspace scope key too");
  ok((r.audits[0]!.detail as Record<string, unknown>).over === true, "over-cap row records over:true");
  ok((r.audits[0]!.detail as Record<string, unknown>).reason === "this channel is over its $5.00 monthly cap", "the tripped cap's reason rides the audit row");
}

{
  const r = await run({ verdict: { over: true, reason: "over cap" }, bypass: { warn: true } });
  ok(r.decision === "proceed", "over cap + admin bypass → proceed (sudo semantics: the guardrail never locks out the budget owner)");
  ok(r.posts.length === 1 && r.posts[0]!.startsWith(":warning:"), "a warned bypass posts the :warning:, never the refusal");
}

{
  const r = await run({ verdict: { over: true, reason: "over cap" }, bypass: { warn: false } });
  ok(r.decision === "proceed", "throttled bypass still proceeds");
  ok(r.posts.length === 0, "a throttled bypass posts nothing (the throttle is UX; the audit row is accountability)");
}

{
  const r = await run({ throwCheck: true });
  ok(r.decision === "proceed", "a check that throws FAILS OPEN → proceed (a broken budget read must never take the agent off the air)");
  ok(r.posts.length === 0, "fail-open posts nothing");
}

{
  const r = await run({ verdict: { over: true, reason: "over cap" }, throwAudit: true });
  ok(r.decision === "declined", "an audit-sink failure is observability-only — the decision still stands");
  ok(r.posts.length === 1, "…and the refusal is still posted");
}

{
  const r = await run({ verdict: { over: true, reason: "over cap" }, throwPost: true });
  ok(r.decision === "declined", "a failed refusal post still DECLINES (fail-closed on spend: a lost message must not buy a turn)");
}

{
  const r = await run({ verdict: { over: true, reason: "over cap" }, principalId: undefined });
  ok(r.decision === "declined", "no principal id → no bypass is possible → declined");
}

{
  const m = await run({ door: "mention", verdict: { over: true, reason: "over cap" } });
  const e = await run({ door: "engagement", verdict: { over: true, reason: "over cap" } });
  const j = await run({ door: "join", verdict: { over: true, reason: "over cap" } });
  ok((m.audits[0]!.detail as Record<string, unknown>).door === "mention", "the mention door stamps door:\"mention\"");
  ok((e.audits[0]!.detail as Record<string, unknown>).door === "engagement", "the engagement door stamps door:\"engagement\"");
  ok((j.audits[0]!.detail as Record<string, unknown>).door === "join", "the channel-join door stamps door:\"join\"");
  ok((m.audits[0]!.detail as Record<string, unknown>).mode === "channel", "the row still carries the session mode");
}

ok(spendRefusalCopy({ reason: "over cap", surfaceKey: "slack/T/C", workspaceKey: "slack/T", mode: "channel" }).includes(":no_entry:"), "refusal copy carries the :no_entry: marker");
ok(spendBypassWarnCopy("over cap").includes(":warning:"), "bypass copy carries the :warning: marker");

{
  const r = await run({ mode: "dm", verdict: { over: true, reason: "this DM reached its monthly budget (~$5.10 of $5.00)" } });
  ok(r.decision === "declined", "OPE-267: an over-budget DM with no admin bypass is DECLINED — no model turn");
  ok(!/DM me/i.test(r.posts[0]!), 'OPE-267: the DM refusal never says "DM me" — the reader is already in the DM');
  ok(/ask an org admin/i.test(r.posts[0]!), "OPE-267: the DM refusal names the remedy that works from there (ask an org admin)");
  ok(r.posts[0]!.includes("slack/T_ENG/C_TXN"), "OPE-267: the DM refusal still names the scope key, so the admin it points at can act on it");
  const c = await run({ verdict: { over: true, reason: "over cap" } });
  ok(/DM me/i.test(c.posts[0]!), "the CHANNEL refusal still points at a DM (an admin raising a channel's cap from their DM is the flow that survives)");
}
{
  const r = await run({ mode: "dm", verdict: { over: true, reason: "this workspace reached its monthly budget (~$500.00 of $200.00)" }, bypass: { warn: true } });
  ok(r.decision === "proceed", "OPE-267 acceptance: an ORG ADMIN's own DM turn proceeds past a fully-burned workspace budget");
  ok(r.posts[0]!.startsWith(":warning:"), "…and VISIBLY: the admin is told they are spending past the cap, not silently exempted");
  ok(r.audits.length === 1 && (r.audits[0]!.detail as Record<string, unknown>).mode === "dm", "…and AUDITED: the spend.gate row records the DM the bypass happened in");
}

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (rel: string) => readFileSync(`${here}../agent/channels/${rel}`, "utf8");

const mentionDoor = read("slack.ts");
ok(/import \{ slackSpendGate \} from "\.\/slack-spend-gate\.js"/.test(mentionDoor), "slack.ts imports the shared gate");
ok(/await slackSpendGate\(/.test(mentionDoor), "MENTION DOOR: slack.ts onInbound calls slackSpendGate");
ok(/door: "mention"/.test(mentionDoor), "the mention door labels itself");
ok(!/scopeOverBudget|capBypassFor/.test(mentionDoor), "slack.ts no longer hand-rolls the gate (no forked scopeOverBudget/capBypassFor)");

const engagementDoor = read("slack-events.ts");
ok(/import \{ slackSpendGate, type SpendGateDecision(?:, type SpendGateDoor)? \} from "\.\/slack-spend-gate\.js"/.test(engagementDoor), "slack-events.ts imports the shared gate");
ok(/door: "engagement"/.test(engagementDoor), "the engagement door labels itself");
ok(/door: "join"/.test(engagementDoor), "the channel-join door labels itself");
const wired = engagementDoor.match(/await slackWakeSpendGate\(/g) ?? [];
ok(wired.length >= 3, `ENGAGEMENT DOOR: every wake route gates (found ${wired.length} call sites; expected the engaged-thread, name-drop and supervisor routes)`);
for (const route of ["routeMessageEvent", "routeNameDropEvent", "routeSupervisorEvent"]) {
  const body = engagementDoor.slice(engagementDoor.indexOf(`export async function ${route}(`));
  const end = body.indexOf("\nexport ", 1);
  ok(/await slackWakeSpendGate\(/.test(end > 0 ? body.slice(0, end) : body), `${route} calls the gate before dispatching a turn`);
}

{
  const engagementCode = stripComments(engagementDoor);
  const fnRe = /export async function (\w+)\(/g;
  const starts: { name: string; at: number }[] = [];
  for (let m = fnRe.exec(engagementCode); m; m = fnRe.exec(engagementCode)) starts.push({ name: m[1]!, at: m.index });
  let dispatching = 0;
  for (let i = 0; i < starts.length; i++) {
    const body = engagementCode.slice(starts[i]!.at, starts[i + 1]?.at ?? engagementCode.length);
    if (!/deps\.wake\(/.test(body)) continue;
    dispatching++;
    ok(/SpendGate\(/.test(body), `${starts[i]!.name} dispatches a turn (deps.wake) and therefore MUST consult a spend gate`);
  }
  ok(dispatching >= 4, `the scan actually found the dispatching routes (saw ${dispatching}; expected engaged-thread, name-drop, supervisor and channel-join)`);
  ok(!/deps\.wake\(/.test(stripComments("/** talks about `deps.wake(...)` */\nconst x = 1;")), "the comment strip really removes a doc-comment mention (the scan reads code)");
  ok(/deps\.wake\(/.test(stripComments("await deps.wake(input);")), "…and really keeps a genuine call (it is not stripping everything)");
}

ok(
  /thread_ts=\$\{encodeURIComponent\(threadRootTs\)\}/.test(engagementDoor),
  "ENGAGEMENT DOOR: the refusal posts threaded under the wake's thread root (thread_ts=<root>)",
);
ok(
  /thread_ts=\$\{encodeURIComponent\(ev\.ts\)\}/.test(engagementDoor),
  "JOIN DOOR: the refusal posts threaded under the join notice",
);
ok(
  /door: "mention",[\s\S]{0,200}post: async \(text\) => \{\s*await ctx\.thread\.post\(text\);/.test(mentionDoor),
  "MENTION DOOR: the refusal posts through ctx.thread (rooted at thread_ts||ts — the wake's own root)",
);

const codeOf = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
ok(!/return \{ auth: null \}/.test(codeOf(mentionDoor)), "slack.ts contains NO counterfeit `return { auth: null }` drop (it dispatches a turn)");
ok(/^const DROP = null;$/m.test(mentionDoor), "slack.ts names the real drop (`const DROP = null`)");
ok(/onAppMention: \(ctx, message\) => admitInbound\(/.test(mentionDoor), "onAppMention is wired to the admission chokepoint, not onInbound");
ok(/onDirectMessage: \(ctx, message\) => admitInbound\(/.test(mentionDoor), "onDirectMessage is wired to the admission chokepoint, not onInbound");
ok(/consult\.gated = true;/.test(mentionDoor), "the mention door's gate consult records itself for the chokepoint");

{
  const msg = { channelId: "C_TXN", ts: "1700.1" } as never;
  const ctx = {} as never;

  const admitted = await admitInbound(ctx, msg, false, async (consult) => {
    consult.gated = true;
    return { auth: { attributes: {} } as never };
  });
  ok(admitted !== null, "a gated wake is admitted (a turn runs)");

  const ungated = await admitInbound(ctx, msg, false, async () => ({ auth: { attributes: {} } as never }));
  ok(ungated === null, "FAIL-CLOSED: a wake admitted without a spend-gate consult is dropped, not spent");

  const ungatedAuthless = await admitInbound(ctx, msg, false, async () => ({ auth: null }));
  ok(ungatedAuthless === null, "the exact live shape — an un-gated `{ auth: null }` — is dropped (it used to run an auth-less turn)");

  const dropped = await admitInbound(ctx, msg, false, async () => null);
  ok(dropped === null, "a real DROP passes straight through (nothing to gate: no turn, no spend)");
}

{
  const TEAM = "T0EXAMPLE";
  const DRIVER_BOT = "B0EXBOT0001";
  const OTHER_BOT = "B0BZZZOTHER";
  const CHANNEL = "C0EXCHAN006";
  process.env.OE_TEST_DRIVER_IDS = `${TEAM}:${DRIVER_BOT}`;
  domains = [defineDomain({ name: "transactions", reach: [`slack/${TEAM}/C_TXN`], memory: "txn" })];
  const store = getOperationalStore();

  const ambient = (over: Record<string, unknown>, ts: string) =>
    parseMessageEvent({
      type: "event_callback",
      team_id: TEAM,
      event: { type: "message", channel: CHANNEL, ts, user: "U_ASKER", channel_type: "channel", text: "what is this channel for?", ...over },
    } as never)!;

  const wakes: unknown[] = [];
  const supDeps = {
    confirmInternalWithMeta: async () => ({ internal: true, memberCount: 3 }),
    getOrCreateSession: async (_org: string, _sk: string, channelId: string) => ({ token: supervisorToken(channelId, 1), generation: 1, freshGeneration: false }),
    touchSession: async () => {},
    wake: async (input: unknown) => {
      wakes.push(input);
    },
  } as unknown as SupervisorRouteDeps;

  const dropRows = async (ts: string) => {
    for (let i = 0; i < 20; i++) {
      const rows = await store.readAudit({ org: "default", action: "surface.wake_dropped" });
      const mine = rows.filter((r) => (r.detail as { ts?: unknown } | undefined)?.ts === ts);
      if (mine.length > 0) return mine;
      await new Promise((r) => setTimeout(r, 10));
    }
    return [];
  };

  wakes.length = 0;
  const allowed = await routeSupervisorEvent(ambient({ bot_id: DRIVER_BOT }, "9001.1"), supDeps);
  ok(allowed.woke === true && wakes.length === 1, "ALLOWLISTED driver bot + ambient non-mention message → the supervisor wake DISPATCHES (the carve-out survives)");
  ok((await dropRows("9001.1")).length === 0, "…and an admitted wake writes NO surface.wake_dropped row (a row must mean a drop, or the trail is noise)");

  wakes.length = 0;
  const foreign = await routeSupervisorEvent(ambient({ bot_id: OTHER_BOT }, "9002.1"), supDeps);
  ok(foreign.woke === false && wakes.length === 0, "NON-allowlisted bot author → no supervisor wake (loop safety holds)");
  const rows = await dropRows("9002.1");
  ok(rows.length === 1, "…and the drop writes exactly ONE surface.wake_dropped audit row (zero-rows-on-drop was the observability bug)");
  {
    const d = (rows[0]!.detail ?? {}) as Record<string, unknown>;
    ok(d.reason === "bot author is not an allowlisted driver", "the row names WHY the wake was dropped");
    ok(d.door === "engagement", "the row names the ingress door (engagement — the mention door audits its own)");
    ok(d.botId === OTHER_BOT && d.channel === CHANNEL, "the row carries the offending bot record + channel (enough to fix the allowlist from the audit alone)");
  }

  wakes.length = 0;
  const human = await routeSupervisorEvent(ambient({}, "9003.1"), supDeps);
  ok(human.woke === true && wakes.length === 1, "human-authored ambient message still dispatches (no new gate on the ordinary path)");
  ok((await dropRows("9003.1")).length === 0, "…writing no row");

  delete process.env.OE_TEST_DRIVER_IDS;
}

{
  const declines = engagementDoor.match(/=== "declined"\) \{\n\s*audit(?:Engagement|Join)WakeDropped\(/g) ?? [];
  ok(declines.length === 4, `every spend-gate decline audits its drop (found ${declines.length}; expected the engaged-thread, name-drop, supervisor and join doors)`);
}

console.log(`slack-spend-gate: ${n} assertions passed`);
