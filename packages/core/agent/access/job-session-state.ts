import { defineState } from "eve/context";
import { resolveJobWakePosture, type JobWakePosture } from "./job-posture.js";

const jobSessionSlot = defineState<boolean>("open-everywhere.job-session", () => false);
const escalatedSlot = defineState<boolean>("open-everywhere.job-wake-escalated", () => false);

export function markJobSession(): void {
  try {
    jobSessionSlot.update(() => true);
  } catch {
  }
}

export function isJobSession(): boolean {
  try {
    return jobSessionSlot.get();
  } catch {
    return false;
  }
}

export function setJobWakeEscalated(escalated: boolean): void {
  try {
    escalatedSlot.update(() => escalated);
  } catch {
  }
}

export function jobWakeEscalated(): boolean {
  try {
    return escalatedSlot.get();
  } catch {
    return false;
  }
}

export function currentJobWakePosture(): JobWakePosture {
  let jobSession = false;
  let escalated = false;
  try {
    jobSession = jobSessionSlot.get();
    escalated = escalatedSlot.get();
  } catch {
    return "unrestricted";
  }
  return resolveJobWakePosture({ jobFire: false, jobSession, humanPrincipal: escalated });
}
