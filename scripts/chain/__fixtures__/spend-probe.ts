import { sqliteOperationalStore } from "../../../packages/core/agent/operational/sqlite.js";

const ORG = "org-chain-leg-isolation-probe";
const seen = await sqliteOperationalStore.spendTotals(ORG);
(globalThis as unknown as { __oeSpendProbe?: number }).__oeSpendProbe = seen.usdMicros;
await sqliteOperationalStore.recordSpend(ORG, {
  surfaceKey: "chain-leg-probe",
  period: "2026-08",
  usdMicros: 1_000_000,
  usdMicrosMeasured: 1_000_000,
  costSource: "measured",
});
