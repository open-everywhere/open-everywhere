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

eq(capabilitiesForPlatform("slack"), { midTurnPost: true, reactions: true }, "slack");
eq(capabilitiesForPlatform("discord"), { midTurnPost: true, reactions: false }, "discord");
eq(capabilitiesForPlatform("teams"), { midTurnPost: true, reactions: false }, "teams");
eq(capabilitiesForPlatform("telegram"), { midTurnPost: true, reactions: false }, "telegram");
eq(capabilitiesForPlatform("linear"), { midTurnPost: true, reactions: false }, "linear");
eq(capabilitiesForPlatform("github"), { midTurnPost: false, reactions: false }, "github");
eq(capabilitiesForPlatform("notion"), { midTurnPost: true, reactions: false }, "notion");

eq(capabilitiesForPlatform("local"), { midTurnPost: false, reactions: false }, "local → NONE");
eq(capabilitiesForPlatform("nope"), { midTurnPost: false, reactions: false }, "unknown platform → NONE");
eq(capabilitiesForPlatform(undefined), { midTurnPost: false, reactions: false }, "undefined platform → NONE");

const ctxFor = (kind: string): BindableContext => ({ channel: { kind } });
ok(capabilitiesFor(ctxFor("slack")).reactions === true, "capabilitiesFor: bare 'slack' kind resolves the slack manifest");
ok(capabilitiesFor(ctxFor("channel:slack")).reactions === true, "capabilitiesFor: namespaced 'channel:slack' resolves the slack manifest");
ok(capabilitiesFor(ctxFor("channel:discord")).midTurnPost === true, "capabilitiesFor: namespaced 'channel:discord' resolves the discord manifest");
ok(capabilitiesFor(ctxFor("discord-gateway")).midTurnPost === true, "capabilitiesFor: 'discord-gateway' aliases to discord");
ok(capabilitiesFor(ctxFor("teams")).midTurnPost === true, "capabilitiesFor: teams honours mid-turn post (sendTeamsActivity)");
ok(capabilitiesFor(ctxFor("github")).midTurnPost === false, "capabilitiesFor: github honours no optional verb (no public proactive comment seam)");

registerCapabilityManifest("regtest", { midTurnPost: true, reactions: true });
eq(capabilitiesForPlatform("regtest"), { midTurnPost: true, reactions: true }, "register seam: a manifest registered via registerCapabilityManifest is resolvable");
eq(capabilitiesForPlatform("neverregistered"), { midTurnPost: false, reactions: false }, "register seam: an unregistered platform still falls back to NONE");

console.log(`✓ ${passed} capabilities assertions passed`);
