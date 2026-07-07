import { defineChannel, GET } from "eve/channels";
import { CONTROL_READ_USAGE_PATH, handleUsageWindowRead } from "../control/read-route.js";

export default defineChannel({
  routes: [GET(CONTROL_READ_USAGE_PATH, async (req) => handleUsageWindowRead(req))],
});
