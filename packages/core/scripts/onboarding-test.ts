import { extractPinnedInstructions, introMessage, instructionBullet } from "../agent/onboarding/onboarding.js";
import { PINNED_HEADER } from "../agent/status/status.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const pins = {
  ok: true,
  items: [
    { message: { text: "When you respond here, focus on the payments service and tag @oncall for incidents." } },
    { message: { text: `${PINNED_HEADER}\n- ⏳ doing a thing · \`s1\`` } },
    { message: { text: "Always open PRs against the develop branch." } },
  ],
};
const instr = extractPinnedInstructions(pins);
ok(instr !== null && instr.includes("payments service"), "extracts a pinned instruction");
ok(instr!.includes("develop branch"), "joins multiple pinned instructions");
ok(!instr!.includes(PINNED_HEADER), "skips OpenEverywhere's own pinned status message");

ok(extractPinnedInstructions({ ok: true, items: [] }) === null, "no pins -> null");
ok(extractPinnedInstructions({ ok: true, items: [{ message: { text: PINNED_HEADER + "\nx" } }] }) === null, "only-our-status-pin -> null");
ok(extractPinnedInstructions(null) === null, "defensive on junk");
ok(extractPinnedInstructions({ items: "nope" }) === null, "defensive on non-array items");

ok(introMessage(false).includes("OpenEverywhere") && !introMessage(false).includes("standing instructions"), "intro without adopted instructions");
ok(introMessage(true).includes("standing instructions"), "intro notes adopted pinned instructions");

const bullet = instructionBullet("Focus on\n  the   payments   service", "2026-06-24");
ok(bullet.startsWith("- 2026-06-24: (from pinned message) "), "bullet is dated + attributed");
ok(bullet.includes("Focus on the payments service") && !bullet.includes("\n"), "bullet collapses whitespace to one line");

console.log(`✓ onboarding: ${passed} assertions passed`);
