import { isSilentRoutine, type Routine } from "./routine.js";
import { resolveRoutineTarget } from "../schedules/routine-dispatch.js";
import { postUnifiedReply } from "../channels/unified-reply.js";

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

export function disableNoticeText(r: Pick<Routine, "id" | "prompt" | "report">, reason: string, consecutiveFailures: number): string {
  const what = r.prompt.trim().replace(/\s+/g, " ").slice(0, 160);
  return (
    `🛑 Routine \`${r.id}\` has DISABLED itself after ${consecutiveFailures} consecutive failures and will not run again — ${reason.slice(0, 200)}.\n` +
    `> ${what}\n` +
    (isSilentRoutine(r)
      ? `This one reported nothing while it was healthy, so this notice is the only sign it stopped. `
      : ``) +
    `Ask me to set it up again once whatever it was failing on is fixed.`
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
  try {
    const dest = (deps.resolveTarget ?? resolveRoutineTarget)(r);
    const origin = dest?.origin;
    if (!origin) {
      log(`self-disable notice SKIPPED for ${r.id} [${r.surfaceKey}] — no post-back origin for this surface (audit row still written)`);
      return false;
    }
    await (deps.post ?? ((o, text) => postUnifiedReply(o as NonNullable<typeof origin>, text)))(
      origin,
      disableNoticeText(r, reason, consecutiveFailures),
    );
    log(`self-disable notice posted for ${r.id} [${r.surfaceKey}]`);
    return true;
  } catch (err) {
    log(`self-disable notice FAILED for ${r.id} [${r.surfaceKey}]: ${String(err)}`);
    return false;
  }
}
