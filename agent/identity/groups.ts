import {
  assertGroupsValid,
  assertReservedGroupNamespace,
  defineGroup,
  type Group,
} from "@open-everywhere/core/agent/identity/groups.js";
import { loadGroupsOverlay } from "./groups-overlay.js";

void defineGroup;

const groups: Group[] = [];

assertReservedGroupNamespace(groups);

const overlay = loadGroupsOverlay();
const mergedGroups: readonly Group[] = [...groups, ...overlay.groups];

assertGroupsValid(mergedGroups);

export function loadGroups(): readonly Group[] {
  return mergedGroups;
}

export function loadBaseGroups(): readonly Group[] {
  return groups;
}
