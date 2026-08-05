import { defineSchedule } from "eve/schedules";
import { runDirectorySync } from "../identity/directory-sync.js";

export default defineSchedule({
  cron: "0 3 * * *",
  async run() {
    await runDirectorySync();
  },
});
