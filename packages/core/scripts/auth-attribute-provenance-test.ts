import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { filesContainingAll, filesMatching } from "./eve-dist-search.js";

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

const SUBAGENT_TOOL = "subagents/tool.js";
const SUBAGENT_HITL_PROXY = "subagents/hitl-proxy.js";

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
const WORKFLOW_STEP_TWIN = "execution/tools/workflow/step-execution.js";
const TURN_STEP = "execution/session/turn-step.js";
const PROXIED_DELIVER = "execution/proxied-deliver-step.js";
const EXPECTED_WRITERS = new Set(["execution/runtime-context.js", TURN_STEP, PROXIED_DELIVER, WORKFLOW_STEP_TWIN]);
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
        `  the ${EXPECTED_WRITERS.size} writers listed in EXPECTED_WRITERS. Read each new site and confirm it cannot carry\n` +
        `  model-derived data BEFORE widening EXPECTED_WRITERS here. A site that only COPIES the slot needs a\n` +
        `  shape assertion beside the widening, the way §3a pins the workflow-step twin — the widening alone is\n` +
        `  a blanket permission. Then update agent/channels/unified-window.ts §AUTH-ATTRIBUTE PROVENANCE.`,
    );
    process.exit(1);
  }
  passed++;
  for (const w of EXPECTED_WRITERS) ok(found.has(w), `eve still writes the auth slot in ${w} (the site is not gone/renamed)`);
}

