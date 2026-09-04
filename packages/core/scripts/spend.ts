import { spendRollup, spendRoot } from "../agent/spend/store.js";
import { resolveCaps } from "../agent/spend/caps.js";
import { connectOperatorStoreForCli } from "./operator-store-connect.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const period = arg("period") ?? new Date().toISOString().slice(0, 7);
const target = await connectOperatorStoreForCli();
const rollup = (await spendRollup()).filter((r) => r.period === period);

console.log(`\nSpend ledger: ${spendRoot()}   period: ${period}   store: ${target.label}`);
console.log("─".repeat(70));

if (rollup.length === 0) {
  console.log("  (no usage recorded yet)");
} else {
  const byWorkspace = new Map<string, { tokens: number; usd: number }>();
  for (const { org, surfaceKey, tokens, usd } of rollup) {
    const caps = resolveCaps(surfaceKey.split("/").slice(0, 2).join("/"), surfaceKey);
    const cap = caps.surfaceMonthlyTokens;
    const flag = cap != null && tokens >= cap ? "  ⛔ OVER" : cap != null ? `  / ${cap.toLocaleString()}` : "";
    console.log(`  ${`${org}/${surfaceKey}`.padEnd(44)} ${tokens.toLocaleString().padStart(12)}  $${usd.toFixed(2).padStart(8)}${flag}`);
    const wk = `${org}/${surfaceKey.split("/").slice(0, 2).join("/")}`;
    const acc = byWorkspace.get(wk) ?? { tokens: 0, usd: 0 };
    byWorkspace.set(wk, { tokens: acc.tokens + tokens, usd: acc.usd + usd });
  }
  console.log("  " + "─".repeat(64));
  for (const [wk, { tokens, usd }] of byWorkspace) {
    const cap = resolveCaps(wk.split("/").slice(1).join("/"), "").workspaceMonthlyTokens;
    const flag = cap != null && tokens >= cap ? "  ⛔ OVER" : cap != null ? `  / ${cap.toLocaleString()}` : "";
    console.log(`  ${("workspace " + wk).padEnd(44)} ${tokens.toLocaleString().padStart(12)}  $${usd.toFixed(2).padStart(8)}${flag}`);
  }
}
console.log();
