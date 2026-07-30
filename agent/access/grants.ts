import { parseGrantsFile, type GrantsFile } from "@open-everywhere/core/agent/access/grants-codemod.js";
import grantsOverlay from "./grants.generated.js";

const overlay: GrantsFile = parseGrantsFile(grantsOverlay);

export function loadGrantsOverlay(): GrantsFile {
  return overlay;
}
