import { bindFrom, bindBridged, registerIdentityMapper, type BindableContext, type IdentityMapper } from "../agent/identity/binding.js";
import { normalizePlatform } from "../agent/identity/platform.js";
import {
  principalKey,
  tryPrincipalKey,
  isQualifiedPrincipalKey,
  parsePrincipalKey,
  principalKeyReplacementHint,
  rosterHasPrincipal,
  principalIdsOnPlatform,
  UNNAMED_TENANT,
} from "../agent/identity/principal-key.js";
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
  ok(principalKey("slack", "T1", "U0EXOWNER") === "slack/T1/U0EXOWNER", "principalKey composes <platform>/<tenant>/<id> on a TENANT-SCOPED platform");
  ok(principalKey("discord", undefined, "300000000000000104") === "discord/300000000000000104", "…and <platform>/<id> everywhere else");
  ok(principalKey("Slack", "T1", "U1") === "Slack/U1", "principalKey does NOT normalize — an un-normalized platform token is not in the tenant-scoped set, so it composes the two-segment shape and the validator is the gate");

  for (const p of ["discord", "teams", "github", "linear", "notion"]) {
    ok(principalKey(p, "IGNORED", "U1") === `${p}/U1`, `${p} keys are unchanged by the rung — the tenant argument is IGNORED, not defaulted`);
  }

  ok(principalKey("discord", "GUILD1", "U1") === principalKey("discord", "U1", "U1"), "🔴 a Discord channel binding and its DM binding compose the SAME key (the workspace fallback cannot split one human in two)");

  ok(principalKey("slack", "T_ACME", "U1") !== principalKey("slack", "T_BETA", "U1"), "🔴 the SAME Slack member id in two workspaces composes two DIFFERENT keys (OPE-309: two humans, two keys)");

  let threw = false;
  try { principalKey("slack", undefined, "U1"); } catch { threw = true; }
  ok(threw, "🔴 the composer THROWS for a tenant-scoped platform with no tenant — an invented tenant segment is an identity claim");
  threw = false;
  try { principalKey("slack", "   ", "U1"); } catch { threw = true; }
  ok(threw, "…and for a whitespace-only tenant");
  threw = false;
  try { principalKey("slack", UNNAMED_TENANT, "U1"); } catch { threw = true; }
  ok(threw, `🔴 …and for the "${UNNAMED_TENANT}" binding fallback, which is the string for "nobody said" and would be ONE aliasing bucket every unnamed delivery lands in`);
  ok(tryPrincipalKey("slack", undefined, "U1") === undefined, "tryPrincipalKey is the same decision as a VALUE — for the matchers and label paths that must refuse rather than throw");

  ok(isQualifiedPrincipalKey("discord/300000000000000104"), "a two-segment key validates on a vendor-global platform");
  ok(isQualifiedPrincipalKey("slack/T1/U1"), "…and the three-segment key validates on a tenant-scoped one");
  ok(isQualifiedPrincipalKey("discord-gateway/1"), "a hyphenated platform token validates");
  ok(!isQualifiedPrincipalKey("slack/U1"), "🔴 a PRE-RUNG two-segment slack key does NOT validate — the composer can no longer mint it, so the entry is inert and config load must say so");
  ok(!isQualifiedPrincipalKey("discord/G1/U1"), "…and a three-segment key on a vendor-global platform does not validate either (the rung is per-platform, not optional)");
  ok(!isQualifiedPrincipalKey(`slack/${UNNAMED_TENANT}/U1`), `…nor a key whose tenant rung is "${UNNAMED_TENANT}" — well-shaped, matches nobody, so it belongs on the loud side of the line`);
  ok(!isQualifiedPrincipalKey("U1"), "a BARE id does not validate (the pre-P0 form)");
  ok(!isQualifiedPrincipalKey("300000000000000104"), "…nor a bare digit string");
  ok(!isQualifiedPrincipalKey("slack/"), "…nor an empty id");
  ok(!isQualifiedPrincipalKey("/U1"), "…nor an empty platform");
  ok(!isQualifiedPrincipalKey("Slack/U1"), "…nor an upper-cased platform token (platforms are normalized lowercase everywhere)");
  ok(!isQualifiedPrincipalKey("slack/T1/U 1"), "…nor an id with whitespace");
  ok(!isQualifiedPrincipalKey(undefined), "…nor undefined");

  const parsed = parsePrincipalKey("discord/300000000000000104");
  ok(parsed?.platform === "discord" && parsed.id === "300000000000000104" && parsed.tenant === undefined, "parsePrincipalKey splits a valid key, with NO tenant on a vendor-global platform");
  const parsedTenant = parsePrincipalKey("slack/T1/U1");
  ok(parsedTenant?.platform === "slack" && parsedTenant.tenant === "T1" && parsedTenant.id === "U1", "…and all three parts on a tenant-scoped one");
  ok(parsePrincipalKey("U1") === undefined, "parsePrincipalKey returns a VALUE (undefined) for a malformed key — display/filter paths skip, they never throw");

  const roster = ["slack/T1/U_ADMIN", "discord/300000000000000104"];
  ok(rosterHasPrincipal(roster, "slack", "T1", "U_ADMIN"), "rosterHasPrincipal matches the qualified entry");
  ok(rosterHasPrincipal(roster, "discord", undefined, "300000000000000104"), "…on either platform in one roster");
  ok(!rosterHasPrincipal(roster, "teams", undefined, "300000000000000104"), "🔴 …and NOT the same digits on another platform — the collision this grammar exists to delete");
  ok(!rosterHasPrincipal(roster, "slack", "T_OTHER", "U_ADMIN"), "🔴 …and NOT the same member id from ANOTHER WORKSPACE (OPE-309 — the collision the rung exists to delete)");
  ok(!rosterHasPrincipal(roster, "slack", undefined, "U_ADMIN"), "…and fails CLOSED, not throws, when the tenant cannot be named on a tenant-scoped platform");
  ok(!rosterHasPrincipal(roster, undefined, "T1", "U_ADMIN"), "rosterHasPrincipal FAILS CLOSED with no platform");
  ok(!rosterHasPrincipal(roster, "slack", "T1", undefined), "…and with no id");
  ok(!rosterHasPrincipal(undefined, "slack", "T1", "U_ADMIN"), "…and with no roster at all");
  ok(!rosterHasPrincipal(["U_ADMIN"], "slack", "T1", "U_ADMIN"), "…and a BARE roster entry never matches (which is why config load refuses one)");
  ok(!rosterHasPrincipal(["slack/U_ADMIN"], "slack", "T1", "U_ADMIN"), "🔴 an UNQUALIFIED roster entry does not match a qualified lookup (a missed matcher costs standing…)");
  ok(!rosterHasPrincipal(["slack/T1/U_ADMIN"], "discord", undefined, "T1"), "🔴 …and no lookup can be shaped to match a qualified entry from the other direction either");

  ok(JSON.stringify(principalIdsOnPlatform(roster, "slack", "T1")) === JSON.stringify(["U_ADMIN"]), "principalIdsOnPlatform projects the roster down to one platform's bare ids");
  ok(principalIdsOnPlatform(roster, "teams", undefined).length === 0, "…dropping every other platform's entries");
  ok(principalIdsOnPlatform(roster, "slack", "T_OTHER").length === 0, "🔴 …and every other WORKSPACE's entries — the one function that legitimately UNQUALIFIES must not hand a foreign workspace's bare id to a membership comparison");
  ok(principalIdsOnPlatform(roster, "slack", undefined).length === 0, "…and yielding nothing at all when the tenant cannot be named (fail closed)");
  ok(principalIdsOnPlatform([...roster, "junk"], "slack", "T1").length === 1, "…and malformed entries");
  ok(principalIdsOnPlatform(roster, undefined, "T1").length === 0, "…and yielding nothing at all with no platform (fail closed)");

  ok(
    principalKeyReplacementHint("slack/U1", "T_ACME").includes(`"slack/T_ACME/U1"`),
    "🔴 the config-load hint computes the EXACT three-segment replacement when the deployment names one workspace",
  );
  ok(
    principalKeyReplacementHint("slack/U1", undefined).includes(`"slack/<tenant-id>/U1"`),
    "…and the shape plus where to find the segment when it does not — never a guessed workspace",
  );
}

console.log(`✓ identity: ${passed} assertions passed`);
