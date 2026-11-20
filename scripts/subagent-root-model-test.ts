import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DynamicModelContext } from "eve/models";

const scratch = mkdtempSync(join(tmpdir(), "oe-subagent-root-model-"));
process.env.OE_PGLITE_DIR = join(scratch, "pglite");
process.env.OE_MEMORY_DIR = join(scratch, "memory");
delete process.env.DATABASE_URL;

const { default: root } = await import("../agent/agent.js");
const { PRIMARY_MODEL, PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS } = await import("../agent/model/models.js");
const { registerSettings } = await import("@open-everywhere/core/agent/settings/settings.js");
const { isSubagentChildContext } = await import("@open-everywhere/core/agent/identity/binding.js");
const { resolvePartition } = await import("@open-everywhere/core/agent/memory/partition.js");
const { noteTurnStep, STEP_BOUNDARY_MARKER, _resetStepBoundaryCountsForTest } = await import("@open-everywhere/core/agent/model/step-boundary.js");
const { noteTurnCloseoutRefusal, turnCloseoutSnapshot, _resetTurnCloseoutForTest } = await import("@open-everywhere/core/agent/model/turn-closeout.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const DYNAMIC = Symbol.for("eve.dynamic");
const ROUTING_LOG = "[open-everywhere:model-routing]";

interface Selection {
  readonly model: {
    readonly modelId: string;
    doGenerate(options: unknown): Promise<unknown>;
  };
  readonly modelContextWindowTokens?: number;
}
type Evaluate = (ctx: DynamicModelContext) => Promise<Selection>;

function evaluatorOf(model: unknown, label: string): Evaluate {
  const fn = typeof model === "object" && model !== null ? (model as Record<symbol, unknown>)[DYNAMIC] : undefined;
  ok(
    typeof fn === "function",
    `${label}: the model is a defineDynamic() model (the primary model resolver) — got ${typeof model === "string" ? `the static id "${model}"` : typeof model}`,
  );
  return fn as Evaluate;
}

const PARENT_SESSION = "sess_parent_root_model";
const CALL_ID = "call_delegate_1";

// The SessionFrame eve 1.x hands a dynamic model. A delegated child carries `session.parent`, the
// `subagent` channel kind and a `subagent:<parent session>:<call id>` continuation token.
function frame(sessionId: string, turnId: string, child: boolean): DynamicModelContext {
  const memo = (async <T>(_key: unknown, fn: () => T | Promise<T>): Promise<T> => await fn()) as DynamicModelContext["memo"];
  return {
    session: {
      id: sessionId,
      auth: { current: null, initiator: null },
      ...(child ? { parent: { sessionId: PARENT_SESSION, callId: CALL_ID, turn: { id: "turn_parent_call", sequence: 1 }, rootSessionId: PARENT_SESSION } } : {}),
    },
    channel: child
      ? { kind: "subagent", metadata: {}, continuationToken: `subagent:${PARENT_SESSION}:${CALL_ID}` }
      : { kind: "http", metadata: {} },
    view: {} as DynamicModelContext["view"],
    turn: { id: turnId, status: "running", input: [] },
    now: new Date(0),
    memo,
    messages: async () => [],
  };
}

async function replyText(selection: Selection): Promise<string | undefined> {
  const out = (await selection.model.doGenerate({ prompt: [] })) as { content?: { type: string; text?: string }[] };
  return out.content?.find((c) => c.type === "text")?.text;
}

// The routed half of the primary resolver falls back to the bare default with a model-routing warning
// when it cannot bind the frame. Watch for that warning, so a pass proves the routed half ran. The
// resolver prints each warning text once per process, so every resolver call that reaches the routed half is watched:
// an unwatched earlier call could hide the same warning from a later one.
const routingWarnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.includes(ROUTING_LOG)) routingWarnings.push(line);
  realWarn(...args);
};

