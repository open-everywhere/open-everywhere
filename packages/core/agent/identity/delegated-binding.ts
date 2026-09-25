import { defineState } from "eve/context";
import type { SurfaceBinding } from "./binding.js";
import type { RequesterVerdict } from "../access/requester-identity.js";

export type DelegatedDispatchAuthority = {
  readonly binding: SurfaceBinding;
  readonly requester: RequesterVerdict;
  readonly nonMemberWake: boolean;
  readonly wakeId?: string;
};

const slot = defineState<DelegatedDispatchAuthority | null>("open-everywhere.delegated-binding", () => null);

export function adoptDelegatedAuthority(authority: DelegatedDispatchAuthority, _turnId: string | undefined): boolean {
  try {
    const current = slot.get();
    if (current === null) {
      slot.update(() => authority);
      return true;
    }
    return JSON.stringify(current) === JSON.stringify(authority);
  } catch {
    return false;
  }
}

export function pinDelegatedBindingToTurn(_turnId: string | undefined): boolean {
  try {
    return slot.get() !== null;
  } catch {
    return false;
  }
}

export function delegatedBindingAdopted(): boolean {
  try {
    return slot.get() !== null;
  } catch {
    return false;
  }
}

export function delegatedSlotState(): "adopted" | "empty" | "no-context" {
  try {
    return slot.get() !== null ? "adopted" : "empty";
  } catch {
    return "no-context";
  }
}

export function delegatedBindingThisTurn(_turnId: string | undefined): SurfaceBinding | undefined {
  try {
    const current = slot.get();
    return current?.binding;
  } catch {
    return undefined;
  }
}

export function delegatedRequesterThisTurn(_turnId: string | undefined): RequesterVerdict | undefined {
  try {
    return slot.get()?.requester;
  } catch {
    return undefined;
  }
}

export function delegatedWakeThisTurn(): string | undefined {
  try {
    return slot.get()?.wakeId;
  } catch {
    return undefined;
  }
}

export function delegatedNonMemberWakeThisTurn(_turnId: string | undefined): boolean | undefined {
  try {
    return slot.get()?.nonMemberWake;
  } catch {
    return undefined;
  }
}
