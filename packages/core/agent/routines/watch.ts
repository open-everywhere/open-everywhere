import type { Routine } from "./routine.js";
import { hashState, shouldPostOnDiff } from "./lifecycle.js";

export const WATCH_SILENCE_SENTINEL = "NO_REPLY";

export const WATCH_STATE_TOOL = "record_watch_state";

export function renderWatchMessage(r: Pick<Routine, "id" | "prompt" | "lastStateHash">): string {
  const baseline =
    r.lastStateHash === undefined
      ? "No baseline is recorded yet — this is the first check, so report what you observe as the baseline."
      : "A baseline from the last check is recorded — the tool will tell you whether the state changed.";
  return [
    `[watch] This is a scheduled check of a WATCH routine — post ONLY if the watched state changed. ` +
      `Protocol: do the check below, then call the \`${WATCH_STATE_TOOL}\` tool with a canonical text ` +
      `representation of the watched state (stable ordering; leave out values that differ on every ` +
      `look, like timestamps or "fetched at" counters). ${baseline} If the tool returns ` +
      `\`changed: false\`, the state is unchanged: end your turn with exactly ${WATCH_SILENCE_SENTINEL} ` +
      `and nothing else — nothing will be posted. If it returns \`changed: true\`, report what changed.`,
    "",
    r.prompt,
  ].join("\n");
}

export interface WatchObservation {
  readonly changed: boolean;
  readonly firstObservation: boolean;
  readonly patch: Partial<Routine>;
}

export function applyWatchObservation(r: Pick<Routine, "lastStateHash">, state: string): WatchObservation {
  const newHash = hashState(state);
  const changed = shouldPostOnDiff(r.lastStateHash, newHash);
  return {
    changed,
    firstObservation: r.lastStateHash === undefined,
    patch: changed ? { lastStateHash: newHash } : { lastStateHash: newHash, lastOutcome: "skipped" },
  };
}
