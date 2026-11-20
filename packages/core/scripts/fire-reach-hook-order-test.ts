/**
 * A routine fire's reach block depends on hook order. The `turn.started` hook
 * (`agent/hooks/fire-toolset.ts`) resolves the routine's declared connector ops into a per-session
 * slot. The access instructions (`agent/instructions/access.ts`) read that slot through
 * `declaredOpsForReach()` and render the reach block. If eve built the instructions before it ran
 * the hook, the first model call of a fire would get an empty reach block, and no error shows.
 *
 * This suite is a tripwire on that order in eve 1.x. It reads eve's installed source and pins each
 * link of the chain, in the order a turn runs:
 *
 *   1. `runStages` awaits the turn input (which opens the turn) before it runs the model step.
 *   2. `openTurn` awaits `apply(receive(...))`, and `receive` writes the `turn.started` fact.
 *   3. The step's apply hands its publish to `applyTransition`, which awaits it. The publish awaits
 *      the step's event handler: the turn step's `handleEvent`, through the instrumentation wrapper,
 *      which awaits it too.
 *   4. That `handleEvent` awaits the turn's main event handler, which awaits `dispatcher.react`.
 *      `react` returns `runEffects` on the written facts, and `runEffects` awaits each hook effect.
 *   5. The model step awaits `prepareModelCall` before it builds the model call, and
 *      `prepareModelCall` awaits `evaluateStepValues`, which awaits the instructions (`system()`).
 *
 * A link that changes turns this suite red. Then re-prove the order on the new eve before a fire's
 * reach block is trusted again. Each file also has a control: the reader finds the function whole.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n += 1;
};

const require_ = createRequire(import.meta.url);
const eveRoot = dirname(require_.resolve("eve/package.json"));
const src = (rel: string): string => readFileSync(join(eveRoot, "dist", "src", rel), "utf8");

/** The text of one minified function: from its declaration to the next `function ` keyword. */
function fnBody(source: string, name: string): string {
  const at = source.search(new RegExp(`function ${name}\\(`));
  if (at === -1) return "";
  const next = source.indexOf("function ", at + name.length + 10);
  return source.slice(at, next === -1 ? undefined : next);
}

const ID = "[\\w$]+";

