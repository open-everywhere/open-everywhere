process.env.OE_SQLITE_PATH = ":memory:";
delete process.env.DATABASE_URL;

import assert from "node:assert/strict";
import {
  registerConfig,
  registerIdentityMapper,
  registerSurfaces,
  defineSurface,
  defineDomain,
  resetSettingsForTest,
  _resetDeploymentIdentityForTest,
} from "@open-everywhere/core/agent/adapter-api.js";
import { bindSlack } from "../agent/channels/slack-identity.js";
import { _resetAuthorMemberCache } from "../agent/channels/slack-events.js";
import { admitInbound } from "../agent/channels/slack.js";
import { withPatchedFetch } from "./_fetch-test-utils.js";

_resetDeploymentIdentityForTest();
resetSettingsForTest();
for (const k of ["OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL"]) delete process.env[k];

const TEAM = "T_HOME";
const CHANNEL = "C_OPS";
const DM = "D_PARTNER";
const GUEST = "U_GUEST";
const MEMBER = "U_MEMBER";
const UNREADABLE = "U_UNREADABLE";

registerIdentityMapper("slack", bindSlack);
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "ops", reach: [`slack/${TEAM}/${CHANNEL}`], memory: "brain" })],
  loadSilos: () => [{ name: "brain", provider: "sqlite" }],
  domainsForSurface: ({ surface }) => (surface === CHANNEL ? ["ops"] : []),
});

let n = 0;
const eq = (actual: unknown, expected: unknown, label: string): void => {
  assert.deepEqual(actual, expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
  n++;
  console.log(`  ✓ ${label}`);
};

const USERS: Record<string, Record<string, unknown>> = {
  [GUEST]: { id: GUEST, team_id: TEAM, is_restricted: true },
  [MEMBER]: { id: MEMBER, team_id: TEAM },
};

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  if (href.endsWith("/users.info")) {
    const user = new URLSearchParams(String(init?.body ?? "")).get("user") ?? "";
    return json(USERS[user] ? { ok: true, user: USERS[user] } : { ok: false, error: "missing_scope" });
  }
  return json({ ok: true });
}) as typeof fetch;

function fakeCtx() {
  return {
    thread: { teamId: null, post: async () => {}, startTyping: async () => {} },
    slack: {
      channelId: undefined,
      threadTs: undefined,
      request: async (method: string, args: { user?: string }) => {
        if (method === "conversations.info") {
          return { ok: true, channel: { id: CHANNEL, is_channel: true, is_private: true, is_ext_shared: false, is_member: true } };
        }
        if (method === "users.info" && args.user && USERS[args.user]) return { ok: true, user: USERS[args.user] };
        throw new Error(`no live slack for ${method} in a unit test`);
      },
    },
  } as never;
}

let tsSeq = 0;
const mention = (userId: string, channelId = CHANNEL, channelType = "channel") => {
  const ts = `1769401811.${String(++tsSeq).padStart(6, "0")}`;
  return {
    channelId,
    ts,
    threadTs: ts,
    markdown: "<@UBOT> chase order 4417",
    text: "<@UBOT> chase order 4417",
    author: { userId, isBot: false },
    teamId: TEAM,
    attachments: [],
    raw: { channel_type: channelType },
  } as never;
};

async function attrsOf(userId: string, isDm = false): Promise<Record<string, string>> {
  const outcome = await admitInbound(fakeCtx(), isDm ? mention(userId, DM, "im") : mention(userId), isDm);
  assert.ok(outcome !== null, "the mention was admitted (a dropped wake proves nothing about its auth)");
  return ((outcome as { auth: { attributes?: Record<string, string> } | null }).auth?.attributes ?? {}) as Record<string, string>;
}

const prevToken = process.env.SLACK_BOT_TOKEN;
process.env.SLACK_BOT_TOKEN = "xoxb-native-guest-stamp-test";
try {
  await withPatchedFetch(fakeFetch, async () => {
    registerSurfaces([]);

    console.log("1. the author leg in an internal channel:");
    _resetAuthorMemberCache();
    eq((await attrsOf(GUEST))["oe_chat_nonmember"], "true", "🔴 a GUEST's native @mention in an internal channel stamps oe_chat_nonmember");
    eq((await attrsOf(MEMBER))["oe_chat_nonmember"], undefined, "negative control: a MEMBER's native @mention in the same channel leaves it ABSENT");

    console.log("2. the fail direction:");
    eq((await attrsOf(UNREADABLE))["oe_chat_nonmember"], undefined, "a refused users.info (`ok:false`) refutes nobody — the leg fails OPEN, as on every other route");

    console.log("3. the room leg:");
    registerSurfaces([defineSurface({ key: `slack/${TEAM}/${CHANNEL}`, trust: "public" })]);
    eq((await attrsOf(MEMBER))["oe_chat_nonmember"], "true", "a MEMBER's mention in a channel declared `public` is stamped — anyone can type there");
    registerSurfaces([defineSurface({ key: `slack/${TEAM}/${CHANNEL}`, trust: "internal" })]);
    eq((await attrsOf(MEMBER))["oe_chat_nonmember"], undefined, "negative control: the same member in the channel declared `internal` is not");
    registerSurfaces([]);

    console.log("4. a 1:1 DM:");
    eq((await attrsOf(GUEST, true))["oe_chat_nonmember"], "true", "a GUEST partner's native DM stamps oe_chat_nonmember");
    eq((await attrsOf(MEMBER, true))["oe_chat_nonmember"], undefined, "negative control: a MEMBER partner's native DM leaves it ABSENT");

    console.log("5. the room's own facts:");
    const guest = await attrsOf(GUEST);
    eq([guest["trust_checked"], guest["is_ext_shared"]], ["true", "false"], "the stamp does not demote the room: the guest's auth keeps the channel's confirmed-internal facts");
  });
} finally {
  if (prevToken === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = prevToken;
}

console.log(`\n✅ slack-native-guest-stamp-test: ${n} assertion(s) passed`);
