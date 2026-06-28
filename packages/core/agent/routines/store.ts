import { randomUUID } from "node:crypto";
import type { Partition } from "../memory/partition.js";
import type { Routine } from "./routine.js";
import { getOperationalStore } from "../operational/provider.js";

export function routinesRoot(): string {
  return getOperationalStore().root();
}

export function newRoutineId(): string {
  return `r-${randomUUID().slice(0, 8)}`;
}

export function listRoutines(p: Partition): Promise<Routine[]> {
  return getOperationalStore().listRoutines(p.org, p.surfaceKey);
}

export function getRoutine(org: string, surfaceKey: string, id: string): Promise<Routine | null> {
  return getOperationalStore().getRoutine(org, surfaceKey, id);
}

export function addRoutine(_p: Partition, routine: Routine): Promise<Routine> {
  return getOperationalStore().addRoutine(routine);
}

export function updateRoutine(
  org: string,
  surfaceKey: string,
  id: string,
  patch: Partial<Routine>,
): Promise<Routine | null> {
  return getOperationalStore().updateRoutine(org, surfaceKey, id, patch);
}

export function removeRoutine(p: Partition, id: string): Promise<boolean> {
  return getOperationalStore().removeRoutine(p.org, p.surfaceKey, id);
}

export function listAllRoutines(): Promise<Routine[]> {
  return getOperationalStore().listAllRoutines();
}
