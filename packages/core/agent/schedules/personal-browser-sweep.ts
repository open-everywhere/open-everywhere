import { defineSchedule } from "eve/schedules";
import { deploymentOrg } from "../identity/binding.js";
import { sweepPersonalBrowsers } from "../personal-browser/lifecycle.js";

export default defineSchedule({
  cron: "*/5 * * * *",
  async run() {
    const { closed, returned, stopped } = await sweepPersonalBrowsers(deploymentOrg());
    if (closed.length > 0) console.log(`[open-everywhere:personal-browser-sweep] closed ${closed.length} browser box(es): ${closed.join(", ")}`);
    if (returned.length > 0) console.log(`[open-everywhere:personal-browser-sweep] returned the controls to the agent after an expired take-over on ${returned.length} box(es)`);
    if (stopped.length > 0) console.log(`[open-everywhere:personal-browser-sweep] stopped ${stopped.length} browser box(es) no record accounts for: ${stopped.join(", ")}`);
  },
});
