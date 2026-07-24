import { capabilitiesForPlatform, capabilitiesFor, registerCapabilityManifest, type CapabilityManifest } from "../agent/identity/capabilities.js";
import type { BindableContext } from "../agent/identity/binding.js";

delete process.env.OE_PLATFORM;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function eq(m: CapabilityManifest, expect: CapabilityManifest, label: string): void {
  ok(
    m.midTurnPost === expect.midTurnPost && m.reactions === expect.reactions,
    `${label} → midTurnPost=${expect.midTurnPost} reactions=${expect.reactions}`,
  );
}

eq(capabilitiesForPlatform("slack"), { midTurnPost: false, reactions: false }, "slack (unregistered in core alone → NONE)");
const { registerSlackFixtureManifest } = await import("./_slack-test-stubs.js");
registerSlackFixtureManifest();
eq(capabilitiesForPlatform("slack"), { midTurnPost: true, reactions: true }, "slack (fixture-registered row)");
eq(capabilitiesForPlatform("discord"), { midTurnPost: false, reactions: false }, "discord (unregistered in core alone → NONE)");
eq(capabilitiesForPlatform("teams"), { midTurnPost: false, reactions: false }, "teams (unregistered in core alone → NONE)");
eq(capabilitiesForPlatform("linear"), { midTurnPost: false, reactions: false }, "linear (unregistered in core alone → NONE)");
eq(capabilitiesForPlatform("github"), { midTurnPost: false, reactions: false }, "github");
eq(capabilitiesForPlatform("notion"), { midTurnPost: false, reactions: false }, "notion (unregistered in core alone → NONE)");
eq(capabilitiesForPlatform("telegram"), { midTurnPost: false, reactions: false }, "telegram (unregistered in core alone → NONE)");

eq(capabilitiesForPlatform("local"), { midTurnPost: false, reactions: false }, "local → NONE");
eq(capabilitiesForPlatform("nope"), { midTurnPost: false, reactions: false }, "unknown platform → NONE");
eq(capabilitiesForPlatform(undefined), { midTurnPost: false, reactions: false }, "undefined platform → NONE");

const ctxFor = (kind: string): BindableContext => ({ channel: { kind } });
ok(capabilitiesFor(ctxFor("slack")).reactions === true, "capabilitiesFor: bare 'slack' kind resolves the slack manifest");
ok(capabilitiesFor(ctxFor("channel:slack")).reactions === true, "capabilitiesFor: namespaced 'channel:slack' resolves the slack manifest");
ok(capabilitiesFor(ctxFor("channel:discord")).midTurnPost === false, "capabilitiesFor: namespaced 'channel:discord' → NONE in core alone (discord manifest is bundle-registered)");
ok(capabilitiesFor(ctxFor("discord-gateway")).midTurnPost === false, "capabilitiesFor: 'discord-gateway' → NONE in core alone (aliases to the bundle-registered discord)");
ok(capabilitiesFor(ctxFor("teams")).midTurnPost === false, "capabilitiesFor: teams → NONE in core alone (bundle-registered manifest — registered row asserted in the teams integration test)");
ok(capabilitiesFor(ctxFor("github")).midTurnPost === false, "capabilitiesFor: github honours no optional verb (no public proactive comment seam)");

registerCapabilityManifest("regtest", { midTurnPost: true, reactions: true });
eq(capabilitiesForPlatform("regtest"), { midTurnPost: true, reactions: true }, "register seam: a manifest registered via registerCapabilityManifest is resolvable");
eq(capabilitiesForPlatform("neverregistered"), { midTurnPost: false, reactions: false }, "register seam: an unregistered platform still falls back to NONE");

console.log(`✓ ${passed} capabilities assertions passed`);
