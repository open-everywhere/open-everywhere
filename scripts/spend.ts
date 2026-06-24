import { allLedgers, spendRoot } from "../agent/spend/store.js";
import { windowTokens } from "../agent/spend/spend.js";
import { resolveCaps } from "../agent/spend/caps.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const period = arg("period") ?? new Date().toISOString().slice(0, 7);
const ledgers = await allLedgers();

console.log(`\nSpend ledger: ${spendRoot()}   period: ${period}`);
console.log("─".repeat(70));

if (ledgers.length === 0) {
  console.log("  (no usage recorded yet)");
} else {
  const byWorkspace = new Map<string, number>();
  for (const { org, surfaceKey, ledger } of ledgers) {
    const tokens = windowTokens(ledger.windows[period]);
    const caps = resolveCaps(surfaceKey.split("/").slice(0, 2).join("/"), surfaceKey);
    const cap = caps.surfaceMonthlyTokens;
    const flag = cap != null && tokens >= cap ? "  ⛔ OVER" : cap != null ? `  / ${cap.toLocaleString()}` : "";
    console.log(`  ${`${org}/${surfaceKey}`.padEnd(44)} ${tokens.toLocaleString().padStart(12)}${flag}`);
    const wk = `${org}/${surfaceKey.split("/").slice(0, 2).join("/")}`;
    byWorkspace.set(wk, (byWorkspace.get(wk) ?? 0) + tokens);
  }
  console.log("  " + "─".repeat(64));
  for (const [wk, tokens] of byWorkspace) {
    const cap = resolveCaps(wk.split("/").slice(1).join("/"), "").workspaceMonthlyTokens;
    const flag = cap != null && tokens >= cap ? "  ⛔ OVER" : cap != null ? `  / ${cap.toLocaleString()}` : "";
    console.log(`  ${("workspace " + wk).padEnd(44)} ${tokens.toLocaleString().padStart(12)}${flag}`);
  }
}
console.log();
