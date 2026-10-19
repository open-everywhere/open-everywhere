import { defineState } from "eve/context";
import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";
import { noteGenerationForRetirement } from "./generation-retirement.js";
import { nonMemberChatTrust } from "../access/taint-signal.js";
import { admitToSummary, buildTail, condenseTailEntry, planConversationCarry, tailEntryToWakeMessage, type SessionTailEntry, type SessionTailWakeRow } from "./session-tail.js";
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
  entry: SessionTailWakeRow,
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
      refuted: false,
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
    if (await store.editSessionTailPost(w.org, w.registryKey, w.token, messageId, text)) return true;
    return await store.editConversationSummaryPost(w.org, w.registryKey, messageId, condenseTailEntry({ kind: "post", at: "", from: "self", trust: "relay", author: "self", text }).text);
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
  noteGenerationForRetirement({ org, registryKey, token: outgoingToken });
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

export async function carryConversationForward(
  org: string,
  registryKey: string,
  outgoingToken: string | undefined,
  store: OperationalStore = getOperationalStore(),
): Promise<WakeMessageInput[]> {
  if (!outgoingToken) return [];
  noteGenerationForRetirement({ org, registryKey, token: outgoingToken });
  let ring: SessionTailEntry[];
  try {
    ring = await store.readSessionTail(org, registryKey, outgoingToken);
  } catch (err) {
    console.warn(`[open-everywhere:session-tail] tail not carried forward (${registryKey}): ${String(err)}`);
    return [];
  }
  let prior: SessionTailEntry[] | undefined;
  try {
    prior = await store.readConversationSummary(org, registryKey);
  } catch (err) {
    console.warn(`[open-everywhere:session-tail] conversation summary not read (${registryKey}) — carrying the tail only: ${String(err)}`);
  }
  try {
    if (prior === undefined) {
      const tail = buildTail(ring);
      await store.clearSessionTail(org, registryKey, outgoingToken).catch(() => {});
      return tail;
    }
    const carry = planConversationCarry(prior, ring, undefined, (e) => admitToSummary(e) && !nonMemberChatTrust(e));
    if (carry.record.length > 0) {
      await store.writeConversationSummary(org, registryKey, carry.record).catch((err: unknown) => {
        console.warn(`[open-everywhere:session-tail] conversation summary not written (${registryKey}): ${String(err)}`);
      });
    }
    await store.clearSessionTail(org, registryKey, outgoingToken).catch(() => {});
    return [...carry.summary, ...carry.tail].map(tailEntryToWakeMessage);
  } catch (err) {
    console.warn(`[open-everywhere:session-tail] conversation not carried forward (${registryKey}): ${String(err)}`);
    return [];
  }
}

export async function readConversationCarry(org: string, registryKey: string, store: OperationalStore = getOperationalStore()): Promise<WakeMessageInput[]> {
  try {
    const summary = await store.readConversationSummary(org, registryKey);
    return summary.filter((e) => admitToSummary(e) && !nonMemberChatTrust(e)).map(tailEntryToWakeMessage);
  } catch (err) {
    console.warn(`[open-everywhere:session-tail] conversation summary not read for the heal (${registryKey}): ${String(err)}`);
    return [];
  }
}

export async function readWindowRing(
  store: OperationalStore = getOperationalStore(),
): Promise<{ readonly ring: SessionTailEntry[]; readonly container?: string } | undefined> {
  const w = tailWindow();
  if (!w) return undefined;
  try {
    const ring = await store.readSessionTail(w.org, w.registryKey, w.token);
    return { ring, ...(w.container ? { container: w.container } : {}) };
  } catch (err) {
    console.warn(`[open-everywhere:session-tail] window ring not read (${w.registryKey}): ${String(err)}`);
    return undefined;
  }
}
