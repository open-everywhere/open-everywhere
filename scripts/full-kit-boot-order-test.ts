import { registerSettings, getSettings } from "@open-everywhere/core/agent/settings/settings.js";

const problems: string[] = [];

await import("../agent/lib/register-config.js");
const { FULL_KIT, WINDOW_GATED_TOOLS } = await import("@open-everywhere/core/agent/access/window-gate-manifest.js");
const { oneshotAgentEnabled } = await import("@open-everywhere/core/agent/access/delegation-flag.js");

const bootFlag = oneshotAgentEnabled();
const bootKit = [...FULL_KIT];
const bootWebFetch = [...WINDOW_GATED_TOOLS.web_fetch];

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

const kitAfter = [...FULL_KIT];
if (JSON.stringify(kitAfter) !== JSON.stringify(bootKit)) {
  problems.push(
    `FULL_KIT changed from ${JSON.stringify(bootKit)} to ${JSON.stringify(kitAfter)} after a post-boot ` +
      "registerSettings() call. The OPE-1101 ordering bug this test pins is now FIXED — update this " +
      "test's expectations, and correct access/delegation-flag.ts + access/window-gate-manifest.ts's " +
      "headers, which currently document an app-level delegation.oneshotAgent override as inert.",
  );
}

const webFetchAfter = [...WINDOW_GATED_TOOLS.web_fetch];
if (JSON.stringify(webFetchAfter) !== JSON.stringify(bootWebFetch)) {
  problems.push(
    `WINDOW_GATED_TOOLS.web_fetch changed from ${JSON.stringify(bootWebFetch)} to ${JSON.stringify(webFetchAfter)} ` +
      "after a post-boot registerSettings() call — see the FULL_KIT problem above; this is the same bug " +
      "reaching the table windowGated()/windowGatedKit() actually consult.",
  );
}

if (problems.length > 0) {
  console.error(`✗ full-kit-boot-order: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

console.log(
  "✓ full-kit-boot-order: FULL_KIT and WINDOW_GATED_TOOLS.web_fetch stay pinned to their boot-time read " +
    "even after a live registerSettings() change confirmed reaching getSettings() — the OPE-1101 finding " +
    "(an app-level delegation.oneshotAgent override never reaches FULL_KIT) holds.",
);
process.exit(0);
