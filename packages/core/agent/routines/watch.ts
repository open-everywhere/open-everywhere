import { isSilentRoutine, type Routine } from "./routine.js";
import { hashState, shouldPostOnDiff } from "./lifecycle.js";

export const WATCH_SILENCE_SENTINEL = "NO_REPLY";

export const WATCH_STATE_TOOL = "record_watch_state";

export function firePreamble(r: Pick<Routine, "id" | "createdAt" | "lastRunAt">): string {
  const last = r.lastRunAt ? `previous run: ${r.lastRunAt}` : "previous run: none — this is the FIRST run";
  return `[routine ${r.id}] Scheduled fire (routine created: ${r.createdAt}; ${last}).`;
}

export function renderSilentBlock(r: Pick<Routine, "report">): string {
  if (!isSilentRoutine(r)) return "";
  return (
    `[silent] This routine reports NOTHING here — its product is the work itself, not a message, ` +
    `so a post would be noise. Do the work, then end your turn with exactly ${WATCH_SILENCE_SENTINEL} ` +
    `and nothing else. The ONE exception: if you hit a problem you cannot resolve, say so with the ` +
    `\`reply\` tool — that message WILL post. Anything you write as your FINAL answer instead is ` +
    `dropped before it reaches anyone, so never leave a problem in it.`
  );
}

function fireMessage(head: string, silent: string, ...rest: readonly string[]): string {
  return [head, ...(silent.length > 0 ? ["", silent] : []), "", ...rest].join("\n");
}

export function renderScheduledMessage(r: Pick<Routine, "id" | "prompt" | "createdAt" | "lastRunAt" | "report">): string {
  return fireMessage(firePreamble(r), renderSilentBlock(r), r.prompt);
}

export function renderWatchMessage(r: Pick<Routine, "id" | "prompt" | "lastStateHash" | "createdAt" | "lastRunAt">): string {
  const baseline =
    r.lastStateHash === undefined
      ? "No baseline is recorded yet — this is the first check, so report what you observe as the baseline."
      : "A baseline from the last check is recorded — the tool will tell you whether the state changed.";
  return [
    firePreamble(r),
    "",
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
