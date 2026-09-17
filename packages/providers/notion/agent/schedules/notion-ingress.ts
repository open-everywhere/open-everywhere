import { defineSchedule } from "eve/schedules";
import { deploymentOrg, getOperationalStore } from "@open-everywhere/core/agent/adapter-api.js";

import { recoverNotionIngress } from "../channels/notion-ingress-drain.js";

export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const result = await recoverNotionIngress(deploymentOrg(), getOperationalStore());
    if (result.due > 0) {
      console.log(
        `[open-everywhere:notion] ingress recovery: ${result.due} due -> ${result.posted} posted, ${result.failed} failed`,
      );
    }
  },
});
