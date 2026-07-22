import { defineChannel, GET } from "eve/channels";
import {
  OE_OAUTH_CALLBACK_PATH,
  handleOeOauthCallback,
  resolveOeOauthCallbackCompleter,
} from "../connections/oe-oauth-callback.js";

export default defineChannel({
  routes: [GET(OE_OAUTH_CALLBACK_PATH, async (req) => handleOeOauthCallback(req, resolveOeOauthCallbackCompleter()))],
});
