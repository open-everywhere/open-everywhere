import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

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

console.log(`auth-attribute-provenance: verifying against installed eve ${eveVersion}`);

{
  const keys = read("context/keys.js");
  ok(/AuthKey\s*=\s*new ContextKey\(`eve\.auth`\)/.test(keys), "eve still defines AuthKey as ContextKey(`eve.auth`)");
  ok(
    /InitiatorAuthKey\s*=\s*new ContextKey\(`eve\.initiatorAuth`\)/.test(keys),
    "eve still defines InitiatorAuthKey as ContextKey(`eve.initiatorAuth`)",
  );
}

{
  ok(/get auth\(\)\{return\{current:\w+\.get\(AuthKey\)/.test(read("channel/session.js")), "channel/session.js buildSessionHandle still reads session.auth.current from AuthKey");
  const provider = read("context/providers/session.js");
  ok(/\w+=\w+\.require\(AuthKey\)/.test(provider), "context/providers/session.js sessionProvider still requires AuthKey");
  ok(/auth:\{current:\w+,initiator:\w+\.get\(InitiatorAuthKey\)/.test(provider), "sessionProvider still projects that slot as session.auth.current");
  ok(/auth:\{current:\w+,initiator:\w+\}/.test(read("context/dynamic-resolve-context.js")), "context/dynamic-resolve-context.js still projects session.auth from the container");
}

const WRITE_RE = /\.set\(\s*(?:Initiator)?AuthKey\b/g;
const EXPECTED_WRITERS = new Set(["execution/runtime-context.js", "execution/workflow-steps.js"]);
{
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.endsWith(".js")) continue;
      if (WRITE_RE.test(readFileSync(abs, "utf8"))) found.add(relative(distSrc, abs).replaceAll("\\", "/"));
      WRITE_RE.lastIndex = 0;
    }
  };
  walk(distSrc);
  const unexpected = [...found].filter((f) => !EXPECTED_WRITERS.has(f));
  if (unexpected.length > 0) {
    console.error(
      `✗ eve ${eveVersion} has NEW writers of the session auth slot: ${unexpected.join(", ")}\n` +
        `  The "host-set auth attributes are model-unforgeable" invariant (OPE-129) was verified against exactly\n` +
        `  two writers. Read each new site and confirm it cannot carry model-derived data BEFORE widening\n` +
        `  EXPECTED_WRITERS here, and update agent/channels/unified-window.ts §AUTH-ATTRIBUTE PROVENANCE.`,
    );
    process.exit(1);
  }
  passed++;
  for (const w of EXPECTED_WRITERS) ok(found.has(w), `eve still writes the auth slot in ${w} (the site is not gone/renamed)`);
}

{
  const steps = read("execution/workflow-steps.js");
  ok(
    /input\?\.kind===`deliver`&&\w+\.input\.auth!==void 0&&\w+\.set\(AuthKey,\w+\.input\.auth\?\?null\)/.test(steps),
    "turnStep's auth write is still guarded on kind===`deliver` AND input.auth!==undefined (approval-resume keeps its stamps)",
  );
  ok(
    /resumeHook\(\w+,\{kind:`deliver`,payloads:\[\{authorizationCallback:/.test(read("runtime/connections/callback-route.js")),
    "the connection authorization callback still resumes with NO `auth` field (auth-preserving resume)",
  );
}

{
  const state = read("public/definitions/state.js");
  ok(/RESERVED_STATE_NAME_PREFIX=`eve\.`/.test(state), "defineState still reserves the `eve.` prefix");
  ok(/startsWith\(RESERVED_STATE_NAME_PREFIX\)\)throw Error/.test(state), "defineState still THROWS on a reserved-prefix name (cannot alias eve.auth)");
}

{
  const authFromContainer = /(?:auth:|\w+=)\w+\.get\(AuthKey\)\?\?null/u;
  const dispatchFiles = ["execution/dispatch-runtime-actions-shared.js", "execution/dispatch-runtime-actions-step.js"]
    .filter((rel) => existsSync(join(distSrc, rel)));
  ok(
    dispatchFiles.some((rel) => authFromContainer.test(read(rel))),
    `subagent dispatch still takes the child's auth from the PARENT's AuthKey slot (looked in: ${dispatchFiles.join(", ") || "no dispatch file found at all"})`,
  );
  const sub = read("execution/subagent-tool.js");
  ok(/\{action:\w+,auth:\w+,batchEvent/.test(sub), "buildSubagentRunInput still takes `auth` as a caller argument, not off the action");
  ok(!/\w+\.input\.auth/.test(sub), "buildSubagentRunInput still never reads `auth` off the model's action input");
}

{
  const messages = read("harness/messages.js");
  ok(/function coalesceTurnInputs/.test(messages), "harness/messages.js still exports coalesceTurnInputs");
  const body = /function coalesceTurnInputs\([^)]*\)\{[\s\S]*?\n?\}(?=function )/.exec(messages)?.[0] ?? messages.slice(messages.indexOf("function coalesceTurnInputs"), messages.indexOf("function normalizeUserContent"));
  ok(!/auth/.test(body), "coalesceTurnInputs still merges only inputResponses/message/context/outputSchema — never `auth`");
  const hitlProxy = read("execution/subagent-hitl-proxy.js");
  ok(/payload:\{inputResponses:/.test(hitlProxy), "routeDeliverPayload still routes HITL answers as `inputResponses` payloads");
  ok(!/auth/.test(hitlProxy), "the HITL proxy still never touches `auth` — an answer cannot become an attribute");
}

{
  const authMod = read("runtime/sessions/auth.js");
  ok(/attributes:z\.record\(/.test(authMod), "eve still carries the runtimeSessionAuthContext zod schema (the shape this note is about)");
  ok(/export\{\};?\s*$/.test(authMod.trim()), "the runtime session-auth schema is still DEAD CODE (exports nothing) — eve does not validate/coerce delivered attributes");
}

{
  const tw = read("execution/turn-workflow.js");

  const ownedStart = tw.indexOf("async function runTurnOwnedWorkflow(");
  const waitStart = tw.indexOf("async function waitForRuntimeActionResults(");
  const legacyStart = tw.indexOf("async function runLegacyTurnWorkflow(");
  ok(ownedStart >= 0 && waitStart > ownedStart && legacyStart > waitStart, "turn-workflow.js still declares runTurnOwnedWorkflow → waitForRuntimeActionResults → runLegacyTurnWorkflow");
  const owned = tw.slice(ownedStart, waitStart);
  const waitFn = tw.slice(waitStart, legacyStart);
  const legacy = tw.slice(legacyStart);

  const ownedParam = /^async function runTurnOwnedWorkflow\((\w+)\)/.exec(owned)?.[1];
  ok(ownedParam !== undefined, "runTurnOwnedWorkflow still takes a single named workflow-input parameter");
  const stepVar = /turnStep\(\w+\.createStepInput\((\w+),/.exec(owned)?.[1];
  ok(stepVar !== undefined, "runTurnOwnedWorkflow still drives turnStep via cursor.createStepInput(<stepInput>, …)");

  const assignRe = new RegExp(`(?<![\\w$.])${stepVar as string}=(?!=)`, "g");
  const rhs = [...owned.matchAll(assignRe)].map((m) => owned.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 48));
  ok(rhs.length === 4, `runTurnOwnedWorkflow still assigns its step-input variable exactly 4 times (found ${rhs.length})`);
  const initial = rhs.filter((r) => r.startsWith(`${ownedParam as string}.stepInput.input`));
  ok(initial.length === 1, "exactly ONE assignment carries the workflow input's `deliver` payload (the initial one)");
  ok(rhs[0] === initial[0], "…and it is the FIRST assignment (so only the first turnStep can see a `deliver` input)");
  const carriedOn = rhs.slice(1);
  ok(
    carriedOn.every((r) => /^(?:void 0|\{kind:`runtime-action-result`)/.test(r)),
    `every LATER assignment is either \`void 0\` or a runtime-action-result — never a delivery (saw: ${JSON.stringify(carriedOn.map((r) => r.slice(0, 34)))})`,
  );
  ok(
    new RegExp(`\\.adopt\\(\\w+\\),${stepVar as string}=void 0\\}`).test(owned),
    "the loop bottom still adopts the step result and NULLS the step input (a continued turn re-enters turnStep with no `deliver`)",
  );

  const legacyVar = /turnStep\((\w+)\)/.exec(legacy)?.[1];
  const legacyParam = /^async function runLegacyTurnWorkflow\((\w+)\)/.exec(legacy)?.[1];
  ok(legacyVar !== undefined && legacyParam !== undefined, "runLegacyTurnWorkflow still drives turnStep(<stepInput>) from a named workflow parameter");
  ok(new RegExp(`(?<![\\w$.])${legacyVar as string}=${legacyParam as string}\\.stepInput;`).test(legacy), "runLegacyTurnWorkflow still seeds its step input from the workflow input ONCE");
  const legacyRebuilds = [...legacy.matchAll(new RegExp(`(?<![\\w$.])${legacyVar as string}=\\{input:([^,]*),`, "g"))].map((m) => m[1]);
  ok(legacyRebuilds.length === 1 && legacyRebuilds[0] === "void 0", `runLegacyTurnWorkflow's loop bottom still rebuilds the step input with \`input: void 0\` (saw: ${JSON.stringify(legacyRebuilds)})`);

  const cursor = read("execution/turn-execution-cursor.js");
  ok(/createStepInput\((\w+),\w+\)\{return\{[^}]*input:\1[,}]/.test(cursor), "TurnExecutionCursor.createStepInput still passes its first argument straight through as `input` (no hidden delivery source)");

  ok(/kind===`driver-delivery`/.test(waitFn), "waitForRuntimeActionResults still recognises a `driver-delivery` while a turn is in flight");
  ok(
    /routeDeliverToChildren\(\{(?:auth:\w+\.delivery\.auth|delivery:\w+\.delivery)[,}]/u.test(waitFn),
    "…and routes it to CHILD sessions (their auth, not this turn's)",
  );
  ok(
    /auth:\w+\.auth,childContinuationToken:/u.test(read("execution/proxied-deliver-step.js")),
    "the proxied child delivery still binds the DELIVERY's own auth onto the child's payload",
  );
  ok(
    /\w+\.bufferedDeliveries\.push\((?:\{\.\.\.\w+\.delivery|\w+\.remainder)/u.test(waitFn),
    "…pushing the residue to bufferedDeliveries — never back into the step input",
  );
  ok(
    /async finish\(\w+,\w+,(\w+)\)\{[\s\S]{0,320}?bufferedDeliveries:\1\.length===0\?void 0:\[\.\.\.\1\]/.test(cursor),
    "TurnExecutionCursor.finish still hands bufferedDeliveries back in the `turn-result` (they become the NEXT turn, not this one)",
  );
}

console.log(`✓ auth-attribute-provenance: ${passed} contract assertions passed against eve ${eveVersion}`);
