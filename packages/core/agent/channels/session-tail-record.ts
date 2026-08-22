import { defineState } from "eve/context";
import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";
import { buildTail, type SessionTailEntry } from "./session-tail.js";
import { standingSeatRegistryKey } from "./unified-supervisor.js";
import { bareTokenFromEveContext, classifySessionId } from "./window-key.js";
import type { WakeMessageInput, WakeTrust } from "./wake-envelope.js";

export interface TailWindow {
  readonly org: string;
  readonly registryKey: string;
  readonly token: string;
  readonly platform?: string;
  readonly container?: string;
}

const windowSlot = defineState<TailWindow | null>("open-everywhere.session-tail-window", () => null);

export function tailWindowFor(input: {
  readonly org: string;
  readonly domainKey: string;
  readonly surfaceKey: string;
  readonly rawToken: unknown;
  readonly platform?: string;
}): TailWindow | null {
  const token = bareTokenFromEveContext(input.rawToken);
  if (token === undefined || classifySessionId(token).grain !== "standing") return null;
  return {
    org: input.org,
    registryKey: standingSeatRegistryKey(token, input.domainKey) ?? input.domainKey,
    token,
    ...(input.platform ? { platform: input.platform } : {}),
    container: input.surfaceKey,
  };
}

export function seedTailWindow(w: TailWindow | null): void {
  try {
    windowSlot.update(() => w);
  } catch {
  }
}

export function tailWindow(): TailWindow | null {
  try {
    return windowSlot.get();
  } catch {
    return null;
  }
}

export async function recordWakeTail(
  org: string,
  registryKey: string,
  token: string,
  entry: SessionTailEntry,
  store: OperationalStore = getOperationalStore(),
): Promise<void> {
  try {
    await store.appendSessionTail(org, registryKey, token, entry);
  } catch (err) {
    console.warn(`[open-everywhere:session-tail] wake entry not recorded (${registryKey}): ${String(err)}`);
  }
}

export async function recordPostTail(
  post: {
    readonly text: string;
    readonly at: string;
    readonly platform?: string;
    readonly id?: string;
    readonly wake?: string;
  },
  store: OperationalStore = getOperationalStore(),
): Promise<void> {
  const w = tailWindow();
  if (!w) return;
  try {
    await store.appendSessionTail(w.org, w.registryKey, w.token, {
      kind: "post",
      at: post.at,
      from: "self",
      trust: "relay" satisfies WakeTrust,
      author: "self",
      ...(post.platform ?? w.platform ? { platform: post.platform ?? w.platform } : {}),
      ...(w.container ? { container: w.container } : {}),
      ...(post.id ? { id: post.id } : {}),
      ...(post.wake ? { wake: post.wake } : {}),
      text: post.text,
    });
  } catch (err) {
    console.warn(`[open-everywhere:session-tail] post entry not recorded (${w.registryKey}): ${String(err)}`);
  }
}

export async function editPostTail(messageId: string, text: string, store: OperationalStore = getOperationalStore()): Promise<boolean> {
  const w = tailWindow();
  if (!w) return false;
  try {
    return await store.editSessionTailPost(w.org, w.registryKey, w.token, messageId, text);
  } catch (err) {
    console.warn(`[open-everywhere:session-tail] post entry not edited (${w.registryKey}): ${String(err)}`);
    return false;
  }
}

export async function carryTailForward(
  org: string,
  registryKey: string,
  outgoingToken: string | undefined,
  store: OperationalStore = getOperationalStore(),
): Promise<WakeMessageInput[]> {
  if (!outgoingToken) return [];
  try {
    const ring = await store.readSessionTail(org, registryKey, outgoingToken);
    const tail = buildTail(ring);
    await store.clearSessionTail(org, registryKey, outgoingToken).catch(() => {});
    return tail;
  } catch (err) {
    console.warn(`[open-everywhere:session-tail] tail not carried forward (${registryKey}): ${String(err)}`);
    return [];
  }
}
