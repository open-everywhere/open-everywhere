import { AsyncLocalStorage } from "node:async_hooks";

interface RouteHold {
  pending: Promise<unknown>[];
}

const MAX_DRAIN_ROUNDS = 10;

const routeHold = new AsyncLocalStorage<RouteHold>();

export function withSlackRouteHold<T>(fn: () => T): T {
  return routeHold.run({ pending: [] }, fn);
}

export function holdRouteWork<T>(work: Promise<T>): Promise<T> {
  routeHold.getStore()?.pending.push(work);
  return work;
}

export function routeHoldQuiesced(work: Promise<unknown>): Promise<void> {
  const hold = routeHold.getStore();
  return (async () => {
    await Promise.allSettled([work]);
    if (!hold) return;
    for (let round = 0; round < MAX_DRAIN_ROUNDS && hold.pending.length > 0; round++) {
      const batch = hold.pending;
      hold.pending = [];
      await Promise.allSettled(batch);
    }
  })();
}
