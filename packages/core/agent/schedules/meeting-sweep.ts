import { defineSchedule } from "eve/schedules";
import { deploymentOrg } from "../identity/binding.js";
import { sweepMeetingBoxes } from "../meetings/lifecycle.js";
import { sweepNativeWatches } from "../meetings/native-recap.js";

export default defineSchedule({
  cron: "*/15 * * * *",
  async run() {
    const { finished, stopped } = await sweepMeetingBoxes(deploymentOrg());
    if (finished.length > 0) console.log(`[open-everywhere:meeting-sweep] finished ${finished.length} meeting(s) past their cap: ${finished.join(", ")}`);
    if (stopped.length > 0) console.log(`[open-everywhere:meeting-sweep] stopped ${stopped.length} unrecorded meeting box(es) past their cap: ${stopped.join(", ")}`);
    const { settled, deferred } = await sweepNativeWatches(deploymentOrg());
    if (settled.length > 0) console.log(`[open-everywhere:meeting-sweep] settled ${settled.length} recap(s) waiting on a platform transcript: ${settled.join(", ")}`);
    if (deferred > 0) console.warn(`[open-everywhere:meeting-sweep] the tick ran out of time; ${deferred} recap watch(es) wait for the next tick`);
  },
});
