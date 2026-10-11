import { defineState } from "eve/context";
import { readPersonOptOut, type PersonOptOutState } from "../identity/person-opt-out.js";

const turnAnswer = defineState<{ key?: string; state?: PersonOptOutState }>("open-everywhere.memory.optOutTurn", () => ({}));

export async function turnPersonOptOut(org: string, principalId: string, turnId: string | undefined): Promise<PersonOptOutState> {
  const key = turnId === undefined ? undefined : `${turnId}\u0000${org}\u0000${principalId}`;
  if (key !== undefined) {
    try {
      const held = turnAnswer.get();
      if (held.key === key && held.state !== undefined) return held.state;
    } catch {
    }
  }
  const state = await readPersonOptOut(org, principalId);
  if (key !== undefined) {
    try {
      turnAnswer.update(() => ({ key, state }));
    } catch {
    }
  }
  return state;
}
