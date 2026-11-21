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

// Minified eve reuses short local names inside arrow callbacks. An arrow body that declares its own
// `name` is a separate scope, so it is blanked (same length) before the outer local is tracked.
// Returns the blanked text and how many arrow bodies it blanked.
function blankShadowingArrows(text: string, name: string): { text: string; blanked: number } {
  const shadowing: Array<[number, number]> = [];
  for (const m of text.matchAll(/=>\{/gu)) {
    const open = (m.index ?? 0) + 2;
    let depth = 0;
    let close = -1;
    for (let k = open; k < text.length; k++) {
      if (text[k] === "{") depth++;
      else if (text[k] === "}" && --depth === 0) {
        close = k;
        break;
      }
    }
    if (close <= open) continue;
    // Test the declaration at the arrow body's OWN depth only: a nested block's `let` is not this
    // arrow's binding, so it must not blank this arrow's outer-scope code.
    let own = "";
    let nest = 0;
    for (let k = open + 1; k < close; k++) {
      if (text[k] === "{") nest++;
      else if (text[k] === "}") nest--;
      else if (nest === 0) own += text[k];
    }
    if (new RegExp(`(?:let|const|var)\\s+${name}=`).test(own)) shadowing.push([open, close]);
  }
  const outer = shadowing.filter(([a, b]) => !shadowing.some(([c, d]) => c < a && b < d));
  return { text: outer.reduceRight((acc, [a, b]) => acc.slice(0, a) + " ".repeat(b - a + 1) + acc.slice(b + 1), text), blanked: outer.length };
}
{
  const probe = blankShadowingArrows("let n=t;x(t=>{let n=1;n=2});n=3", "n");
  ok(probe.blanked === 1 && [...probe.text.matchAll(/(?<![\w$.])n=/gu)].length === 2, "control: the shadow blanker hides an arrow body that declares the name, and keeps the outer writes");
  ok(blankShadowingArrows("let n=t;x(t=>{n=2})", "n").blanked === 0, "control: …and keeps an arrow body that only WRITES the outer name");
  const nested = blankShadowingArrows("let n=t;x(()=>{n=1;y(t=>{let n=2})})", "n");
  ok(
    nested.blanked === 1 && [...nested.text.matchAll(/(?<![\w$.])n=/gu)].length === 2,
    "control: …and blanks only the INNERMOST arrow that declares the name, keeping an outer arrow's write to the outer name",
  );
}

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
  ok(
    /session:\{auth:\{current:\w+\.get\(AuthKey\)\?\?null,initiator:\w+\.get\(InitiatorAuthKey\)\?\?null\}/.test(read("definitions/frame.js")),
    "definitions/frame.js still projects a dynamic's session.auth from the container (the frame every defineDynamic() reads)",
  );
}

const WRITE_RE = /\.set\(\s*(?:Initiator)?AuthKey\b/g;
const WORKFLOW_STEP_TWIN = "execution/tools/workflow/step-execution.js";
const TURN_STEP = "execution/session/turn-step.js";
const PROXIED_DELIVER = "execution/proxied-deliver-step.js";
const SCHEDULE_COLLECTION = "channel/schedule.js";
const INVOKE_TOOL = "execution/invoke-tool.js";
const EVENT_DISPATCH = "runtime/connections/events/dispatch-step.js";
const EVENT_OWNER = "runtime/connections/events/owner.js";
const CANCELLED_BATCH = "execution/cancelled-model-call-batch.js";
const EXPECTED_WRITERS = new Set([
  "execution/runtime-context.js",
  TURN_STEP,
  PROXIED_DELIVER,
  WORKFLOW_STEP_TWIN,
  SCHEDULE_COLLECTION,
  INVOKE_TOOL,
  EVENT_DISPATCH,
  EVENT_OWNER,
  CANCELLED_BATCH,
]);
const ANY_WRITE_RE = /\.(?:set|setVirtualContext)\(\s*(?:Initiator)?AuthKey\b|[{,]\s*\[(?:Initiator)?AuthKey\.name\]\s*:|[\w$)\]]\[(?:Initiator)?AuthKey\.name\]\s*=(?!=)/;
{
  ok(
    ANY_WRITE_RE.test("t.setVirtualContext(AuthKey,i.auth)") &&
      ANY_WRITE_RE.test("r={...a,[AuthKey.name]:t[AuthKey.name]}") &&
      ANY_WRITE_RE.test("o.set(AuthKey,a)") &&
      ANY_WRITE_RE.test("n[AuthKey.name]=continueTurnAuth(e[AuthKey.name],t.auth)"),
    "control: the census matcher sees a `.set(`, a `.setVirtualContext(`, a serialized `[AuthKey.name]:` write and a member `x[AuthKey.name]=` write (eve 1.x joinAnswerToTurn)",
  );
  ok(
    !ANY_WRITE_RE.test("principalOf(n===void 0?t[AuthKey.name]:n)") && !ANY_WRITE_RE.test("e.get(AuthKey)") && !ANY_WRITE_RE.test("t[AuthKey.name]===n"),
    "control: the census matcher skips a `?:` read, a `.get(` read and a `===` comparison",
  );
}
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
      if (ANY_WRITE_RE.test(readFileSync(abs, "utf8"))) found.add(relative(distSrc, abs).replaceAll("\\", "/"));
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
        `  a blanket permission. Pin the new writer in scripts/eve-auth-writers-test.ts, and add its row to\n` +
        `  EVE_AUTH_WRITERS (scripts/eve-auth-paths-lint.ts at the repository root).`,
    );
    process.exit(1);
  }
  passed++;
  for (const w of EXPECTED_WRITERS) ok(found.has(w), `eve still writes the auth slot in ${w} (the site is not gone/renamed)`);
}

