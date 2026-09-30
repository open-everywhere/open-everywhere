import { parseHooksFile, type HooksFile } from "@open-everywhere/core/agent/webhooks/hooks-codemod.js";
import hooksOverlay from "./hooks.generated.js";

const overlay: HooksFile = parseHooksFile(hooksOverlay);

export function loadHooksOverlay(): HooksFile {
  return overlay;
}
