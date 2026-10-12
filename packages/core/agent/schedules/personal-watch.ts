import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";
import { deliverWatchNudge } from "../personal-watch/deliver.js";
import { personalWatchTick } from "../personal-watch/watch.js";

export default defineSchedule({
  cron: "*/30 * * * *",
  async run(args: ScheduleHandlerArgs) {
    const report = await personalWatchTick({ deliver: (d) => deliverWatchNudge({ to: args.to, appAuth: args.appAuth }, d) });
    if (report.checked > 0 || report.deferred > 0) {
      console.log(
        `[open-everywhere:personal-watch] checked ${report.checked} person(s): ${report.nudged} nudge(s), ${report.silenced} silence row(s)` +
          (report.deferred > 0 ? `, ${report.deferred} left for the next tick` : ""),
      );
    }
  },
});