{
  // The session-creation writer: a new session's context takes the RUN input's auth, verbatim, and
  // its initiator only from the run input (or that same auth).
  const rc = read("execution/runtime-context.js");
  const build = /function buildRunContext\((\w+)\)\{let\{agent:\w+,run:(\w+)\}=\1;let (\w+)=new ContextContainer;let (\w+)=\2\.auth;/.exec(rc);
  ok(build !== null, "buildRunContext takes the new session's auth from the run input's `auth`");
  const [, , run, box, auth] = build ?? ["", "\\0", "\\0", "\\0", "\\0"];
  ok(
    new RegExp(`${box}\\.set\\(AuthKey,${auth}\\),`).test(rc) &&
      new RegExp(`\\(${run}\\.initiatorAuth!==void 0\\|\\|${run}\\.input\\.message!==void 0\\)&&${box}\\.set\\(InitiatorAuthKey,${run}\\.initiatorAuth\\?\\?${auth}\\)`).test(rc),
    "🔴 …writes that value to the slot, and the initiator slot only from the run input's initiatorAuth (else that same auth)",
  );
  ok((rc.match(WRITE_RE) ?? []).length === 2, `execution/runtime-context.js holds exactly TWO \`.set(\` auth-slot writes (saw ${(rc.match(WRITE_RE) ?? []).length})`);
  const fnBody = rc.slice(build?.index ?? 0, rc.indexOf("function ", (build?.index ?? 0) + 9));
  ok(
    (fnBody.match(new RegExp(`(?<![\\w$.])${auth}=(?!=)`, "gu")) ?? []).length === 1,
    "…and the auth local is never reassigned between the read and the write",
  );
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
  const startJs = read("execution/tools/workflow/start.js");
  ok(
    /async function startWorkflowToolCallRun\((\w+),\w+\)\{(?:let\{prestarted:(\w+)\}=\1;if\(\2!==void 0\)\{[^{}]*\{[^{}]*\}[^{}]*return await \2\.run\})?let\{task:(\w+)[^}]*\}=\1;[^;]*?session:\{auth:\1\.auth,/.test(startJs),
    "startWorkflowToolCallRun still builds the run's session.auth from its caller's OWN `auth` argument, never off the model's task input",
  );
  ok(
    !/prestarted/.test(startJs) ||
      /function withPrestartedRuns\(\w+,\w+,\w+\)\{[^]*?\.map\(\((\w+),\w+\)=>\{[^}]*let (\w+)=startWorkflowToolCallRun\(\1,\w+\);return \2\.catch\(\(\)=>\{\}\),\{\.\.\.\1,prestarted:\{entry:\w+,run:\2\}/.test(read("execution/coordination-dispatch-step.js")),
    "…and a PRESTARTED run (eve 1.x) is that same function on the same dispatch object, so it carries the same `auth`",
  );
  {
    const step = read("execution/coordination-dispatch-step.js");
    const prepared = /\b(\w+)=await prepareCoordinationDispatch\(/.exec(step);
    ok(prepared !== null, "the coordination step still prepares its dispatch through prepareCoordinationDispatch");
    const dispatchLocal = prepared![1]!;
    ok(
      new RegExp(`dispatchWorkflowCall\\(\\{[^]*?auth:\\{current:${dispatchLocal}\\.auth,initiator:${dispatchLocal}\\.initiatorAuth\\}`).test(step) ||
        new RegExp(
          `let (\\w+)=withPrestartedRuns\\(\\w+\\.map\\((?!${dispatchLocal}=>)\\w+=>\\(\\{[^]*?auth:\\{current:${dispatchLocal}\\.auth,initiator:${dispatchLocal}\\.initiatorAuth\\}[^;]*;for\\(let (\\w+) of \\1\\)\\{[^]*?dispatchWorkflowCall\\(\\{\\.\\.\\.\\2,session:\\w+\\}`,
        ).test(step),
      "🔴 the workflow task's auth pair is read off THE OBJECT prepareCoordinationDispatch returned — the named local, not merely one identifier used twice (eve 1.x builds it in the map that withPrestartedRuns takes, and each dispatch spreads that entry)",
    );
    ok(
      /async function dispatchWorkflowCall\((\w+)(?:,\w+)?\)\{[^]*?case`execute`:return await startWorkflowTask\(\1\);case`task`:case`serve`:return await startTaskRun\(\{\.\.\.\1,/.test(step) &&
        (!/case`receive`/.test(step) || /async function dispatchWorkflowCall\((\w+),\w+\)\{[^]*?case`receive`:return await sendToTask\(\{\.\.\.\1,taskId:\w+\.taskId\},\w+\)\}\}/.test(step)),
      "…and dispatchWorkflowCall hands that SAME argument object on to both start paths",
    );

    const shared = read("execution/coordination-dispatch-shared.js");
    const inner = /\b(\w+)=await prepareActionDispatch\(\{/.exec(shared);
    const inline = /async function prepareCoordinationDispatch\(\w+\)\{[^]*?return\{\.\.\.await prepareActionDispatch\(\{[^]*?\}\),sessionState:\w+\.sessionState\}\}/.exec(shared);
    ok(inner !== null || inline !== null, "prepareCoordinationDispatch still delegates to prepareActionDispatch");
    ok(
      inline !== null || new RegExp(`return\\{\\.\\.\\.${inner?.[1] ?? "\\0"}[,}]`).test(shared),
      "🔴 …and prepareCoordinationDispatch RETURNS that object by spread — `auth` reaches the step verbatim, never re-sourced in between (eve 1.x spreads it inline and adds only `sessionState`)",
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
  // The proxied answers writer (eve 1.0.2). Two writes live in this module, and the census
  // sees both. (a) deliverChannelAnswers writes the delivery's auth into a SCRATCH context that only
  // the channel's `deliver` reads. (b) joinAnswerToTurn writes the PARENT's serialized context, and
  // only through continueTurnAuth, so it can never name another principal.
  const proxied = read(PROXIED_DELIVER);
  const fn = /async function deliverChannelAnswers\((\w+)\)\{(?:(?!function )[\s\S])*/.exec(proxied);
  ok(fn !== null, `${PROXIED_DELIVER} still declares deliverChannelAnswers`);
  const body = fn?.[0] ?? "";
  const param = fn?.[1] ?? "";
  const write = new RegExp(
    `let (\\w+)=await deserializeContext\\(${param}\\.serializedContext\\);let \\w+=\\1\\.require\\(ChannelKey\\);if\\(\\w+\\.deliver===void 0\\)return ${param};${param}\\.delivery\\.auth!==void 0&&\\1\\.set\\(AuthKey,${param}\\.delivery\\.auth\\?\\?null\\)`,
  ).exec(body);
  ok(write !== null, "🔴 (a) the proxied write takes the DELIVERY's own auth, guarded on presence, into a context it just deserialized");
  const scratch = write?.[1] ?? "";
  ok(
    new RegExp(`buildAdapterContext\\(\\{[^}]*\\},${scratch}\\)`).test(body) && !new RegExp(`serializeContext\\(${scratch}\\)`).test(body),
    "🔴 (a) …that context reaches only the channel's adapter context, and is NEVER serialized back — the write lives only as long as one channel `deliver` call",
  );
  ok(
    new RegExp(`let (\\w+)=await deserializeContext\\(${param}\\.serializedContext\\);return setChannelContext\\(\\1,[^;]*serializedContext:serializeContext\\(\\1\\)`).test(body),
    "(a) …the context it DOES hand back is a second, fresh deserialize that carries only the channel state",
  );
  ok((body.match(WRITE_RE) ?? []).length === 1 && (proxied.match(WRITE_RE) ?? []).length === 1, `${PROXIED_DELIVER} holds exactly ONE \`.set(\` auth-slot write`);

  const join = /function joinAnswerToTurn\((\w+),(\w+)\)\{let (\w+)=\{\.\.\.\1\};if\(\2\.auth!==void 0&&\(\3\[AuthKey\.name\]=continueTurnAuth\(\1\[AuthKey\.name\],\2\.auth\)\),/.exec(proxied);
  ok(join !== null, "🔴 (b) joinAnswerToTurn writes the turn's serialized slot ONLY as continueTurnAuth(the slot it holds, the delivery's auth) — the same principal or a throw");
  ok(
    (proxied.match(/\[AuthKey\.name\]\s*=(?!=)/gu) ?? []).length === 1 && ANY_WRITE_RE.test(join?.[0] ?? ""),
    `(b) …it is the module's ONE member write, and the census matcher sees it`,
  );
  const joined = /serializedContext:joinAnswerToTurn\((\w+),\{auth:(\w+)\?(\w+)\.auth:void 0,deliveryIds:\w+\}\)/.exec(proxied);
  ok(joined !== null, "(b) its one caller passes the routed delivery's auth only when a flag is set");
  const flag = joined?.[2] ?? "\\0";
  const routed = joined?.[3] ?? "\\0";
  ok(
    new RegExp(`\\{delivery:${routed},serializedContext:${joined?.[1] ?? "\\0"}\\}=await deliverChannelAnswers\\(`).test(proxied),
    "(b) …and that delivery and context are the ones deliverChannelAnswers returned",
  );
  ok(
    (proxied.match(new RegExp(`(?<![\\w$.])${flag}=(?!=)`, "gu")) ?? []).length === 2 &&
      new RegExp(`let ${flag}=!1;`).test(proxied) &&
      new RegExp(`let (\\w+)=\\w+\\.forChildren\\.find\\(\\w+=>\\w+\\.message!==void 0\\);let (\\w+)=[^;]*askedTurn\\(\\w+\\)!==void 0\\);let (\\w+)=\\2===void 0\\?void 0:askedTurn\\(\\2\\);\\1!==void 0&&\\3!==void 0&&\\(${flag}=!0\\)`).test(proxied),
    "🔴 (b) the flag is set ONLY when a MESSAGE routed to a child answers a question that a running or waiting turn asked",
  );
  ok(
    /let (\w+)=!hasDelegatedSessionContext\(\w+\)&&!\(\w+\.deliveryMetadata\?\?\[\]\)\.some\(\w+=>\w+\.hook!==void 0\)&&isSteeringDelivery\(\w+,\{callerCallId:void 0,principal:resolveTurnPrincipal\(void 0,\w+\)\},\{heldOnPerson:!0\}\);[^]*?routeDeliverPayload\(\{[^}]*resolveMessage:\1,/.test(proxied),
    "🔴 (b) …and a message may resolve a child's question only when isSteeringDelivery says it is the turn's OWN principal, or carries no auth",
  );
}

{
  // The turn-step writers (eve 1.0.2). Four `.set(` writes and two deletes, in order:
  // (1) the delivery's auth, (2) the initiator when it is empty, (3) a sign-in requester, and
  // (4) the closing write, which decides what the step runs with. (4) restores the value read
  // before (1) on a step that yields no turn input and on an attributed answer. A MESSAGE that joins
  // a running turn keeps continueTurnAuth's result instead: the same principal, but the NEW bag.
  // BETWEEN turns nothing is restored: an answers-only delivery that attributeAnswers leaves alone
  // (no answer targets an open request of this session) keeps the answerer's auth in the slot.
  const step = read(TURN_STEP);
  ok((step.match(WRITE_RE) ?? []).length === 4, `${TURN_STEP} holds exactly FOUR \`.set(\` auth-slot writes (saw ${(step.match(WRITE_RE) ?? []).length})`);
  ok(
    (step.match(/\.delete\((?:Initiator)?AuthKey\)/gu) ?? []).length === 2 && (step.match(/\[AuthKey\.name\]\s*=(?!=)/gu) ?? []).length === 0,
    `${TURN_STEP} holds exactly TWO slot deletes, one of each key, and no member write`,
  );
  const bound = /async function runSessionStepBody\((\w+),\w+,\w+\)\{let (\w+)=\1\.input\?\.delivery;let (\w+)=\2;/.exec(step);
  ok(bound !== null, "runSessionStepBody binds its delivery from the step input, and aliases it");
  const d = bound?.[3] ?? "";
  const prior = new RegExp(
    `let (\\w+)=(\\w+)\\.get\\(AuthKey\\);let (\\w+)=\\2\\.has\\(InitiatorAuthKey\\);${d}\\?\\.auth!==void 0&&\\(\\2\\.set\\(AuthKey,${d}\\.auth\\?\\?null\\),\\2\\.has\\(InitiatorAuthKey\\)\\|\\|\\2\\.set\\(InitiatorAuthKey,${d}\\.auth\\?\\?null\\)\\)`,
  ).exec(step);
  ok(prior !== null, "🔴 (1)+(2) the slot takes the DELIVERY's auth only when the delivery supplies one, and the initiator slot only when it is empty");
  const rawSpan = step.slice((bound?.index ?? 0) + (bound?.[0].length ?? 0), prior?.index ?? 0);
  // eve 1.x declares its own `let ${d}=` inside an arrow callback in this span (the sign-in
  // settlement). That arrow is its own scope, so its body is blanked before the outer local is
  // tracked — and ONLY an arrow body that declares the name is blanked.
  const { text: span, blanked } = blankShadowingArrows(rawSpan, d);
  ok(blanked === 1, `exactly one arrow callback in the span declares its own \`${d}\` — the sign-in settlement (saw ${blanked})`);
  const reassigned = [...span.matchAll(new RegExp(`(?<![\\w$.])${d}=(?!=)([^;)]{0,24})`, "gu"))].map((m) => m[1]);
  ok(
    reassigned.length === 2 && reassigned[0]?.startsWith(`{...${d},payloads:`) === true && reassigned[1] === "void 0",
    `🔴 before the write the delivery local is reassigned only to the same delivery with its sign-in payloads removed, or to void 0 (saw ${JSON.stringify(reassigned)})`,
  );
  ok(
    !new RegExp(`(?:let|const|var)\\s+${d}\\b|(?:let|const|var)\\s*\\{[^}]*(?<![\\w$])${d}(?![\\w$])[^}]*\\}=|\\(${d}\\)=>|\\b${d}=>`).test(span),
    "…and, outside that blanked callback, no nested declaration or arrow parameter shadows it in that span",
  );
  const saved = prior?.[1] ?? "\\0";
  const ctx = prior?.[2] ?? "\\0";
  const hadInitiator = prior?.[3] ?? "\\0";
  const signIns = /let\{signIns:(\w+)\}=readHitlState\(\w+\.state\);/.exec(step);
  ok(signIns !== null, "the pending sign-ins come from the HITL state in durable session state");
  ok(
    /function readRequests\((\w+)\)\{let (\w+)=\1\?\.\[REQUESTS_KEY\];/.test(read("harness/hitl/requests.js")) && /REQUESTS_KEY=`eve\.[\w.-]+`/.test(read("harness/hitl/requests.js")),
    "…under an `eve.`-reserved state key (§5), which no authored state can alias",
  );
  const matches = new RegExp(`let\\{matches:(\\w+),remainingPayloads:\\w+\\}=matchAuthorizationCallbacks\\(${signIns?.[1] ?? "\\0"},${d}\\.payloads\\)`).exec(step);
  ok(matches !== null, "the sign-in matches come from matchAuthorizationCallbacks over the step's own delivery payloads");
  const afterMatch = step.slice(matches?.index ?? 0, prior?.index ?? 0);
  const kept = new RegExp(`,(\\w+)=${matches?.[1] ?? "\\0"},`).exec(afterMatch)?.[1] ?? "\\0";
  const signIn = new RegExp(
    `let (\\w+)=${d}===void 0\\?${kept}\\?\\.find\\(\\(\\{challenge:(\\w+)\\}\\)=>\\2\\.candidateId===void 0\\)\\?\\.challenge\\.requester:void 0;\\1!==void 0&&${ctx}\\.set\\(AuthKey,\\1\\)`,
  ).exec(step);
  ok(signIn !== null, "🔴 (3) a sign-in-only step restores the challenge's `requester` — nothing else — and only when no delivery is left");

  const between = new RegExp(`let (\\w+)=isBetweenTurns\\(currentProjection\\(${ctx}\\)\\)`).exec(step);
  ok(between !== null, "the step reads whether a turn is running from the session projection, never from the delivery");
  const x = between?.[1] ?? "\\0";
  const attributed = new RegExp(
    `let (\\w+)=${d}\\?\\.auth===void 0\\?void 0:attributeAnswers\\(\\{owner:${x}\\?void 0:${saved}\\?\\?null,responder:${d}\\.auth,state:\\w+\\.state,stepInput:(\\w+)\\}\\);\\1!==void 0&&\\(\\2=\\1,${hadInitiator}\\|\\|${ctx}\\.delete\\(InitiatorAuthKey\\)\\);`,
  ).exec(step);
  ok(
    attributed !== null,
    "🔴 attributeAnswers labels an answer with the delivery's auth as its `responder`, against the slot read before (1) as the `owner`, and an attributed answer UNDOES the initiator write (2)",
  );
  const A = attributed?.[1] ?? "\\0";
  const O = attributed?.[2] ?? "\\0";
  const noInput = new RegExp(`let (\\w+)=${d}!==void 0&&${O}===void 0&&!${x};`).exec(step);
  ok(noInput !== null, "the rollback flag is set for a mid-turn delivery that yields no turn input");
  const closing = new RegExp(
    `let (\\w+)=${ctx}\\.get\\(AuthKey\\);if\\(${A}!==void 0\\|\\|${noInput?.[1] ?? "\\0"}\\?\\1=${saved}:${d}!==void 0&&!${x}&&\\(\\1=${O}\\?\\.message===void 0\\?${saved}:continueTurnAuth\\(${saved},\\1\\)\\),\\1===void 0\\?${ctx}\\.delete\\(AuthKey\\):${ctx}\\.set\\(AuthKey,\\1\\)`,
  ).exec(step);
  ok(
    closing !== null,
    "🔴 (4) the closing write RESTORES the value read before (1) after an attributed answer, after a mid-turn delivery with no turn input, and after a mid-turn input with no message — and a mid-turn MESSAGE keeps continueTurnAuth(that value, the delivery's)",
  );
  ok(
    (closing?.index ?? 0) > (attributed?.index ?? Number.MAX_SAFE_INTEGER) && (attributed?.index ?? 0) > (signIn?.index ?? Number.MAX_SAFE_INTEGER) && (signIn?.index ?? 0) > (prior?.index ?? Number.MAX_SAFE_INTEGER),
    "…in that order: (1)+(2), (3), the attribution, then (4)",
  );
  ok(
    step.indexOf("await runHarnessStep(") > (closing?.index ?? Number.MAX_SAFE_INTEGER),
    "…and (4) runs BEFORE the step hands the context to the model loop, so the model never runs on a value (4) would undo",
  );

  const principal = read("execution/session/principal.js");
  ok(
    /function principalOf\((\w+)\)\{return \1==null\|\|\1\.principalType===`anonymous`\?ANONYMOUS_PRINCIPAL:JSON\.stringify\(\[\1\.authenticator,\1\.issuer\?\?null,\1\.principalType,\1\.principalId\]\)\}/.test(principal),
    "🔴 principalOf is [authenticator, issuer, principalType, principalId] — the attributes bag is NOT part of the principal",
  );
  ok(
    /function continueTurnAuth\((\w+),(\w+)\)\{if\(\2===void 0\)return \1;if\(principalOf\(\2\)!==principalOf\(\1\)\)throw Error\(`[^`]*`\);return \2\}/.test(principal),
    "🔴 continueTurnAuth THROWS on another principal, and returns the NEW auth (a new bag) for the same principal",
  );
  ok(
    JSON.stringify(filesMatching(/continueTurnAuth\(/u)) === JSON.stringify([PROXIED_DELIVER, "execution/session/principal.js", TURN_STEP]),
    `continueTurnAuth has exactly two callers, the turn step and the proxied answers writer (saw ${JSON.stringify(filesMatching(/continueTurnAuth\(/u))})`,
  );

  const answers = read("execution/session/answer-caller.js");
  ok(
    JSON.stringify(filesMatching(/attributeAnswers\(\{/u)) === JSON.stringify([TURN_STEP]),
    `attributeAnswers has ONE caller, the turn step (saw ${JSON.stringify(filesMatching(/attributeAnswers\(\{/u))})`,
  );
  ok(
    /function attributeAnswers\((\w+)\)\{let\{stepInput:(\w+)\}=\1;let (\w+)=\2\?\.answers\?\?\[\];if\(\2===void 0\|\|\2\.message!==void 0\|\|\3\.length===0\)return;/.test(answers),
    "🔴 attributeAnswers acts only on an answers-only step input — a step input that carries a message is never attributed",
  );
  ok(
    /let (\w+)=\w+\.owner!==void 0&&principalOf\(\w+\.owner\)!==principalOf\(\w+\.responder\);let (\w+)=\w+\.filter\(\w+=>!\1\|\|\w+\.has\(\w+\.interactionId\)\);/.test(answers),
    "🔴 …an answer from ANOTHER principal mid-turn keeps only the answers that target an OPEN request",
  );
  ok(
    /\?\{\.\.\.(\w+),responder:(\w+)\.responder\}:\1\)\}\}export/.test(answers) && /===`approval`\?\{\.\.\.\w+,responder:/.test(answers),
    "🔴 …and it stamps the responder ONLY on an approval answer, as a label on the answer — it writes no auth slot",
  );
  ok(!/AuthKey/.test(answers), "…attributeAnswers never touches AuthKey");
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
  // The approval responder (eve 1.0.2). harness/approval-delivery-coordinator.js is gone: the
  // responder is now read in harness/hitl/responders.js, off the answer's `responder` label that
  // attributeAnswers stamped (the delivery's own auth), else the session's slot. It is stored on the
  // durable response record and bound only into the approval-response authorizer — it is never
  // written to the session auth slot, and the turn step restores that slot after an attributed answer.
  const responders = read("harness/hitl/responders.js");
  ok(
    JSON.stringify(filesMatching(/checkResponders\(/u)) === JSON.stringify(["harness/hitl/intake.js", "harness/hitl/responders.js"]),
    `the responder check lives in harness/hitl/responders.js and has one caller, the HITL intake (saw ${JSON.stringify(filesMatching(/checkResponders\(/u))})`,
  );
  const label = /let\{responder:(\w+),responseId:(\w+)\}=\w+;/.exec(responders);
  ok(label !== null, "the responder check reads each answer's `responder` label");
  const responder = new RegExp(
    `let (\\w+)=${label?.[1] ?? "\\0"}===void 0\\?buildCallbackContext\\(\\)\\.session\\.auth\\.current:${label?.[1] ?? "\\0"};\\1===null\\?\\w+\\.push\\(\\{reason:UNAUTHENTICATED_FEEDBACK,responseId:${label?.[2] ?? "\\0"}\\}\\):(\\w+)\\[${label?.[2] ?? "\\0"}\\]=\\{expiresAt:[^,]+,responder:\\1\\}`,
  ).exec(responders);
  ok(responder !== null, "🔴 …and the responder is the answer's attributed auth, else the session's own slot — stored on the pending response record, not on the slot");
  ok(
    new RegExp(`let (\\w+)=${label?.[1] ?? "\\0"}===void 0\\?currentResponder\\(\\):${label?.[1] ?? "\\0"};`).test(responders),
    "…the requester-only comparison takes the same label, else the current slot",
  );
  ok(
    /buildApprovalResponseAuth\(\{responder:(\w+)\.pending\.responder,scope:\w+\.responseId\}\)/.test(responders),
    "🔴 the approval-response authorizer is bound to that stored responder, and nothing else",
  );
  ok(!WRITE_RE.test(responders) && !ANY_WRITE_RE.test(responders), "harness/hitl/responders.js writes no auth slot");
  const STAMP = /\{\.\.\.\w+,responder:/gu;
  ok([..."x={...t,responder:e.responder}".matchAll(STAMP)].length === 1 && [..."let{responder:t}=s".matchAll(STAMP)].length === 0, "control: the stamp matcher counts a built label and skips a binding pattern");
  // `compiled/` holds vendored third-party bundles (the agent-client-protocol SDK builds its own
  // `responder` objects there); none of them imports eve's HITL state.
  const stamped = filesMatching(STAMP).filter((f) => !f.startsWith("compiled/"));
  ok(
    JSON.stringify(stamped) === JSON.stringify(["execution/session/answer-caller.js"]),
    `🔴 attributeAnswers is the ONLY eve module that stamps a responder onto an answer (saw ${JSON.stringify(stamped)})`,
  );
}

{
  // eve 1.0.2 builds the callback's resume value once, then hands it to the hosted hook, else to the
  // runnable hook. The literal closes after `payloads`, so the regex also proves it carries no `auth`.
  const callbackRoute = read("execution/connections/callback-route.js");
  const callbackValue =
    /let (\w+)=\{kind:`authorization-callback`,payloads:\[\{authorizationCallback:\{attemptId:\w+,callback:\w+,connectionName:\w+\}\}\]\};/.exec(
      callbackRoute,
    );
  ok(
    callbackValue !== null &&
      new RegExp(`await deliverToHostedHook\\(\\w+,${callbackValue[1]}\\)\\|\\|await resumeRunnableHook\\(\\w+,${callbackValue[1]}\\)`).test(callbackRoute),
    "the connection authorization callback still resumes with NO `auth` field (auth-preserving resume)",
  );
  ok(
    /if\((\w+)\.kind===`authorization-callback`\)return \w+\.queue\.enqueueAuthorization\(\1\.payloads\)/.test(read("execution/session/admission.js")),
    "…the session admits it as its PAYLOADS only — an auth field on the callback could not reach the queue",
  );
  ok(
    /let (\w+)=this\.input\.queue\.takeAuthorizations\(\w+\.attemptIds\);if\(\1!==void 0\)return\{delivery:\{kind:`deliver`,payloads:\1\}\}/.test(read("execution/session/turn.js")),
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
  const subInput = /function buildSubagentRunInput\((\w+)\)\{let\{([^}]*)\}=\1[,;]/.exec(sub);
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
  ok(/payload:\{answers:\w+\}/.test(hitlProxy), "routeDeliverPayload still routes HITL answers to a child as an `answers`-only payload");
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

  // eve 1.0.2: the session loop calls the step through its host (`host.runTurnStep`), and the
  // workflow host's runTurnStep is the `turnStep` wrapper.
  const stepCallers = filesMatching(/(?<![\w$.])turnStep\(/u).filter((f) => !/^execution\/(?:session|workflow-host)\/turn-step\.js$/u.test(f));
  ok(
    JSON.stringify(stepCallers) === JSON.stringify(["execution/session/workflow-host.js"]) && /runTurnStep:(\w+)=>turnStep\(\1\)/.test(read("execution/session/workflow-host.js")),
    `turnStep has ONE call site outside its own modules, the workflow host's runTurnStep (saw ${JSON.stringify(stepCallers)})`,
  );
  ok((turnJs.match(/\.host\.runTurnStep\(/gu) ?? []).length === 1, "…and the session loop calls runTurnStep in ONE place");
  const loop = /async runTurnSteps\((\w+),(\w+)\)\{let (\w+)=\2;/.exec(turnJs);
  ok(loop !== null, "runTurnSteps seeds its step input from its second parameter — the turn's own delivery");
  const turnVar = loop?.[1] ?? "\\0";
  const inputVar = loop?.[3] ?? "\\0";
  ok(
    new RegExp(`\\.host\\.runTurnStep\\(\\{[^}]*input:${inputVar}[,}]`).test(turnJs),
    "…and the ONE runTurnStep call passes that variable as its input",
  );
  ok(
    /async runTurn\((\w+),\w+=\{\}\)\{[^]*?this\.runTurnSteps\(\w+,\1\)/.test(turnJs),
    "① runTurn hands runTurnSteps the delivery the turn was started with",
  );

  const loopEnd = turnJs.indexOf("async withSteering(");
  const loopBlank = blankShadowingArrows(turnJs.slice(loop?.index ?? 0, loopEnd), inputVar);
  ok(loopBlank.blanked === 1, `exactly one arrow in runTurnSteps declares its own \`${inputVar}\` — the retry's .catch (saw ${loopBlank.blanked})`);
  const body = loopBlank.text;
  const assigns = [...body.matchAll(new RegExp(`(?<![\\w$.])${inputVar}=(?!=)`, "gu"))].map((m) => body.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 40));
  ok(assigns.length === 3, `runTurnSteps assigns its step input exactly three times — the seed and two re-entries (saw ${JSON.stringify(assigns)})`);
  ok(assigns[0]?.startsWith(`${loop?.[2] ?? ""};`) === true, "…the first is the seed from the turn's delivery");
  ok(
    new RegExp(`let (\\w+)=await this\\.resume\\(${turnVar},\\w+,\\w+\\);if\\(\\1===\`cancelled\`\\)return await this\\.finishCancelledTurn\\(${turnVar}\\);${inputVar}=\\1;continue`).test(body),
    "② a paused turn re-enters with what resume() returned — and nothing else",
  );
  ok(new RegExp(`${inputVar}=await this\\.withSteering\\(${turnVar},\\{\\}\\);continue`).test(body), "③ a continuing turn re-enters with whatever withSteering admits");
  ok(
    /async withSteering\((\w+),(\w+)\)\{let (\w+)=await \1\.takeSteering\(\);if\(\3!==void 0\|\|\2\.runtimeResults!==void 0\)return\{\.\.\.\2,\.\.\.\3!==void 0&&\{delivery:\3\}\}\}/.test(turnJs),
    "③ withSteering takes a delivery ONLY from takeSteering() with no options",
  );
  const resume = /async resume\((\w+),(\w+),(\w+)\)\{(?:(?!async )[\s\S])*/.exec(turnJs);
  ok(resume !== null, "the session loop still declares resume()");
  const r = resume?.[0] ?? "";
  const rTurn = resume?.[1] ?? "\\0";
  const heldSince = resume?.[3] ?? "\\0";
  const returns = [...r.matchAll(/return([^;}]*(?:\{[^;]*?\}\})?)/gu)].map((m) => m[1]!.trim());
  ok(
    new RegExp(`let (\\w+)=this\\.input\\.queue\\.takeAuthorizations\\(\\w+\\.attemptIds\\);if\\(\\1!==void 0\\)return\\{delivery:\\{kind:\`deliver\`,payloads:\\1\\}\\};let (\\w+)=await ${rTurn}\\.takeAnswers\\(\\w+\\.requestIds\\);if\\(\\2!==void 0\\)return\\{delivery:\\2\\};let (\\w+)=await ${rTurn}\\.takeSteering\\(\\{heldSince:${heldSince}\\}\\);if\\(\\3!==void 0\\)return\\{delivery:\\3\\}`).test(r),
    "② a turn held on a person re-enters with a sign-in delivery that carries NO auth key, the delivery that answers the held request, or a delivery takeSteering admits since the hold began",
  );
  ok(
    returns.length === 6 &&
      returns.filter((x) => x.startsWith("{delivery:")).length === 3 &&
      returns.filter((x) => x.startsWith(`await this.withSteering(${rTurn},`)).length === 2 &&
      returns.filter((x) => /^\w+$/u.test(x)).length === 1,
    `resume() returns only through those three, through withSteering, or the bare \`cancelled\` value (saw ${JSON.stringify(returns)})`,
  );
  ok(
    /async runTurnSteps\([^]*?let (\w+)=this\.input\.queue\.nextAdmission;[^]*?await this\.resume\(\w+,\w+,\1\)/.test(turnJs),
    "…where the hold begins at the queue's next admission, read when the step paused",
  );

  const queue = read("execution/session/input-queue.js");
  ok(
    /takeSteering\((\w+),(\w+),(\w+)\)\{let \w+=this\.entries\.filter\((\w+)=>\4\.kind===`delivery`&&\1\.has\(\4\.sequence\)&&isSteeringDelivery\(\4\.delivery,\2,\{heldOnPerson:\3\?\.heldSince!==void 0&&\4\.sequence>=\3\.heldSince\}\)\)/.test(queue),
    "the queue admits a steering delivery only through isSteeringDelivery — and bypasses the policy only for a delivery that arrived after the hold began",
  );
  ok(
    /function isSteeringDelivery\((\w+),(\w+),(\w+)\)\{return\(\3\?\.heldOnPerson===!0\|\|\(\1\.turnPolicy\?\?`steer`\)===`steer`\)&&\(\1\.caller===void 0\|\|\1\.caller\.callId===\2\.callerCallId\)&&\(\1\.auth===void 0\|\|principalOf\(\1\.auth\)===\2\.principal\)\}/.test(queue),
    "🔴 …which needs (held on a person OR a `steer` policy) AND the same caller AND (the same principal OR no auth)",
  );
  ok(
    /async takeSteering\((\w+)\)\{[^]*?this\.input\.queue\.takeSteering\(this\.admitted,this\.identity,\1\)/.test(read("execution/session/active-turn.js")),
    "…and the active turn passes its own identity and the caller's options straight through",
  );
  ok(
    (turnJs.match(/heldSince:/gu) ?? []).length === 1,
    "② only resume() passes a hold — the one road that bypasses the steering policy, and only for a same-principal delivery",
  );
  const takeAnswers = /async takeAnswers\(\w+\)\{(?:(?!async )[\s\S])*/.exec(read("execution/session/active-turn.js"))?.[0] ?? "";
  ok(
    takeAnswers.length > 0 && /let (\w+)=isSteeringDelivery\((\w+),this\.identity,\{heldOnPerson:!0\}\)\?void 0:splitAnswers\(\2\);return this\.input\.queue\.replaceDelivery\(\w+,\1\?\.rest\),\1\?\.answers\?\?\2\}/.test(takeAnswers),
    "② the held request's answer is selected by request id; from ANOTHER principal only its answers are taken and the rest waits in the queue — its auth reaches the turn step's attribution as delivered",
  );

  const unifiedSrc = readFileSync(new URL("../agent/channels/unified.ts", import.meta.url), "utf8");
  ok(
    /\bturnPolicy:\s*"queue"/u.test(unifiedSrc),
    "🔴 OE's unified channel declares `turnPolicy: \"queue\"` — so ③ admits no MESSAGE delivery on an OE seat window (② still does, below)",
  );
  ok(
    /turnPolicy:(\w+)\.message===void 0\?void 0:/u.test(read("channel/channel-address.js")),
    "🔴 eve stamps NO turnPolicy on a delivery without a message — an input response — so isSteeringDelivery reads it as `steer`",
  );
  ok(
    !/\.respond\s*\(/u.test(unifiedSrc.replace(/^\s*(\/\/|\*|\/\*).*$/gmu, "")),
    "OE's unified channel has no answer road — no `.respond(` call, so no room answer reaches a window turn as an attributed answer (OPE-2389)",
  );

  // OPE-2789. `queue` does NOT keep every message out of a running OE turn, and a message that joins
  // one replaces the turn's bag (the closing write above keeps continueTurnAuth's result). A message
  // that answers a child's question replaces the PARENT's bag too (joinAnswerToTurn, (b)). OE closes
  // ② and (b) on a SEAT window with the join issuer (channels/turn-join-fence.ts): a delivery whose
  // authority attributes differ is another principal. ③ on a WORK window stays open by design, and
  // the job gate refuses (and reissues) a worker whose job the step's stamp does not name. A surface's
  // own session with no standing seat is not a unified window and keeps eve's join (OPE-2790 tracks OE's direct
  // sends into native sessions). turn-join-fence-test drives these roads through eve's real queue and
  // writer.
  const code = unifiedSrc.replace(/^\s*(\/\/|\*|\/\*).*$/gmu, "");
  const steerOnWork = /\.\.\.\(isWorkWindowToken\(t\.token\) \? \{ turnPolicy: "steer" as const \} : \{\}\)/u.test(code);
  ok(steerOnWork, "🔴 OE's unified receive sets `turnPolicy: \"steer\"` on a WORK window — so ③ admits a same-principal MESSAGE into a running work turn");
  const blankPrincipal =
    /principalId: auth\?\.principalId \?\? "",/u.test(code) && /principalType: auth\?\.principalType \?\? "",/u.test(code) && /authenticator: auth\?\.authenticator \?\? "",/u.test(code);
  const internalSends = [...code.matchAll(/auth: \{ attributes(?: \}|: )/gu)].length;
  const AUTH_NAMES_PRINCIPAL = /\bauth: \{[^{}]*\bprincipal(?:Id|Type):/u;
  ok(
    AUTH_NAMES_PRINCIPAL.test('send(m, { auth: { attributes, principalId: "U1" } })') && !AUTH_NAMES_PRINCIPAL.test("send(m, { auth: { attributes } }); f({ principalId: x })"),
    "control: the principal matcher sees a principal key inside an `auth: {` literal and skips one outside it",
  );
  const namedPrincipal = AUTH_NAMES_PRINCIPAL.test(code);
  ok(
    blankPrincipal && internalSends === 5 && !namedPrincipal,
    `🔴 the five OE internal dispatches send attributes only, no auth literal in unified.ts names a principal, and completeWakeAuth fills the principal fields with "" — so all of them share ONE principal (saw ${internalSends} attribute-only sends, named principal: ${namedPrincipal})`,
  );
  ok(
    steerOnWork && blankPrincipal && (turnJs.match(/heldSince:/gu) ?? []).length === 1 && /\w+\[AuthKey\.name\]=continueTurnAuth\(/u.test(read(PROXIED_DELIVER)),
    "🔴 eve still lets a MESSAGE of the same principal join a running turn and replace its bag (a message with no auth also joins, but keeps the earlier bag) — ② while the turn waits on a person, ③ on a `steer` window, and (b) a message that answers a child's question replaces the parent's bag. The principal cannot change; the attributes become the later delivery's",
  );
  const FENCED_RECEIVE = /const wakeAuth = completeWakeAuth\(input\.auth\);\s*return from\(t\.token\)\.send\(input\.message, \{\s*auth: isWorkWindowToken\(t\.token\) \? wakeAuth : fenceTurnJoin\(wakeAuth, authority \?\? null\),/u;
  ok(
    FENCED_RECEIVE.test("const wakeAuth = completeWakeAuth(input.auth);\n    return from(t.token).send(input.message, {\n      auth: isWorkWindowToken(t.token) ? wakeAuth : fenceTurnJoin(wakeAuth, authority ?? null),") &&
      !FENCED_RECEIVE.test("return from(t.token).send(input.message, {\n      auth: completeWakeAuth(input.auth),"),
    "control: the fence matcher sees the fenced receive and skips the unfenced one",
  );
  ok(
    FENCED_RECEIVE.test(code) && (code.match(/from\(t\.token\)\.send\(/gu) ?? []).length === 1,
    "🔴 OPE-2789: OE's unified receive — its ONE send into a window session — fences every SEAT window delivery with the join issuer over its bag AND its wake's resolved authority row, so ② and (b) admit only a delivery with the turn's own authority. A WORK window is not fenced: its joins are the design (③)",
  );
  const proxiedSrc = read(PROXIED_DELIVER);
  const resolveGate = /let (\w+)=!hasDelegatedSessionContext\((\w+)\)&&[^;]*?isSteeringDelivery\((\w+),\{callerCallId:void 0,principal:resolveTurnPrincipal\(void 0,\2\)\},\{heldOnPerson:!0\}\);/u.exec(proxiedSrc);
  ok(
    resolveGate !== null && new RegExp(`resolveMessage:${resolveGate[1]}[,}]`).test(proxiedSrc),
    "🔴 (b) eve resolves a message as a child's answer ONLY when isSteeringDelivery admits it against the parent's serialized principal (held on a person) — the gate turn-join-fence-test C2 drives; an eve bump that moves it fails here",
  );
  const joinFlag = /joinAnswerToTurn\(\w+,\{auth:(\w+)\?\w+\.auth:void 0,/u.exec(proxiedSrc)?.[1];
  const routeVar = resolveGate === null ? undefined : new RegExp(`let (\\w+)=routeDeliverPayload\\(\\{[^}]*resolveMessage:${resolveGate[1]}[,}]`).exec(proxiedSrc)?.[1];
  const flagSet = joinFlag === undefined || routeVar === undefined
    ? null
    : new RegExp(`let (\\w+)=${routeVar}\\.forChildren\\.find\\((\\w+)=>\\2\\.message!==void 0\\);[^;]*;let (\\w+)=[^;]*;\\1!==void 0&&\\3!==void 0&&\\(${joinFlag}=!0\\)`).exec(proxiedSrc);
  ok(
    joinFlag !== undefined &&
      routeVar !== undefined &&
      flagSet !== null &&
      new RegExp(`let ${joinFlag}=!1;`).test(proxiedSrc) &&
      (proxiedSrc.match(new RegExp(`(?<![\\w$.])${joinFlag}=(?!=)`, "gu")) ?? []).length === 2 &&
      /resolveMessageAgainstFirstRequest\(\{enabled:\w+\.resolveMessage===!0,/u.test(read(SUBAGENT_HITL_PROXY)),
    "(b) …and joinAnswerToTurn takes the message's auth only under a flag that starts false and is set ONCE, when a child entry with a message came from the routeDeliverPayload call gated by that isSteeringDelivery result (the proxy resolves a message only when resolveMessage is true)",
  );

  const active = read("execution/session/active-turn.js");
  ok(
    /let (\w+)=await this\.input\.cursor\.advance\(\w+=>routeDeliverToChildren\(\{delivery:\w+,\.\.\.\w+\}\)\);[^]*?this\.input\.queue\.replaceDelivery\(\w+,\1\.remainder\)/.test(active),
    "a mid-turn arrival is routed to CHILD sessions first, and its residue goes BACK INTO THE QUEUE — it reaches the running step only through takeSteering (② or ③ above)",
  );
  ok(
    /takeNext\(\w+\)\{/.test(queue),
    "…where takeNext picks it up as the NEXT turn's delivery",
  );
  const proxied = read(PROXIED_DELIVER);
  const routed = /\{delivery:(\w+),serializedContext:\w+\}=await deliverChannelAnswers\(/.exec(proxied)?.[1] ?? "";
  ok(
    routed !== "" &&
      new RegExp(`let (\\w+)=\\{\\.\\.\\.${routed},deliveryMetadata:[^;]*;[^]*?resumeRoutedSessionInbox\\([^;]*,\\1\\)`).test(proxied) &&
      new RegExp(`respondToRemoteAgentSession\\(\\{[^}]*auth:${routed}\\.auth,`).test(proxied),
    "the proxied child delivery still carries the DELIVERY's own auth — spread whole to a local child, named to a remote one",
  );
}

console.log(`✓ auth-attribute-provenance: ${passed} contract assertions passed against eve ${eveVersion}`);
