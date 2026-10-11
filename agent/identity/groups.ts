import {
  assertGroupsValid,
  assertReservedGroupNamespace,
  defineGroup,
  type Group,
} from "@open-everywhere/core/agent/identity/groups.js";
import { loadGroupsOverlay } from "./groups-overlay.js";

const groups: Group[] = [
  defineGroup({ name: "slack-as-you-pilot", members: ["slack/T0EXAMPLE/U0IT2421PERSON"] }),
];

assertReservedGroupNamespace(groups);

const overlay = loadGroupsOverlay();
const mergedGroups: readonly Group[] = [...groups, ...overlay.groups];

assertGroupsValid(mergedGroups);

export function loadGroups(): readonly Group[] {
  return mergedGroups;
}
