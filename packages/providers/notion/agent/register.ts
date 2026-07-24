import {
  registerIdentityMapper,
  registerCapabilityManifest,
  registerPostArm,
  registerWakeOriginCodec,
} from "@open-everywhere/core/agent/adapter-api.js";
import { bindNotion } from "./channels/notion-identity.js";
import { notionPostArm } from "./channels/notion-post-arm.js";
import { notionWakeOriginCodec } from "./channels/notion-origin-codec.js";
import { registerNotionMemory } from "./memory/memory.js";

export function registerNotionProvider(): void {
  registerIdentityMapper("notion", bindNotion);
  registerCapabilityManifest("notion", { midTurnPost: true, reactions: false });
  registerPostArm(notionPostArm);
  registerWakeOriginCodec("notion", notionWakeOriginCodec);
  registerNotionMemory();
}
