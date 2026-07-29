import { AsyncLocalStorage } from "node:async_hooks";

export interface ArmingApproval {
  readonly id: string;
  readonly kind: string;
}

const store = new AsyncLocalStorage<ArmingApproval>();

export function withArmingApproval<T>(approval: ArmingApproval, fn: () => Promise<T>): Promise<T> {
  return store.run(approval, fn);
}

export function armingApproval(): ArmingApproval | undefined {
  return store.getStore();
}
