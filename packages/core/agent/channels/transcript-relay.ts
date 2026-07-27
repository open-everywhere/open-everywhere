import { defineChannel, POST } from "eve/channels";
import { TRANSCRIPT_RELAY_PATH, handleTranscriptRelay } from "../control/transcript-relay.js";

export default defineChannel({
  routes: [POST(TRANSCRIPT_RELAY_PATH, async (req, { getSession }) => handleTranscriptRelay(req, getSession))],
});
