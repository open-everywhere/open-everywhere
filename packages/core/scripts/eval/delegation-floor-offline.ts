export interface FloorAsk {
  readonly id: string;
  readonly expect: "floor" | "route";
  readonly body: string;
  readonly why: string;
}

export const FLOOR_ASKS: readonly FloorAsk[] = [
  {
    id: "persist-one-line",
    expect: "floor",
    body: "<@BOT> we've settled on quarterly for the reconciliation cadence — token QX-4417. Remember that.",
    why: "One memory write. The seat holds the verb, and one call is the whole job.",
  },
  {
    id: "read-one-section",
    expect: "floor",
    body: "<@BOT> what does our runbook say about the sandbox retry ceiling? Just that one section.",
    why: "A single read of one named thing — no digging, no unknown scope.",
  },
  {
    id: "recall-this-morning",
    expect: "floor",
    body: "<@BOT> what was the decision token from standup this morning?",
    why: "One recall of something the seat itself persisted earlier in the day.",
  },
  {
    id: "route-multi-step-pr",
    expect: "route",
    body: "<@BOT> check out the payments repo, find every caller of resolveRetryCeiling, and open a PR that raises the default to 8.",
    why: "CONTROL — several steps and worker-only verbs (`checkout_repo`, `grep`, `open_pull_request`). Not delegating this is the opposite defect.",
  },
  {
    id: "route-unknown-digging",
    expect: "route",
    body: "<@BOT> something is making the nightly job flaky — can you work out what changed this week and why?",
    why: "CONTROL — an unknown amount of digging, which the floor explicitly names as a reason to route.",
  },
];

export interface ScoredCall {
  readonly name: string;
}

export const DELEGATION_TOOL_NAME = "agent";

export interface FloorScore {
  readonly delegated: boolean;
  readonly belowFloor: boolean;
  readonly missedRoute: boolean;
}

export function scoreFloorTurn(ask: FloorAsk, calls: readonly ScoredCall[]): FloorScore {
  const delegated = calls.some((c) => c.name === DELEGATION_TOOL_NAME);
  return {
    delegated,
    belowFloor: ask.expect === "floor" && delegated,
    missedRoute: ask.expect === "route" && !delegated,
  };
}

export function summariseFloorRun(scored: readonly { readonly ask: FloorAsk; readonly score: FloorScore }[]): {
  readonly floorAsks: number;
  readonly belowFloor: number;
  readonly routeAsks: number;
  readonly missedRoute: number;
} {
  const floorAsks = scored.filter((s) => s.ask.expect === "floor").length;
  const routeAsks = scored.filter((s) => s.ask.expect === "route").length;
  return {
    floorAsks,
    belowFloor: scored.filter((s) => s.score.belowFloor).length,
    routeAsks,
    missedRoute: scored.filter((s) => s.score.missedRoute).length,
  };
}
