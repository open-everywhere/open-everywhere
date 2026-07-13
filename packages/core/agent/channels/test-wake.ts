import { defineChannel, POST } from "eve/channels";
import { CONTROL_TEST_WAKE_PATH, handleTestWakeInjection } from "../control/test-route.js";

export default defineChannel({
  routes: [
    POST(CONTROL_TEST_WAKE_PATH, async (req, { receive }) => handleTestWakeInjection(req, receive)),
  ],
});
