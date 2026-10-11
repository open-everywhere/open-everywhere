import { defineChannel, POST } from "eve/channels";
import { deploymentOrg } from "../identity/binding.js";
import { MAX_CALLBACK_BYTES, MEETING_CALLBACK_PATH, handleMeetingCallback } from "../meetings/lifecycle.js";
import { readCappedBody } from "./self-dispatch.js";

export default defineChannel({
  routes: [
    POST(`${MEETING_CALLBACK_PATH}/:id`, async (req, { waitUntil, params }) => {
      const read = await readCappedBody(req, MAX_CALLBACK_BYTES);
      if ("tooLarge" in read) return new Response(null, { status: 413 });
      const result = await handleMeetingCallback(deploymentOrg(), params["id"] ?? "", read.body, req.headers, { defer: waitUntil });
      return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
    }),
  ],
});
