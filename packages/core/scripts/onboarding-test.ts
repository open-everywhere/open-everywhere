import { extractPinnedInstructions, introMessage, instructionBullet } from "../agent/onboarding/onboarding.js";
import { PINNED_HEADER, PINNED_HEADERS } from "../agent/status/status.js";

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
ok(!instr!.includes(PINNED_HEADER), "skips our own pinned status message");

ok(extractPinnedInstructions({ ok: true, items: [] }) === null, "no pins -> null");
ok(extractPinnedInstructions({ ok: true, items: [{ message: { text: PINNED_HEADER + "\nx" } }] }) === null, "only-our-status-pin -> null");
ok(
  PINNED_HEADERS.filter((h) => h !== PINNED_HEADER).every((legacy) => extractPinnedInstructions({ ok: true, items: [{ message: { text: legacy + "\nx" } }] }) === null),
  "a status pin posted under a LEGACY header is still recognised as ours (never adopted as instructions)",
);
ok(extractPinnedInstructions(null) === null, "defensive on junk");
ok(extractPinnedInstructions({ items: "nope" }) === null, "defensive on non-array items");

ok(introMessage(false).includes("Open Everywhere") && !introMessage(false).includes("pinned message"), "intro without adopted instructions falls back to the product name");
ok(introMessage(true).includes("pinned message as my instructions"), "intro notes adopted pinned instructions");
ok(introMessage(false, "Test Slack Bot").includes("I'm Test Slack Bot"), "intro identifies as the bot's live workspace display name when known");
ok(!introMessage(false, "Test Slack Bot").includes("**"), "intro carries NO markdown — it is posted verbatim and Slack renders ** literally");
ok(introMessage(false, "  ").includes("Open Everywhere"), "a blank display name falls back to the product name");

const bullet = instructionBullet("Focus on\n  the   payments   service", "2026-06-24");
ok(bullet.startsWith("- 2026-06-24: (from pinned message) "), "bullet is dated + attributed");
ok(bullet.includes("Focus on the payments service") && !bullet.includes("\n"), "bullet collapses whitespace to one line");

console.log(`✓ onboarding: ${passed} assertions passed`);
