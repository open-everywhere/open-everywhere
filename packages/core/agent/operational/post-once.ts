import { createHash } from "node:crypto";
import { getOperationalStore } from "./provider.js";

export const OUTBOUND_KEY_PREFIX = "outbound:";

export const OUTBOUND_DEDUPE_TTL_MS = 60_000;

export type MarkEventSeen = (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;

export interface OutboundKeyParts {
  readonly surface: string;
  readonly channel?: string;
  readonly threadTs?: string;
  readonly action: string;
  readonly stableId?: string;
  readonly payload: string;
}

export function outboundKey(parts: OutboundKeyParts): string {
  const material = [
    parts.surface,
    parts.channel ?? "",
    parts.threadTs ?? "",
    parts.action,
    parts.stableId ?? "",
    parts.payload,
  ].join(" ");
  const digest = createHash("sha256").update(material).digest("hex");
  return `${OUTBOUND_KEY_PREFIX}${parts.action}:${digest}`;
}

export interface PostOnceOptions<T> {
  readonly org: string | undefined;
  readonly key: string;
  readonly run: () => Promise<T>;
  readonly skipped?: () => T;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly markEventSeen?: MarkEventSeen;
  readonly releaseKeyOnFailure?: (err: unknown) => boolean;
  readonly forgetEventSeen?: ForgetEventSeen;
}

export type ForgetEventSeen = (org: string, key: string) => Promise<void>;

let warnedStore = false;

export async function postOnce<T>(opts: PostOnceOptions<T>): Promise<T | undefined> {
  const nowFn = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? OUTBOUND_DEDUPE_TTL_MS;

  if (!opts.org) return await opts.run();

  const mark: MarkEventSeen =
    opts.markEventSeen ?? ((org, key, atIso, ttlMs) => getOperationalStore().markEventSeen(org, key, atIso, ttlMs));

  let firstSighting = true;
  try {
    firstSighting = await mark(opts.org, opts.key, new Date(nowFn()).toISOString(), ttl);
  } catch (err) {
    if (!warnedStore) {
      warnedStore = true;
      console.warn(
        `[open-everywhere:post-once] dedupe store unavailable — proceeding with post (fail-open): ${String(err)}`,
      );
    }
    firstSighting = true;
  }

  if (!firstSighting) {
    return opts.skipped ? opts.skipped() : undefined;
  }
  if (!opts.releaseKeyOnFailure) return await opts.run();
  try {
    return await opts.run();
  } catch (err) {
    let release = false;
    try {
      release = opts.releaseKeyOnFailure(err) === true;
    } catch {
      release = false;
    }
    if (release) {
      const forget: ForgetEventSeen = opts.forgetEventSeen ?? ((org, key) => getOperationalStore().forgetEventSeen(org, key));
      await forget(opts.org, opts.key).catch(() => undefined);
    }
    throw err;
  }
}