console.log("§0 the OE side of the premise");
{
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const hook = readFileSync(join(repoRoot, "agent", "hooks", "fire-toolset.ts"), "utf8");
  const access = readFileSync(join(repoRoot, "agent", "instructions", "access.ts"), "utf8");
  ok(/"turn\.started":\s*optional\("fire-toolset"/.test(hook), "the fire-toolset hook resolves the declared ops on `turn.started`");
  ok(/renderDeclaredReachBlock\(declaredOpsForReach\(\)\)/.test(access), "the access instructions render the reach block from the slot the hook writes");
  ok(/from "eve\/instructions"/.test(access) && access.includes("defineDynamic"), "the access instructions are a dynamic value, which eve evaluates per model step");
}

console.log("§1 the step opens the turn before it runs the model step (harness/kernel.js)");
{
  const kernel = src("harness/kernel.js");
  const stages = fnBody(kernel, "runStages");
  ok(stages.includes("runModelStep("), "CONTROL: runStages was read whole: it runs the model step");
  const turnInputAt = stages.search(new RegExp(`=await turnInput\\(`));
  const modelAt = stages.indexOf("runModelStep(");
  ok(turnInputAt !== -1 && turnInputAt < modelAt, "🔴 runStages AWAITS turnInput before it reaches runModelStep");
  const turnInput = fnBody(kernel, "turnInput");
  ok(new RegExp(`=await openTurn\\(`).test(turnInput), "🔴 turnInput awaits openTurn");
  const step = fnBody(kernel, "executeStepBody");
  ok(step.includes("createStep("), "CONTROL: executeStepBody was read whole: it creates the step");
  const handlerVar = new RegExp(`let (${ID})=${ID}\\?\\.createHandleEvent\\(\\{isFrameworkTool:[^}]*handleEvent:${ID}\\.handleEvent\\}\\)\\?\\?${ID}\\.handleEvent`).exec(step)?.[1];
  ok(handlerVar !== undefined, "🔴 the step's event handler is the config's handleEvent (through the instrumentation wrapper)");
  ok(
    new RegExp(`let publish=async\\(${ID},${ID}\\)=>\\{[^}]*${handlerVar}!==void 0&&await ${handlerVar}\\(${ID},${ID}\\)`).test(step),
    "🔴 the step's publish AWAITS that handler whenever the handler is defined",
  );
  ok(new RegExp(`createStep\\(\\{[^}]*\\bpublish,`).test(step), "🔴 the step is created with that publish");
}

console.log("§2 openTurn applies `receive`, which writes `turn.started` (harness/step/context.js, session-machine/transitions.js)");
{
  const context = src("harness/step/context.js");
  const open = fnBody(context, "openTurn");
  ok(open.includes("preparePreamble"), "CONTROL: openTurn was read whole");
  ok(new RegExp(`await ${ID}\\.apply\\(receive\\(`).test(open), "🔴 openTurn AWAITS apply(receive(...))");
  const create = fnBody(context, "createStep");
  ok(create.includes("hasDelegatedCaller"), "CONTROL: createStep was read whole");
  ok(new RegExp(`publish:${ID}\\.publish`).test(create), "🔴 the step keeps the publish it was created with");
  ok(new RegExp(`applyTransition\\(${ID}\\.session,${ID},${ID}\\.publish,`).test(create), "🔴 the step's apply hands that publish to applyTransition");
  const transitions = src("harness/session-machine/transitions.js");
  const receive = fnBody(transitions, "receive");
  ok(receive.includes("session.started"), "CONTROL: receive was read whole");
  ok(receive.includes("fact(`turn.started`"), "🔴 receive writes the `turn.started` fact");
}

console.log("§3 applying a transition publishes its events and waits (session-machine/commit.js)");
{
  const commit = src("harness/session-machine/commit.js");
  const apply = fnBody(commit, "applyTransition");
  ok(apply.includes("saveTransition("), "CONTROL: applyTransition was read whole");
  ok(new RegExp(`await ${ID}\\(commitOf\\(`).test(apply), "🔴 applyTransition AWAITS the publish of its events");
}

console.log("§4 the published facts run the hooks, and the publish waits for them");
{
  const handler = fnBody(src("execution/session/turn-event-handler.js"), "createTurnEventHandler");
  ok(handler.includes(".emit("), "CONTROL: createTurnEventHandler was read whole");
  ok(new RegExp(`await ${ID}\\.dispatcher\\.react\\(`).test(handler), "🔴 the turn's event handler AWAITS dispatcher.react on the emitted facts");

  const turnStep = src("execution/session/turn-step.js");
  const mainHandler = new RegExp(`let (${ID})=createTurnEventHandler\\(\\{[^}]*publisher:${ID}\\}\\)`).exec(turnStep)?.[1];
  ok(mainHandler !== undefined, "🔴 the turn step builds its main event handler on the session's publisher");
  ok(
    new RegExp(`let handleEvent=async\\(${ID},${ID}\\)=>\\{[^}]*await ${mainHandler}\\(${ID},${ID}\\)\\}`).test(turnStep),
    "🔴 the turn step's handleEvent AWAITS that main handler",
  );
  ok(new RegExp(`createExecutionNodeStep\\(\\{[^}]*\\bhandleEvent,`).test(turnStep), "🔴 the harness step runs with that handleEvent");
  const instrumented = fnBody(src("instrumentation/native-events.js"), "createInstrumentationHandleEvent");
  ok(instrumented.includes("hooks"), "CONTROL: createInstrumentationHandleEvent was read whole");
  ok(
    new RegExp(`let\\{handleEvent:(${ID}),hooks:${ID}\\}=${ID}[\\s\\S]*?await \\1\\(${ID},${ID}\\)`).test(instrumented),
    "🔴 the instrumentation wrapper AWAITS the handleEvent it wraps",
  );

  const publisher = src("execution/publish-session-events.js");
  const dispatcher = fnBody(publisher, "createSessionEventDispatcher");
  ok(dispatcher.includes("deliver("), "CONTROL: createSessionEventDispatcher was read whole");
  ok(
    new RegExp(`react\\(${ID},${ID}\\)\\{[^}]*let (${ID})=${ID}\\.then\\(\\(\\)=>runEffects\\(${ID},\\{\\.\\.\\.${ID},written:${ID}\\}\\)\\)[\\s\\S]*?return ${ID}=\\1\\.catch\\(\\(\\)=>void 0\\),\\1\\}`).test(
      dispatcher,
    ),
    "🔴 react returns the runEffects promise for the written facts, so a caller that awaits react waits for the hooks",
  );

  const kernel = src("definitions/kernel.js");
  const effects = fnBody(kernel, "runEffects");
  ok(effects.includes("settleHookCommands("), "CONTROL: runEffects was read whole");
  ok(/for\(let [\w$]+ of await collectEffects\(/.test(effects) && /try\{await withUsageInEffect\(\(\)=>[\w$]+\.run\(\)\)/.test(effects), "🔴 runEffects AWAITS each hook effect in turn");
}

console.log("§5 the model step builds the instructions after that (model-call/run.js, step/context.js, definitions/step.js)");
{
  const run = src("harness/model-call/run.js");
  const step = fnBody(run, "runModelStep");
  ok(step.includes("new ModelCaller("), "CONTROL: runModelStep was read whole");
  const prepareAt = step.search(/=await prepareModelCall\(/);
  ok(prepareAt !== -1 && prepareAt < step.indexOf("new ModelCaller("), "🔴 runModelStep AWAITS prepareModelCall before it builds the model call");
  const prepare = fnBody(src("harness/step/context.js"), "prepareModelCall");
  ok(prepare.includes("validateHarnessModelMessages("), "CONTROL: prepareModelCall was read whole");
  ok(prepare.includes("await evaluateStepValues("), "🔴 prepareModelCall evaluates the step's dynamic values");
  const evaluate = fnBody(src("definitions/step.js"), "evaluateStepValues");
  ok(evaluate.includes("contributionsOf("), "CONTROL: evaluateStepValues was read whole");
  ok(new RegExp(`await ${ID}\\.system\\(\\)`).test(evaluate), "🔴 evaluateStepValues builds the instructions (system())");
}

console.log(`\nfire-reach-hook-order: ${n} assertions passed`);
