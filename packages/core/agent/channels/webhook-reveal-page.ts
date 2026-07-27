import { defineChannel, GET, POST } from "eve/channels";
import { REVEAL_PAGE_PATH, handleRevealGet, handleRevealPost } from "../webhooks/reveal-page.js";

export default defineChannel({
  routes: [
    GET(REVEAL_PAGE_PATH, async (req) => handleRevealGet(req)),
    POST(REVEAL_PAGE_PATH, async (req) => handleRevealPost(req)),
  ],
});
