import { markNotApplied, type SurfaceMessageOps } from "@open-everywhere/core/agent/adapter-api.js";
import { googleChatPolicy, type GoogleChatPolicy } from "../policy.js";
import { createGoogleChatMessage, type GoogleChatPostDeps } from "./google-chat-rest.js";

export interface GoogleChatNoticeDeps extends GoogleChatPostDeps {
  readonly policy?: () => GoogleChatPolicy;
}

export async function postGoogleChatNotice(channelId: string, text: string, deps: GoogleChatNoticeDeps = {}): Promise<string> {
  const policy = (deps.policy ?? googleChatPolicy)();
  if (!policy.enabled) throw markNotApplied(new Error("the Google Chat surface is turned off."));
  return createGoogleChatMessage({ space: channelId, text }, deps);
}

export const googleChatMessageOps: SurfaceMessageOps = {
  platform: "google-chat",
  postText: (channelId, text) => postGoogleChatNotice(channelId, text),
  async editMessage() {
    throw markNotApplied(new Error("editing a Google Chat message is not built yet."));
  },
};
