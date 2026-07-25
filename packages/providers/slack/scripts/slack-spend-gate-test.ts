import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  registerConfig,
  registerIdentityMapper,
  defineDomain,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";
import { bindSlack } from "../agent/channels/slack-identity.js";
import { slackSpendGate, spendRefusalCopy, spendBypassWarnCopy, type SpendGateAuditRow } from "../agent/channels/slack-spend-gate.js";

for (const k of ["OE_PLATFORM", "OE_WORKSPACE", "OE_SURFACE", "OE_CHANNEL", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_ORG", "OE_TRUST", "OE_TEST_DRIVER_IDS"]) {
  delete process.env[k];
}

registerIdentityMapper("slack", bindSlack);
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "transactions", channels: ["slack/T_ENG/C_TXN"], memory: "txn" })],
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
  door?: "mention" | "engagement";
  principalId?: string;
}): Promise<{ decision: string; posts: string[]; audits: SpendGateAuditRow[] }> {
  const posts: string[] = [];
  const audits: SpendGateAuditRow[] = [];
  const decision = await slackSpendGate({
    bindable: BINDABLE,
    mode: "channel",
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
  const r = await run({ verdict: { over: false } });
  ok(r.decision === "proceed", "under cap → proceed");
  ok(r.posts.length === 0, "under cap posts nothing");
  ok(r.audits.length === 1 && r.audits[0]!.action === "spend.gate", "under cap still writes the spend.gate row (the S10 debug aid)");
  ok((r.audits[0]!.detail as Record<string, unknown>).over === false, "under-cap row records over:false");
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
  const m = await run({ door: "mention" });
  const e = await run({ door: "engagement" });
  ok((m.audits[0]!.detail as Record<string, unknown>).door === "mention", "the mention door stamps door:\"mention\"");
  ok((e.audits[0]!.detail as Record<string, unknown>).door === "engagement", "the engagement door stamps door:\"engagement\"");
  ok((m.audits[0]!.detail as Record<string, unknown>).mode === "channel", "the row still carries the session mode");
}

ok(spendRefusalCopy("over cap", "slack/T/C", "slack/T").includes(":no_entry:"), "refusal copy carries the :no_entry: marker");
ok(spendBypassWarnCopy("over cap").includes(":warning:"), "bypass copy carries the :warning: marker");

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (rel: string) => readFileSync(`${here}../agent/channels/${rel}`, "utf8");

const mentionDoor = read("slack.ts");
ok(/import \{ slackSpendGate \} from "\.\/slack-spend-gate\.js"/.test(mentionDoor), "slack.ts imports the shared gate");
ok(/await slackSpendGate\(/.test(mentionDoor), "MENTION DOOR: slack.ts onInbound calls slackSpendGate");
ok(/door: "mention"/.test(mentionDoor), "the mention door labels itself");
ok(!/scopeOverBudget|capBypassFor/.test(mentionDoor), "slack.ts no longer hand-rolls the gate (no forked scopeOverBudget/capBypassFor)");

const engagementDoor = read("slack-events.ts");
ok(/import \{ slackSpendGate, type SpendGateDecision \} from "\.\/slack-spend-gate\.js"/.test(engagementDoor), "slack-events.ts imports the shared gate");
ok(/door: "engagement"/.test(engagementDoor), "the engagement door labels itself");
const wired = engagementDoor.match(/await slackWakeSpendGate\(/g) ?? [];
ok(wired.length >= 3, `ENGAGEMENT DOOR: every wake route gates (found ${wired.length} call sites; expected the engaged-thread, name-drop and supervisor routes)`);
for (const route of ["routeMessageEvent", "routeNameDropEvent", "routeSupervisorEvent"]) {
  const body = engagementDoor.slice(engagementDoor.indexOf(`export async function ${route}(`));
  const end = body.indexOf("\nexport ", 1);
  ok(/await slackWakeSpendGate\(/.test(end > 0 ? body.slice(0, end) : body), `${route} calls the gate before dispatching a turn`);
}

console.log(`slack-spend-gate: ${n} assertions passed`);
