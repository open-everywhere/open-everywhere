import { isSilentRoutine, type Routine } from "./routine.js";
import type { BoundVerdict } from "./bound.js";
import { resolveRoutineTarget } from "../schedules/routine-dispatch.js";
import { postUnifiedReply } from "../channels/unified-reply.js";

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

export function disableNoticeText(r: Pick<Routine, "id" | "prompt" | "report" | "trigger">, reason: string, consecutiveFailures: number): string {
  const what = r.prompt.trim().replace(/\s+/g, " ").slice(0, 160);
  const headline =
    r.trigger.kind === "once"
      ? `🛑 One-shot routine \`${r.id}\` did not complete: its one scheduled fire failed, and a one-shot routine does not run again.\n`
      : `🛑 Routine \`${r.id}\` has DISABLED itself after ${consecutiveFailures} consecutive failures and will not run again — ${reason.slice(0, 200)}.\n`;
  return (
    headline +
    `> ${what}\n` +
    (isSilentRoutine(r)
      ? `This one reported nothing while it was healthy, so this notice is the only sign it stopped. `
      : ``) +
    `Ask me to set it up again once whatever it was failing on is fixed.`
  );
}

export function boundNoticeText(
  r: Pick<Routine, "id" | "prompt" | "report" | "sessionMode">,
  verdict: Extract<BoundVerdict, { exhausted: true }>,
): string {
  const what = r.prompt.trim().replace(/\s+/g, " ").slice(0, 160);
  const noun = r.sessionMode === "job" ? "Job" : "Routine";
  const stalled = verdict.dimension === "stalled";
  return (
    `⏹️ ${noun} \`${r.id}\` has STOPPED ${stalled ? "because it was BLOCKED" : "at its ceiling"} and will not run again — ${verdict.reason.slice(0, 200)}.\n` +
    `> ${what}\n` +
    (stalled
      ? `Nothing broke, and it did not run out of runs: a session cost checkpoint paused its consequential actions and the "keep going?" card was never answered, so it kept waking up unable to do its work. ` +
        (isSilentRoutine(r) ? `It reported nothing while it was running, so this notice is the only sign of it. ` : ``) +
        `Answer that card — or raise the cost checkpoint for this scope — and THEN ask me to start it again, or it will stall the same way.`
      : `Nothing failed: it just never finished, so I stopped it rather than keep going unattended. ` +
        (isSilentRoutine(r) ? `It reported nothing while it was running, so this notice is the only sign of it. ` : ``) +
        `Ask me to start it again if you still want it — it picks up from where it got to, with a fresh ceiling.`)
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

async function postRoutineNotice(r: Routine, text: string, what: string, deps: DisableNoticeDeps): Promise<boolean> {
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
