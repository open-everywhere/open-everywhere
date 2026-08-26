import { randomUUID } from "node:crypto";
import type { Partition } from "../memory/partition.js";
import { assertKnownSubscription, assertReportConsistent, type Routine } from "./routine.js";
import { getOperationalStore } from "../operational/provider.js";
import type { RoutinePromptProvenance, RoutinePromptRevisionRow } from "../operational/store.js";

export function routinesRoot(): string {
  return getOperationalStore().root();
}

export function newRoutineId(): string {
  return `r-${randomUUID().slice(0, 8)}`;
}

export function newPolicyRuleId(): string {
  return `p-${randomUUID().slice(0, 8)}`;
}

export function listRoutines(p: Partition): Promise<Routine[]> {
  return getOperationalStore().listRoutines(p.org, p.surfaceKey);
}

export function getRoutine(org: string, surfaceKey: string, id: string): Promise<Routine | null> {
  return getOperationalStore().getRoutine(org, surfaceKey, id);
}

export function addRoutine(_p: Partition, routine: Routine): Promise<Routine> {
  assertReportConsistent(routine.trigger, routine.report, routine.sessionMode);
  assertKnownSubscription(routine.trigger);
  return getOperationalStore().addRoutine(routine);
}

export function updateRoutine(
  org: string,
  surfaceKey: string,
  id: string,
  patch: Partial<Routine>,
  provenance?: RoutinePromptProvenance,
): Promise<Routine | null> {
  return getOperationalStore().updateRoutine(org, surfaceKey, id, patch, provenance);
}

export function listRoutinePromptRevisions(org: string, surfaceKey: string, routineId?: string): Promise<RoutinePromptRevisionRow[]> {
  return getOperationalStore().listRoutinePromptRevisions(org, surfaceKey, routineId);
}

export function removeRoutine(p: Partition, id: string): Promise<boolean> {
  return getOperationalStore().removeRoutine(p.org, p.surfaceKey, id);
}

export function listAllRoutines(): Promise<Routine[]> {
  return getOperationalStore().listAllRoutines();
}
