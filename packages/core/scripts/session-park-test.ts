// proves: DELG-42, DELG-44, SEAT-70, SEAT-71, SEAT-72

process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  budgetSessionLimitPark,
  detectSessionLimitPark,
  handleSessionLimitPark,
  sessionUsageWindowIndex,
  type BudgetInteraction,
  parkRotateDelta,
  parkThrottleKey,
  SESSION_LIMIT_CONTINUATION_TOOL_NAME,
  SESSION_LIMIT_REQUEST_ID_RE,
  SESSION_LIMIT_COST_REQUEST_ID_RE,
  isSessionLimitRequestId,
  SESSION_PARK_AUDIT_ACTION,
  PARK_AUDIT_WINDOW_MS,
  type ParkScope,
} from "../agent/channels/session-park.js";
import { standingSeatRegistryKey, isSupervisorToken, unifiedDomainSessionKey } from "../agent/channels/unified-supervisor.js";
import { dmSeatRegistryKey } from "../agent/channels/window-key.js";
import { supervisorRotateTokenBudget, shouldRotate } from "../agent/channels/turn-delivery.js";
import { DM_SEAT_ROTATE_TOKEN_BUDGET } from "../agent/channels/dm-seat.js";
import type { AuditInput } from "../agent/audit/audit.js";

let n = 0;
function ok(cond: boolean, msg: string): void {
  assert.ok(cond, msg);
  n++;
}

