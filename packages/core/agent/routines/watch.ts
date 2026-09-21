import { isSilentRoutine, type Routine } from "./routine.js";
import { hashState, MAX_CONSECUTIVE_FAILURES, shouldPostOnDiff } from "./lifecycle.js";
import { renderPolicyBlock } from "./policy.js";
import { renderCollectedBlock, type CollectedInput } from "./collector.js";
import { renderFollowUpsBlock } from "./follow-ups.js";

export const WATCH_SILENCE_SENTINEL = "NO_REPLY";

export const WATCH_STATE_TOOL = "record_watch_state";

export const RUN_FAILED_TOOL = "report_run_failed";

export const CONNECTION_SEARCH_TOOL = "connection_search";

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

export function renderFailureBlock(): string {
  return (
    `[health] If the work this fire was asked to do DID NOT HAPPEN — the thing you needed was down, ` +
    `a credential was rejected, the page never loaded — call the \`${RUN_FAILED_TOOL}\` tool with one ` +
    `line saying why, before you finish. Saying it only in your answer is not enough: nothing reads ` +
    `your prose, so a run that reports a problem and finishes cleanly is recorded as a SUCCESS and ` +
    `this routine keeps firing at the same broken thing forever. ${MAX_CONSECUTIVE_FAILURES} declared ` +
    `failures in a row and it stops itself. Do NOT call it when the work DID happen and the news was ` +
    `merely bad — finding a problem is a routine doing its job, not failing at it. ` +
    `Say what you TRIED and what the system ANSWERED: the operation you called, the search you ran, ` +
    `and the words that came back. A bare "not authorized" is a guess unless a call returned it.`
  );
}

export type FireReach = "full" | "job-restricted";

export function renderReachBlock(reach: FireReach): string {
  if (reach === "job-restricted") {
    return (
      `[reach] This fire runs on a RESTRICTED job wake: it holds no \`${CONNECTION_SEARCH_TOOL}\`, and ` +
      `no connector operation beyond a read. That is the design, not a fault — this job runs for weeks ` +
      `with nobody attending it, so the consequential half of the kit is withheld until a human takes ` +
      `the session over. Do NOT go looking for a connector here, and do not describe the narrowing as a ` +
      `refusal: nothing refused you. If the work this fire was sent to do needs a tool you do not hold, ` +
      `call \`${RUN_FAILED_TOOL}\` and name the tool you needed and the fact that this wake does not ` +
      `carry it. That IS what the [health] block above asks of you here: a tool your kit does not hold ` +
      `is a fact about the kit, not a guess, and no call has to sit behind it. Never invent one.`
    );
  }
  return (
    `[reach] A tool you cannot see is not a tool you do not have. A CONNECTOR operation — creating a ` +
    `Notion page, reading a record in a connected workspace — is FOUND by search: it is not always ` +
    `listed in this session, and the list you start with is not the whole of your reach. Call ` +
    `\`${CONNECTION_SEARCH_TOOL}\` with a keyword for the thing you need, then call the operation it ` +
    `names. Do that BEFORE you report that a connector is unavailable. Attempt the operation this ` +
    `fire names, and report what came back. A refusal is what a call returned — never something you ` +
    `concluded without making one.`
  );
}

function fireMessage(
  head: string,
  silent: string,
  rules: string,
  followUps: string,
  body: readonly string[],
  collected: string,
): string {
  return [
    head,
    ...(silent.length > 0 ? ["", silent] : []),
    "",
    renderFailureBlock(),
    "",
    renderReachBlock("full"),
    ...(rules.length > 0 ? ["", rules] : []),
    ...(followUps.length > 0 ? ["", followUps] : []),
    "",
    ...body,
    ...(collected.length > 0 ? ["", collected] : []),
  ].join("\n");
}

export function renderScheduledMessage(
  r: Pick<Routine, "id" | "prompt" | "createdAt" | "lastRunAt" | "report" | "policy" | "followUps">,
  collected: readonly CollectedInput[] = [],
): string {
  return fireMessage(
    firePreamble(r),
    renderSilentBlock(r),
    renderPolicyBlock(r),
    renderFollowUpsBlock(r),
    [r.prompt],
    renderCollectedBlock(collected),
  );
}

export function renderWatchMessage(
  r: Pick<Routine, "id" | "prompt" | "lastStateHash" | "createdAt" | "lastRunAt" | "policy" | "followUps">,
  collected: readonly CollectedInput[] = [],
): string {
  const baseline =
    r.lastStateHash === undefined
      ? "No baseline is recorded yet — this is the first check, so report what you observe as the baseline."
      : "A baseline from the last check is recorded — the tool will tell you whether the state changed.";
  const rules = renderPolicyBlock(r);
  const followUps = renderFollowUpsBlock(r);
  const collectedBlock = renderCollectedBlock(collected);
  return [
    firePreamble(r),
    "",
    renderFailureBlock(),
    "",
    renderReachBlock("full"),
    ...(rules.length > 0 ? ["", rules] : []),
    ...(followUps.length > 0 ? ["", followUps] : []),
    "",
    `[watch] This is a scheduled check of a WATCH routine — post ONLY if the watched state changed. ` +
      `Protocol: do the check below, then call the \`${WATCH_STATE_TOOL}\` tool with a canonical text ` +
      `representation of the watched state (stable ordering; leave out values that differ on every ` +
      `look, like timestamps or "fetched at" counters). ${baseline} If the tool returns ` +
      `\`changed: false\`, the state is unchanged: end your turn with exactly ${WATCH_SILENCE_SENTINEL} ` +
      `and nothing else — nothing will be posted. If it returns \`changed: true\`, report what changed.`,
    "",
    r.prompt,
    ...(collectedBlock.length > 0 ? ["", collectedBlock] : []),
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
