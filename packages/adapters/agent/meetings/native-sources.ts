import { registerNativeTranscriptSource } from "@open-everywhere/core/agent/adapter-api.js";
import { teamsTranscriptSource } from "./native-teams.js";
import { meetTranscriptSource } from "./native-meet.js";
import { zoomTranscriptSource } from "./native-zoom.js";

export function registerNativeTranscriptSources(): void {
  registerNativeTranscriptSource(teamsTranscriptSource());
  registerNativeTranscriptSource(meetTranscriptSource());
  registerNativeTranscriptSource(zoomTranscriptSource());
}
