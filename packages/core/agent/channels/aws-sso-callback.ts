import { defineChannel, GET } from "eve/channels";
import { OE_AWS_SSO_CALLBACK_PATH, handleAwsSsoCallback } from "../connections/aws-sso-callback.js";

export default defineChannel({
  routes: [GET(OE_AWS_SSO_CALLBACK_PATH, async (req) => handleAwsSsoCallback(req))],
});
