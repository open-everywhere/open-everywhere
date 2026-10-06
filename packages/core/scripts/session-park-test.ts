process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  detectSessionLimitPark,
  handleSessionLimitPark,
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
  const mod = read("harness/session-limit-enforcement.js");
  const enfStart = mod.indexOf("async function enforceSessionUsageLimit(");
  const parkStart = mod.indexOf("async function parkOnSessionUsageLimit(");
  const fmtStart = mod.indexOf("function formatSessionLimitMessage(");
  const failStart = mod.indexOf("async function failSessionUsageLimit(");
  ok(
    enfStart >= 0 && parkStart > enfStart && fmtStart > parkStart && failStart > fmtStart,
    "session-limit-enforcement.js still declares enforceSessionUsageLimit → parkOnSessionUsageLimit → formatSessionLimitMessage → failSessionUsageLimit",
  );
  const enforce = mod.slice(enfStart, parkStart);
  const park = mod.slice(parkStart, mod.indexOf("function violationWindow("));
  const fail = mod.slice(failStart);
  ok(park.length > 0, "the park arm was sliced from real bytes — an empty slice would pass its regexes vacuously");

  const param = /^async function enforceSessionUsageLimit\((\w+)\)/.exec(enforce)?.[1];
  const emitVar = /\{emit:(\w+)\}=/.exec(enforce)?.[1];
  ok(param !== undefined && emitVar !== undefined, "enforceSessionUsageLimit still takes one input object and destructures its `emit`");
  const branch = new RegExp(
    `${emitVar as string}!==void 0&&` + `${param as string}\\.config\\.capabilities\\?\\.requestInput===!0\\?parkOnSessionUsageLimit\\(`,
  );
  ok(branch.test(enforce), "enforceSessionUsageLimit still PARKS when an emitter exists AND capabilities?.requestInput===true");
  ok(!/\.config\.mode\b/.test(enforce), "…and no `mode` arm survives — eve 0.67 removed it, so a session without the capability FAILS at the bound");
  ok(/:failSessionUsageLimit\(/.test(enforce), "…and only the ELSE arm reaches failSessionUsageLimit");

  ok(/createSessionLimitContinuationRequest\(\{/.test(park), "parkOnSessionUsageLimit still builds a createSessionLimitContinuationRequest");
  ok(/\.emit\(createInputRequestedEvent\(/.test(park), "…emits it via createInputRequestedEvent (the event authored hooks see)");
  ok(/\{next:null,session:setHarnessEmissionState\(/.test(park), "…and returns `{ next: null }` — the session PARKS, it does not end");

  ok(/`SESSION_TOKEN_LIMIT_REACHED`/.test(fail), "failSessionUsageLimit still emits the SESSION_TOKEN_LIMIT_REACHED code");
  ok(!/\bthrow\b/.test(fail), "failSessionUsageLimit still RETURNS a step result — it never throws");
  ok(/\{next:\{done:!0/.test(fail), "…returning a done step result");

  ok(/`SESSION_TOKEN_COST_LIMIT_REACHED`/.test(fail), "the fail arm also mints SESSION_TOKEN_COST_LIMIT_REACHED for the token-COST bound");
  ok(/`token-cost`/.test(enforce) === false, "the park-vs-fail branch does NOT discriminate on the violation kind — a cost park is still a park");
  ok(/violationWindow\(\w+\)>0/.test(enforce), "…the branch's only extra guard is a positive violation window, which both kinds carry for a seat — a delegated worker with a zero budget share has a zero window and takes the fail arm (OPE-2256)");

  const producers = ["harness/session-limit-enforcement.js"];
  ok(producers.every((f) => read(f).includes("SESSION_TOKEN_LIMIT_REACHED")), "session-limit-enforcement.js is a producer of SESSION_TOKEN_LIMIT_REACHED");

  ok(
    /`The session reached its configured \$\{\w+\} token limit\.`/.test(mod),
    "formatSessionLimitMessage still formats `The session reached its configured <kind> token limit.`",
  );

  ok(!mod.includes("n_REACHED"), "the 0.22.x `n_REACHED` minifier artifact is absent from this dist (why the classifier's third pattern was removed in OPE-171)");
}

{
  const send = read("channel/channel-address.js");
  ok(!/mode\?\?`conversation`/.test(send), "channel-address.js no longer defaults a `mode` — eve 0.67 removed the run mode");
  ok(
    /capabilities:\{requestInput:!0\}/.test(send),
    "channel-address.js declares `capabilities: { requestInput: true }` unconditionally — every OE seat and fire can park at the bound",
  );
  ok(
    /=await \w+\.runtime\.dispatchContinuation\(\{command:\w+,continuationToken:\w+\}\)/.test(send),
    "the send still awaits only runtime.dispatchContinuation on the continuation path (0.31's rename of runtime.deliver)",
  );
  const inlineCreate = /createSession\(\(await \w+\.runtime\.createSession\(\w+\)\)\.sessionId,/.test(send);
  const hoistedCreate = /(\w+)=await \w+\.runtime\.createSession\(\w+\);?/.exec(send)?.[1];
  const hoistedCreatePlacement = hoistedCreate !== undefined && new RegExp(`createSession\\(${hoistedCreate}\\.sessionId,`).test(send);
  ok(
    inlineCreate || hoistedCreatePlacement,
    "…and only runtime.createSession on the fresh-session path (0.31's rename of runtime.run — the turn still runs elsewhere), written inline or through a hoisted local",
  );
}

{
  const cont = read("harness/session-limit-continuation.js");
  ok(
    cont.includes("toolName:`session_limit_continuation`"),
    "eve still stamps the continuation prompt's action.toolName as `session_limit_continuation`",
  );
  ok(cont.includes("kind:`session-limit`"), "…and the request carries eve's own `kind: \"session-limit\"`");
  ok(/kind:\w+\.kind,limit:\w+\.limit,usedTokens:\w+\.usedTokens\}/.test(cont), "a token-count violation still carries {kind, limit, usedTokens} as the action input");
  ok(/kind:\w+\.kind,limitUsd:\w+\.limitUsd,usedCostUsd:\w+\.usedCostUsd\}/.test(cont), "…and a token-COST violation carries {kind, limitUsd, usedCostUsd} instead");
  ok(/isSessionLimitContinuationRequestId[\s\S]{0,140}?\/:limit:\(\?:input\|output\):\\d\+\$\/u/.test(cont), "eve's requestId grammar still carries the token-count pattern OE's SESSION_LIMIT_REQUEST_ID_RE mirrors");
  ok(/isSessionLimitContinuationRequestId[\s\S]{0,240}?:limit:token-cost:/.test(cont), "…and eve added a SECOND requestId pattern for the token-cost bound");
  ok(cont.includes(`\`${SESSION_LIMIT_CONTINUATION_TOOL_NAME}\``), "OE's SESSION_LIMIT_CONTINUATION_TOOL_NAME matches eve's literal");
  ok(SESSION_LIMIT_REQUEST_ID_RE.source === ":limit:(?:input|output):\\d+$", "OE's token-COUNT source is byte-identical to eve's");
  ok(SESSION_LIMIT_REQUEST_ID_RE.flags === "u", "…with eve's flags on that arm (no `i`)");
  ok(SESSION_LIMIT_COST_REQUEST_ID_RE.source === ":limit:token-cost:\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?$", "OE's token-COST source is byte-identical to eve's");
  ok(SESSION_LIMIT_COST_REQUEST_ID_RE.flags === "iu", "…with eve's flags on that arm (`i`, as eve wrote it)");
  ok(cont.includes(`/${SESSION_LIMIT_REQUEST_ID_RE.source}/u`), "eve's dist still carries OE's token-COUNT pattern verbatim");
  ok(cont.includes(`/${SESSION_LIMIT_COST_REQUEST_ID_RE.source}/iu`), "…and OE's token-COST pattern verbatim");

  ok(isSessionLimitRequestId("sess-1:limit:input:31000000"), "the mirrored predicate admits a token-count id");
  ok(isSessionLimitRequestId("sess-1:limit:output:31000000"), "…on both token-count kinds");
  ok(isSessionLimitRequestId("sess-1:limit:token-cost:12.5"), "…a cost id whose figure carries a decimal point");
  ok(isSessionLimitRequestId("sess-1:limit:token-cost:12"), "…a bare integer cost figure");
  ok(isSessionLimitRequestId("sess-1:limit:token-cost:1.5e-3"), "…and an exponent, which eve's own pattern admits");
  ok(!isSessionLimitRequestId("sess-1:limit:input:notanumber"), "…and does NOT admit a non-numeric token-count figure");
  ok(!isSessionLimitRequestId("sess-1:limit:token-cost:"), "…nor a token-cost id with no figure at all");
  ok(!isSessionLimitRequestId("sess-1:limit:wallclock:30"), "…nor a FOURTH bound eve has not shipped — the mirror stays a mirror, not a wildcard");
  ok(!isSessionLimitRequestId("sess-1:limit:INPUT:5"), "…nor an upper-cased token-count kind, which eve's own `/u` arm rejects too");
  ok(!isSessionLimitRequestId("q1"), "…nor an unrelated request id");
}

{
  const proto = read("protocol/message.js");
  const inlineData = /function createInputRequestedEvent\((\w+)\)\{return\{data:\{requests:\1\.requests[\s\S]{0,120}?type:`input\.requested`\}\}/.test(proto);
  const hoisted = /function createInputRequestedEvent\((\w+)\)\{let (\w+)=\{requests:\1\.requests[\s\S]{0,200}?return[\s\S]{0,80}?\{data:\2,type:`input\.requested`\}\}/.test(proto);
  ok(
    inlineData || hoisted,
    "createInputRequestedEvent still emits a `input.requested` event carrying `requests`, inline or through a hoisted local",
  );

  const hookMap = readFileSync(join(distSrc, "public", "definitions", "hook.d.ts"), "utf8");
  ok(
    /readonly "input\.requested": ProtocolEvent<"input\.requested">;/.test(hookMap),
    "`input.requested` is still in eve's PUBLIC HookEventMap (authored hooks may subscribe)",
  );

  const handler = read("execution/session/turn-event-handler.js");
  ok(
    /function createTurnEventHandler\(\w+\)\{[\s\S]{0,200}?return async\((\w+),\w+\)=>\{let (\w+)=await \w+\.emit\(\1\)[\s\S]{0,600}?await \w+\.dispatcher\.runHooks\(\2,/.test(handler),
    "turn-event-handler.js still publishes each harness event and then runs authored hooks on the SAME published event",
  );
  const turnStep = read("execution/session/turn-step.js");
  const handlerVar = /(\w+)=createTurnEventHandler\(\{/.exec(turnStep)?.[1];
  ok(handlerVar !== undefined, "turn-step.js still builds its emitter with createTurnEventHandler");
  ok(
    new RegExp(`handleEvent:${handlerVar as string}[,}]`).test(turnStep) ||
      (new RegExp(
        `[,{]handleEvent=async\\((\\w+),(\\w+)\\)=>\\{\\1\\.type===\`compaction\\.completed\`&&\\(\\w+=!0\\),await ${handlerVar as string}\\(\\1,\\2\\)\\}`,
      ).test(turnStep) &&
        /createExecutionNodeStep\(\{[^{}]*?[,{]handleEvent,/.test(turnStep)),
    "…and hands THAT handler to the harness as `handleEvent` (so harness-emitted events, input.requested included, reach hooks)",
  );

  const loop = read("harness/tool-loop.js");
  ok(/await enforceSessionUsageLimit\(\{[^}]{0,80}?emit:\w+/.test(loop), "the tool loop still calls enforceSessionUsageLimit WITH an emitter (so the park branch is reachable)");
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
  const at = "2026-03-30T11:30:00.000Z";
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
