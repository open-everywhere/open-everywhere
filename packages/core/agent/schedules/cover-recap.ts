import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";
import { coverRecapTick, deliverCoverRecap } from "../cover/recap.js";

export default defineSchedule({
  cron: "*/5 * * * *",
  async run(args: ScheduleHandlerArgs) {
    const report = await coverRecapTick({ deliver: (d) => deliverCoverRecap({ to: args.to, appAuth: args.appAuth }, d) });
    if (report.ended > 0 || report.delivered > 0 || report.failed > 0) {
      console.log(`[open-everywhere:cover] ${report.ended} cover(s) reached their end date, ${report.delivered} recap(s) delivered, ${report.failed} refused`);
    }
  },
});
