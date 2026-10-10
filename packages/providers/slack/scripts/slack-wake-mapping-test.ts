process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  registerConfig,
  registerIdentityMapper,
  defineDomain,
  getOperationalStore,
  classifyWakeMapping,
  unmappedWakeCopy,
  UNMAPPED_WAKE_DROP_REASON,
} from "@open-everywhere/core/agent/adapter-api.js";
import { bindSlack } from "../agent/channels/slack-identity.js";
import { admitInbound } from "../agent/channels/slack.js";
import { _resetDeploymentIdentityForTest } from "@open-everywhere/core/agent/adapter-api.js";

_resetDeploymentIdentityForTest();
for (const k of ["OE_PLATFORM", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST"]) {
  delete process.env[k];
}

const MAPPED_TEAM = "T0EXAMPLE";
const MAPPED_CHANNEL = "C0EXCHAN005";
const UNMAPPED_CHANNEL = "C0BKUNMAPPED";

registerIdentityMapper("slack", bindSlack);
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "mapped", reach: [`slack/${MAPPED_TEAM}/${MAPPED_CHANNEL}`], memory: "brain" })],
  loadSilos: () => [{ name: "brain", provider: "sqlite" }],
  domainsForSurface: ({ surface }) => (surface === MAPPED_CHANNEL ? ["mapped"] : []),
});

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

ok(classifyWakeMapping({ platform: "slack", mode: "channel", workspaceId: undefined }) === "unmapped", "channel wake with NO workspace id → unmapped");
ok(classifyWakeMapping({ platform: "slack", mode: "channel", workspaceId: "" }) === "unmapped", "an empty workspace id is no workspace id");
ok(classifyWakeMapping({ platform: "slack", mode: "channel", workspaceId: "   " }) === "unmapped", "…and neither is a blank one (the heal returns nothing, not whitespace — but a surface could)");
ok(classifyWakeMapping({ platform: "slack", mode: "channel", workspaceId: MAPPED_TEAM }) === "proceed", "a resolved workspace proceeds — the ordinary path is untouched");
ok(classifyWakeMapping({ platform: "slack", mode: "dm", workspaceId: undefined }) === "proceed", "DMs are EXEMPT: a DM is never domain-mapped, so an unresolved workspace there is not a config hole");
ok(classifyWakeMapping({ platform: "slack", mode: "mpim", workspaceId: undefined }) === "proceed", "group DMs are exempt for the same reason");
ok(classifyWakeMapping({ platform: "local", mode: "channel", workspaceId: undefined }) === "proceed", "the `local` binding is exempt — `eve dev`/tests resolve identity from env stand-ins");
ok(classifyWakeMapping({ platform: "discord", mode: "channel", workspaceId: undefined }) === "unmapped", "the rule is platform-agnostic (any real surface can adopt it at its own door)");

{
  const copy = unmappedWakeCopy("slack", UNMAPPED_CHANNEL);
  ok(copy.includes(UNMAPPED_CHANNEL), "the nudge names the channel id the operator must map");
  ok(copy.includes("agent/memory/config/domains/<name>.ts"), "…the per-domain file to edit");
  ok(copy.includes("`reach`") && !copy.includes("`channels`"), "…naming the CURRENT field — a nudge that names a removed one sends the operator to an edit the config refuses");
  ok(copy.includes(`slack/<workspace-id>/${UNMAPPED_CHANNEL}`), "…and the exact fully-qualified line shape to add");
  ok(copy.length < 400, "…terse (tool-instruction-brevity: a config nudge, not an essay)");
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

const messageIn = (channelId: string, ts: string) =>
  ({
    channelId,
    ts,
    threadTs: ts,
    markdown: "hey, what's the deploy story here?",
    author: { userId: "U_ASKER", isBot: false },
    teamId: undefined,
    raw: { channel_type: "channel" },
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
  const outcome = await admitInbound(fakeCtx(posts), messageIn(UNMAPPED_CHANNEL, "8001.1"), false);

  ok(outcome === null, "UNMAPPED CHANNEL: the wake DROPS — eve dispatches no model turn at all");
  ok(posts.length === 1, "…and the channel is told exactly once");
  ok(posts[0] === unmappedWakeCopy("slack", UNMAPPED_CHANNEL), "…with the shared operator nudge (not a forked string)");

  const rows = await dropRows("8001.1");
  ok(rows.length === 1, "…and the drop leaves ONE surface.wake_dropped row (a silent drop is unreadable in a webhook process)");
  {
    const d = (rows[0]!.detail ?? {}) as Record<string, unknown>;
    ok(d.reason === UNMAPPED_WAKE_DROP_REASON, "the row names WHY (the one greppable reason string)");
    ok(d.door === "mention", "the row names the ingress door");
    ok(d.channel === UNMAPPED_CHANNEL, "the row carries the channel to map — enough to fix the config from the trail alone");
  }
}

{
  const posts: string[] = [];
  const outcome = await admitInbound(fakeCtx(posts), messageIn(MAPPED_CHANNEL, "8002.1"), false);
  ok(outcome !== null, "MAPPED CHANNEL: the same team-less shape heals its team from config and is ADMITTED (the guard is not a blanket refusal)");
  ok(!posts.includes(unmappedWakeCopy("slack", MAPPED_CHANNEL)), "…and is never told it's unmapped");
  ok((await dropRows("8002.1")).length === 0, "…and writes no wake_dropped row");
}

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (rel: string) => readFileSync(`${here}../agent/channels/${rel}`, "utf8");
const mentionDoor = read("slack.ts");
const engagementDoor = read("slack-events.ts");

ok(/classifyWakeMapping\(\{ platform: "slack", mode, workspaceId: message\.teamId \}\) === "unmapped"/.test(mentionDoor), "MENTION DOOR: onInbound consults the shared guard on the HEALED teamId");
ok(!/function classifyWakeMapping/.test(mentionDoor), "…via the core helper, not a forked copy of the rule");

{
  const body = mentionDoor.slice(mentionDoor.indexOf("async function onInbound("));
  ok(body.indexOf("classifyWakeMapping(") < body.indexOf("await slackSpendGate("), "the tenant guard runs BEFORE the spend gate (an unresolved workspace can't be keyed for a cap)");
  ok(/=== "unmapped"\) \{[\s\S]{0,600}?return DROP;/.test(body), "the unmapped branch returns the REAL drop (`DROP`), never `{ auth: null }`");
}

ok(/envelope\.team_id \?\? \(typeof e\.team === "string" \? e\.team : undefined\)/.test(engagementDoor), "ENGAGEMENT DOOR: teamId is read off the event ENVELOPE (always present) — no heal gap, hence no guard there");

console.log(`slack-wake-mapping: ${n} assertions passed`);
