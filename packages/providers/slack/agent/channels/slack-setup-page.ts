import { defineChannel, GET, POST } from "eve/channels";
import {
  SLACK_SETUP_CALLBACK_PATH,
  SLACK_SETUP_PATH,
  handleSlackSetupCallback,
  handleSlackSetupGet,
  handleSlackSetupPost,
} from "../setup/page.js";

export default defineChannel({
  routes: [
    GET(SLACK_SETUP_PATH, async (req) => handleSlackSetupGet(req)),
    POST(SLACK_SETUP_PATH, async (req) => handleSlackSetupPost(req)),
    GET(SLACK_SETUP_CALLBACK_PATH, async (req) => handleSlackSetupCallback(req)),
  ],
});
