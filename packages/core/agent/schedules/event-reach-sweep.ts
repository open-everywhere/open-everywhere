import { postRoutineNotice, type DisableNoticeDeps } from "../routines/disable-notice.js";
import { eventReach, type EventReach } from "../routines/event-reach.js";
import { watchWords } from "../routines/ask-watch.js";
import { sourceWords } from "../routines/schedule-words.js";
import { getRoutine, updateRoutine } from "../routines/store.js";
import type { Routine } from "../routines/routine.js";

export const MAX_REACH_NOTICES_PER_TICK = 10;

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

export interface EventReachSweepDeps extends DisableNoticeDeps {
  readonly reach?: (source: string) => Promise<EventReach>;
}

function routineLine(r: Routine): string {
  return watchWords(r.trigger, r.watchFor) ?? r.prompt.trim().replace(/\s+/gu, " ").slice(0, 160);
}

export function unreachableNoticeText(r: Routine): string {
  const app = r.trigger.kind === "event" ? sourceWords(r.trigger.source) : "the app";
  const what = r.watchFor !== undefined ? "watch" : "routine";
  return (
    `⚠️ ${app}'s events no longer reach me, so this ${what} can't fire:\n` +
    `> ${routineLine(r)}\n` +
    `Ask an admin to set up ${app}'s webhook again, or ask me to check on a schedule instead. I'll tell you here when it works again.`
  );
}

export function reachableAgainNoticeText(r: Routine): string {
  const app = r.trigger.kind === "event" ? sourceWords(r.trigger.source) : "the app";
  const what = r.watchFor !== undefined ? "watch" : "routine";
  return `✅ ${app}'s events reach me again, so this ${what} works again:\n> ${routineLine(r)}`;
}

export async function sweepEventReach(all: readonly Routine[], now: Date, deps: EventReachSweepDeps = {}): Promise<{ readonly told: number; readonly recovered: number }> {
  const ask = deps.reach ?? ((s: string) => eventReach(s));
  const answers = new Map<string, Promise<EventReach>>();
  const reachOf = (source: string): Promise<EventReach> => {
    let hit = answers.get(source);
    if (hit === undefined) {
      hit = ask(source).catch((): EventReach => "unknown");
      answers.set(source, hit);
    }
    return hit;
  };
  let told = 0;
  let recovered = 0;
  for (const listed of all) {
    if (told + recovered >= MAX_REACH_NOTICES_PER_TICK) break;
    try {
      if (listed.trigger.kind !== "event") continue;
      if (listed.status !== "active") {
        if (listed.unreachableSince !== undefined) await updateRoutine(listed.org, listed.surfaceKey, listed.id, { unreachableSince: undefined });
        continue;
      }
      const reach = await reachOf(listed.trigger.source);
      const marked = listed.unreachableSince !== undefined;
      if (!(reach === "deaf" && !marked) && !(reach === "reaches" && marked)) continue;
      const r = await getRoutine(listed.org, listed.surfaceKey, listed.id);
      if (r === null || r.status !== "active" || r.trigger.kind !== "event") continue;
      if (reach === "deaf" && r.unreachableSince === undefined) {
        const posted = await postRoutineNotice(r, unreachableNoticeText(r), "event-reach", deps);
        await updateRoutine(r.org, r.surfaceKey, r.id, { unreachableSince: now.toISOString() });
        log(`EVENT-REACH: ${r.id} on ${r.surfaceKey} — "${r.trigger.source}" events no longer reach this deployment (room ${posted ? "told" : "not told"})`);
        told++;
      } else if (reach === "reaches" && r.unreachableSince !== undefined) {
        await postRoutineNotice(r, reachableAgainNoticeText(r), "event-reach", deps);
        await updateRoutine(r.org, r.surfaceKey, r.id, { unreachableSince: undefined });
        log(`EVENT-REACH: ${r.id} on ${r.surfaceKey} — "${r.trigger.source}" events reach this deployment again`);
        recovered++;
      }
    } catch (err) {
      log(`event-reach sweep failed for ${listed.id} on ${listed.surfaceKey}: ${String(err)}`);
    }
  }
  return { told, recovered };
}
