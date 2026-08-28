import { parseAgentsFile, type AgentsFile } from "@open-everywhere/core/agent/memory/agents-codemod.js";
import agentsOverlay from "./agents.generated.js";

const overlay: AgentsFile = parseAgentsFile(agentsOverlay);

export function loadAgentsOverlay(): AgentsFile {
  return overlay;
}
