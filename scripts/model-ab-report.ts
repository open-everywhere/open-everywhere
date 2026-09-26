import { readAudit } from "@open-everywhere/core/agent/audit/audit.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { usageForSession } from "@open-everywhere/core/agent/spend/usage-events.js";
import { resolveAssumedModel } from "@open-everywhere/core/agent/spend/reporting.js";
import { registerModelPricing } from "@open-everywhere/core/agent/spend/pricing.js";
import type { UsageEventEntry } from "@open-everywhere/core/agent/operational/store.js";
import { MODEL_AB_ARM_ACTION, MODEL_AB_RATING_ACTION } from "@open-everywhere/core/agent/model/ab-test.js";
import { ARMS, armedSessions, tallyModelAb } from "./model-ab-report-lib.js";
import { importAppModule, resolveAppRoot } from "@open-everywhere/core/agent/scaffold/app-root.js";

const APP_ROOT = resolveAppRoot();
const { loadModelPricing } = await importAppModule<typeof import("../agent/spend/model-pricing.js")>("agent/spend/model-pricing.ts", APP_ROOT);
const { MODEL_AB_TEST } = await importAppModule<typeof import("../agent/model/ab-test.js")>("agent/model/ab-test.ts", APP_ROOT);
const { PRIMARY_MODEL } = await importAppModule<typeof import("../agent/model/models.js")>("agent/model/models.ts", APP_ROOT);

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function reportOrg(org: string, limit: number): Promise<void> {
  const armRows = await readAudit({ org, action: MODEL_AB_ARM_ACTION, limit });
  const ratingRows = await readAudit({ org, action: MODEL_AB_RATING_ACTION, limit });
  const usageBySession = new Map<string, readonly UsageEventEntry[]>();
  for (const sessionId of armedSessions(armRows).keys()) usageBySession.set(sessionId, await usageForSession(org, sessionId));

  const assumed = resolveAssumedModel();
  const { tallies } = tallyModelAb({ armRows, ratingRows, usageBySession }, assumed);

  console.log(`\n=== model A/B — org "${org}" ===`);
  console.log(`champion   = ${PRIMARY_MODEL}`);
  console.log(`challenger = ${MODEL_AB_TEST.challenger} @ ${MODEL_AB_TEST.percent}% of conversations${MODEL_AB_TEST.percent === 0 ? " (OFF)" : ""}`);
  for (const arm of ARMS) {
    const t = tallies[arm];
    const mean = t.ratings > 0 ? (t.ratingSum / t.ratings).toFixed(2) : "—";
    const perTurn = t.turns > 0 ? `$${(t.usd / t.turns).toFixed(5)}/turn` : "—";
    console.log(
      `${arm.padEnd(11)} turns=${t.turns} · ratings=${t.ratings} (mean ${mean}) · ` +
        `calls=${t.calls} · tokens ${t.inputTokens}in/${t.outputTokens}out · $${t.usd.toFixed(4)} (${perTurn})` +
        (t.unpricedCalls > 0 ? ` · ${t.unpricedCalls} unpriced call(s)` : ""),
    );
  }
  if (tallies.champion.turns === 0 && tallies.challenger.turns === 0) {
    console.log("no armed turns recorded — the experiment has not run in this org (or its rows aged out).");
  }
  console.log(`basis: ${assumed.note}`);
  console.log("means are descriptive only — voluntary ratings, no significance test. See the header of this script.");
}

registerModelPricing(loadModelPricing());

const limit = Number(argOf("--limit") ?? 2000);
if (!Number.isInteger(limit) || limit <= 0) {
  console.error(`--limit must be a positive integer, got ${JSON.stringify(argOf("--limit"))}`);
  process.exit(2);
}
const only = argOf("--org");
const orgs = only ? [only] : await getOperationalStore().listAuditOrgs();
if (orgs.length === 0) console.log("no orgs in this operational store.");
for (const org of orgs) await reportOrg(org, limit);
