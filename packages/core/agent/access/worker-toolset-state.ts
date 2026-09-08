import { defineState } from "eve/context";

export interface WorkerToolsetIdentity {
  readonly org: string;
  readonly domain: string;
  readonly worker: string;
  readonly parentSession: string | null;
  readonly parentCallId: string | null;
  readonly rootSession: string | null;
  readonly turn: string | null;
}

const identity = defineState<WorkerToolsetIdentity | null>("open-everywhere.worker-toolset.identity", () => null);
const lastRoster = defineState<string | null>("open-everywhere.worker-toolset.last-roster", () => null);

export function setWorkerToolsetIdentity(next: WorkerToolsetIdentity | null): void {
  try {
    identity.update(() => next);
  } catch {
  }
}

export function currentWorkerToolsetIdentity(): WorkerToolsetIdentity | null {
  try {
    return identity.get();
  } catch {
    return null;
  }
}

export type WorkerToolsetClaim = "mount" | "changed";

export function claimWorkerToolsetEvidence(key: string): WorkerToolsetClaim | null {
  try {
    let claim: WorkerToolsetClaim | null = null;
    lastRoster.update((cur) => {
      if (cur === key) return cur;
      claim = cur === null ? "mount" : "changed";
      return key;
    });
    return claim;
  } catch {
    return null;
  }
}
