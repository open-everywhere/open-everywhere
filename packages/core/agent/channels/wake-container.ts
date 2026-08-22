import type { BindableContext } from "../identity/binding.js";
import { resolveReadAdapter, type ReadAdapter } from "./channel-read.js";
import type { Domain } from "../memory/domain.js";

export class WakeContainerError extends Error {}

export interface WakeReadTarget {
  readonly platform: string;
  readonly adapter: ReadAdapter;
  readonly container: string;
  readonly threadRoot?: string;
}

export function resolveWakeChannel(ctx: BindableContext, domains: readonly Domain[]): WakeReadTarget {
  const { platform, adapter } = resolveReadAdapter(ctx, undefined, domains);
  const address = adapter.wakeAddress(ctx);
  if (!address?.container) {
    throw new WakeContainerError(
      `read: this ${platform} turn's wake names no container to read, so there is nothing to fetch. Say what ` +
        "you can see and what you cannot; do not state message content you have not read.",
    );
  }
  return { platform, adapter, container: address.container, ...(address.threadRoot ? { threadRoot: address.threadRoot } : {}) };
}

export function requireWakeThreadRoot(target: WakeReadTarget): string {
  if (!target.threadRoot) {
    throw new WakeContainerError(
      "read_thread: this turn is not in a thread — it arrived at the top level of its container. Use " +
        "`read_channel` to read the room instead.",
    );
  }
  return target.threadRoot;
}
