import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { filesMatching } from "./eve-dist-search.js";

// Pins the principal each session-auth writer that eve 1.0.0-rc.18 added carries, and the road
// that reaches it. The census of every writer lives in auth-attribute-provenance-test.ts and in
// lint:eve-auth-paths (EVE_AUTH_WRITERS). OE keeps three of these writers unreachable on purpose:
// lint:eve-auth-paths rule C (connection events) and rule E (invokeTool, mcpChannel, a schedule
// collection) refuse the module that would reach them.

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const distSrc = join(eveRoot, "dist", "src");
const eveVersion = (JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")) as { version: string }).version;
const read = (rel: string): string => readFileSync(join(distSrc, rel), "utf8");

const TURN_STEP = "execution/session/turn-step.js";
const SCHEDULE_COLLECTION = "channel/schedule.js";
const INVOKE_TOOL = "execution/invoke-tool.js";
const EVENT_DISPATCH = "runtime/connections/events/dispatch-step.js";
const EVENT_OWNER = "runtime/connections/events/owner.js";
const CANCELLED_BATCH = "execution/cancelled-model-call-batch.js";
const ANY_WRITE_RE = /\.(?:set|setVirtualContext)\(\s*(?:Initiator)?AuthKey\b|[{,]\s*\[(?:Initiator)?AuthKey\.name\]\s*:/;

console.log(`eve-auth-writers: verifying against installed eve ${eveVersion}`);
{
  const count = (text: string): number => (text.match(new RegExp(ANY_WRITE_RE.source, "g")) ?? []).length;
  ok(count("o.set(AuthKey,a);t.setVirtualContext(AuthKey,i.auth);r={...x,[AuthKey.name]:t[AuthKey.name]}") === 3, "control: the write counter counts a `.set(`, a `.setVirtualContext(` and a serialized `[AuthKey.name]:` write");
  ok(count("principalOf(n===void 0?t[AuthKey.name]:n);e.get(AuthKey)") === 0, "control: the write counter skips a `?:` read and a `.get(` read");
}

{
  const writes = (rel: string): number => (read(rel).match(new RegExp(ANY_WRITE_RE.source, "g")) ?? []).length;

  // (A) channel/schedule.js — a schedule-collection occurrence. OE deploys no collection
  // (lint:eve-auth-paths rule E); these pins say what the slot would carry if one appeared.
  const sched = read(SCHEDULE_COLLECTION);
  ok(writes(SCHEDULE_COLLECTION) === 1, `${SCHEDULE_COLLECTION} holds exactly ONE auth-slot write (saw ${writes(SCHEDULE_COLLECTION)})`);
  const env = /let\{envelope:(\w+)\}=parseSchedulePayload\((\w+)\.payload,/.exec(sched);
  ok(env !== null, "the collection occurrence parses its envelope from the queued payload");
  const resolved = new RegExp(`let (\\w+)=resolveCreatorAuth\\(await \\w+\\.auth\\(\\{principal:${env?.[1] ?? "\\0"}\\.principal,[^}]*\\}\\),${env?.[1] ?? "\\0"}\\.principal\\)`).exec(sched);
  ok(resolved !== null, "🔴 (A) the occurrence's auth is resolveCreatorAuth(the authored callback's result, THE ENVELOPE'S CREATOR)");
  ok(new RegExp(`\\w+\\.set\\(AuthKey,${resolved?.[1] ?? "\\0"}\\)`).test(sched), "🔴 (A) …and that resolved value is the one the write stores");
  const creator = /function resolveCreatorAuth\((\w+),(\w+)\)\{if\(\1===null\)throw new PermanentScheduleMessageError[^;]*;if\(typeof \1==`object`&&`principalId`in \1\)\{if\(\1\.principalId!==\2\.principalId\|\|\1\.principalType!==\2\.type\|\|\1\.authenticator!==\2\.authenticator\|\|\1\.issuer!==\2\.issuer\|\|\1\.subject!==\2\.subject\)throw new PermanentScheduleMessageError[^;]*;return \1\}/.exec(sched);
  ok(creator !== null, "🔴 (A) a callback that returns a whole principal must return the creator itself, or the occurrence fails");
  ok(
    creator !== null && new RegExp(`\\{attributes:\\w+,authenticator:${creator[2]}\\.authenticator,principalId:${creator[2]}\\.principalId,principalType:${creator[2]}\\.type\\}`).test(sched),
    "🔴 (A) …and a callback that returns only attributes gets the CREATOR's principal fields — the callback cannot name another principal",
  );
  const inScope = sched.slice(sched.indexOf("async triggerInScope("), sched.indexOf("createHandlerContext(e="));
  ok(inScope.length > 0 && !/AuthKey/.test(inScope), "(A) the static `defineSchedule` path (every OE schedule) writes no auth slot");
  ok(/args:\{appAuth:SCHEDULE_APP_AUTH\$?\d*,/.test(sched), "(A) …and hands its `run` eve's schedule app principal as `appAuth`");
  const triggerCallers = filesMatching(/\.triggerCollection\(/u);
  ok(
    JSON.stringify(triggerCallers) === JSON.stringify(["runtime/schedules/dispatch-occurrence.js"]),
    `(A) the collection write has ONE caller, the occurrence dispatcher (saw ${JSON.stringify(triggerCallers)})`,
  );
  ok(
    /if\((\w+)===void 0\)throw new ScheduleCollectionNotDeployedError/.test(read("runtime/schedules/load-collection.js")),
    "🔴 (A) a delivery for a collection this agent does not deploy throws ScheduleCollectionNotDeployedError",
  );
  const consumer = read("internal/nitro/routes/schedule-collection-consumer.js");
  const occurrenceCallers = filesMatching(/await dispatchScheduledOccurrence\(/u);
  ok(
    JSON.stringify(occurrenceCallers) === JSON.stringify(["internal/nitro/routes/schedule-collection-consumer.js", "runtime/schedules/dispatch-occurrence.js"]),
    `🔴 (A) two modules await an occurrence dispatch: the queue consumer, and a schedule provider's own deliver target (saw ${JSON.stringify(occurrenceCallers)})`,
  );
  ok(
    /deliver:async\(\{payload:\w+,occurrence:\w+\}\)=>\{await dispatchScheduledOccurrence\(/.test(read("runtime/schedules/dispatch-occurrence.js")),
    "(A) …the second sits inside createScheduleProviderContext's deliver target",
  );
  const providerCallers = filesMatching(/createScheduleProviderContext\(\{/u);
  ok(
    JSON.stringify(providerCallers) === JSON.stringify(["runtime/schedules/collection-client.js", "runtime/schedules/dispatch-occurrence.js"]),
    `(A) …which only the collection client and the dispatcher itself build (saw ${JSON.stringify(providerCallers)})`,
  );
  const clientImporters = filesMatching(/collection-client\.js[`"]/u);
  ok(
    JSON.stringify(clientImporters) === JSON.stringify(["public/experimental/schedules/client.js"]),
    `🔴 (A) …and one module imports the collection client, the public schedule client (saw ${JSON.stringify(clientImporters)})`,
  );
  const publicImporters = filesMatching(/schedules\/client\.js[`"]/u);
  ok(
    JSON.stringify(publicImporters) === JSON.stringify(["context/schedule-collection-tools.js", "public/experimental/schedules/index.js"]),
    `🔴 (A) …which two modules import: \`eve/experimental/schedules\` (lint:eve-auth-paths rule E refuses it) and the model-facing schedule tools (saw ${JSON.stringify(publicImporters)})`,
  );
  ok(
    /scheduleTools:scheduleToolsDefinitions\(declared\(\w+,`schedules`\)\.filter\(\w+=>\w+\.offersTools===!0\)/.test(read("definitions/compiled-agent.js")),
    "🔴 (A) …and the agent mounts those tools only for a DECLARED schedule collection that offers them — OE declares none (rule E)",
  );
  ok(
    /await (\w+)\.verifyDelivery\?\.\(\);let \w+=resolveCreatorAuth\(/.test(sched),
    "(A) the occurrence runs the delivery check BEFORE it resolves the auth",
  );
  ok(
    /verifyDelivery:async\(\)=>verifyScheduleDelivery\(/.test(consumer),
    "🔴 (A) …and the queue consumer supplies that check (it compares the schedule's id, name and namespace with the stored record — NOT the envelope's principal)",
  );
  const loadAt = consumer.indexOf("await loadScheduleCollectionDefinition(");
  const dispatchAt = consumer.indexOf("await dispatchScheduledOccurrence(");
  ok(loadAt > 0 && dispatchAt > loadAt, "🔴 (A) …and the queue consumer loads the collection BEFORE it dispatches, so an agent with no collection never reaches the write");

  // (B) execution/invoke-tool.js — a tool call outside a conversation. No OE module calls it
  // (lint:eve-auth-paths rule E); the caller's `auth` option is the principal, verbatim.
  const invoke = read(INVOKE_TOOL);
  ok(writes(INVOKE_TOOL) === 2, `${INVOKE_TOOL} holds exactly TWO auth-slot writes, the slot and the initiator (saw ${writes(INVOKE_TOOL)})`);
  const opts = /let\{[^}]*options:(\w+)[^}]*\}=\w+/.exec(invoke);
  ok(
    opts !== null && new RegExp(`createCallContext\\(\\{auth:${opts[1]}\\.auth,initiator:${opts[1]}\\.initiator\\?\\?${opts[1]}\\.auth,`).test(invoke),
    "🔴 (B) the call context takes `auth` and `initiator` from the CALLER's options — the principal is whatever the caller passes",
  );
  ok(
    /function createCallContext\((\w+)\)\{let (\w+)=new ContextContainer;return \2\.set\(AuthKey,\1\.auth\),\2\.set\(InitiatorAuthKey,\1\.initiator\)/.test(invoke),
    "🔴 (B) …and createCallContext writes exactly those two values into a fresh container",
  );
  const importers = filesMatching(/["`]#execution\/invoke-tool\.js[`"]/u);
  ok(
    JSON.stringify(importers) === JSON.stringify(["internal/nitro/routes/route-invoke-tool.js"]),
    `🔴 (B) one module imports invokeTool, the route wrapper (saw ${JSON.stringify(importers)})`,
  );
  const wrappers = filesMatching(/createRouteInvokeTool\(\{/u);
  ok(
    JSON.stringify(wrappers) === JSON.stringify(["internal/nitro/routes/channel-dispatch.js"]),
    `🔴 (B) …and one module mounts that wrapper, the channel route dispatcher (saw ${JSON.stringify(wrappers)})`,
  );
  ok(
    /agent:\{\.\.\.\w+\.args,invokeTool:createRouteInvokeTool\(/.test(read("internal/nitro/routes/channel-dispatch.js")) &&
      /\.\.\.(\w+)\.agent,params:\1\.params/.test(read("channel/route-args.js")),
    "🔴 (B) …as `invokeTool` on the route handler args of EVERY channel, eve's own channels included",
  );
  const named = filesMatching(/\binvokeTool\b/u);
  const NAMED = [
    "execution/invoke-tool.js",
    "harness/call-executor.js",
    "harness/tools.js",
    "internal/mcp/published-tools.js",
    "internal/nitro/routes/channel-dispatch.js",
    "internal/nitro/routes/route-invoke-tool.js",
    "public/channels/mcp.js",
    "shared/sandbox-tool-session-error.js",
  ];
  ok(
    JSON.stringify([...named].sort()) === JSON.stringify(NAMED),
    `🔴 (B) the name \`invokeTool\` appears in exactly these eve modules — a new one (an eve channel that starts to call it) is a new road (saw ${JSON.stringify(named)})`,
  );
  const callers = filesMatching(/\.invokeTool\(/u);
  ok(
    JSON.stringify(callers) === JSON.stringify(["internal/mcp/published-tools.js"]),
    `🔴 (B) …and one module CALLS it off a handle, the MCP channel's published tools (saw ${JSON.stringify(callers)}); no vendor channel eve ships calls it`,
  );
  ok(
    /let\{current:(\w+),forwarder:(\w+),initiator:(\w+)\}=(\w+)\.principals;[^]*?await \4\.invokeTool\(\w+\.name,\w+,\{auth:\1,forwardedBy:\2,initiator:\3,/.test(read("internal/mcp/published-tools.js")),
    "(B) …and that caller passes the principals its MCP route authenticated",
  );

  // (C) runtime/connections/events/dispatch-step.js and (D) owner.js — connection events. OE
  // declares no connection events (lint:eve-auth-paths rule C).
  const dispatch = read(EVENT_DISPATCH);
  ok(writes(EVENT_DISPATCH) === 1, `${EVENT_DISPATCH} holds exactly ONE auth-slot write (saw ${writes(EVENT_DISPATCH)})`);
  const bound = /let (\w+)=accepts\((\w+)\.binding,\2\.payload\)\?resolveBinding\(\w+,\2\.binding\):void 0;if\(\1===void 0\)return;let\{binding:(\w+),connection:\w+\}=\1;/.exec(dispatch);
  ok(bound !== null, "(C) the callback step resolves its binding through resolveBinding, and returns when that refuses");
  ok(new RegExp(`\\.setVirtualContext\\(AuthKey,${bound?.[3] ?? "\\0"}\\.auth\\)`).test(dispatch), "🔴 (C) the callback runs under the STORED BINDING's auth — no field of the delivered event");
  ok(
    /let (\w+)=(\w+)\?\.experimental_events;if\(\2===void 0\|\|\1===void 0\|\|(\w+)\.instanceId!==\2\.instanceId\|\|\1\.connector!==\3\.connector\)return;/.test(dispatch),
    "🔴 (C) resolveBinding refuses a binding whose connection this agent deploys WITHOUT events, or under another instance or connector",
  );
  ok(/if\(principalKey\(\w+\)===\w+\.principalKey\)return\{binding:/.test(dispatch), "(C) …and one whose auth no longer resolves to the principal the binding was keyed by");
  const owner = read(EVENT_OWNER);
  ok(writes(EVENT_OWNER) === 1, `${EVENT_OWNER} holds exactly ONE auth-slot write (saw ${writes(EVENT_OWNER)})`);
  ok(/async function bindingContext\((\w+),\w+\)\{let (\w+)=new ContextContainer\([^)]*\);return[^;]*\2\.set\(AuthKey,\1\.auth\)/.test(owner), "🔴 (D) the owner's context carries the binding's own auth");
  ok(
    /let (\w+)=(\w+)\.owner;return await startConnectionEventDeliveryRun\(\{binding:\1,serializedContext:await bindingContext\(\1,/.test(owner),
    "🔴 (D) a delivery runs under the binding the OWNER HOOK stored, not one read off the inbound request",
  );
  const loop = read("runtime/connections/events/workflow.js");
  const own = /async function connectionEventWorkflow\((\w+)\)\{"use workflow";let\{binding:(\w+),serializedContext:(\w+)\}=\1;let \w+=createHook\(\{token:connectionEventHookToken\(\2\.id\),metadata:parseJsonObject\(\2\)\}\)/.exec(loop);
  ok(own !== null, "🔴 (D) the owner workflow stores ITS OWN input binding as the hook metadata that a direct delivery reads back as `owner`");
  const body = own === null ? "" : loop.slice(own.index, loop.indexOf("export{", own.index));
  ok(
    own !== null && new RegExp(`startConnectionEventDeliveryStep\\(\\{binding:${own[2]},serializedContext:${own[3]},payload:\\w+\\.payload\\}\\)`).test(body),
    "🔴 (D) the queued road (no subscription yet) delivers under the owner workflow's OWN input binding and context, not one off the payload",
  );
  ok(
    own !== null && !new RegExp(`(?<![\\w$.])(?:${own[2]}|${own[3]})=(?!=)`).test(body.slice(own[0].length)),
    "(D) …and the owner workflow never reassigns that binding or context",
  );
  const actions = read("runtime/connections/events/actions.js");
  const scope = /let\{ctx:(\w+),[^}]*\}=this\.scope\(\)/.exec(actions);
  ok(
    scope !== null && new RegExp(`auth:structuredClone\\(${scope[1]}\\.get\\(AuthKey\\)\\?\\?null\\)`).test(actions),
    "🔴 (D) the binding's auth is a clone of the SUBSCRIBING session's own slot, minted when its turn calls the watch action",
  );

  // (E) execution/cancelled-model-call-batch.js — a copy of the turn step's slot.
  const cancelled = read(CANCELLED_BATCH);
  ok(writes(CANCELLED_BATCH) === 1, `${CANCELLED_BATCH} holds exactly ONE auth-slot write (saw ${writes(CANCELLED_BATCH)})`);
  const ser = /let (\w+)=serializeContext\((\w+)\.ctx\);/.exec(cancelled);
  ok(ser !== null && new RegExp(`\\[AuthKey\\.name\\]:${ser[1]}\\[AuthKey\\.name\\]`).test(cancelled), "🔴 (E) the cancelled batch copies the slot of its OWN `ctx`, serialized, under the same key");
  const cancelCallers = filesMatching(/createCancelledModelCallBatchResult\(\{/u);
  ok(JSON.stringify(cancelCallers) === JSON.stringify([TURN_STEP]), `(E) the turn step is its one caller (saw ${JSON.stringify(cancelCallers)})`);
  const step = read(TURN_STEP);
  const stepCtx = /let \w+=(\w+)\.get\(AuthKey\);/.exec(step)?.[1] ?? "\\0";
  ok(
    new RegExp(`createCancelledModelCallBatchResult\\(\\{[^}]*ctx:${stepCtx}[,}]`).test(step),
    "🔴 (E) …and it passes the SAME context its pinned writers (1)-(4) write, so the copy carries no value they did not",
  );
}

console.log(`✓ eve-auth-writers: ${passed} assertions passed against eve ${eveVersion}`);
