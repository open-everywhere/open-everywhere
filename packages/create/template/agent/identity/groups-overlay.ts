import { parseGroupsFile, type GroupsFile } from "@open-everywhere/core/agent/identity/groups-codemod.js";
import groupsOverlay from "./groups.generated.js";

const overlay: GroupsFile = parseGroupsFile(groupsOverlay);

export function loadGroupsOverlay(): GroupsFile {
  return overlay;
}
