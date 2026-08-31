
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
  const enfStart = mod.indexOf("async function enforceSessionTokenLimit(");
  const parkStart = mod.indexOf("async function parkOnSessionTokenLimit(");
  const fmtStart = mod.indexOf("function formatSessionTokenLimitMessage(");
  const failStart = mod.indexOf("async function failSessionTokenLimit(");
  ok(
    enfStart >= 0 && parkStart > enfStart && fmtStart > parkStart && failStart > fmtStart,
    "session-limit-enforcement.js still declares enforceSessionTokenLimit → parkOnSessionTokenLimit → formatSessionTokenLimitMessage → failSessionTokenLimit",
  );
  const enforce = mod.slice(enfStart, parkStart);
  const park = mod.slice(parkStart, fmtStart);
  const fail = mod.slice(failStart);

  const param = /^async function enforceSessionTokenLimit\((\w+)\)/.exec(enforce)?.[1];
  const emitVar = /\{emit:(\w+)\}=/.exec(enforce)?.[1];
  ok(param !== undefined && emitVar !== undefined, "enforceSessionTokenLimit still takes one input object and destructures its `emit`");
  const branch = new RegExp(
    `${emitVar as string}!==void 0&&\\(${param as string}\\.config\\.mode===\`conversation\`\\|\\|` +
      `${param as string}\\.config\\.capabilities\\?\\.requestInput===!0\\)\\?parkOnSessionTokenLimit\\(`,
  );
  ok(branch.test(enforce), "enforceSessionTokenLimit still PARKS when an emitter exists AND (mode===`conversation` || capabilities?.requestInput===true)");
  ok(/:failSessionTokenLimit\(/.test(enforce), "…and only the ELSE arm reaches failSessionTokenLimit");

  ok(/createSessionLimitContinuationRequest\(\{/.test(park), "parkOnSessionTokenLimit still builds a createSessionLimitContinuationRequest");
  ok(/\.emit\(createInputRequestedEvent\(/.test(park), "…emits it via createInputRequestedEvent (the event authored hooks see)");
  ok(/\{next:null,session:setHarnessEmissionState\(/.test(park), "…and returns `{ next: null }` — the session PARKS, it does not end");

  ok(/code:`SESSION_TOKEN_LIMIT_REACHED`/.test(fail), "failSessionTokenLimit still emits the SESSION_TOKEN_LIMIT_REACHED code");
  ok(!/\bthrow\b/.test(fail), "failSessionTokenLimit still RETURNS a step result — it never throws");
  ok(/\{next:\{done:!0/.test(fail), "…returning a done step result");

  const producers = ["harness/session-limit-enforcement.js"];
  ok(producers.every((f) => read(f).includes("SESSION_TOKEN_LIMIT_REACHED")), "session-limit-enforcement.js is a producer of SESSION_TOKEN_LIMIT_REACHED");

  ok(
    /return`The session reached its configured \$\{\w+\} token limit\.`/.test(mod),
    "formatSessionTokenLimitMessage still formats `The session reached its configured <kind> token limit.`",
  );

  ok(!mod.includes("n_REACHED"), "the 0.22.x `n_REACHED` minifier artifact is absent from this dist (why the classifier's third pattern was removed in OPE-171)");
}

{
  const send = read("channel/channel-address.js");
  const modeVar = /mode:(\w+)\.mode\?\?`conversation`/.exec(send)?.[1];
  ok(modeVar !== undefined, "channel-address.js still defaults an unspecified `mode` to `conversation`");
  const capabilitiesTernary = `${modeVar as string}\\.mode===\`task\`\\?void 0:\\{requestInput:!0\\}`;
  const inlinePlacement = new RegExp(`capabilities:${capabilitiesTernary}`).test(send);
  const hoistedLocal = new RegExp(`(\\w+)=${capabilitiesTernary}`).exec(send)?.[1];
  const hoistedPlacement = hoistedLocal !== undefined && new RegExp(`capabilities:${hoistedLocal}[,}]`).test(send);
  ok(
    inlinePlacement || hoistedPlacement,
    "channel-address.js still declares `capabilities: { requestInput: true }` for every non-task run (⊇ conversation — OE's seats), written inline or through a hoisted local",
  );
  ok(
    /=await \w+\.runtime\.dispatchContinuation\(\{command:\w+,continuationToken:\w+\}\)/.test(send),
    "the send still awaits only runtime.dispatchContinuation on the continuation path (0.31's rename of runtime.deliver)",
  );
  ok(
    /createSession\(\(await \w+\.runtime\.createSession\(\w+\)\)\.sessionId,/.test(send),
    "…and only runtime.createSession on the fresh-session path (0.31's rename of runtime.run — the turn still runs elsewhere)",
  );
}

{
  const cont = read("harness/session-limit-continuation.js");
  ok(
    cont.includes("SESSION_LIMIT_CONTINUATION_TOOL_NAME=`session_limit_continuation`"),
    "eve still names the continuation prompt's synthetic tool `session_limit_continuation`",
  );
  ok(new RegExp(`toolName:SESSION_LIMIT_CONTINUATION_TOOL_NAME`).test(cont), "…and stamps it as the request's action.toolName");
  ok(/input:\{kind:\w+\.kind,limit:\w+\.limit,usedTokens:\w+\.usedTokens\}/.test(cont), "…carrying {kind, limit, usedTokens} as the action input");
  ok(/isSessionLimitContinuationRequestId[\s\S]{0,120}?\/:limit:\(\?:input\|output\):\\d\+\$\/u/.test(cont), "…and eve's own requestId grammar still matches OE's SESSION_LIMIT_REQUEST_ID_RE");
  ok(cont.includes(`\`${SESSION_LIMIT_CONTINUATION_TOOL_NAME}\``), "OE's SESSION_LIMIT_CONTINUATION_TOOL_NAME matches eve's literal");
  ok(SESSION_LIMIT_REQUEST_ID_RE.source === ":limit:(?:input|output):\\d+$", "OE's SESSION_LIMIT_REQUEST_ID_RE mirrors eve's isSessionLimitContinuationRequestId grammar");
}

{
  const proto = read("protocol/message.js");
  ok(
    /function createInputRequestedEvent\((\w+)\)\{return\{data:\{requests:\1\.requests[\s\S]{0,120}?type:`input\.requested`\}\}/.test(proto),
    "createInputRequestedEvent still emits a `input.requested` event carrying `requests`",
  );

  const hookMap = readFileSync(join(distSrc, "public", "definitions", "hook.d.ts"), "utf8");
  ok(
    /readonly "input\.requested": ProtocolEvent<"input\.requested">;/.test(hookMap),
    "`input.requested` is still in eve's PUBLIC HookEventMap (authored hooks may subscribe)",
  );

  const steps = read("execution/workflow-steps.js");
  const hookDispatch = /handleEvent=async\((\w+),\w+\)=>\{let (\w+)=[^;]*?await emit\(\1\)[^;]*;[^;]*?await dispatchStreamEventHooks\(\{[^}]*event:\2\}\)/u.exec(steps);
  ok(hookDispatch !== null, "workflow-steps.js still wraps `emit` in a `handleEvent` that dispatches authored stream-event hooks");
  ok(
    /createExecutionNodeStep\(\{[\s\S]{0,400}?handleEvent[,}]/.test(steps),
    "…and hands THAT wrapper to createExecutionNodeStep as the harness's emitter (so harness-emitted events reach hooks)",
  );

  const loop = read("harness/tool-loop.js");
  ok(/await enforceSessionTokenLimit\(\{[^}]{0,80}?emit:\w+/.test(loop), "the tool loop still calls enforceSessionTokenLimit WITH an emitter (so the park branch is reachable)");
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
  ok(SESSION_LIMIT_REQUEST_ID_RE.test(hit?.requestId ?? ""), "…which matches eve's requestId grammar");

  ok(
    detectSessionLimitPark([{ requestId: "q1", action: { callId: "c", kind: "tool-call", toolName: "ask_question", input: {} } }]) === undefined,
    "an unrelated HITL request (ask_question) is NOT claimed as a park",
  );
  ok(detectSessionLimitPark([]) === undefined, "an empty batch is not a park");
  ok(detectSessionLimitPark(undefined) === undefined, "a missing requests array degrades to `not a park`");
  ok(detectSessionLimitPark("nonsense") === undefined, "a non-array degrades to `not a park`");
  ok(detectSessionLimitPark([null, 7, parkRequest()]) !== undefined, "…and a park is still found alongside junk entries");

  const drifted = detectSessionLimitPark([{ action: { toolName: "session_limit_continuation" } }]);
  ok(drifted !== undefined && drifted.kind === "unknown" && drifted.limit === undefined && drifted.requestId === "", "a park with no action input reads kind `unknown` with no numbers");
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
