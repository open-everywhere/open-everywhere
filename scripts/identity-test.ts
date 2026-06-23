import { bindFrom, slackMode, slackVisibility, type BindableContext } from "../agent/identity/binding.js";
import { resolvePartition } from "../agent/memory/partition.js";
import {
  buildSlackAuth,
  channelFactsFromInfo,
  channelFactsFromRaw,
} from "../agent/channels/slack-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

for (const k of ["OE_PLATFORM", "OE_WORKSPACE", "OE_SURFACE", "OE_CHANNEL", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL"]) {
  delete process.env[k];
}

function slackCtx(attributes: Record<string, string>, principalId?: string): BindableContext {
  return {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes, principalId: principalId ?? "", principalType: "slack-user" } } },
  };
}

ok(slackMode("im", undefined) === "dm", "channel_type im -> dm");
ok(slackMode("mpim", undefined) === "mpim", "channel_type mpim -> mpim");
ok(slackMode("channel", undefined) === "channel", "channel_type channel -> channel");
ok(slackMode("group", undefined) === "channel", "channel_type group -> channel");
ok(slackMode(undefined, "D0815") === "dm", "id prefix D -> dm when type unknown");
ok(slackMode(undefined, "C0815") === "channel", "id prefix C -> channel when type unknown");

ok(slackVisibility("channel", "false", "channel") === "public", "explicit is_private=false -> public");
ok(slackVisibility("group", "true", "channel") === "private", "explicit is_private=true -> private");
ok(slackVisibility(undefined, undefined, "dm") === "private", "dm is never public");
ok(slackVisibility(undefined, undefined, "mpim") === "private", "mpim is never public");
ok(slackVisibility("channel", undefined, "channel") === "public", "typed public channel -> public");
ok(slackVisibility(undefined, undefined, "channel") === "private", "FAIL-CLOSED: unknown -> private");

const pub = bindFrom(slackCtx({ team_id: "T1", channel_id: "C9", channel_type: "channel", is_private: "false", user_id: "U7" }));
ok(pub.platform === "slack" && pub.workspace === "T1" && pub.surface === "C9", "slack: platform/workspace/surface from attributes");
ok(pub.mode === "channel" && pub.visibility === "public", "slack public channel -> channel/public");
ok(pub.principalId === "U7", "slack: principalId from user_id attribute");
ok(JSON.stringify(pub.target) === JSON.stringify({ channelId: "C9" }), "slack: post-back target is { channelId }");

const priv = bindFrom(slackCtx({ team_id: "T1", channel_id: "G2", channel_type: "group", is_private: "true", user_id: "U7" }));
ok(priv.mode === "channel" && priv.visibility === "private", "slack private channel -> channel/private");

const dm = bindFrom(slackCtx({ team_id: "T1", channel_id: "D3", channel_type: "im", user_id: "U7" }, "U7"));
ok(dm.mode === "dm" && dm.visibility === "private", "slack im -> dm/private");
ok(dm.principalId === "U7", "slack: principalId prefers auth.principalId");

const mpim = bindFrom(slackCtx({ team_id: "T1", channel_id: "C4", channel_type: "mpim", user_id: "U7" }));
ok(mpim.mode === "mpim" && mpim.visibility === "private", "slack mpim -> mpim/private");

const unknown = bindFrom(slackCtx({ team_id: "T1", channel_id: "C5", user_id: "U7" }));
ok(unknown.mode === "channel" && unknown.visibility === "private", "slack unknown facts -> channel + FAIL-CLOSED private");

const part = resolvePartition(slackCtx({ team_id: "T1", channel_id: "C9", channel_type: "channel", is_private: "false", user_id: "U7" }));
ok(part.surfaceKey === "slack/T1/C9", "partition surfaceKey derives from slack binding");

process.env.OE_WORKSPACE = "acme";
process.env.OE_SURFACE = "alpha";
process.env.OE_MODE = "dm";
process.env.OE_VISIBILITY = "private";
const local = bindFrom({});
ok(local.platform === "local" && local.workspace === "acme" && local.surface === "alpha", "local: identity from OE_* env");
ok(local.mode === "dm" && local.visibility === "private", "local: mode/visibility from env");
ok(local.target === undefined, "local: no post-back target");
delete process.env.OE_SURFACE;
delete process.env.OE_CHANNEL;
const defaults = bindFrom({ channel: { kind: "local" } });
ok(defaults.surface === "default", "local: surface defaults when env unset for that field");

const auth = buildSlackAuth({ userId: "U7", teamId: "T1", channelId: "C9", threadTs: "169.1", channelType: "channel", isPrivate: false });
ok(auth.authenticator === "slack" && auth.principalId === "U7" && auth.principalType === "slack-user", "buildSlackAuth: principal fields");
ok(auth.attributes.is_private === "false" && auth.attributes.channel_type === "channel", "buildSlackAuth: facts captured as strings");
const sparse = buildSlackAuth({ userId: "U7", channelId: "C9" });
ok(sparse.attributes.is_private === undefined && sparse.attributes.team_id === undefined, "buildSlackAuth: omits unknown facts (no false claims)");

ok(channelFactsFromRaw({ channel_type: "mpim" }).channelType === "mpim", "channelFactsFromRaw reads channel_type");
ok(channelFactsFromRaw({}).channelType === undefined, "channelFactsFromRaw: absent type stays undefined");
ok(channelFactsFromInfo({ channel: { is_private: true, is_group: true } }).isPrivate === true, "channelFactsFromInfo: is_private");
ok(channelFactsFromInfo({ channel: { is_im: true } }).channelType === "im", "channelFactsFromInfo: is_im -> im");
ok(channelFactsFromInfo({ channel: { is_channel: true, is_private: false } }).channelType === "channel", "channelFactsFromInfo: is_channel -> channel");
ok(JSON.stringify(channelFactsFromInfo(null)) === "{}", "channelFactsFromInfo: defensive on junk");

console.log(`✓ identity: ${passed} assertions passed`);
