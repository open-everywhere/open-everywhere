import { bindFrom, bindBridged, registerIdentityMapper, type BindableContext, type IdentityMapper } from "../agent/identity/binding.js";
import { normalizePlatform } from "../agent/identity/platform.js";
import { principalKey, isQualifiedPrincipalKey, parsePrincipalKey, rosterHasPrincipal, principalIdsOnPlatform } from "../agent/identity/principal-key.js";
import { readBindingBridge, stampBindingBridge, bridgedContext } from "../agent/identity/binding-bridge.js";
import { resolvePartition } from "../agent/memory/partition.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

for (const k of [
  "OE_PLATFORM", "OE_WORKSPACE", "OE_SURFACE", "OE_CHANNEL", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST",
]) {
  delete process.env[k];
}

ok(
  bindFrom({ channel: { kind: "slack" }, session: { auth: { current: { attributes: { team_id: "T1", channel_id: "C9", channel_type: "channel", is_private: "false" }, principalId: "", principalType: "slack-user" } } } }).trust === "external",
  "slack UNREGISTERED (core alone): binds fail-closed external through bindLocal",
)

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

ok(bindFrom({}).trust === "internal", "bindFrom: local/dev defaults internal");
process.env.OE_TRUST = "external";
ok(bindFrom({}).trust === "external", "bindFrom: OE_TRUST=external forces external (gate testing)");
delete process.env.OE_TRUST;
ok(bindFrom({ channel: { kind: "myspace" } }).trust === "external", "bindFrom: unknown platform fails closed to external");

process.env.OE_MODE = "dm";
ok(bindFrom({}).trust === "internal", "bindFrom: local/dev DM stays internal (platform-exempt)");
delete process.env.OE_MODE;

ok(readBindingBridge() === null, "binding-bridge: read outside a session context → null (fail-soft)");
stampBindingBridge({
  channel: { kind: "local" },
  session: { auth: { current: { attributes: { ws: "W", sfc: "S" }, principalId: "", principalType: "user" } } },
});
ok(readBindingBridge() === null, "binding-bridge: stamp outside a session context is a no-op");
const bridgedSlug = bindFrom(
  bridgedContext({
    platform: "discord-gateway",
    principalId: "U_dg",
    principalType: "discord-user",
    attributes: { guild_id: "G7", channel_id: "C7", channel_type: "0", user_id: "U_dg" },
  }),
);
ok(bridgedSlug.platform === "discord",
  "binding-bridge: a channel-slug platform stamp ('discord-gateway') normalizes to the discord platform (mapper dispatch is app-tier — bundle-registered)");

const uniNoStamp = bindBridged({
  platform: "unified",
  principalId: "U1",
  principalType: "slack-user",
  attributes: { team_id: "T9", channel_id: "C9", channel_type: "channel", is_ext_shared: "false", trust_checked: "true" },
});
ok(uniNoStamp.platform === "unified",
  "binding-bridge: a unified stamp WITHOUT oe_platform stays 'unified' — no origin to hop to, so no surface mapper resolves (falls to the env stand-in → bindFrom fails it closed to external, asserted below)");
ok(bindFrom(bridgedContext({
  platform: "unified",
  principalId: "U1",
  principalType: "slack-user",
  attributes: { team_id: "T9", channel_id: "C9", channel_type: "channel", is_ext_shared: "false", trust_checked: "true" },
})).trust === "external",
  "binding-bridge: bindFrom on a unified stamp WITHOUT oe_platform fails closed to external (no origin recovered)");

ok(normalizePlatform("slack-qabot") === "slack", "platform: slack-* slug collapses via the prefix rule");
ok(normalizePlatform("discord-databot") === "discord", "platform: discord-* slug collapses via the prefix rule");
ok(normalizePlatform("teams-support") === "teams", "platform: teams-* slug collapses via the prefix rule");
ok(normalizePlatform("discord-gateway") === "discord", "platform: the explicit alias still wins (map before prefix)");
ok(normalizePlatform("slack") === "slack", "platform: a bare platform passes through unchanged");
ok(normalizePlatform("slackish") === "slackish", "platform: prefix rule needs the hyphen — no substring false-positives");
ok(normalizePlatform("linear-bot") === "linear", "platform: linear-* slug collapses via the prefix rule");