{
  const twin = read(WORKFLOW_STEP_TWIN);
  const bound = /let\{args:(\w+),context:(\w+)\}=/.exec(twin);
  ok(bound !== null, `${WORKFLOW_STEP_TWIN} still destructures {args, context} from the step invocation`);
  const argsLocal = bound?.[1] ?? "";
  const contextLocal = bound?.[2] ?? "";
  ok(
    new RegExp(`\\.set\\(AuthKey,${contextLocal}\\.session\\.auth\\.current\\)`).test(twin),
    "the workflow-step twin still writes AuthKey from context.session.auth.current (a copy of the host slot)",
  );
  ok(
    new RegExp(`\\.set\\(InitiatorAuthKey,${contextLocal}\\.session\\.auth\\.initiator\\)`).test(twin),
    "the workflow-step twin still writes InitiatorAuthKey from context.session.auth.initiator",
  );
  ok(
    !new RegExp(`\\.set\\(\\s*(?:Initiator)?AuthKey,[^)]*\\b${argsLocal}\\b`).test(twin),
    "the workflow-step twin's auth writes never read the model-supplied `args` local",
  );
  const dispatch = read("execution/coordination-dispatch-shared.js");
  ok(
    /auth:\w+\.get\(AuthKey\)\?\?null/.test(dispatch),
    "the workflow-tool run's `auth` is still a host read of AuthKey (coordination-dispatch-shared.js)",
  );
  ok(
    /initiatorAuth:\w+\.get\(InitiatorAuthKey\)\?\?null/.test(dispatch),
    "the workflow-tool run's `initiatorAuth` is still a host read of InitiatorAuthKey",
  );
  ok(
    /async function startWorkflowToolCallRun\((\w+),\w+\)\{let\{task:(\w+)[^}]*\}=\1;[^;]*?session:\{auth:\1\.auth,/.test(read("execution/tools/workflow/start.js")),
    "startWorkflowToolCallRun still builds the run's session.auth from its caller's OWN `auth` argument, never off the model's task input",
  );
  {
    const step = read("execution/coordination-dispatch-step.js");
    const prepared = /\b(\w+)=await prepareCoordinationDispatch\(/.exec(step);
    ok(prepared !== null, "the coordination step still prepares its dispatch through prepareCoordinationDispatch");
    const dispatchLocal = prepared![1]!;
    ok(
      new RegExp(`dispatchWorkflowCall\\(\\{[^]*?auth:\\{current:${dispatchLocal}\\.auth,initiator:${dispatchLocal}\\.initiatorAuth\\}`).test(step),
      "🔴 the workflow task's auth pair is read off THE OBJECT prepareCoordinationDispatch returned — the named local, not merely one identifier used twice",
    );
    ok(
      /async function dispatchWorkflowCall\((\w+)\)\{[^]*?case`execute`:return await startWorkflowTask\(\1\);case`task`:case`serve`:return await startTaskRun\(\{\.\.\.\1,/.test(step),
      "…and dispatchWorkflowCall hands that SAME argument object on to both start paths",
    );

    const shared = read("execution/coordination-dispatch-shared.js");
    const inner = /\b(\w+)=await prepareActionDispatch\(\{/.exec(shared);
    ok(inner !== null, "prepareCoordinationDispatch still delegates to prepareActionDispatch");
    const innerLocal = inner![1]!;
    ok(
      new RegExp(`return\\{\\.\\.\\.${innerLocal}[,}]`).test(shared),
      "🔴 …and prepareCoordinationDispatch RETURNS that object by spread — `auth` reaches the step verbatim, never re-sourced in between",
    );

    ok(
      /async function prepareActionDispatch\(\w+\)\{(?:(?!function )[\s\S]){0,2000}?auth:\w+\.get\(AuthKey\)\?\?null/.test(shared),
      "🔴 …and the object originates in prepareActionDispatch, whose own body is where the AuthKey read happens",
    );
  }
  ok(
    /session:\w+\.session/.test(read("execution/tools/workflow/body.js")),
    "createWorkflowBodyContext still takes ctx.session from the RUN INPUT (the model's own half is ctx.input), so the twin copies THAT bag",
  );
  ok(
    /Symbol\.for\(`eve\.workflow-tool-run\.context`\)/.test(read("execution/tools/workflow/ask.js")),
    "the workflow-tool run context is still branded with a symbol (unreachable from JSON tool input)",
  );
}

{
  const proxied = read(PROXIED_DELIVER);
  const fn = /async function deliverChannelInputResponses\((\w+)\)\{(?:(?!function )[\s\S])*/.exec(proxied);
  ok(fn !== null, `${PROXIED_DELIVER} still declares deliverChannelInputResponses`);
  const body = fn?.[0] ?? "";
  const param = fn?.[1] ?? "";
  const write = new RegExp(
    `let (\\w+)=await deserializeContext\\(${param}\\.serializedContext\\),\\w+=\\1\\.require\\(ChannelKey\\);if\\(\\w+\\.deliver===void 0\\)return ${param};${param}\\.delivery\\.auth!==void 0&&\\1\\.set\\(AuthKey,${param}\\.delivery\\.auth\\?\\?null\\)`,
  ).exec(body);
  ok(write !== null, "🔴 the proxied write takes the DELIVERY's own auth, guarded on presence, into a context it just deserialized");
  const scratch = write?.[1] ?? "";
  ok(
    !new RegExp(`serializeContext\\(${scratch}\\)`).test(body),
    "🔴 …and that context is NEVER serialized back — the write lives only as long as one channel `deliver` call",
  );
  ok(
    new RegExp(`let (\\w+)=await deserializeContext\\(${param}\\.serializedContext\\);return setChannelContext\\(\\1,[^;]*serializedContext:serializeContext\\(\\1\\)`).test(body),
    "…the context it DOES hand back is a second, fresh deserialize that carries only the channel state",
  );
  ok((body.match(WRITE_RE) ?? []).length === 1 && (proxied.match(WRITE_RE) ?? []).length === 1, `${PROXIED_DELIVER} holds exactly ONE auth-slot write`);
}

{
  const step = read(TURN_STEP);
  ok((step.match(WRITE_RE) ?? []).length === 4, `${TURN_STEP} holds exactly FOUR auth-slot writes (saw ${(step.match(WRITE_RE) ?? []).length})`);
  const bound = /let (\w+)=(\w+)\.input\?\.delivery,(\w+)=\1,/.exec(step);
  ok(bound !== null, "runSessionStep binds its delivery from the step input, and aliases it");
  const d = bound?.[3] ?? "";
  const prior = new RegExp(`let (\\w+)=(\\w+)\\.get\\(AuthKey\\);${d}\\?\\.auth!==void 0&&\\(\\2\\.set\\(AuthKey,${d}\\.auth\\?\\?null\\),\\2\\.has\\(InitiatorAuthKey\\)\\|\\|\\2\\.set\\(InitiatorAuthKey,${d}\\.auth\\?\\?null\\)\\)`).exec(step);
  ok(prior !== null, "🔴 (1)+(2) the slot takes the DELIVERY's auth only when the delivery supplies one, and the initiator slot only when it is empty");
  const span = step.slice((bound?.index ?? 0) + (bound?.[0].length ?? 0), prior?.index ?? 0);
  const reassigned = [...span.matchAll(new RegExp(`(?<![\\w$.])${d}=(?!=)([^;)]{0,24})`, "gu"))].map((m) => m[1]);
  ok(
    reassigned.length === 2 && reassigned[0]?.startsWith(`{...${d},payloads:`) === true && reassigned[1] === "void 0",
    `🔴 before the write the delivery local is reassigned only to the same delivery with its sign-in payloads removed, or to void 0 (saw ${JSON.stringify(reassigned)})`,
  );
  ok(
    !new RegExp(`(?:let|const|var)\\s+${d}\\b|(?:let|const|var)\\s*\\{[^}]*(?<![\\w$])${d}(?![\\w$])[^}]*\\}=`).test(span),
    "…and no nested declaration shadows it in that span",
  );
  const saved = prior?.[1] ?? "";
  const ctx = prior?.[2] ?? "";
  const matches = new RegExp(`let\\{matches:(\\w+),remainingPayloads:\\w+\\}=matchAuthorizationCallbacks\\((\\w+),${d}\\.payloads\\)`).exec(step);
  ok(matches !== null, "the sign-in matches come from matchAuthorizationCallbacks over the step's own delivery payloads");
  ok(new RegExp(`let ${matches?.[2] ?? "\\0"}=getPendingAuthorization\\(\\w+\\.state\\)`).test(step), "…against the PENDING authorization in durable session state (an `eve.`-reserved key, §5)");
  const kept = new RegExp(`(\\w+)=${matches?.[1] ?? "\\0"},`).exec(step)?.[1] ?? "";
  ok(
    new RegExp(`let (\\w+)=${d}===void 0\\?${kept}\\?\\.find\\(\\(\\{challenge:(\\w+)\\}\\)=>\\2\\.candidateId===void 0\\)\\?\\.challenge\\.requester:void 0;\\1!==void 0&&${ctx}\\.set\\(AuthKey,\\1\\)`).test(step),
    "🔴 (3) a sign-in-only step restores the challenge's `requester` — nothing else — and only when no delivery is left",
  );
  ok(
    new RegExp(`${saved}===void 0\\?${ctx}\\.delete\\(AuthKey\\):${ctx}\\.set\\(AuthKey,${saved}\\)`).test(step),
    "🔴 (4) the last write is a RESTORE of the value read before (1) — a mid-turn delivery that yields no turn input leaves the slot as it was",
  );
}

{
  const callers = filesMatching(/requestAuthorization\(\[/u);
  ok(
    callers.length === 1 && callers[0] === "runtime/connections/scoped-authorization.js",
    `requestAuthorization has ONE caller in the whole dist, the scoped authorization (saw ${JSON.stringify(callers)})`,
  );
  const scoped = read("runtime/connections/scoped-authorization.js");
  const req = /(\w+)=\w+\.boundResponder\?\?contextStorage\.getStore\(\)\?\.get\(AuthKey\)\?\?void 0/.exec(scoped);
  ok(req !== null && new RegExp(`requester:${req[1]}[,}]`).test(scoped), "🔴 `requester` is the bound responder, else a host read of AuthKey — never a tool argument");
  const responderSites = filesMatching(/boundResponder:/u);
  ok(
    JSON.stringify([...responderSites].sort()) === JSON.stringify(["execution/tool-auth.js", "runtime/authorization-context.js"]),
    `a bound responder is set in exactly two modules (saw ${JSON.stringify(responderSites)})`,
  );
  ok(/boundResponder:(\w+)\.boundResponder[,}]/.test(read("runtime/authorization-context.js")), "…runtime/authorization-context.js only forwards one it was given");
  ok(/createAuthorizationContext\(\{scope:(\w+)\.scope,boundResponder:\1\.responder\}\)/.test(read("execution/tool-auth.js")), "…execution/tool-auth.js binds the approval RESPONDER");
  const coordinator = read("harness/approval-delivery-coordinator.js");
  ok(
    /let (\w+)=(\w+)===void 0\?buildCallbackContext\(\)\.session\.auth\.current:\2;if\(\1===null\)/.test(coordinator),
    "🔴 …and the responder is the response's attributed auth, else the session's own slot",
  );
  const PAIR = /(?<!(?:let|const|var)\s*)\{auth:([^,{}]+),response:/gu;
  const attributed = filesMatching(PAIR).flatMap((rel) => [...read(rel).matchAll(PAIR)].map((m) => `${rel}: ${m[1]}`));
  ok(
    [..."for(let{auth:e,response:n}of C)x={auth:void 0,response:r}".matchAll(PAIR)].length === 1,
    "control: the pair matcher counts a built literal and skips a binding pattern",
  );
  ok(attributed.length > 0, "control: the dist does build `{auth, response}` pairs, so the absence below is not a blind matcher");
  ok(
    attributed.every((a) => a.endsWith(": void 0")),
    `🔴 no module builds an attributed input response with an auth of its own (saw ${JSON.stringify(attributed)})`,
  );
}

{
  ok(
    /resumeAuthorizationCallback\(\w+,\{kind:`authorization-callback`,payloads:\[\{authorizationCallback:/.test(read("execution/connections/callback-route.js")),
    "the connection authorization callback still resumes with NO `auth` field (auth-preserving resume)",
  );
  ok(
    /if\((\w+)\.kind===`authorization-callback`\)return \w+\.queue\.enqueueAuthorization\(\1\.payloads\)/.test(read("execution/session/admission.js")),
    "…the session admits it as its PAYLOADS only — an auth field on the callback could not reach the queue",
  );
  ok(
    /\.takeAuthorizations\(\w+\);if\(\w+!==void 0\)return\{kind:`deliver`,payloads:\w+\}/.test(read("execution/session/turn.js")),
    "…and the held turn re-delivers those payloads in a delivery that carries NO auth key",
  );
}

{
  const state = read("public/definitions/state.js");
  ok(
    /RESERVED_STATE_NAME_PREFIX=`eve\.`/.test(state) || /RESERVED_STATE_NAME_PREFIXES=\[[^\]]*`eve\.`[^\]]*\]/.test(state),
    "defineState still reserves the `eve.` prefix",
  );
  ok(
    /startsWith\(RESERVED_STATE_NAME_PREFIX\)\)throw Error/.test(state) ||
      /let (\w+)=RESERVED_STATE_NAME_PREFIXES\.find\(\w+=>(\w+)\.startsWith\(\w+\)\);if\(\1!==void 0\)throw Error/.test(state),
    "defineState still THROWS on a reserved-prefix name (cannot alias eve.auth)",
  );
}

{
  const authSites = filesContainingAll("deserializeContext(", "serializedContext", "get(AuthKey)??null");
  ok(
    authSites.length > 0,
    "subagent dispatch still takes the child's auth from the PARENT's deserialized context — no module of the installed eve pairs `deserializeContext` with a `get(AuthKey)??null` read any more",
  );
  const sub = read(SUBAGENT_TOOL);
  const subInput = /function buildSubagentRunInput\((\w+)\)\{let\{([^}]*)\}=\1,/.exec(sub);
  ok(subInput !== null, "buildSubagentRunInput still destructures its single parameter object");
  const subKeys = new Set((subInput?.[2] ?? "").split(",").map((p) => (p.split(":")[0] ?? "").trim()));
  ok(subKeys.has("auth"), "buildSubagentRunInput still takes `auth` as a caller argument, not off the action");
  ok(subKeys.has("initiatorAuth"), "buildSubagentRunInput still takes `initiatorAuth` as a caller argument too");
  ok(subKeys.has("action"), "buildSubagentRunInput still takes the model's action SEPARATELY from those two");
  ok(!/\w+\.input\.auth/.test(sub), "buildSubagentRunInput still never reads `auth` off the model's action input");
}

{
  const messages = read("harness/messages.js");
  ok(/function coalesceTurnInputs/.test(messages), "harness/messages.js still exports coalesceTurnInputs");
  const body = /function coalesceTurnInputs\([^)]*\)\{[\s\S]*?\n?\}(?=function )/.exec(messages)?.[0] ?? messages.slice(messages.indexOf("function coalesceTurnInputs"), messages.indexOf("function normalizeUserContent"));
  ok(!/auth/.test(body), "coalesceTurnInputs still merges only inputResponses/message/context/outputSchema — never `auth`");
  const hitlProxy = read(SUBAGENT_HITL_PROXY);
  ok(/payload:\{inputResponses:/.test(hitlProxy), "routeDeliverPayload still routes HITL answers as `inputResponses` payloads");
  const AUTH_KEY_RE = /(?<![\w$])auth(?![\w$])|AuthKey/u;
  ok(
    AUTH_KEY_RE.test("x.auth") && AUTH_KEY_RE.test("{auth:e}") && AUTH_KEY_RE.test("c.set(AuthKey,v)") && !AUTH_KEY_RE.test("emitProxiedAuthorizationEvent"),
    "control: the key matcher sees `.auth`, `auth:` and AuthKey, and skips a name that only contains the word",
  );
  ok(!AUTH_KEY_RE.test(hitlProxy), "the HITL proxy still never touches `auth` — an answer cannot become an attribute");
}

{
  const authMod = read("shared/session-auth.js");
  ok(/attributes:z\.record\(/.test(authMod), "eve still carries the runtimeSessionAuthContext zod schema (the shape this note is about)");
  ok(/export\{\};?\s*$/.test(authMod.trim()), "the runtime session-auth schema is still DEAD CODE (exports nothing) — eve does not validate/coerce delivered attributes");
}

{
  const turnJs = read("execution/session/turn.js");

  const callers = filesMatching(/(?<!function )turnStep\(\{/u);
  ok(
    callers.length === 1 && callers[0] === "execution/session/turn.js",
    `turnStep has ONE call site in eve's whole dist, the session loop (saw ${JSON.stringify(callers)})`,
  );
  const loop = /async runTurnSteps\((\w+),(\w+)\)\{let (\w+)=\2,/.exec(turnJs);
  ok(loop !== null, "runTurnSteps seeds its step input from its second parameter — the turn's own delivery");
  const turnVar = loop?.[1] ?? "";
  const inputVar = loop?.[3] ?? "";
  ok(
    new RegExp(`turnStep\\(\\{[^}]*input:${inputVar}[,}]`).test(turnJs),
    "…and the ONE turnStep call passes that variable as its input",
  );
  ok(
    /async runTurn\((\w+),\w+=\{\}\)\{[^]*?this\.runTurnSteps\(\w+,\1\)/.test(turnJs),
    "① runTurn hands runTurnSteps the delivery the turn was started with",
  );

  const body = turnJs.slice(loop?.index ?? 0, turnJs.indexOf("async dispatchRuns("));
  const assigns = [...body.matchAll(new RegExp(`(?<![\\w$.])${inputVar}=(?!=)`, "gu"))].map((m) => body.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 60));
  ok(assigns.length === 5, `runTurnSteps assigns its step input exactly five times — the seed and four re-entries (saw ${assigns.length})`);
  ok(assigns[0]?.startsWith(`${loop?.[2] ?? ""},`) === true, "…the first is the seed from the turn's delivery");
  const later = assigns.slice(1);
  const heldVar = new RegExp(`let (\\w+)=await this\\.waitForHeldRequest\\(${turnVar},\\w+\\);if\\(\\1===\`cancelled\`\\)return await this\\.finishCancelledTurn\\(${turnVar}\\);${inputVar}=\\{delivery:\\1\\};continue`).exec(body);
  ok(heldVar !== null, "② a held request re-enters with the delivery waitForHeldRequest returned — and nothing else");
  const steered = [...body.matchAll(new RegExp(`let (\\w+)=await ${turnVar}\\.takeSteering\\(\\);${inputVar}=\\1===void 0\\?void 0:\\{delivery:\\1\\}`, "gu"))];
  ok(steered.length === 2, `③ two re-entries take a delivery ONLY from takeSteering() with no options (saw ${steered.length})`);
  ok(
    new RegExp(`${inputVar}=\\{delivery:await ${turnVar}\\.takeSteering\\(\\),runtimeResults:`).test(body),
    "③ a coordination park re-enters with runtime results plus whatever takeSteering() admits",
  );
  const direct = later.filter((r) => r.startsWith("{delivery:")).length;
  const optional = later.filter((r) => /^\w+===void 0\?void 0:\{delivery:\w+\}/u.test(r)).length;
  ok(
    direct === 2 && optional === 2,
    `every re-entry carries a delivery only through one of those three sources (saw ${JSON.stringify(later.map((r) => r.slice(0, 40)))})`,
  );

  const queue = read("execution/session/input-queue.js");
  ok(
    /takeSteering\((\w+),(\w+),(\w+)\)\{let \w+=this\.entries\.filter\((\w+)=>\4\.kind===`delivery`&&\1\.has\(\4\.sequence\)&&isSteeringDelivery\(\4\.delivery,\2,\3\)\)/.test(queue),
    "the queue admits a steering delivery only through isSteeringDelivery",
  );
  ok(
    /function isSteeringDelivery\((\w+),(\w+),(\w+)\)\{return\(\3\?\.heldOnPerson===!0\|\|\(\1\.turnPolicy\?\?`steer`\)===`steer`\)&&\(\1\.caller===void 0\|\|\1\.caller\.callId===\2\.callerCallId\)&&\(\1\.auth===void 0\|\|principalOf\(\1\.auth\)===\2\.principal\)\}/.test(queue),
    "🔴 …which needs (held on a person OR a `steer` policy) AND the same caller AND the same principal",
  );
  ok(
    /async takeSteering\((\w+)\)\{[^]*?this\.input\.queue\.takeSteering\(this\.admitted,this\.identity,\1\)/.test(read("execution/session/active-turn.js")),
    "…and the active turn passes its own identity and the caller's options straight through",
  );

  ok(
    (turnJs.match(/heldOnPerson:!0/gu) ?? []).length === 1 &&
      /async waitForHeldRequest\((\w+),\w+\)\{[^]*?\1\.takeSteering\(\{heldOnPerson:!0\}\)/.test(turnJs),
    "② only waitForHeldRequest bypasses the steering policy, and only for a same-principal delivery",
  );
  ok(
    /async waitForHeldRequest\((\w+),\w+\)\{[^]*?let (\w+)=this\.input\.queue\.takeAuthorizations\(\w+\);if\(\2!==void 0\)return\{kind:`deliver`,payloads:\2\};let (\w+)=await \1\.takeInputResponses\(\w+\);if\(\3!==void 0\)return \3;/.test(turnJs),
    "② …and its other two returns are a sign-in delivery with NO auth key, and the delivery that answers the held request",
  );
  const takeInput = /async takeInputResponses\(\w+\)\{(?:(?!async )[\s\S])*/.exec(read("execution/session/active-turn.js"))?.[0] ?? "";
  ok(takeInput.length > 0 && !/principal/u.test(takeInput), "② the held request's answer is selected by request id with NO principal check — its auth reaches §3c(1) as delivered");

  const unifiedSrc = readFileSync(new URL("../agent/channels/unified.ts", import.meta.url), "utf8");
  ok(
    /\bturnPolicy:\s*"queue"/u.test(unifiedSrc),
    "🔴 OE's unified channel declares `turnPolicy: \"queue\"` — so ③ admits no MESSAGE delivery on an OE seat",
  );
  ok(
    /turnPolicy:(\w+)\.message===void 0\?void 0:/u.test(read("channel/channel-address.js")),
    "🔴 eve stamps NO turnPolicy on a delivery without a message — an input response — so isSteeringDelivery reads it as `steer`",
  );
  ok(!/ownerToken/u.test(unifiedSrc), "OE's answer road has no work-session owner arm (D21 retired by OPE-2340)");
  const respondCall = /\.respond\(\[[^]{0,400}?\],\s*\{([^]{0,4000}?)\}\s*as\s*\{/u.exec(unifiedSrc)?.[1];
  ok(respondCall !== undefined, "OE's answer road is found: one `.respond([…], {…})` call");
  ok(
    respondCall !== undefined && !/\bauth\b/u.test(respondCall.replace(/\/\/.*$/gmu, "")),
    "🔴 …and it carries NO `auth` key on either road, in any form (key, shorthand or name), so another member's answer never replaces the turn's bag (OPE-2336)",
  );
  const spreads = [...(respondCall ?? "").replace(/\/\/.*$/gmu, "").matchAll(/\.\.\.\s*\(?\s*([^\n]*)/gu)].map((m) => m[1] ?? "");
  ok(
    respondCall !== undefined && spreads.every((x) => x.startsWith("t.context")),
    `…and its only spread is the \`t.context\` side channel, so no spread can bring an \`auth\` key back (saw ${JSON.stringify(spreads)})`,
  );

  const active = read("execution/session/active-turn.js");
  ok(
    /let (\w+)=await this\.input\.cursor\.advance\(\w+=>routeDeliverToChildren\(\{delivery:\w+,\.\.\.\w+\}\)\);[^]*?this\.input\.queue\.replaceDelivery\(\w+,\1\.remainder\)/.test(active),
    "a mid-turn arrival is routed to CHILD sessions first, and its residue goes BACK INTO THE QUEUE — never into the running step",
  );
  ok(
    /takeNext\(\w+\)\{/.test(queue),
    "…where takeNext picks it up as the NEXT turn's delivery",
  );
  const proxied = read(PROXIED_DELIVER);
  const routed = /\{delivery:(\w+),serializedContext:\w+\}=await deliverChannelInputResponses\(/.exec(proxied)?.[1] ?? "";
  ok(
    routed !== "" && new RegExp(`let \\w+=\\{\\.\\.\\.${routed},deliveryMetadata:`).test(proxied) && new RegExp(`auth:${routed}\\.auth,responses:`).test(proxied),
    "the proxied child delivery still carries the DELIVERY's own auth — spread whole to a local child, named to a remote one",
  );
}

console.log(`✓ auth-attribute-provenance: ${passed} contract assertions passed against eve ${eveVersion}`);
