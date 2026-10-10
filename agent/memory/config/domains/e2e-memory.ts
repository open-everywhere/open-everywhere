import { testValveArmed } from "@open-everywhere/core/agent/testing/test-valves.js";
import { defineDomain } from "@open-everywhere/core/agent/memory/domain.js";
import { E2E_NOTION_SURFACE } from "../fixture-surfaces.js";

export const domain = defineDomain({
  name: "e2e-memory",
  reach: ["slack/T0EXAMPLE/C0EXCHAN005", E2E_NOTION_SURFACE],
  memory: ["payments-brain", "platform-notes", "misc", "handbook-cache"],
  ambientSupervisor: true,
  mode: "unified",
  reasoningCeiling: "high",
});

export const enabled = (): boolean => testValveArmed("memory-eval");