const fakeMapper: IdentityMapper = (ctx) => {
  const a = ctx.session?.auth?.current?.attributes;
  const ws = a?.["ws"];
  const sfc = a?.["sfc"];
  return {
    workspace: typeof ws === "string" ? ws : "WSX",
    surface: typeof sfc === "string" ? sfc : "SFX",
    mode: "channel",
    trust: "internal",
  };
};
registerIdentityMapper("regtest", fakeMapper);
const reg = bindFrom({ channel: { kind: "regtest" }, session: { auth: { current: { attributes: { ws: "WSX", sfc: "SFX" } } } } });
ok(
  reg.platform === "regtest" && reg.workspace === "WSX" && reg.surface === "SFX" && reg.trust === "internal",
  "register seam: a mapper registered via registerIdentityMapper is resolvable by bindFrom",
);
ok(
  bindFrom({ channel: { kind: "neverregistered" } }).trust === "external",
  "register seam: an unregistered platform still falls through to bindLocal + fail-closed external",
);

{
  ok(principalKey("slack", "U0EXOWNER") === "slack/U0EXOWNER", "principalKey composes <platform>/<id>");
  ok(principalKey("discord", "300000000000000104") === "discord/300000000000000104", "…for a digit-string id too");
  ok(principalKey("Slack", "U1") === "Slack/U1", "principalKey does NOT normalize — it is a join, and the validator is the gate");

  ok(isQualifiedPrincipalKey("slack/U1"), "a two-segment key validates");
  ok(isQualifiedPrincipalKey("discord-gateway/1"), "a hyphenated platform token validates");
  ok(!isQualifiedPrincipalKey("U1"), "a BARE id does not validate (the pre-P0 form)");
  ok(!isQualifiedPrincipalKey("300000000000000104"), "…nor a bare digit string");
  ok(!isQualifiedPrincipalKey("slack/"), "…nor an empty id");
  ok(!isQualifiedPrincipalKey("/U1"), "…nor an empty platform");
  ok(!isQualifiedPrincipalKey("slack/T1/U1"), "…nor a surface-shaped three-segment key — the id carries no slash");
  ok(!isQualifiedPrincipalKey("Slack/U1"), "…nor an upper-cased platform token (platforms are normalized lowercase everywhere)");
  ok(!isQualifiedPrincipalKey("slack/U 1"), "…nor an id with whitespace");
  ok(!isQualifiedPrincipalKey(undefined), "…nor undefined");

  const parsed = parsePrincipalKey("discord/300000000000000104");
  ok(parsed?.platform === "discord" && parsed.id === "300000000000000104", "parsePrincipalKey splits a valid key");
  ok(parsePrincipalKey("U1") === undefined, "parsePrincipalKey returns a VALUE (undefined) for a malformed key — display/filter paths skip, they never throw");

  const roster = ["slack/U_ADMIN", "discord/300000000000000104"];
  ok(rosterHasPrincipal(roster, "slack", "U_ADMIN"), "rosterHasPrincipal matches the qualified entry");
  ok(rosterHasPrincipal(roster, "discord", "300000000000000104"), "…on either platform in one roster");
  ok(!rosterHasPrincipal(roster, "telegram", "300000000000000104"), "🔴 …and NOT the same digits on another platform — the collision this grammar exists to delete");
  ok(!rosterHasPrincipal(roster, undefined, "U_ADMIN"), "rosterHasPrincipal FAILS CLOSED with no platform");
  ok(!rosterHasPrincipal(roster, "slack", undefined), "…and with no id");
  ok(!rosterHasPrincipal(undefined, "slack", "U_ADMIN"), "…and with no roster at all");
  ok(!rosterHasPrincipal(["U_ADMIN"], "slack", "U_ADMIN"), "…and a BARE roster entry never matches (which is why config load refuses one)");

  ok(JSON.stringify(principalIdsOnPlatform(roster, "slack")) === JSON.stringify(["U_ADMIN"]), "principalIdsOnPlatform projects the roster down to one platform's bare ids");
  ok(principalIdsOnPlatform(roster, "telegram").length === 0, "…dropping every other platform's entries");
  ok(principalIdsOnPlatform([...roster, "junk"], "slack").length === 1, "…and malformed entries");
  ok(principalIdsOnPlatform(roster, undefined).length === 0, "…and yielding nothing at all with no platform (fail closed)");
}

console.log(`✓ identity: ${passed} assertions passed`);
