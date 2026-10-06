import { slackGovernanceRoster } from "../agent/channels/slack-events.js";
import type { RoomRoster } from "@open-everywhere/core/agent/adapter-api.js";
import { withPatchedFetch } from "./_fetch-test-utils.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  n++;
};

process.env.SLACK_BOT_TOKEN = "xoxb-governance-roster-never-real";

type SlackAnswer = Record<string, unknown> | "network-error" | { readonly status: number };

function fakeSlack(answers: Readonly<Record<string, SlackAnswer>>): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = new URL(url).pathname.split("/").pop() ?? "";
    const answer = answers[method];
    if (answer === undefined) throw new Error(`unexpected Slack call: ${method}`);
    if (answer === "network-error") throw new TypeError("fetch failed");
    if ("status" in answer && typeof answer.status === "number") {
      return new Response(JSON.stringify({ ok: false, error: "internal_error" }), { status: answer.status });
    }
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const roster = (answers: Readonly<Record<string, SlackAnswer>>): Promise<RoomRoster | undefined> =>
  withPatchedFetch(fakeSlack(answers), () => slackGovernanceRoster("C_ROOM"));

const INFO_OK = { ok: true, channel: { id: "C_ROOM", is_channel: true, is_private: false, is_ext_shared: false } };
const MEMBERS_OK = { ok: true, members: ["U_A", "U_BOT"], response_metadata: { next_cursor: "" } };
const AUTH_OK = { ok: true, user_id: "U_BOT" };

{
  const r = await roster({ "conversations.info": INFO_OK, "conversations.members": MEMBERS_OK, "auth.test": AUTH_OK });
  ok(r?.resolved === true && r.unresolvedState === undefined, "a good read resolves");
  ok(r?.humanMemberIds.length === 1 && r.humanMemberIds[0] === "U_A", "the bot's own id is dropped from the roster");
}

for (const [label, answers] of [
  ["conversations.info rate-limited", { "conversations.info": { ok: false, error: "ratelimited" } }],
  ["conversations.info with an unknown error code", { "conversations.info": { ok: false, error: "some_new_error" } }],
  ["conversations.info network error", { "conversations.info": "network-error" }],
  ["conversations.info HTTP 500", { "conversations.info": { status: 500 } }],
  ["conversations.info ok with no channel object", { "conversations.info": { ok: true }, "conversations.members": MEMBERS_OK, "auth.test": AUTH_OK }],
  ["conversations.members rate-limited", { "conversations.info": INFO_OK, "conversations.members": { ok: false, error: "ratelimited" } }],
  ["conversations.members network error", { "conversations.info": INFO_OK, "conversations.members": "network-error" }],
  [
    "conversations.info ok with no channel object, members longer than one page",
    { "conversations.info": { ok: true }, "conversations.members": { ok: true, members: ["U_A"], response_metadata: { next_cursor: "dXNlcjpVMDYx" } } },
  ],
] as const) {
  const r = await roster(answers as Readonly<Record<string, SlackAnswer>>);
  ok(r !== undefined && r.resolved === false && r.unresolvedState === "failed", `🔴 ${label} → failed (the connector-disclosure floor refuses on it)`);
}

for (const [label, answers] of [
  ["conversations.info missing_scope", { "conversations.info": { ok: false, error: "missing_scope" } }],
  ["conversations.info channel_not_found", { "conversations.info": { ok: false, error: "channel_not_found" } }],
  ["conversations.info no_permission", { "conversations.info": { ok: false, error: "no_permission" } }],
  ["conversations.info team_access_not_granted", { "conversations.info": { ok: false, error: "team_access_not_granted" } }],
  ["conversations.members not_in_channel", { "conversations.info": INFO_OK, "conversations.members": { ok: false, error: "not_in_channel" } }],
  [
    "a members list longer than one page",
    { "conversations.info": INFO_OK, "conversations.members": { ok: true, members: ["U_A"], response_metadata: { next_cursor: "dXNlcjpVMDYx" } } },
  ],
] as const) {
  const r = await roster(answers as Readonly<Record<string, SlackAnswer>>);
  ok(
    r !== undefined && r.resolved === false && r.unresolvedState === "unobservable",
    `${label} → unobservable (the observed-guest legs stay inert, the clicker floor's beneficiary leg still refuses; a refusal would be a standing outage)`,
  );
}

const PAGE_2 = { ok: true, members: ["U_A"], response_metadata: { next_cursor: "dXNlcjpVMDYx" } };
for (const bit of ["is_ext_shared", "is_org_shared", "is_shared", "is_pending_ext_shared"] as const) {
  for (const isPrivate of [false, true]) {
    const info = { ok: true, channel: { id: "C_ROOM", is_channel: true, is_private: isPrivate, [bit]: true } };
    const r = await roster({ "conversations.info": info, "conversations.members": PAGE_2 });
    ok(
      r !== undefined && r.resolved === true && r.unresolvedState === undefined && r.hasGuest === true,
      `🔴 ${bit} (private=${isPrivate}) with a members list longer than one page → resolved, hasGuest (the guest floors arm)`,
    );
    ok(r?.humanMemberIds.length === 0, `${bit} (private=${isPrivate}) multi-page: the roster carries NO partial member list`);
    ok(r?.isPrivate === isPrivate, `${bit} (private=${isPrivate}) multi-page: isPrivate still comes from conversations.info`);
  }
}
{
  const r = await roster({ "conversations.info": INFO_OK, "conversations.members": PAGE_2 });
  ok(
    r !== undefined && r.resolved === false && r.unresolvedState === "unobservable" && r.hasGuest === false,
    "negative control: a NON-shared channel longer than one page stays unobservable (today's behaviour)",
  );
}
{
  const info = { ok: true, channel: { id: "C_ROOM", is_channel: true, is_private: false, is_ext_shared: true } };
  const r = await roster({ "conversations.info": info, "conversations.members": MEMBERS_OK, "auth.test": AUTH_OK });
  ok(r?.resolved === true && r.hasGuest === true && r.humanMemberIds.length === 1, "a single-page shared channel resolves with its member list and hasGuest");
}

console.log(`✓ slack-governance-roster: ${n} assertions passed`);
