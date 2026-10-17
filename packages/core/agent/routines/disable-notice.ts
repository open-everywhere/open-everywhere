import { isSilentRoutine, type Routine } from "./routine.js";
import type { BoundVerdict } from "./bound.js";
import { resolveRoutineTarget } from "../schedules/routine-dispatch.js";
import { postUnifiedReply } from "../channels/unified-reply.js";

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

export function disableNoticeText(r: Pick<Routine, "id" | "prompt" | "report" | "trigger">, _reason: string, consecutiveFailures: number): string {
  const what = r.prompt.trim().replace(/\s+/g, " ").slice(0, 160);
  const headline =
    r.trigger.kind === "once"
      ? `🛑 This one-time routine didn't work, and it won't run again:\n`
      : `🛑 I stopped this routine because it failed ${consecutiveFailures} times in a row. It won't run again:\n`;
  return (
    headline +
    `> ${what}\n` +
    (isSilentRoutine(r) ? `It doesn't usually post, so this is the only sign it stopped. ` : ``) +
    `Ask me to set it up again once the problem is fixed.`
  );
}

export function boundNoticeText(
  r: Pick<Routine, "id" | "prompt" | "report" | "sessionMode">,
  verdict: Extract<BoundVerdict, { exhausted: true }>,
): string {
  const what = r.prompt.trim().replace(/\s+/g, " ").slice(0, 160);
  const noun = r.sessionMode === "job" ? "job" : "routine";
  const stalled = verdict.dimension === "stalled";
  const why = stalled
    ? "it was waiting for someone to approve more spending"
    : verdict.dimension === "deadline"
      ? "it reached its end date"
      : "it reached its run limit";
  const silent = isSilentRoutine(r) ? `It doesn't usually post, so this is the only sign it stopped. ` : ``;
  return (
    `⏹️ I stopped this ${noun} because ${why}. It won't run again:\n` +
    `> ${what}\n` +
    (stalled
      ? `It kept waking up but couldn't do its work. ${silent}` +
        `Answer the "keep going?" request (or ask an admin to raise the limit) first, then ask me to start it again.`
      : `Nothing went wrong. It just didn't finish. ${silent}` +
        `Ask me to start it again if you still want it. It carries on from where it stopped.`)
  );
}

export interface DisableNoticeDeps {
  readonly resolveTarget?: typeof resolveRoutineTarget;
  readonly post?: (origin: NonNullable<ReturnType<typeof resolveRoutineTarget>>["origin"], text: string) => Promise<string>;
}

export async function announceSelfDisable(
  r: Routine,
  reason: string,
  consecutiveFailures: number,
  deps: DisableNoticeDeps = {},
): Promise<boolean> {
  return postRoutineNotice(r, disableNoticeText(r, reason, consecutiveFailures), "self-disable", deps);
}

export async function announceBoundExhausted(
  r: Routine,
  verdict: Extract<BoundVerdict, { exhausted: true }>,
  deps: DisableNoticeDeps = {},
): Promise<boolean> {
  return postRoutineNotice(r, boundNoticeText(r, verdict), "ceiling", deps);
}

export async function postRoutineNotice(r: Routine, text: string, what: string, deps: DisableNoticeDeps): Promise<boolean> {
  try {
    const dest = (deps.resolveTarget ?? resolveRoutineTarget)(r);
    const origin = dest?.origin;
    if (!origin) {
      log(`${what} notice SKIPPED for ${r.id} [${r.surfaceKey}] — no post-back origin for this surface (audit row still written)`);
      return false;
    }
    await (deps.post ?? ((o, t) => postUnifiedReply(o as NonNullable<typeof origin>, t)))(origin, text);
    log(`${what} notice posted for ${r.id} [${r.surfaceKey}]`);
    return true;
  } catch (err) {
    log(`${what} notice FAILED for ${r.id} [${r.surfaceKey}]: ${String(err)}`);
    return false;
  }
}
