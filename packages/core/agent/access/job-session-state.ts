import { defineState } from "eve/context";
import { resolveJobWakePosture, type JobWakePosture } from "./job-posture.js";
import { readWakeSlot, writeWakeSlot } from "./wake-slot.js";

const JOB_SESSION_SLOT = "open-everywhere.job-session";
const ESCALATED_SLOT = "open-everywhere.job-wake-escalated";
const jobSessionSlot = defineState<boolean>(JOB_SESSION_SLOT, () => false);
const escalatedSlot = defineState<boolean>(ESCALATED_SLOT, () => false);

export function markJobSession(): void {
  writeWakeSlot(JOB_SESSION_SLOT, () => jobSessionSlot.update(() => true));
}

export function isJobSession(): boolean {
  return readWakeSlot(JOB_SESSION_SLOT, () => jobSessionSlot.get(), { contextless: false, restricting: true });
}

export function setJobWakeEscalated(escalated: boolean): void {
  writeWakeSlot(ESCALATED_SLOT, () => escalatedSlot.update(() => escalated));
}

export function jobWakeEscalated(): boolean {
  return readWakeSlot(ESCALATED_SLOT, () => escalatedSlot.get(), { contextless: false, restricting: false });
}

export function currentJobWakePosture(): JobWakePosture {
  return readWakeSlot<JobWakePosture>(
    `${JOB_SESSION_SLOT}+${ESCALATED_SLOT}`,
    () =>
      resolveJobWakePosture({ jobFire: false, jobSession: jobSessionSlot.get(), humanPrincipal: escalatedSlot.get() }),
    { contextless: "unrestricted", restricting: "restricted" },
  );
}
