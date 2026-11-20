import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EVE_PATCH_PARTS } from "../agent/access/eve-patch-probe.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
for (;;) {
  const pkg = join(repoRoot, "package.json");
  if (existsSync(pkg) && typeof JSON.parse(readFileSync(pkg, "utf8")).workspaces !== "undefined") break;
  const up = dirname(repoRoot);
  if (up === repoRoot) throw new Error("eve-install-integrity: could not locate the workspace root from " + here);
  repoRoot = up;
}
const rel = (p: string): string => relative(repoRoot, p) || ".";

const rootZod = createRequire(import.meta.url)("zod/package.json") as { version: string };
const rootZodVersion = rootZod.version;

function eveSourceFiles(eveDir: string): string[] {
  const srcDir = join(eveDir, "dist", "src");
  if (!existsSync(srcDir)) return [];
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((rel) => (rel.endsWith(".js") || rel.endsWith(".d.ts")) && !rel.split(/[/\\]/).includes("compiled"))
    .map((rel) => join("dist", "src", rel));
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".claude",
  ".next",
  ".vercel",
  ".output",
  ".turbo",
  "dist",
  "build",
  "coverage",
  "tmp",
]);

const manifestDirs: string[] = [];
const walkSource = (dir: string): void => {
  if (existsSync(join(dir, "package.json"))) manifestDirs.push(dir);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
    walkSource(join(dir, e.name));
  }
};
walkSource(repoRoot);

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const pins: { file: string; field: string; version: string }[] = [];
for (const dir of manifestDirs) {
  const file = join(dir, "package.json");
  const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string> | undefined>;
  for (const field of DEP_FIELDS) {
    const v = json[field]?.eve;
    if (typeof v === "string") pins.push({ file: rel(file), field, version: v });
  }
}

ok(pins.length > 0, "pins: at least one package.json in the tree depends on eve (zero would mean this gate checks nothing)");

const pinned = pins[0]!.version;
const diverged = pins.filter((p) => p.version !== pinned);
assert.ok(
  diverged.length === 0,
  `pins: every package.json must pin the SAME eve version. ${pins[0]!.file} (${pins[0]!.field}) pins "${pinned}" but ` +
    diverged
      .map((p) => `${p.file} (${p.field}) pins "${p.version}"`)
      .join("; ") +
    ". A divergent pin installs a NESTED node_modules/eve that patch-package never patches — " +
    "the OE addition (patch part 10, the authored-package boundary) is silently absent from it.",
);
n++;
ok(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pinned), `pins: eve is pinned to an EXACT version (got "${pinned}") — a range would let the installed bytes drift off the patch`);

const patchFile = join(repoRoot, "patches", `eve+${pinned}.patch`);
ok(
  existsSync(patchFile),
  `patch: patches/eve+${pinned}.patch exists for the pinned version — a pin bump that leaves the ` +
    `patch filename behind makes patch-package silently skip the OE hooks (found: ${readdirSync(join(repoRoot, "patches")).filter((f) => f.startsWith("eve+")).join(", ") || "none"})`,
);

const patchBody = existsSync(patchFile) ? readFileSync(patchFile, "utf8") : "";
const patchAdded = patchBody
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .join("\n");
for (const part of EVE_PATCH_PARTS) {
  ok(
    patchAdded.includes(`globalThis.${part.marker}=!0;`),
    `markers: the committed patch ADDS \`globalThis.${part.marker}=!0;\` for part ${part.part} — ` +
      `agent/access/eve-patch-probe.ts refuses to boot without that marker, so a part whose hunk stops ` +
      `planting it turns core's fail-closed boot into a refusal of every correctly-patched tree`,
  );
}
const plantedMarkers = [...new Set([...patchAdded.matchAll(/globalThis\.(__oe[A-Za-z0-9_]*Patched)=/g)].map((m) => m[1]))].sort();
const declaredMarkers = EVE_PATCH_PARTS.map((p) => p.marker).sort();
ok(
  plantedMarkers.length === declaredMarkers.length && plantedMarkers.every((m, i) => m === declaredMarkers[i]),
  `markers: the markers the patch plants (${plantedMarkers.join(", ") || "none"}) are exactly the ones ` +
    `EVE_PATCH_PARTS declares (${declaredMarkers.join(", ")}). A marker planted with no row in that table ` +
    `is checked by nothing at boot; a row with no marker in the patch refuses every boot`,
);

