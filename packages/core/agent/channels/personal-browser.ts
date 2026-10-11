import { defineChannel, GET, POST } from "eve/channels";
import {
  BROWSER_LIVE_PATH,
  BROWSER_VIEW_PATH,
  handleLiveControl,
  handleLiveFrame,
  handleLiveGet,
  handleLiveInput,
  handleLiveState,
  handleViewGet,
  handleViewPost,
} from "../personal-browser/viewer.js";

export default defineChannel({
  routes: [
    GET(BROWSER_VIEW_PATH, async (req) => handleViewGet(req)),
    POST(BROWSER_VIEW_PATH, async (req) => handleViewPost(req)),
    GET(BROWSER_LIVE_PATH, async (req) => handleLiveGet(req)),
    GET(`${BROWSER_LIVE_PATH}/frame`, async (req) => handleLiveFrame(req)),
    GET(`${BROWSER_LIVE_PATH}/state`, async (req) => handleLiveState(req)),
    POST(`${BROWSER_LIVE_PATH}/control`, async (req) => handleLiveControl(req)),
    POST(`${BROWSER_LIVE_PATH}/input`, async (req) => handleLiveInput(req)),
  ],
});
