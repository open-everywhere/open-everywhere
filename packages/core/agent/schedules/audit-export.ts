import { defineSchedule } from "eve/schedules";
import { runAuditExport } from "../audit/siem-export.js";

export default defineSchedule({
  cron: "*/5 * * * *",
  async run() {
    const outcomes = await runAuditExport();
    for (const o of outcomes) {
      if (o.sent > 0 || o.error !== undefined) {
        console.log(`[open-everywhere:audit-export] target "${o.target}" org "${o.org}": sent ${o.sent}, cursor ${o.cursor}${o.error ? `, stopped: ${o.error}` : ""}`);
      }
    }
  },
});
