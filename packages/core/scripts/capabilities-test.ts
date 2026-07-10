import { capabilitiesForPlatform, capabilitiesFor, type CapabilityManifest } from "../agent/identity/capabilities.js";
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
    m.midTurnPost === expect.midTurnPost && m.silentEdit === expect.silentEdit && m.reactions === expect.reactions,
    `${label} → midTurnPost=${expect.midTurnPost} silentEdit=${expect.silentEdit} reactions=${expect.reactions}`,
  );
}

eq(capabilitiesForPlatform("slack"), { midTurnPost: true, silentEdit: true, reactions: true }, "slack");
eq(capabilitiesForPlatform("discord"), { midTurnPost: true, silentEdit: true, reactions: false }, "discord");
eq(capabilitiesForPlatform("teams"), { midTurnPost: false, silentEdit: false, reactions: false }, "teams");
eq(capabilitiesForPlatform("telegram"), { midTurnPost: false, silentEdit: false, reactions: false }, "telegram");
eq(capabilitiesForPlatform("linear"), { midTurnPost: false, silentEdit: false, reactions: false }, "linear");
eq(capabilitiesForPlatform("github"), { midTurnPost: false, silentEdit: false, reactions: false }, "github");
eq(capabilitiesForPlatform("notion"), { midTurnPost: false, silentEdit: false, reactions: false }, "notion (pre-Part-2)");

eq(capabilitiesForPlatform("local"), { midTurnPost: false, silentEdit: false, reactions: false }, "local → NONE");
eq(capabilitiesForPlatform("nope"), { midTurnPost: false, silentEdit: false, reactions: false }, "unknown platform → NONE");
eq(capabilitiesForPlatform(undefined), { midTurnPost: false, silentEdit: false, reactions: false }, "undefined platform → NONE");

const ctxFor = (kind: string): BindableContext => ({ channel: { kind } });
ok(capabilitiesFor(ctxFor("slack")).reactions === true, "capabilitiesFor: bare 'slack' kind resolves the slack manifest");
ok(capabilitiesFor(ctxFor("channel:slack")).reactions === true, "capabilitiesFor: namespaced 'channel:slack' resolves the slack manifest");
ok(capabilitiesFor(ctxFor("channel:discord")).midTurnPost === true, "capabilitiesFor: namespaced 'channel:discord' resolves the discord manifest");
ok(capabilitiesFor(ctxFor("discord-gateway")).silentEdit === true, "capabilitiesFor: 'discord-gateway' aliases to discord");
ok(capabilitiesFor(ctxFor("teams")).midTurnPost === false, "capabilitiesFor: teams honours no optional verb");

console.log(`✓ ${passed} capabilities assertions passed`);
