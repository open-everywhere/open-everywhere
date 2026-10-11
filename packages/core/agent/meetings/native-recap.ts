import { createHash, randomBytes } from "node:crypto";
import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { getOperatorSecret } from "../credentials/operator-secrets.js";
import { resolveHalt, haltScopeFor } from "../access/halt.js";
import { meetingPolicy, type MeetingPolicy } from "./policy.js";
import { meetingCompletion } from "./transcription.js";
import { parseRecap, recapPrompt, renderRecapPost } from "./recap.js";
import { claimMeetingRecap } from "./store.js";
import { notifyThread, type FinishDeps } from "./lifecycle.js";
import {
  nativeMeetingMinutes,
  nativeRefusalSentence,
  nativeTimeoutSentence,
  nativeTranscriptSource,
  nativeTranscriptText,
  type NativeMeetingRef,
  type NativeRefusalReason,
  type NativeTranscriptResult,
} from "./native.js";
import { platformLabel, type MeetingPlatform } from "./link.js";
import type { Partition } from "../memory/partition.js";
import type { SurfaceMode } from "../operational/store.js";

const HOUR_MS = 60 * 60_000;

export const NEXT_SESSION_GRACE_MINUTES = 120;

export interface NativeRecapArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly recapId: string;
  readonly url: string;
  readonly platform: MeetingPlatform;
  readonly host: string;
  readonly roomId: string;
  readonly tenantId?: string;
  readonly organizerId?: string;
  readonly organiserEmail?: string;
  readonly when: "past" | "next";
  readonly askedAt: number;
  readonly requestedBy: string;
  readonly origin: { readonly platform: string; readonly channelId: string; readonly threadTs: string | null };
  readonly partition: Partition;
  readonly surfaceMode?: SurfaceMode;
  readonly watchHours: number;
  readonly disclosure: string;
  readonly reason?: string;
}

export function mintNativeRecapId(turn?: { readonly sessionId: string; readonly turnId: string; readonly url: string }): string {
  if (turn === undefined) return `mtg_${randomBytes(16).toString("hex").slice(0, 26)}`;
  return `mtg_${createHash("sha256").update(`native\n${turn.sessionId}\n${turn.turnId}\n${turn.url}`).digest("hex").slice(0, 26)}`;
}

export function nativeMeetingRef(args: NativeRecapArgs): NativeMeetingRef {
  return {
    platform: args.platform,
    url: args.url,
    roomId: args.roomId,
    ...(args.tenantId !== undefined ? { tenantId: args.tenantId } : {}),
    ...(args.organizerId !== undefined ? { organizerId: args.organizerId } : {}),
    ...(args.organiserEmail !== undefined ? { organiserEmail: args.organiserEmail } : {}),
    ...(args.when === "next" ? { startedAfter: args.askedAt - NEXT_SESSION_GRACE_MINUTES * 60_000 } : {}),
  };
}

export interface NativeRecapDeps extends Pick<FinishDeps, "post"> {
  readonly policy?: MeetingPolicy;
  readonly now?: () => number;
  readonly secret?: (name: string) => Promise<string>;
  readonly halted?: (args: NativeRecapArgs) => Promise<boolean>;
}

export type NativeRecapOutcome =
  | { readonly kind: "posted"; readonly posted: boolean }
  | { readonly kind: "refused"; readonly reason: NativeRefusalReason | "timeout" | "disabled" | "full" }
  | { readonly kind: "waiting" }
  | { readonly kind: "halted" }
  | { readonly kind: "duplicate" };

function auditWhere(p: Partition): { org: string; platform: string; workspace: string; surface: string } {
  return { org: p.org, platform: p.platform, workspace: p.workspace, surface: p.surface };
}

async function nativeHalted(args: NativeRecapArgs): Promise<boolean> {
  const state = await resolveHalt(haltScopeFor({ org: args.org, scopeKey: args.partition.surfaceKey, principalId: args.requestedBy }));
  return state.halted;
}

const liveSecret = async (name: string): Promise<string> => (await getOperatorSecret(name)).value;

async function readOnce(args: NativeRecapArgs, policy: MeetingPolicy, deps: NativeRecapDeps): Promise<NativeTranscriptResult> {
  const source = nativeTranscriptSource(args.platform);
  if (source === undefined) return { status: "refused", reason: "credential", hint: `This deployment has no ${platformLabel(args.platform)} transcript reader registered.` };
  let missingSecret: string | undefined;
  const secret = async (name: string): Promise<string> => {
    try {
      return await (deps.secret ?? liveSecret)(name);
    } catch (err) {
      missingSecret = name;
      throw err;
    }
  };
  try {
    return await source.read(nativeMeetingRef(args), { policy: policy.native, secret });
  } catch (err) {
    if (missingSecret !== undefined) return { status: "refused", reason: "credential", hint: `The stored secret ${missingSecret} is missing or unreadable (oe secret set ${missingSecret}).` };
    console.warn(`[open-everywhere:meetings] native transcript read failed for ${args.recapId} (checked again on the next sweep): ${String(err)}`);
    return { status: "pending" };
  }
}