const require_ = createRequire(import.meta.url);
const eveRoot = dirname(require_.resolve("eve/package.json"));
const distSrc = join(eveRoot, "dist", "src");
const eveVersion = (JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")) as { version: string }).version;
const read = (rel: string): string => readFileSync(join(distSrc, rel), "utf8");

console.log(`session-park: pinning against installed eve ${eveVersion}`);

{
  const budget = read("harness/hitl/budget.js");
  ok(budget.includes("function checkSessionUsageLimit("), "hitl/budget.js still declares checkSessionUsageLimit");
  ok(
    /\.canAsk\?\{kind:`ask`,ask:createSessionLimitContinuationRequest\(\{/.test(budget),
    "checkSessionUsageLimit ASKS (the park) when the session can ask, through createSessionLimitContinuationRequest",
  );
  ok(/:\{kind:`fail`,code:`SESSION_USAGE_LIMIT_REACHED`/.test(budget), "…and only the ELSE arm FAILS, with SESSION_USAGE_LIMIT_REACHED");
  ok(
    /windowIndex:\w+\?\.index\?\?0\}/.test(budget),
    "…and the ask carries the usage window's index, which is 0 until a person accepts a budget ask",
  );
  ok(
    /\.limit\(\{total:\{\.\.\.\w+\},window:\{\.\.\.\w+\}\}\)/.test(budget),
    "eve still calls the agent's sessionUsage function with {total, window}, so OE's budget is the bound that trips",
  );

  const req = read("harness/hitl/budget-request.js");
  const createStart = req.indexOf("function createSessionLimitContinuationRequest(");
  const create = req.slice(createStart, req.indexOf("function toJsonUsage("));
  ok(createStart >= 0 && create.length > 0, "budget-request.js still declares createSessionLimitContinuationRequest (sliced from real bytes)");
  ok(
    /interactionId:`\$\{\w+\}:\$\{\w+\}:limit:usage:\$\{\w+\}`/.test(create),
    "eve's budget ask id is `<session>:<turn>:limit:usage:<window>` — the grammar OE's SESSION_USAGE_WINDOW_RE reads",
  );
  ok(create.includes("kind:`budget`"), "…and the request's kind is `budget`, the kind the park hook claims");
  ok(
    !/[{,](?:limit|usedTokens|inputTokens):/.test(create),
    "🔴 the budget ask carries NO limit and NO usage — so OE records the bound from its own budget and the usage from the session view",
  );
  ok(req.includes(`/${SESSION_LIMIT_REQUEST_ID_RE.source}/u`), "eve's isSessionLimitContinuationRequestId carries OE's token pattern verbatim");
  ok(req.includes(`/${SESSION_LIMIT_COST_REQUEST_ID_RE.source}/iu`), "…and OE's token-COST pattern verbatim");
  ok(SESSION_LIMIT_REQUEST_ID_RE.flags === "u" && SESSION_LIMIT_COST_REQUEST_ID_RE.flags === "iu", "…with eve's flags on each arm");

  const hitl = read("harness/hitl/index.js");
  const enforce = hitl.slice(hitl.indexOf("async function enforceBudget("), hitl.indexOf("function humanInputContext("));
  ok(enforce.length > 0, "hitl/index.js still declares enforceBudget (sliced from real bytes)");
  ok(
    /canAsk:\w+\.emit!==void 0&&\w+\.config\.capabilities\?\.requestInput===!0/.test(enforce),
    "enforceBudget can ask only with an emitter AND capabilities.requestInput===true",
  );
  ok(/limit:\w+\.config\.sessionUsageLimit\?\?DEFAULT_SESSION_USAGE_LIMIT/.test(enforce), "…it reads the agent's own limit before eve's default");
  ok(
    /usage:\w+\.view\(\)\.projection\.view\.usage\.total/.test(enforce),
    "🔴 …and it measures `view.usage.total` — the same totals a hook reads as `ctx.view.usage.total`",
  );
  ok(/window:\w+\.view\(\)\.projection\.usageWindow/.test(enforce), "…against the private usage window, which a hook cannot read");

  const proj = read("protocol/session-projection.js");
  ok(
    /usageWindow:\{interactionId:\w+\.interactionId,index:\(\w+\.usageWindow\?\.index\?\?0\)\+1,start:\w+\.view\.usage\.total\}/.test(proj),
    "🔴 only an ACCEPTED budget ask opens a new window (index+1, start = the totals then) — so window 0 starts at zero and its usage IS the session total",
  );

  const hookMap = readFileSync(join(distSrc, "public", "definitions", "hook.d.ts"), "utf8");
  ok(/readonly "interaction\.opened": /.test(hookMap), "`interaction.opened` is in eve's PUBLIC hook event map (the park hook subscribes to it)");
  ok(
    /interface HookBaseContext extends [^{]*Omit<SessionFrame, "session">/.test(hookMap),
    "every hook context extends SessionFrame (less its `session`)…",
  );
  ok(/readonly view: SessionView;/.test(readFileSync(join(distSrc, "dynamic", "definition.d.ts"), "utf8")), "…and SessionFrame carries the session `view`, so every hook context carries it");
}

{
  const send = read("channel/channel-address.js");
  ok(
    /capabilities:\{requestInput:!0\}/.test(send),
    "channel-address.js declares `capabilities: { requestInput: true }` unconditionally — every OE seat and fire can park at the bound",
  );
}

{
  const parkRequest = (over: Record<string, unknown> = {}) => ({
    requestId: "sess-1:limit:input:31000000",
    display: "confirmation",
    prompt: "This session has hit the input-token limit (30M) per session…",
    action: { callId: "sess-1:limit:input:31000000", kind: "tool-call", toolName: "session_limit_continuation", input: { kind: "input", limit: 30_000_000, usedTokens: 31_000_000 } },
    ...over,
  });

  const hit = detectSessionLimitPark([parkRequest()]);
  ok(hit !== undefined, "a session-limit continuation request is detected");
  ok(hit?.kind === "input" && hit.limit === 30_000_000 && hit.usedTokens === 31_000_000, "…carrying kind/limit/usedTokens off the action input");
  ok(hit?.requestId === "sess-1:limit:input:31000000", "…and eve's requestId");
  ok(isSessionLimitRequestId(hit?.requestId ?? ""), "…which matches eve's requestId grammar");

  ok(
    detectSessionLimitPark([{ requestId: "q1", action: { callId: "c", kind: "tool-call", toolName: "ask_question", input: {} } }]) === undefined,
    "an unrelated HITL request (ask_question) is NOT claimed as a park",
  );
  ok(detectSessionLimitPark([]) === undefined, "an empty batch is not a park");
  ok(detectSessionLimitPark(undefined) === undefined, "a missing requests array degrades to `not a park`");
  ok(detectSessionLimitPark("nonsense") === undefined, "a non-array degrades to `not a park`");
  ok(detectSessionLimitPark([null, 7, parkRequest()]) !== undefined, "…and a park is still found alongside junk entries");

  const cost = detectSessionLimitPark([
    {
      requestId: "sess-1:limit:token-cost:12.5",
      display: "confirmation",
      prompt: "This session has hit the $10.00 model token-cost limit per session…",
      action: {
        callId: "sess-1:limit:token-cost:12.5",
        kind: "tool-call",
        toolName: "session_limit_continuation",
        input: { kind: "token-cost", limitUsd: 10, usedCostUsd: 12.5 },
      },
    },
  ]);
  ok(cost !== undefined, "a token-COST continuation request is detected");
  ok(cost?.kind === "token-cost", "…carrying kind `token-cost`, NOT the `unknown` the token-count-only reader produced");
  ok(cost?.limitUsd === 10 && cost.usedCostUsd === 12.5, "…and the dollar bound plus the measured cost, off the action input");
  ok(cost?.kind === "token-cost" && cost.limit === undefined && cost.usedTokens === undefined, "…while the TOKEN pair stays absent — the two shapes never cross-fill");
  ok(isSessionLimitRequestId(cost?.requestId ?? ""), "…and its requestId matches eve's second grammar");

  ok(hit?.kind === "input" && hit.limitUsd === undefined && hit.usedCostUsd === undefined, "a token-COUNT park carries no dollar figures");

  const drifted = detectSessionLimitPark([{ action: { toolName: "session_limit_continuation" } }]);
  ok(drifted !== undefined && drifted.kind === "unknown" && drifted.limit === undefined && drifted.requestId === "", "a park with no action input reads kind `unknown` with no numbers");
  ok(drifted?.kind === "unknown" && drifted.limitUsd === undefined && drifted.usedCostUsd === undefined, "…and no dollar figures either");
  const alien = detectSessionLimitPark([
    { requestId: "x", action: { toolName: "session_limit_continuation", input: { kind: "wallclock", limit: 5 } } },
  ]);
  ok(alien?.kind === "unknown", "an UNKNOWN violation kind degrades to `unknown` rather than being carried through");
}

{
  const usage = { inputTokens: 31_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 500 };
  const ask = (over: Partial<BudgetInteraction> = {}): BudgetInteraction => ({
    interactionId: "sess-1:4:limit:usage:0",
    requestKind: "budget",
    relayed: false,
    budget: 30_000_000,
    sessionUsage: usage,
    ...over,
  });

  ok(SESSION_LIMIT_REQUEST_ID_RE.test("sess-1:4:limit:usage:0"), "OE's mirrored id pattern admits eve 1.x's usage-window id");
  ok(sessionUsageWindowIndex("sess-1:4:limit:usage:0") === 0 && sessionUsageWindowIndex("sess-1:4:limit:usage:3") === 3, "the window index reads off the id");
  ok(sessionUsageWindowIndex("sess-1:limit:input:31000000") === undefined && sessionUsageWindowIndex("q1") === undefined, "…and no other id has a window index");

  ok(isSessionLimitRequestId("sess-1:limit:input:31000000"), "the mirrored predicate admits a token-count id");
  ok(isSessionLimitRequestId("sess-1:limit:output:31000000"), "…on both token-count kinds");
  ok(isSessionLimitRequestId("sess-1:limit:token-cost:12.5"), "…a cost id whose figure carries a decimal point");
  ok(isSessionLimitRequestId("sess-1:limit:token-cost:12"), "…a bare integer cost figure");
  ok(isSessionLimitRequestId("sess-1:limit:token-cost:1.5e-3"), "…and an exponent, which eve's own pattern admits");
  ok(!isSessionLimitRequestId("sess-1:limit:input:notanumber"), "…and does NOT admit a non-numeric token-count figure");
  ok(!isSessionLimitRequestId("sess-1:limit:token-cost:"), "…nor a token-cost id with no figure at all");
  ok(!isSessionLimitRequestId("sess-1:limit:wallclock:30"), "…nor a bound eve has not shipped — the mirror stays a mirror, not a wildcard");
  ok(!isSessionLimitRequestId("sess-1:limit:INPUT:5"), "…nor an upper-cased token-count kind, which eve's own `/u` arm rejects too");
  ok(!isSessionLimitRequestId("sess-1:4:limit:usage:"), "…nor a usage-window id with no index");
  ok(!isSessionLimitRequestId("sess-1:4:limit:usage:x"), "…nor a non-numeric usage-window index");
  ok(!isSessionLimitRequestId("sess-1:4:limit:USAGE:0"), "…nor an upper-cased usage kind");
  ok(!isSessionLimitRequestId("q1"), "…nor an unrelated request id");

  const hit = budgetSessionLimitPark(ask());
  ok(hit?.kind === "input", "🔴 a budget ask parks as an INPUT-token park — OE's only session bound is its input-token budget");
  ok(hit?.limit === 30_000_000, "🔴 the park carries the configured budget as its limit");
  ok(hit?.usedTokens === 30_000_000, "🔴 …and the window-0 usage the budget counts: input minus cache reads (31M − 1M)");
  ok(hit?.requestId === "sess-1:4:limit:usage:0" && isSessionLimitRequestId(hit.requestId), "…and eve's interaction id as its requestId");
  ok(hit?.limitUsd === undefined && hit?.usedCostUsd === undefined, "…and no dollar figures");

  ok(budgetSessionLimitPark(ask({ requestKind: "question" })) === undefined, "a question is NOT a park (negative control)");
  ok(budgetSessionLimitPark(ask({ requestKind: "approval" })) === undefined, "…nor an approval");
  ok(budgetSessionLimitPark(ask({ requestKind: "sign-in" })) === undefined, "…nor a sign-in");

  const later = budgetSessionLimitPark(ask({ interactionId: "sess-1:9:limit:usage:2" }));
  ok(later?.limit === 30_000_000 && later.usedTokens === undefined, "after an accepted ask (window > 0) the limit stays, but the hook cannot see the window start, so it records no usage");
  const relayed = budgetSessionLimitPark(ask({ relayed: true }));
  ok(relayed?.limit === 30_000_000 && relayed.usedTokens === undefined, "a RELAYED ask records no usage — this session's view is not the asker's");
  ok(budgetSessionLimitPark(ask({ sessionUsage: undefined }))?.usedTokens === undefined, "a missing view records no usage");
  ok(budgetSessionLimitPark(ask({ sessionUsage: { inputTokens: "x", cacheReadTokens: 0 } }))?.usedTokens === undefined, "…nor does a malformed one");
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, "30000000"]) {
    const p = budgetSessionLimitPark(ask({ budget: bad }));
    ok(p !== undefined && p.limit === undefined, `a budget of ${String(bad)} still parks, with no limit recorded`);
  }

  const { sessionLimitParkOf, sessionUsageTotalOf } = await import("../agent/hooks/session-park.js");
  const { getSettings } = await import("../agent/settings/settings.js");
  const { emptySessionView } = await import("eve/events");
  const configured = getSettings().agent.sessionInputTokenBudget;
  const data = { interactionId: "sess-h:2:limit:usage:0", subject: { turnId: "t1" }, request: { kind: "budget", prompt: "This session has hit its usage limit." } } as const;
  const viaHook = sessionLimitParkOf(data as never, usage);
  ok(configured > 0 && viaHook?.limit === configured, "🔴 the hook's park carries the deployment's configured sessionInputTokenBudget");
  ok(viaHook?.usedTokens === 30_000_000, "🔴 …and the usage totals it is handed");
  ok(sessionLimitParkOf({ ...data, origin: { sessionId: "child", interactionId: "c:1:limit:usage:0" } } as never, usage)?.usedTokens === undefined, "…but not on a relayed ask");
  ok(sessionLimitParkOf(data as never, undefined)?.limit === configured, "…and a context with no usage still parks with the limit");

  const realTotal = sessionUsageTotalOf(emptySessionView()) as { inputTokens?: unknown } | undefined;
  ok(realTotal?.inputTokens === 0, "🔴 the hook reads a REAL eve view's totals through eve's public `usage()` accessor");
  ok(
    sessionUsageTotalOf({ usage: { total: usage } }) === undefined,
    "🔴 …and NOT a plain `view.usage` property: eve 1.x's view is an opaque handle, so a property read finds nothing",
  );
  ok(sessionUsageTotalOf(undefined) === undefined, "…and a missing view degrades to no usage, not a throw");
}

{
  const DOMAIN_KEY = "slack/T1/C-ops";
  ok(standingSeatRegistryKey("C-ops:oe-sup:g3", DOMAIN_KEY) === DOMAIN_KEY, "a per-container supervisor token targets the domain-grain row");
  ok(standingSeatRegistryKey("oe-dom:eng:oe-sup:g2", DOMAIN_KEY) === unifiedDomainSessionKey("eng"), "a WINDOW supervisor token targets the synthetic window row, not the surface key");
  ok(standingSeatRegistryKey("D999:oe-dm:g4", DOMAIN_KEY) === dmSeatRegistryKey("D999"), "a DM-seat token targets its own seat row");
  ok(standingSeatRegistryKey("C-ops:1700000000.001", DOMAIN_KEY) === undefined, "a THREAD token has no registry row (⇒ no rotation is possible)");
  ok(standingSeatRegistryKey("subagent:sess-1:call-2", DOMAIN_KEY) === undefined, "eve's own subagent child token has no registry row");
  ok(standingSeatRegistryKey(undefined, DOMAIN_KEY) === undefined, "a native/absent token has no registry row");
  ok(isSupervisorToken("C-ops:oe-sup:g3") && !isSupervisorToken("D999:oe-dm:g4"), "isSupervisorToken keeps its `:oe-sup:g` substring semantics after the move from hooks/spend.ts");
}

{
  ok(parkRotateDelta() >= supervisorRotateTokenBudget(), "the park delta reaches the supervisor rotation budget");
  ok(parkRotateDelta() >= DM_SEAT_ROTATE_TOKEN_BUDGET, "…and the (larger) DM-seat rotation budget");
  const at = "2026-07-26T12:00:00.000Z";
  const neutralised = { quietGapMs: Number.POSITIVE_INFINITY, turnBudget: 1_000_000, expiryMs: Number.POSITIVE_INFINITY };
  for (const prior of [0, 1, 3_999_999, 4_000_001]) {
    for (const tokenBudget of [supervisorRotateTokenBudget(), DM_SEAT_ROTATE_TOKEN_BUDGET]) {
      ok(
        shouldRotate({ createdAt: at, lastWakeAt: at, turnCount: 1, inputTokensTotal: prior + parkRotateDelta() }, at, { ...neutralised, tokenBudget }),
        `a seat at ${prior} + the park delta rotates under a ${tokenBudget}-token budget`,
      );
      ok(
        !shouldRotate({ createdAt: at, lastWakeAt: at, turnCount: 1, inputTokensTotal: prior }, at, { ...neutralised, tokenBudget }) || prior >= tokenBudget,
        `…and ${prior} alone would not have (unless it already crossed ${tokenBudget})`,
      );
    }
  }
}

interface Capture {
  bumps: { key: string; token: string; delta: number }[];
  audits: AuditInput[];
  seen: Set<string>;
}

function harness(matched = 1, opts: { markSeenThrows?: boolean; bumpThrows?: boolean } = {}) {
  const cap: Capture = { bumps: [], audits: [], seen: new Set() };
  const deps = {
    store: {
      async bumpChannelSessionUsage(_org: string, key: string, token: string, delta: number) {
        if (opts.bumpThrows) throw new Error("store down");
        cap.bumps.push({ key, token, delta });
        return matched;
      },
      async markEventSeen(org: string, key: string, _at: string, _ttl: number) {
        if (opts.markSeenThrows) throw new Error("throttle store down");
        const k = `${org}|${key}`;
        if (cap.seen.has(k)) return false;
        cap.seen.add(k);
        return true;
      },
    },
    audit: async (e: AuditInput) => {
      cap.audits.push(e);
    },
  };
  return { cap, deps };
}

const PARK = { kind: "input" as const, limit: 30_000_000, usedTokens: 31_000_000, requestId: "sess-9:limit:input:31000000" };
const scopeFor = (token: unknown): ParkScope => ({
  org: "acme",
  platform: "slack",
  workspace: "T1",
  surface: "C-ops",
  domainKey: "slack/T1/C-ops",
  token,
  sessionId: "sess-9",
});

{
  const { cap, deps } = harness();
  const out = await handleSessionLimitPark(scopeFor("C-ops:oe-sup:g3"), PARK, deps);
  ok(out.remedy === "rotate_on_next_wake" && out.registryKey === "slack/T1/C-ops", "supervisor park → the domain row's generation is retired");
  ok(cap.bumps.length === 1 && cap.bumps[0]!.delta === parkRotateDelta() && cap.bumps[0]!.token === "C-ops:oe-sup:g3", "…via ONE token-guarded bump of the park delta");
  ok(cap.audits.length === 1 && cap.audits[0]!.action === SESSION_PARK_AUDIT_ACTION, `…and exactly one ${SESSION_PARK_AUDIT_ACTION} row`);
  const d = cap.audits[0]!.detail as Record<string, unknown>;
  ok(d.remedy === "rotate_on_next_wake" && d.kind === "input" && d.sessionId === "sess-9" && d.registryKey === "slack/T1/C-ops", "…carrying remedy/kind/sessionId/registryKey");
  ok(d.limit === 30_000_000 && d.usedTokens === 31_000_000 && d.requestId === PARK.requestId, "…plus the violation numbers and eve's requestId");
  ok(cap.audits[0]!.org === "acme" && cap.audits[0]!.platform === "slack" && cap.audits[0]!.surface === "C-ops", "…scoped to the parking session's partition");
  ok(!JSON.stringify(cap.audits[0]).includes("This session has hit"), "…and NEVER the prompt text (ids and counts only)");
  ok(d.limitUsd === undefined && d.usedCostUsd === undefined, "…and a TOKEN park's row carries no dollar figures");
}

{
  const { cap, deps } = harness();
  const COST_PARK = {
    kind: "token-cost" as const,
    limitUsd: 10,
    usedCostUsd: 12.5,
    requestId: "sess-9:limit:token-cost:12.5",
  };
  const out = await handleSessionLimitPark(scopeFor("C-ops:oe-sup:g3"), COST_PARK, deps);
  ok(out.remedy === "rotate_on_next_wake", "a token-COST park retires the generation exactly like a token-count park");
  ok(cap.audits.length === 1 && cap.audits[0]!.action === SESSION_PARK_AUDIT_ACTION, `…and writes one ${SESSION_PARK_AUDIT_ACTION} row — ONE action for all three bounds`);
  const d = cap.audits[0]!.detail as Record<string, unknown>;
  ok(d.kind === "token-cost", "…whose `kind` names the SPEND bound, which is what tells it from a token park");
  ok(d.limitUsd === 10 && d.usedCostUsd === 12.5, "…carrying eve's dollar bound and the measured cost");
  ok(d.limit === undefined && d.usedTokens === undefined, "…and NOT the token pair, which a cost violation never carries");
  ok(d.requestId === COST_PARK.requestId, "…plus eve's requestId");
}

{
  const { cap, deps } = harness();
  const out = await handleSessionLimitPark(scopeFor("oe-dom:eng:oe-sup:g7"), PARK, deps);
  ok(out.registryKey === unifiedDomainSessionKey("eng") && cap.bumps[0]!.key === unifiedDomainSessionKey("eng"), "window-seat park → the synthetic window row is the one retired");
}

{
  const { cap, deps } = harness();
  await handleSessionLimitPark(scopeFor("D42:oe-dm:g2"), PARK, deps);
  ok(cap.bumps[0]!.key === dmSeatRegistryKey("D42"), "dm-seat park → the seat's own row is retired");
}

{
  const { cap, deps } = harness();
  const out = await handleSessionLimitPark(scopeFor("C-ops:1700000000.001"), PARK, deps);
  ok(out.remedy === "none" && out.registryKey === undefined && cap.bumps.length === 0, "thread-seat park → no registry row, so nothing is retired");
  ok(cap.audits.length === 1 && (cap.audits[0]!.detail as Record<string, unknown>).remedy === "none", "…and the park is STILL recorded (visible, not silent — the whole point of OPE-171)");
  ok(String((cap.audits[0]!.detail as Record<string, unknown>).note).includes("fresh thread"), "…with a note that says what a human must do");
}

{
  const { cap, deps } = harness(0);
  const out = await handleSessionLimitPark(scopeFor("C-ops:oe-sup:g3"), PARK, deps);
  ok(out.remedy === "already_rotated", "a token-guard miss reports `already_rotated`, never a false `rotate_on_next_wake`");
  ok((cap.audits[0]!.detail as Record<string, unknown>).remedy === "already_rotated", "…and says so in the row");
}

{
  const { cap, deps } = harness();
  const first = await handleSessionLimitPark(scopeFor("C-ops:oe-sup:g3"), PARK, deps);
  const second = await handleSessionLimitPark(scopeFor("C-ops:oe-sup:g3"), PARK, deps);
  ok(first.audited && !second.audited, "a second park on the same seat within the window is throttled");
  ok(cap.audits.length === 1 && cap.bumps.length === 2, "…the row is suppressed but the generation retire still runs");
  ok(PARK_AUDIT_WINDOW_MS === 60 * 60_000, "the throttle window is one hour (routines/fire-audit.ts's shape)");
  ok(parkThrottleKey("slack/T1/C-ops", "x") !== parkThrottleKey(undefined, "x"), "the throttle key distinguishes a keyed seat from a bare token");
}

{
  const { cap, deps } = harness(1, { markSeenThrows: true });
  const out = await handleSessionLimitPark(scopeFor("C-ops:oe-sup:g3"), PARK, deps);
  ok(out.audited && cap.audits.length === 1, "a throttle-store failure fails OPEN — the row is written");
}

{
  const { cap, deps } = harness(1, { bumpThrows: true });
  const out = await handleSessionLimitPark(scopeFor("C-ops:oe-sup:g3"), PARK, deps);
  ok(out.remedy === "already_rotated" && cap.audits.length === 1, "a store failure during the retire still writes the park row");
}

console.log(`✓ session-park: ${n} assertions passed (eve ${eveVersion} park-branch pin + detector + registry seam + remedy)`);
