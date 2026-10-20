import { defineChannel, POST } from "eve/channels";
import { CONTROL_TEST_WAKE_PATH, handleTestWakeInjection } from "../control/test-route.js";
import { CONTROL_SECRET_ADOPT_PATH, handleSecretAdopt } from "../control/secret-adopt-route.js";

export default defineChannel({
  routes: [
    POST(CONTROL_TEST_WAKE_PATH, async (req, { to }) => handleTestWakeInjection(req, to)),
    POST(CONTROL_SECRET_ADOPT_PATH, async (req) => handleSecretAdopt(req)),
  ],
});
