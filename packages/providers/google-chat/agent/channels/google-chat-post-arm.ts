import { markNotApplied, type PostArm, type UnifiedReplyDeps, type UnifiedWakeOrigin } from "@open-everywhere/core/agent/adapter-api.js";
import { googleChatPolicy, type GoogleChatPolicy } from "../policy.js";
import { createGoogleChatMessage, type GoogleChatPostDeps } from "./google-chat-rest.js";
import { googleChatWakeOriginCodec, type GoogleChatOrigin } from "./google-chat-origin-codec.js";

export interface GoogleChatReplyDeps extends GoogleChatPostDeps {
  readonly policy?: () => GoogleChatPolicy;
}

export async function sendGoogleChatReply(origin: GoogleChatOrigin, text: string, deps: GoogleChatReplyDeps = {}): Promise<string> {
  if (!googleChatWakeOriginCodec.validate(origin as unknown as Record<string, unknown>)) {
    throw markNotApplied(new Error("reply couldn't post to Google Chat — the stored reply target is not a valid Google Chat origin."));
  }
  const policy = (deps.policy ?? googleChatPolicy)();
  if (!policy.enabled) throw markNotApplied(new Error("reply couldn't post to Google Chat — the surface is turned off in agent/google-chat/policy.ts."));
  if (origin.workspace !== policy.workspace) {
    throw markNotApplied(new Error("reply couldn't post to Google Chat — the stored reply target belongs to another workspace."));
  }
  return createGoogleChatMessage({ space: origin.space, ...(origin.thread !== undefined ? { thread: origin.thread } : {}), text }, deps);
}

export const googleChatPostArm: PostArm = {
  platform: "google-chat",
  dispatchUnified: (origin: UnifiedWakeOrigin, text: string, _deps: UnifiedReplyDeps) => sendGoogleChatReply(origin as GoogleChatOrigin, text),
  describeRedriveTarget: (origin) => `Google Chat ${(origin as GoogleChatOrigin).space}`,
  redriveContainerId: (origin) => (origin as GoogleChatOrigin).space,
};