const copies: string[] = [];
const seen = new Set<string>();
const collectCopies = (pkgDir: string): void => {
  const nm = join(pkgDir, "node_modules");
  if (!existsSync(nm)) return;
  const eveDir = join(nm, "eve");
  if (existsSync(join(eveDir, "package.json")) && basename(dirname(eveDir)) === "node_modules") copies.push(eveDir);
  for (const e of readdirSync(nm, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (e.name.startsWith("@")) {
      for (const s of readdirSync(join(nm, e.name), { withFileTypes: true })) {
        if (s.isDirectory()) collectCopies(join(nm, e.name, s.name));
      }
      continue;
    }
    collectCopies(join(nm, e.name));
  }
};
for (const dir of [repoRoot, ...manifestDirs]) {
  const key = resolve(dir);
  if (seen.has(key)) continue;
  seen.add(key);
  collectCopies(dir);
}

ok(
  copies.length > 0,
  "copies: at least one node_modules/eve is installed — finding zero would mean this gate silently verified nothing (run `npm install` from the repo root)",
);

const TOOL_LOOP = join("dist", "src", "harness", "tool-loop.js");
const WEB_FETCH_REQUEST = join("dist", "src", "execution", "web-fetch", "request.js");
const COMPACTION = join("dist", "src", "harness", "compaction", "engine.js");
const COMPACTION_STEP = join("dist", "src", "harness", "compaction", "step.js");
const AUTHORED_PACKAGE_BOUNDARY = join("dist", "src", "internal", "authored-package-boundary.js");

const RETIRED = [
  { symbol: "__oeCfg", why: "OPE-172" },
  { symbol: "__oeMatch", why: "OPE-172" },
  { symbol: "__oeWrapPrepareStep", why: "OPE-172" },
  { symbol: "__oeNoteTerminal", why: "OPE-172" },
  { symbol: "__oeForceContinue", why: "OPE-172" },
  { symbol: "__oeHistoryHasTerminal", why: "OPE-172" },
  { symbol: "__OE_FORCE_NUDGE", why: "OPE-172" },
  { symbol: "OE_FORCE_TOOL_TURN", why: "OPE-172" },
  { symbol: "__oeCeil", why: "OPE-407" },
  { symbol: "__oeCeilTrip", why: "OPE-407" },
  { symbol: "__oeCeilClear", why: "OPE-407" },
  { symbol: "__oeCeilStop", why: "OPE-407" },
  { symbol: "__oeStepCounts", why: "OPE-407" },
  { symbol: "__oeCONT", why: "OPE-407" },
  { symbol: "OE_TURN_STEP_CEILING", why: "OPE-407" },
  { symbol: "__oeTaskCohortJoin", why: "OPE-1856" },
  { symbol: "__oeTaskCohortJoinPatched", why: "OPE-1856" },
  { symbol: "__oeSessionToolScopePatched", why: "OPE-2106" },
  { symbol: "__oeThrowEmptyResponseUnlessTerminal", why: "OPE-2252" },
  { symbol: "__oeEmptyStepTerminalPatched", why: "OPE-2252" },
  { symbol: "__oeTurnTerminalActionScan", why: "OPE-2252" },
  { symbol: "__oeProjectModelMessages", why: "OPE-2251" },
  { symbol: "__oeProjectModelMessagesPatched", why: "OPE-2251" },
  { symbol: "__oeProjectToolSet", why: "OPE-2690" },
  { symbol: "__oeCompactionReduced", why: "OPE-2704" },
  { symbol: "__oeWithReduced", why: "OPE-2704" },
  { symbol: "__oeCompactionContractPatched", why: "OPE-2704" },
] as const;

const CARRIAGE = [
  {
    rel: join("dist", "src", "public", "definitions", "channel.js"),
    test: (s: string): boolean => /return\{__kind:CHANNEL_SENTINEL,(?:[^{}]*,)?turnPolicy:/.test(s),
    what:
      "defineChannel() copies `turnPolicy` onto the Channel object it returns. runtime/resolve-channel.js reads it off that object, so without this line EVERY vendor channel resolves `undefined` and falls back to the platform default `steer`",
  },
  {
    rel: join("dist", "src", "public", "definitions", "channel.d.ts"),
    test: (s: string): boolean => /readonly turnPolicy\?: TurnPolicy;/.test(s),
    what: "the `Channel` type declares `turnPolicy` again, so a channel's policy is visible to type-checked callers",
  },
  {
    rel: join("dist", "src", "public", "channels", "slack", "slackChannel.js"),
    test: (s: string): boolean => /turnPolicy:[A-Za-z_$][A-Za-z_$0-9]*\.turnPolicy/.test(s),
    what:
      "slackChannel() forwards `turnPolicy` from its config object into defineChannel(). At 0.34.0-0.38.3 the name does not occur anywhere in the Slack tree, so this forward is the restore",
  },
  {
    rel: join("dist", "src", "public", "channels", "slack", "slackChannel.d.ts"),
    test: (s: string): boolean => /readonly turnPolicy\?: TurnPolicy;/.test(s),
    what:
      "SlackChannelConfig declares `turnPolicy` again. Without it packages/providers/slack/agent/channels/slack.ts's `turnPolicy: \"queue\"` is a type error, and a cast would compile into a silent no-op",
  },
] as const;

const SEMANTICS = [
  {
    rel: join("dist", "src", "public", "channels", "slack", "slackChannel.js"),
    test: (s: string): boolean =>
      /onAnswers\?\?defaultOnAnswers/.test(s) &&
      /function defaultOnAnswers\([A-Za-z_$][A-Za-z_$0-9]*\)\{return\{auth:[A-Za-z_$][A-Za-z_$0-9]*\.defaultAuth\}\}/.test(s),
    what:
      "an OMITTED Slack `onAnswers` accepts the submitting user unconditionally. This is the hole OPE-574 closes; if eve ever tightens the default, packages/providers/slack/agent/channels/slack-input-response.ts is still the authority but its header stops being true",
  },
  {
    rel: join("dist", "src", "public", "channels", "slack", "interactions.js"),
    test: (s: string): boolean => /=await authorizeAnswer\([^;]*\);if\([A-Za-z_$][A-Za-z_$0-9]*===null\)return;/.test(s),
    what:
      "a `null` result from `onAnswers` returns before the `respond()` that resolves the parked batch, so a refusal leaves the request pending. If this guard goes, a refused answer would resolve the turn anyway",
  },
  {
    rel: join("dist", "src", "public", "channels", "slack", "answers.js"),
    test: (s: string): boolean =>
      /try\{return await [A-Za-z_$][A-Za-z_$0-9]*\.deps\.onAnswers\([^)]*\)\}catch\([A-Za-z_$][A-Za-z_$0-9]*\)\{return [A-Za-z_$][A-Za-z_$0-9]*\.error\(`HITL input response authorization failed`/.test(s) &&
      /HITL input response authorization failed`,\{error:[A-Za-z_$][A-Za-z_$0-9]*\}\),null\}/.test(s),
    what:
      "a THROWN Slack `onAnswers` is caught and the answer dropped (`null`). This is why packages/providers/slack/agent/channels/slack-input-response.ts must fail OPEN rather than let an error escape",
  },
  {
    rel: join("dist", "src", "public", "channels", "teams", "teamsChannel.js"),
    test: (s: string): boolean =>
      /onAnswers\?\?\([A-Za-z_$][A-Za-z_$0-9]*\.onMessage===void 0\?defaultOnAnswers:rejectInput\)/.test(s) &&
      /function rejectInput\(\)\{return null\}/.test(s),
    what:
      "on Teams the default is CONDITIONAL: authoring `onMessage` (which OE does) makes an omitted `onAnswers` reject every answer silently. This is why the Teams arm of OPE-574 opens a path rather than narrowing one",
  },
  {
    rel: join("dist", "src", "public", "channels", "teams", "teamsChannel.js"),
    test: (s: string): boolean =>
      /=await [A-Za-z_$][A-Za-z_$0-9]*\.onAnswers\([A-Za-z_$][A-Za-z_$0-9]*,[A-Za-z_$][A-Za-z_$0-9]*\.activity\)\}catch/.test(s) &&
      /Teams input response authorization failed`,\{error:[A-Za-z_$][A-Za-z_$0-9]*\}\);return\}if\([A-Za-z_$][A-Za-z_$0-9]*===null\)return;/.test(s),
    what:
      "a THROWN Teams `onAnswers` is swallowed and the answer dropped, and a `null` result returns before `respond()`. Both are why packages/providers/teams/agent/channels/teams-input-response.ts must fail OPEN rather than let an error escape",
  },
] as const;

const WHY: Record<string, string> = {
  "OPE-2690":
    "patch part 1, the untrusted output projection (OPE-73), is NOT carried onto eve 1.0.0-rc.18 (OPE-2691). Its carrier harness/tool-loop.js does not exist on the rc, and on v1 connector calls reach the model through eve__tool, so a byte re-anchor would leave connector results unfenced. The fence returns as OE-owned deferred tools whose toModelOutput applies it (OPE-2690). The eve 0.x toolset projection is deleted (OPE-2750). The seat cuts, the halt subtraction, the outbound filter, the test-run fence and the replay by card id returned on eve's public API; the work-session cancel fence and the continuation fence wait on OPE-2748",
  "OPE-2704":
    "patch part 4, the compaction event contract (OPE-697), RETIRED on eve 1.0.0-rc.18 (OPE-2691, OPE-2704): its carrier harness/tool-loop.js does not exist on the rc. eve v1 opens a compaction's context change only when it is about to call the summary model (a blocking failure on context.started can still stop that call, and the change then settles failed), so a pre-call pass under the trigger (compactUnder) publishes no context event. A manual compaction has no trigger: on a non-empty history it summarizes, unless the fixed part is over the limit, and that failure opens no change and publishes no context event. A pass that summarizes publishes context.started, the summary run's model.requested and model.started, and then settles: model.settled and context.settled (outcome completed), or a failed outcome. eve rewrites the history only when the result differs from the input",
  "OPE-172": "the force-tool-turn nudge was retired in OPE-172 (gated on an env var that was never set anywhere, so it never ran once)",
  "OPE-407":
    "the per-turn step ceiling LEFT the patch in OPE-407 and lives in userland at packages/core/agent/model/step-boundary.ts (two-tier: a wrap-up instruction at the budget, a text-only stub at the backstop). Porting it back would regress behaviour — the bytes could only stop the loop mutely",
  "OPE-1856":
    "patch part 8, the bounded task-cohort join, RETIRED at the eve 0.69.0 re-roll (OPE-2247): its carrier dist/src/tasks/session-index.js no longer exists, because eve 0.63.x deleted the task index. The symbol can only come back by patching a file eve does not ship. The starvation hazard is CLOSED at eve 0.70: both carriers are deleted, so no producer of a caller-less completion delivery exists and the cohort cannot form, which OPE-2250 T4 measured and recorded in agent/access/eve-patch-probe.ts",
  "OPE-2251":
    "patch part 6, the model-message projection (OPE-1396), RETIRED at OPE-2251 (eve 0.69 reshape T5, ruling C): it existed to splice eve's `[Agents]` listing out of the model call so the seat could not learn a worker's agentId. eve 0.70 has no `[Agents]` note and no agentId, continuation by taskId is ALLOWED, and the one reader that still needs the model's messages (the attachment leg) reads them from the step.started resolver's own ctx.messages",
  "OPE-2106":
    "patch part 9, the delegated-binding refresh, RETIRED at the eve 0.69.0 re-roll (OPE-2247): eve 0.64.1 wraps refreshDynamicSessionToolsForRuntimeRevision in contextStorage.run at the CALLER (dist/src/execution/session/turn-step.js), so re-applying our hunk DOUBLE-WRAPS the same call. The anchor still matches, which is exactly why a blind re-roll needs this row",
};

for (const eveDir of copies) {
  const where = rel(eveDir);
  const version = (JSON.parse(readFileSync(join(eveDir, "package.json"), "utf8")) as { version?: string }).version;
  ok(
    version === pinned,
    `copies: ${where} is eve@${version} but the tree pins ${pinned} — a version-skewed copy is unpatched and can be resolved by anything that imports eve from inside that package`,
  );
  const src = eveSourceFiles(eveDir)
    .map((file) => readFileSync(join(eveDir, file), "utf8"))
    .join("\n");
  ok(src.length > 0, `copies: ${where}/dist/src holds eve's own modules (zero would mean the rows below check nothing)`);
  ok(
    !existsSync(join(eveDir, TOOL_LOOP)),
    `copies: ${where}/${TOOL_LOOP} does NOT exist — eve 1.0.0-rc.18 removed it, and patch parts 1 and 4 were dropped with it (OPE-2691). If the file is back, this tree holds a 0.x eve`,
  );
  ok(
    !src.includes("__oeThrowEmptyResponseUnlessTerminal") &&
      !src.includes("__oeEmptyStepTerminalPatched") &&
      /throw new EmptyModelResponseError[;}]/.test(src),
    `copies: ${where} carries NO empty-step terminal guard (part 5, OPE-762) — it RETIRED at OPE-2252 onto eve's native \`endsTurn\`, so eve's own \`EmptyModelResponseError\` throws must be pristine. A re-roll that ports it back re-arms a scan with no producer`,
  );
  const boundaryFile = join(eveDir, AUTHORED_PACKAGE_BOUNDARY);
  ok(
    existsSync(boundaryFile),
    `boundary: ${where}/${AUTHORED_PACKAGE_BOUNDARY} exists (if eve moved the authored-module boundary, patch part 10 and packages/core/scripts/eve-authored-boundary-test.ts are both stale)`,
  );
  const boundarySrc = existsSync(boundaryFile) ? readFileSync(boundaryFile, "utf8") : "";
  const runtimeLoaderAt = boundarySrc.indexOf("function createRuntimeLoaderPackageBoundaryPlugin(");
  const runtimeLoaderEnd = runtimeLoaderAt < 0 ? -1 : boundarySrc.indexOf("function ", runtimeLoaderAt + 1);
  const runtimeLoaderSrc = runtimeLoaderAt < 0 ? "" : boundarySrc.slice(runtimeLoaderAt, runtimeLoaderEnd < 0 ? undefined : runtimeLoaderEnd);
  const boundaryCalls = boundarySrc.split("__oeResolvesThroughInstalledPackage(").length - 1;
  ok(
    boundarySrc.includes("function __oeResolvesThroughInstalledPackage(") &&
      boundaryCalls === 2 &&
      /if\(isNodeModulesPath\([A-Za-z_$][A-Za-z_$0-9]*\.id\)\|\|__oeResolvesThroughInstalledPackage\(/.test(runtimeLoaderSrc),
    `boundary: ${where} carries patch part 10 (OPE-2276, __oeResolvesThroughInstalledPackage, defined once and called ONLY from createRuntimeLoaderPackageBoundaryPlugin's node_modules route; found ${boundaryCalls} occurrence(s) of the call shape, want 2: the definition and one call). An unpatched copy of eve 1.0.0-rc.18 inlines the @open-everywhere packages into the authored graph, and \`eve build\` exits 13 (Node's unsettled top-level await) before it writes a build (OPE-2705). On eve 0.54.3 it cost 31 graph evaluations per cold build, about 140 s against 48 s (OPE-2276). A second call site, in the GENERATION plugin, would drop dynamic-tool callback stamps (OPE-2270)`,
  );
  ok(
    !boundarySrc.includes("globalThis.__oe"),
    `boundary: ${where}/${AUTHORED_PACKAGE_BOUNDARY} plants NO runtime marker — part 10 changes only eve's CLI-side evaluation of authored files, which the deployed server never runs, so its absence is not a reason for core to refuse a boot. A marker here needs an EVE_PATCH_PARTS row, and that row would turn a slow build into a refused wake`,
  );
  for (const part of EVE_PATCH_PARTS) {
    const carrierFile = join(eveDir, part.carrier);
    const carrierSrc = existsSync(carrierFile) ? readFileSync(carrierFile, "utf8") : "";
    ok(
      carrierSrc.includes(`globalThis.${part.marker}=!0;`),
      `markers: ${where}/${part.carrier} publishes \`${part.marker}\` (patch part ${part.part}) — without it ` +
        `core's boot probe refuses to serve a wake from this install, and the part it guards is silently ` +
        `absent: ${part.lost}`,
    );
  }
  const compactionFile = join(eveDir, COMPACTION);
  ok(
    existsSync(compactionFile) && existsSync(join(eveDir, COMPACTION_STEP)),
    `adjust: ${where}/${COMPACTION} and ${COMPACTION_STEP} exist (if eve moved the compaction engine, this tripwire and eve-compaction-anchor-test.ts are both stale)`,
  );
  const compactionSrc = existsSync(compactionFile) ? readFileSync(compactionFile, "utf8") : "";
  const compactionStepSrc = existsSync(join(eveDir, COMPACTION_STEP)) ? readFileSync(join(eveDir, COMPACTION_STEP), "utf8") : "";
  ok(
    !src.includes("tokenEstimateAdjustment"),
    `adjust: ${where} carries NO tokenEstimateAdjustment — the v1 engine anchors the trigger on the provider's count and scales its estimate by estimateRatio. An additive estimate adjustment on top of that double-counts the real-minus-estimate gap, so a red here means eve changed the correction and eve-compaction-anchor-test.ts must be re-derived`,
  );
  ok(
    /function getInputTokenCount\([^)]*\)\{let [A-Za-z_$]{1,2}=[A-Za-z_$]{1,2}\.lastKnownInputTokens;/.test(compactionSrc) &&
      /function shouldCompact\([^)]*\)\{return [A-Za-z_$]{1,2}\.length>0&&getInputTokenCount\(/.test(compactionSrc),
    `adjust: ${where} anchors the compaction trigger on the provider's reported input-token count (getInputTokenCount reads lastKnownInputTokens, and shouldCompact reads getInputTokenCount). Without the anchor the trigger counts JSON.stringify/4 and a dense session never compacts`,
  );
  ok(
    /let reachesTarget=[A-Za-z_$]{1,2}=>Math\.ceil\(estimateTokens\([A-Za-z_$]{1,2}\)\*[A-Za-z_$]{1,2}\)<=[A-Za-z_$]{1,2}\.target;/.test(compactionSrc),
    `adjust: ${where} accepts a kept tail only when its estimate, scaled by the session's estimateRatio, reaches the target (half the window). Without it a compaction can leave the history over the threshold, and the next call compacts again`,
  );
  const heuristicAt = compactionSrc.indexOf("async function fixedTailHeuristic(");
  const heuristicSrc = heuristicAt < 0 ? "" : compactionSrc.slice(heuristicAt, compactionSrc.indexOf("function overLimitError(", heuristicAt));
  const summarizeAt = heuristicSrc.search(/=await [A-Za-z_$]{1,2}\(\{messages:\[createFrameworkUserMessage\(`context\.compaction`/);
  const firstReturnAt = heuristicSrc.search(/return\{messages:/);
  ok(
    summarizeAt > 0 && firstReturnAt > summarizeAt &&
      compactionSrc.includes("const COMPACTION_HEURISTICS=[fixedTailHeuristic];") &&
      /if\([A-Za-z_$]{1,2}\.type===`compacted`\)return\{messages:[A-Za-z_$]{1,2}\.messages,stage:[A-Za-z_$]{1,2}\.stage\}\}throw overLimitError\(/.test(compactionSrc),
    `adjust: ${where} has NO no-op path — fixedTailHeuristic is the only compaction heuristic, it calls the summary model before its first return, and compactMessages throws rather than return the input when no heuristic compacts. A return ahead of the summary call is the 0.x no-op exit that wedged a dense session (OPE-689)`,
  );
  ok(
    /if\(!shouldCompact\([^)]*\)\)return;/.test(compactionStepSrc) &&
      /let summarize=async [A-Za-z_$]{1,2}=>\{await [A-Za-z_$]{1,2}\.open\(\)/.test(compactionStepSrc) &&
      /let ([A-Za-z_$]{1,2})=isDeepStrictEqual\([A-Za-z_$]{1,2},[A-Za-z_$]{1,2}\);if\([A-Za-z_$]{1,2}\.opened&&await settleChange\([^;]*\),\1\)return;let [A-Za-z_$]{1,2}=changeHistory\(/.test(compactionStepSrc),
    `adjust: ${where}/${COMPACTION_STEP} compacts before a model call only past the trigger, the summary call opens the context change before the model runs, and the step settles a change only when it opened one and rewrites the history only when the result differs from the input. So a pre-call pass under the trigger publishes no context event`,
  );
  ok(
    !compactionSrc.includes("__oeAnchoredConfig(") && !compactionSrc.includes("__oeNoteNoOpCompaction("),
    `adjust: ${where} carries NO part-3 helper — the hunk is retired, and a re-roll that ports it back would patch upstream's fix on top of itself`,
  );
  const compiledZodDir = join(eveDir, "dist", "src", "compiled", "zod");
  ok(
    existsSync(compiledZodDir),
    `zod: ${where}/dist/src/compiled/zod exists — that is where eve vendors the zod behind \`#compiled/zod\` as of 0.66.0. If eve moved or dropped the bundle, re-read dist/src/tools/schema.js and re-derive which zod builds a tool schema before relaxing this gate (OPE-1751)`,
  );
  const toolSchemaFile = join(eveDir, "dist", "src", "tools", "schema.js");
  ok(
    existsSync(toolSchemaFile),
    `zod: ${where}/dist/src/tools/schema.js exists — it is the module that decides what a tool schema becomes before the model call, and the whole OPE-1751 derivation reads it`,
  );
  const zodRehydrators = eveSourceFiles(eveDir).filter((rel) => readFileSync(join(eveDir, rel), "utf8").includes("fromJSONSchema"));
  ok(
    zodRehydrators.length === 0,
    `zod: no eve module outside dist/src/compiled/ calls \`fromJSONSchema\` — found ${zodRehydrators.join(", ")}. eve 0.66.0 passes tool schemas only as JSON Schema, which is what makes the root-vs-vendored zod skew unreachable through the tool path; a caller coming back means OPE-1751's version-equality rule must be restored, with a readable version for eve's vendored copy`,
  );
  ok(
    /^4\./.test(rootZodVersion),
    `zod: the root zod is a v4 (found ${rootZodVersion}) — \`overrides.zod\` pins it for every package that declares zod exactly (@agent-browser/eve, @vercel/cli-config), which is what stops npm nesting a private copy. Confirm with \`npm ls zod\`: one version, exit 0 (OPE-1751)`,
  );
  for (const dead of RETIRED) {
    ok(
      !src.includes(dead.symbol),
      `absent: ${where} must NOT contain \`${dead.symbol}\` — ${WHY[dead.why]}. A re-roll that ports an old __oe* block wholesale drags it back; on eve 1.0.0-rc.18 port ONLY part 10 (OPE-2691)`,
    );
  }
  {
    const request = join(eveDir, WEB_FETCH_REQUEST);
    ok(existsSync(request), `dropped: ${where}/${WEB_FETCH_REQUEST} exists (if eve moved the file, this row is stale)`);
    ok(
      !readFileSync(request, "utf8").includes("__oeWebFetchHop"),
      `dropped: ${where}/${WEB_FETCH_REQUEST} must NOT contain \`__oeWebFetchHop\` — patch part 7 was dropped at OPE-2688, and its helper refuses every redirect when no guard is installed. Restore patches/ from git and reinstall eve`,
    );
  }
  for (const hunk of CARRIAGE) {
    const file = join(eveDir, hunk.rel);
    ok(existsSync(file), `carriage: ${where}/${hunk.rel} exists (if eve moved the file, the restore hunk and this gate are stale)`);
    ok(
      hunk.test(readFileSync(file, "utf8")),
      `carriage: ${where}/${hunk.rel} carries the turnPolicy restore (OPE-448, upstream vercel/eve#2172) — ${hunk.what}. Re-apply the restore hunks, or drop them deliberately only once upstream has fixed the root`,
    );
  }
  for (const pin of SEMANTICS) {
    const file = join(eveDir, pin.rel);
    ok(existsSync(file), `semantics: ${where}/${pin.rel} exists (if eve moved the file, the OPE-574 admission hooks and this gate are stale)`);
    ok(
      pin.test(readFileSync(file, "utf8")),
      `semantics: ${where}/${pin.rel} still behaves as OPE-574 assumed — ${pin.what}. Re-read packages/core/agent/approvals/input-response-floor.ts and both channel hooks against this eve before deploying`,
    );
  }
}

console.log(
  `\n✓ eve-install-integrity: ${n} assertions passed (${pins.length} pins all @${pinned}, patch file present, ${copies.length} installed cop${copies.length === 1 ? "y carries" : "ies carry"} patch part 10 and no part 1 or part 4 symbol, eve's own compaction anchor (part 3 retired), all ${CARRIAGE.length} turnPolicy restore hunks and all ${SEMANTICS.length} HITL-answer semantics, and none of the ${RETIRED.length} retired symbols; root zod @${rootZodVersion}, and no eve module rehydrates a tool schema with eve's vendored zod)\n`,
);
