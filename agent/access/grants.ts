import { parseGrantsFile, type GrantsFile } from "@open-everywhere/core/agent/access/grants-codemod.js";
import grantsJson from "./grants.json" with { type: "json" };

const overlay: GrantsFile = parseGrantsFile(grantsJson);

export function loadGrantsOverlay(): GrantsFile {
  return overlay;
}