function rowTtlMs(args: NativeRecapArgs): number {
  return args.watchHours * HOUR_MS + HOUR_MS;
}

async function refuse(args: NativeRecapArgs, reason: NativeRefusalReason | "timeout" | "disabled" | "full" | "halted", text: string | undefined, deps: NativeRecapDeps): Promise<boolean> {
  if (!(await claimMeetingRecap(args.org, args.recapId, rowTtlMs(args)))) return false;
  const messageId = text !== undefined ? await notifyThread({ id: args.recapId, origin: args.origin }, text, deps) : undefined;
  await appendAudit({
    ...auditWhere(args.partition),
    principalId: args.requestedBy,
    action: "meeting.recap_refused",
    detail: { meetingId: args.recapId, platform: args.platform, reason, posted: messageId !== undefined },
  });
  return true;
}

async function postRecap(args: NativeRecapArgs, result: Extract<NativeTranscriptResult, { status: "ready" }>, deps: NativeRecapDeps): Promise<NativeRecapOutcome> {
  const text = nativeTranscriptText(result.segments);
  const minutes = nativeMeetingMinutes(result);
  const empty = text.trim().length === 0;
  let recap = undefined;
  if (!empty) {
    const complete = meetingCompletion();
    if (complete !== undefined) {
      try {
        recap = parseRecap(await complete(args.partition.surfaceKey, recapPrompt(text, { platform: args.platform, minutes, labelled: true, labelSource: "transcript" })));
      } catch (err) {
        console.warn(`[open-everywhere:meetings] recap completion failed for ${args.recapId}: ${String(err)}`);
      }
    }
  }
  const post = renderRecapPost(recap, { platform: args.platform, minutes, missingChunks: 0, empty, source: "native" });
  if (!(await claimMeetingRecap(args.org, args.recapId, rowTtlMs(args)))) return { kind: "duplicate" };
  const messageId = await notifyThread({ id: args.recapId, origin: args.origin }, post, deps);
  const speakers = new Set(result.segments.map((s) => s.speaker).filter((s) => s.length > 0)).size;
  await appendAudit({
    ...auditWhere(args.partition),
    principalId: args.requestedBy,
    action: "meeting.recap_posted",
    detail: {
      meetingId: args.recapId,
      posted: messageId !== undefined,
      decisions: recap?.decisions.length ?? 0,
      actions: recap?.actions.length ?? 0,
      summarised: recap !== undefined,
      missingChunks: 0,
      source: "native",
      platform: args.platform,
      speakers,
    },
  });
  return { kind: "posted", posted: messageId !== undefined };
}

async function settle(args: NativeRecapArgs, result: NativeTranscriptResult, deps: NativeRecapDeps): Promise<NativeRecapOutcome | undefined> {
  if (result.status === "ready") return await postRecap(args, result, deps);
  if (result.status === "refused") {
    return (await refuse(args, result.reason, nativeRefusalSentence(args.platform, result.reason, result.hint), deps)) ? { kind: "refused", reason: result.reason } : { kind: "duplicate" };
  }
  return undefined;
}

const SWEEP_TICK_MS = 15 * 60_000;
const SWEEP_BUDGET_MS = 10 * 60_000;

export const MAX_NATIVE_WATCHES = 64;
const WATCH = (n: number): string => `meeting-native-watch:${n}`;

interface Watch {
  readonly args: NativeRecapArgs;
  readonly deadline: number;
}

function parseWatch(raw: string | null): Watch | undefined {
  if (raw === null) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<Watch>;
    return v.args !== undefined && typeof v.args.recapId === "string" && typeof v.deadline === "number" ? (v as Watch) : undefined;
  } catch {
    return undefined;
  }
}

async function claimWatch(args: NativeRecapArgs, deadline: number): Promise<number | undefined> {
  const store = getOperationalStore();
  const value = JSON.stringify({ args, deadline } satisfies Watch);
  let slot: number | undefined;
  for (let n = 0; n < MAX_NATIVE_WATCHES && slot === undefined; n++) {
    if (await store.putTaskResultIfAbsent(args.org, WATCH(n), value, new Date().toISOString(), rowTtlMs(args))) slot = n;
  }
  if (slot === undefined) return undefined;
  if (!(await store.putTaskResultIfAbsent(args.org, `meeting-native-watching:${args.recapId}`, String(slot), new Date().toISOString(), rowTtlMs(args)))) {
    await releaseWatch(args.org, slot, args.recapId);
    const kept = Number(await store.getTaskResult(args.org, `meeting-native-watching:${args.recapId}`));
    return Number.isInteger(kept) ? kept : slot;
  }
  return slot;
}

