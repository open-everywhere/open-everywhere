import { parseHooksFile, type HooksFile } from "@open-everywhere/core/agent/webhooks/hooks-codemod.js";
import hooksJson from "./hooks.json" with { type: "json" };

const overlay: HooksFile = parseHooksFile(hooksJson);

export function loadHooksOverlay(): HooksFile {
  return overlay;
}
