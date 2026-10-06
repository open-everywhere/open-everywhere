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

const resolvedTurn = defineState<string | null>("open-everywhere.delegated-binding.resolved-turn", () => null);

export function delegatedAuthorityResolvedFor(turnId: string): boolean {
  try {
    return resolvedTurn.get() === turnId;
  } catch {
    return false;
  }
}

export function refreshDelegatedAuthority(authority: DelegatedDispatchAuthority, turnId: string): boolean {
  try {
    slot.update(() => authority);
    resolvedTurn.update(() => turnId);
    return true;
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

const rootSessionSlot = defineState<string | null>("open-everywhere.delegated-binding.root-session", () => null);

export function adoptDelegatedRootSession(rootSessionId: string): boolean {
  try {
    if (rootSessionId.length === 0) return false;
    const current = rootSessionSlot.get();
    if (current === null) {
      rootSessionSlot.update(() => rootSessionId);
      return true;
    }
    return current === rootSessionId;
  } catch {
    return false;
  }
}

export function delegatedRootSessionId(): string | undefined {
  try {
    return rootSessionSlot.get() ?? undefined;
  } catch {
    return undefined;
  }
}
