import { registerSettings, getSettings, overrideSettingsForTest } from "@open-everywhere/core/agent/settings/settings.js";

const problems: string[] = [];

await import("../agent/lib/register-config.js");
const { fullKit, WINDOW_GATED_TOOLS } = await import("@open-everywhere/core/agent/access/window-gate-manifest.js");
const { oneshotAgentEnabled } = await import("@open-everywhere/core/agent/access/delegation-flag.js");

const bootFlag = oneshotAgentEnabled();
const bootKit = [...fullKit()];
const bootWebFetch = [...WINDOW_GATED_TOOLS.web_fetch];

const ARMED = ["task"];
const DISARMED = ["task", "native"];
const kitFor = (flag: boolean): string[] => (flag ? ARMED : DISARMED);

if (JSON.stringify(bootKit) !== JSON.stringify(kitFor(bootFlag))) {
  problems.push(
    `at boot, fullKit() was ${JSON.stringify(bootKit)} with delegation.oneshotAgent=${bootFlag} — expected ` +
      `${JSON.stringify(kitFor(bootFlag))}. The ternary's arms do not match the documented matrices.`,
  );
}
if (JSON.stringify(bootWebFetch) !== JSON.stringify(bootKit)) {
  problems.push(
    `WINDOW_GATED_TOOLS.web_fetch was ${JSON.stringify(bootWebFetch)} at boot while fullKit() was ` +
      `${JSON.stringify(bootKit)} — a wide-hands row must carry the wide-hands matrix.`,
  );
}

registerSettings({ delegation: { oneshotAgent: !bootFlag } });

if (oneshotAgentEnabled() !== !bootFlag) {
  problems.push(
    "oneshotAgentEnabled() did not observe a post-boot registerSettings() call. getSettings() is " +
      "documented to resolve fresh on every call with no module-level cache — if that changed, this " +
      "test's whole premise is broken and every claim below needs re-deriving before trusting it.",
  );
}

if (getSettings().delegation.oneshotAgent !== !bootFlag) {
  problems.push(
    `getSettings().delegation.oneshotAgent read ${getSettings().delegation.oneshotAgent} after registering ` +
      `${!bootFlag} — the settings resolver itself is not honouring registerSettings().`,
  );
}

const expectedAfter = kitFor(!bootFlag);
const kitAfter = [...fullKit()];
if (JSON.stringify(kitAfter) !== JSON.stringify(expectedAfter)) {
  problems.push(
    `fullKit() read ${JSON.stringify(kitAfter)} after a post-boot registerSettings() flipped ` +
      `delegation.oneshotAgent to ${!bootFlag} — expected ${JSON.stringify(expectedAfter)}. The wide-hands ` +
      "matrix is not following the live setting: something captured it at module load, which is the " +
      "OPE-1101 defect (see this file's header).",
  );
}

const webFetchAfter = [...WINDOW_GATED_TOOLS.web_fetch];
if (JSON.stringify(webFetchAfter) !== JSON.stringify(expectedAfter)) {
  problems.push(
    `WINDOW_GATED_TOOLS.web_fetch read ${JSON.stringify(webFetchAfter)} after a post-boot registerSettings() ` +
      `flipped delegation.oneshotAgent to ${!bootFlag} — expected ${JSON.stringify(expectedAfter)}. The row is ` +
      "holding a captured value instead of calling fullKit() through a getter; this is the table both " +
      "grain resolvers and the execute backstop consult.",
  );
}

if (WINDOW_GATED_TOOLS.web_fetch !== fullKit()) {
  problems.push(
    "WINDOW_GATED_TOOLS.web_fetch is not REFERENCE-IDENTICAL to fullKit()'s return value. fullKit() must " +
      "hand back one shared frozen matrix per flag setting, not a fresh array per call — " +
      "access/invoker-posture.ts's wide-hands set is derived by identity (scripts/invoker-posture-test.ts).",
  );
}

if (JSON.stringify([...WINDOW_GATED_TOOLS.return_result]) !== JSON.stringify(["task"])) {
  problems.push(
    `WINDOW_GATED_TOOLS.return_result read ${JSON.stringify([...WINDOW_GATED_TOOLS.return_result])} after the ` +
      'flag flip — it is a FIXED ["task"] row and delegation.oneshotAgent must not touch it.',
  );
}
if (JSON.stringify([...WINDOW_GATED_TOOLS.agent]) !== JSON.stringify(["standing", "thread"])) {
  problems.push(
    `WINDOW_GATED_TOOLS.agent read ${JSON.stringify([...WINDOW_GATED_TOOLS.agent])} after the flag flip — it is a ` +
      'FIXED ["standing","thread"] row and delegation.oneshotAgent must not touch it.',
  );
}

overrideSettingsForTest({ delegation: { oneshotAgent: bootFlag } });

if (problems.length > 0) {
  console.error(`✗ full-kit-boot-order: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

console.log(
  `✓ full-kit-boot-order: fullKit() and WINDOW_GATED_TOOLS.web_fetch both followed a post-boot ` +
    `registerSettings() from ${JSON.stringify(bootKit)} to ${JSON.stringify(expectedAfter)}, by value and by ` +
    "reference identity, while the fixed-matrix rows stayed put — an app-level delegation.oneshotAgent " +
    "override reaches the wide-hands mount table (OPE-1105).",
);
process.exit(0);