// Every declared subagent, not only the shipped one. The agent module names are the ones the
// subagent lint accepts; a directory without one fails here and is never skipped.
const SUBAGENTS_DIR = join(process.cwd(), "agent", "subagents");
const AGENT_MODULES = ["agent.ts", "agent.mts", "agent.cts", "agent.js", "agent.mjs", "agent.cjs"];
const names = readdirSync(SUBAGENTS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
ok(names.includes("fresh_eyes_review"), `the scan finds the shipped fresh_eyes_review subagent (found ${names.join(", ") || "none"})`);
function agentModuleOf(name: string): string {
  const file = AGENT_MODULES.find((f) => existsSync(join(SUBAGENTS_DIR, name, f)));
  ok(file !== undefined, `${name}: the subagent directory has an agent module (${AGENT_MODULES.join(", ")})`);
  return join(SUBAGENTS_DIR, name, file!);
}

const parentProbe = frame(PARENT_SESSION, "turn_probe", false);
ok(!isSubagentChildContext(parentProbe), "fixture: the parent frame does not read as a subagent child context");

for (const name of names) {
  const { default: subagent } = (await import(pathToFileURL(agentModuleOf(name)).href)) as { default: { model?: unknown } };
  const childSession = `sess_child_${name}`;

  // The wiring itself: the declared subagent takes the root agent's model, not a static id.
  ok(subagent.model === root.model, `${name}: its model IS the root agent's model (\`model: root.model\`)`);
  const childModel = evaluatorOf(subagent.model, name);

  const childProbe = frame(childSession, "turn_probe", true);
  ok(isSubagentChildContext(childProbe), `${name} fixture: the child frame reads as a subagent child context`);
  let bindError: unknown;
  try {
    resolvePartition(childProbe);
  } catch (err) {
    bindError = err;
  }
  ok(bindError === undefined, `${name} fixture: the routed resolver can bind the child frame (${String(bindError)})`);

  // 1. The child resolves to the root agent's primary model, and the step count keys on the child session.
  {
    _resetStepBoundaryCountsForTest();
    _resetTurnCloseoutForTest();
    registerSettings({ turn: { stepBudget: 2, stepBackstopMultiple: 2 } });
    const SHARED_TURN = `turn_shared_${name}`;
    const child = frame(childSession, SHARED_TURN, true);
    const warningsBefore = routingWarnings.length;
    // A backstop model keeps the inner model's id, so `modelId` cannot tell a live step from a stopped
    // one. The step-5 text below and the parent's count carry that check.
    for (let step = 1; step <= 4; step++) {
      let selection: Selection | undefined;
      let thrown: unknown;
      try {
        selection = await childModel(child);
      } catch (err) {
        thrown = err;
      }
      ok(thrown === undefined, `${name} step ${step}: the subagent's model resolves without a throw (${String(thrown)})`);
      ok(selection?.model.modelId === PRIMARY_MODEL, `${name} step ${step}: the subagent gets the root agent's primary model ${PRIMARY_MODEL} — got ${selection?.model.modelId}`);
      ok(
        selection?.modelContextWindowTokens === PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS,
        `${name} step ${step}: the subagent gets the root agent's context window (${PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS})`,
      );
    }
    ok(
      routingWarnings.length === warningsBefore,
      `${name}: the routed half of the primary resolver ran for the child, with no fallback — got ${JSON.stringify(routingWarnings.slice(warningsBefore))}`,
    );
    const text = await replyText(await childModel(child));
    ok(
      text?.startsWith(STEP_BOUNDARY_MARKER) === true && text.includes("reached 5 model round-trips, past the hard backstop of 4"),
      `${name} step 5: the hard backstop stops the subagent's own turn at its own count — got ${JSON.stringify(text?.slice(0, 160))}`,
    );

    const parent = frame(PARENT_SESSION, SHARED_TURN, false);
    const parentStep = await noteTurnStep(parent as never);
    ok(
      parentStep.tier === "none" && parentStep.count === 1 && parentStep.sessionId === PARENT_SESSION,
      `${name}: the parent's turn with the same turn id counts from 1 — the child's 5 steps did not land on it (got tier=${parentStep.tier} count=${parentStep.count})`,
    );
    const parentWarningsBefore = routingWarnings.length;
    const parentSelection = await evaluatorOf(root.model, "root")(parent);
    ok(parentSelection.model.modelId === PRIMARY_MODEL, `${name}: the parent's root model resolves the primary model`);
    ok(
      routingWarnings.length === parentWarningsBefore,
      `${name}: the routed half of the primary resolver ran for the parent too — got ${JSON.stringify(routingWarnings.slice(parentWarningsBefore))}`,
    );
  }

  // 2. The closeout keys on the child session: a parent closeout does not end the child's turn, and a child closeout does.
  {
    _resetStepBoundaryCountsForTest();
    _resetTurnCloseoutForTest();
    registerSettings({ turn: { stepBudget: 0 } });
    const SHARED_TURN = `turn_closeout_${name}`;
    const parent = frame(PARENT_SESSION, SHARED_TURN, false);
    const child = frame(childSession, SHARED_TURN, true);
    ok((await noteTurnCloseoutRefusal(parent as never, "parent spoke after its closeout")) === 1, `${name} fixture: the parent's turn records one closeout refusal`);
    ok(turnCloseoutSnapshot(childSession, SHARED_TURN) === undefined, `${name}: the parent's closeout latch is not the child's latch`);
    const openWarningsBefore = routingWarnings.length;
    const open = await childModel(child);
    ok(open.model.modelId === PRIMARY_MODEL, `${name}: the child's model resolves the primary model after the parent's closeout`);
    ok(
      routingWarnings.length === openWarningsBefore,
      `${name}: the routed half of the primary resolver ran for the child after the parent's closeout — got ${JSON.stringify(routingWarnings.slice(openWarningsBefore))}`,
    );
    const childStep = await noteTurnStep(child as never);
    ok(
      childStep.tier === "none",
      `${name}: a closeout on the parent's turn does not end the subagent's turn (got tier=${childStep.tier})`,
    );
    ok((await noteTurnCloseoutRefusal(child as never, "child spoke after its closeout")) === 1, `${name} fixture: the child's turn records its own first closeout refusal`);
    const closed = await replyText(await childModel(child));
    ok(
      closed?.startsWith(STEP_BOUNDARY_MARKER) === true && closed.includes("(child spoke after its closeout)"),
      `${name}: a closeout on the subagent's own turn ends it with the child's reason — got ${JSON.stringify(closed?.slice(0, 200))}`,
    );
  }
}

console.warn = realWarn;
console.log(
  `✓ subagent root model: ${passed} assertions passed over ${names.length} declared subagent(s) (each child resolves the root agent's model through the primary model resolver)`,
);
process.exit(0);