async function releaseWatch(org: string, slot: number, recapId: string): Promise<void> {
  const store = getOperationalStore();
  if (parseWatch(await store.getTaskResult(org, WATCH(slot)))?.args.recapId === recapId) await store.deleteTaskResult(org, WATCH(slot));
}

export async function nativeWatches(org: string): Promise<{ readonly slot: number; readonly recapId: string; readonly deadline: number }[]> {
  const store = getOperationalStore();
  const out: { slot: number; recapId: string; deadline: number }[] = [];
  for (let n = 0; n < MAX_NATIVE_WATCHES; n++) {
    const w = parseWatch(await store.getTaskResult(org, WATCH(n)));
    if (w !== undefined) out.push({ slot: n, recapId: w.args.recapId, deadline: w.deadline });
  }
  return out;
}

export async function startNativeRecap(args: NativeRecapArgs, approvedBy: string, deps: NativeRecapDeps = {}): Promise<NativeRecapOutcome> {
  const policy = deps.policy ?? meetingPolicy();
  if (!policy.native.enabled) throw new Error("recaps from the platform's own transcript were turned off on this deployment after the card was posted, so I did not read it");
  const now = (deps.now ?? Date.now)();
  const store = getOperationalStore();
  const settledAlready = (await store.getTaskResult(args.org, `meeting-recap:${args.recapId}`)) !== null;
  if (settledAlready || (await nativeWatches(args.org)).some((w) => w.recapId === args.recapId)) return { kind: "duplicate" };
  await appendAudit({
    ...auditWhere(args.partition),
    principalId: approvedBy,
    action: "meeting.recap_requested",
    detail: { meetingId: args.recapId, platform: args.platform, host: args.host, roomId: args.roomId, requestedBy: args.requestedBy, when: args.when },
  });
  if (await (deps.halted ?? nativeHalted)(args)) {
    await refuse(args, "halted", undefined, deps);
    return { kind: "halted" };
  }
  const result = await readOnce(args, policy, deps);
  const settled = await settle(args, result, deps);
  if (settled !== undefined) return settled;
  const slot = await claimWatch(args, now + args.watchHours * HOUR_MS);
  if (slot === undefined) {
    await refuse(args, "full", `${platformLabel(args.platform)} has no transcript for this meeting yet, and this deployment is already waiting on ${MAX_NATIVE_WATCHES} transcripts, so I can't wait for this one. Ask me again after the meeting has a transcript.`, deps);
    return { kind: "refused", reason: "full" };
  }
  return { kind: "waiting" };
}

export async function sweepNativeWatches(
  org: string,
  deps: NativeRecapDeps & { readonly budgetMs?: number; readonly clock?: () => number } = {},
): Promise<{ readonly settled: string[]; readonly deferred: number }> {
  const policy = deps.policy ?? meetingPolicy();
  const now = (deps.now ?? Date.now)();
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const budget = deps.budgetMs ?? SWEEP_BUDGET_MS;
  const store = getOperationalStore();
  const settled: string[] = [];
  let deferred = 0;
  const offset = Math.floor(now / SWEEP_TICK_MS) % MAX_NATIVE_WATCHES;
  for (let i = 0; i < MAX_NATIVE_WATCHES; i++) {
    const n = (offset + i) % MAX_NATIVE_WATCHES;
    if (clock() - started > budget) {
      if (parseWatch(await store.getTaskResult(org, WATCH(n))) !== undefined) deferred++;
      continue;
    }
    const w = parseWatch(await store.getTaskResult(org, WATCH(n)));
    if (w === undefined) continue;
    const { args } = w;
    if (!policy.native.enabled) {
      await refuse(args, "disabled", `Recaps from ${platformLabel(args.platform)}'s own transcript were turned off on this deployment, so I stopped waiting for this meeting's transcript.`, deps);
    } else if (await (deps.halted ?? nativeHalted)(args)) {
      await refuse(args, "halted", undefined, deps);
    } else {
      const result = await readOnce(args, policy, deps);
      const outcome = await settle(args, result, deps);
      if (outcome === undefined) {
        if (now < w.deadline) continue;
        await refuse(args, "timeout", nativeTimeoutSentence(args.platform, args.watchHours), deps);
      }
    }
    await releaseWatch(org, n, args.recapId);
    settled.push(args.recapId);
  }
  return { settled, deferred };
}
