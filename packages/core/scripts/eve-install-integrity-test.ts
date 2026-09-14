import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    "the OE addition (the __oeProjectToolSet untrusted-output projection) is silently absent from it.",
);
n++;
ok(/^\d+\.\d+\.\d+$/.test(pinned), `pins: eve is pinned to an EXACT version (got "${pinned}") — a range would let the installed bytes drift off the patch`);

const patchFile = join(repoRoot, "patches", `eve+${pinned}.patch`);
ok(
  existsSync(patchFile),
  `patch: patches/eve+${pinned}.patch exists for the pinned version — a pin bump that leaves the ` +
    `patch filename behind makes patch-package silently skip the OE hooks (found: ${readdirSync(join(repoRoot, "patches")).filter((f) => f.startsWith("eve+")).join(", ") || "none"})`,
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
const COMPACTION = join("dist", "src", "harness", "compaction.js");
const SESSION_TASK_INDEX = join("dist", "src", "tasks", "session-index.js");

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
      /onInputResponse\?\?defaultOnInputResponse/.test(s) &&
      /function defaultOnInputResponse\([A-Za-z_$][A-Za-z_$0-9]*\)\{return\{auth:[A-Za-z_$][A-Za-z_$0-9]*\.defaultAuth\}\}/.test(s),
    what:
      "an OMITTED Slack `onInputResponse` accepts the submitting user unconditionally. This is the hole OPE-574 closes; if eve ever tightens the default, packages/providers/slack/agent/channels/slack-input-response.ts is still the authority but its header stops being true",
  },
  {
    rel: join("dist", "src", "public", "channels", "slack", "interactions.js"),
    test: (s: string): boolean => /authorizeInputResponse\([^;]*\);if\([A-Za-z_$][A-Za-z_$0-9]*!==null\)\{/.test(s),
    what:
      "a `null` result from `onInputResponse` skips the `respond()` that resolves the parked batch, so a refusal leaves the request pending. If this guard goes, a refused answer would resolve the turn anyway",
  },
  {
    rel: join("dist", "src", "public", "channels", "teams", "teamsChannel.js"),
    test: (s: string): boolean =>
      /onInputResponse\?\?\([A-Za-z_$][A-Za-z_$0-9]*\.onMessage===void 0\?defaultOnInputResponse:rejectInput\)/.test(s) &&
      /function rejectInput\(\)\{return null\}/.test(s),
    what:
      "on Teams the default is CONDITIONAL: authoring `onMessage` (which OE does) makes an omitted `onInputResponse` reject every answer silently. This is why the Teams arm of OPE-574 opens a path rather than narrowing one",
  },
  {
    rel: join("dist", "src", "public", "channels", "teams", "teamsChannel.js"),
    test: (s: string): boolean =>
      /onInputResponse\([A-Za-z_$][A-Za-z_$0-9]*,[A-Za-z_$][A-Za-z_$0-9]*\.activity\)\}catch/.test(s) &&
      /Teams input response authorization failed/.test(s) &&
      /if\([A-Za-z_$][A-Za-z_$0-9]*!==null\)try\{await [A-Za-z_$][A-Za-z_$0-9]*\.from\(/.test(s),
    what:
      "a THROWN Teams hook is swallowed and the answer dropped, and a `null` result skips `respond()`. Both are why packages/providers/teams/agent/channels/teams-input-response.ts must fail OPEN rather than let an error escape",
  },
] as const;

const WHY: Record<string, string> = {
  "OPE-172": "the force-tool-turn nudge was retired in OPE-172 (gated on an env var that was never set anywhere, so it never ran once)",
  "OPE-407":
    "the per-turn step ceiling LEFT the patch in OPE-407 and lives in userland at packages/core/agent/model/step-boundary.ts (two-tier: a wrap-up instruction at the budget, a text-only stub at the backstop). Porting it back would regress behaviour — the bytes could only stop the loop mutely",
};

for (const eveDir of copies) {
  const where = rel(eveDir);
  const version = (JSON.parse(readFileSync(join(eveDir, "package.json"), "utf8")) as { version?: string }).version;
  ok(
    version === pinned,
    `copies: ${where} is eve@${version} but the tree pins ${pinned} — a version-skewed copy is unpatched and can be resolved by anything that imports eve from inside that package`,
  );
  const toolLoop = join(eveDir, TOOL_LOOP);
  ok(existsSync(toolLoop), `copies: ${where}/${TOOL_LOOP} exists (if eve moved the harness file, the patch and every sibling test are stale)`);
  const src = readFileSync(toolLoop, "utf8");
  ok(
    src.includes("__oeProjectToolSet"),
    `copies: ${where} carries the __oeProjectToolSet hook (OPE-73) — an unpatched copy means connector and MCP results reach the model unfenced (prompt-injection containment regression) and every seat cut is lost: the lean seat, the job wake, the worker subtraction, the invoker-posture withdrawal and the \`agent\` gate all run in that hook`,
  );
  ok(
    src.includes("__oeCompactionReduced(") && src.includes("__oeWithReduced("),
    `copies: ${where} carries the compaction event-contract stamp (OPE-697, __oeCompactionReduced + __oeWithReduced) — without it maybeCompact emits compaction.completed with no \`reduced\` field, so a pass that returned the history unchanged is indistinguishable from a real summary`,
  );
  ok(
    src.includes("__oeThrowEmptyResponseUnlessTerminal(") && !src.includes("throw new EmptyModelResponseError;"),
    `copies: ${where} carries the empty-step terminal guard (OPE-762, __oeThrowEmptyResponseUnlessTerminal) on BOTH throw sites — an unpatched copy reissues the model call with "Your previous reply was empty and was not delivered" after every correctly-silent turn, so the seat replies to the wake it just declined`,
  );
  ok(
    src.includes("__oeProjectModelMessages(validateHarnessModelMessages(normalizeModelMessages("),
    `copies: ${where} carries the model-message projection seam (OPE-1396, part 6) WRAPPING normalizeModelMessages — this is the only seam that hands OE the list the model actually reads, so an unpatched copy takes OPE-593's \`[Agents]\` subtraction off the model call and the seat learns a live worker \`agentId\` from the listing`,
  );
  const taskIndexFile = join(eveDir, SESSION_TASK_INDEX);
  ok(
    existsSync(taskIndexFile),
    `cohort: ${where}/${SESSION_TASK_INDEX} exists (if eve moved the task index, patch part 8 and packages/core/scripts/task-cohort-starvation-test.ts are both stale)`,
  );
  const taskIndexSrc = existsSync(taskIndexFile) ? readFileSync(taskIndexFile, "utf8") : "";
  ok(
    taskIndexSrc.includes("function __oeTaskCohortJoin(") && /else\{let [A-Za-z_$][A-Za-z_$0-9]*=__oeTaskCohortJoin\(/.test(taskIndexSrc),
    `cohort: ${where} carries patch part 8 (OPE-1856, __oeTaskCohortJoin AND its call site in recordSessionTask) — an unpatched copy gives a new task the cohort of the first task with no terminal view WHATEVER TURN IT CAME FROM, so one worker parked on an unanswered question starves every later delegation settlement on that seat for the life of the session (measured on deploy #212: two workers completed, neither ever settled, no completing reply)`,
  );
  const compactionFile = join(eveDir, COMPACTION);
  ok(
    existsSync(compactionFile),
    `adjust: ${where}/${COMPACTION} exists (if eve moved the harness file, this tripwire and eve-compaction-anchor-test.ts are both stale)`,
  );
  const compactionSrc = existsSync(compactionFile) ? readFileSync(compactionFile, "utf8") : "";
  ok(
    compactionSrc.includes("tokenEstimateAdjustment"),
    `adjust: ${where} carries eve's OWN tokenEstimateAdjustment (landed 0.52.3) — without it the work step re-decides with JSON.stringify/4 while the trigger counted the provider's real token figure, so a dense session emits compaction.completed having compacted NOTHING and the generation wedges. OE's part-3 hunk was retired against this; a red here means it must be restored`,
  );
  ok(
    !compactionSrc.includes("__oeAnchoredConfig(") && !compactionSrc.includes("__oeNoteNoOpCompaction("),
    `adjust: ${where} carries NO part-3 helper — the hunk is retired, and a re-roll that ports it back would patch upstream's fix on top of itself`,
  );
  const pnpmDir = join(eveDir, "dist", "src", "node_modules", ".pnpm");
  ok(
    existsSync(pnpmDir),
    `zod: ${where}/dist/src/node_modules/.pnpm exists — that is where eve vendors the zod behind \`#compiled/zod\`. If eve stopped vendoring (or moved the directory), re-read dist/src/tools/schema.js and re-derive which zod rehydrates an MCP inputSchema before relaxing this gate (OPE-1751)`,
  );
  const vendoredZod4 = existsSync(pnpmDir)
    ? readdirSync(pnpmDir)
        .filter((d) => /^zod@4\./.test(d))
        .map((d) => d.slice("zod@".length))
        .sort()
    : [];
  ok(
    vendoredZod4.length === 1,
    `zod: ${where} vendors exactly ONE zod v4 under dist/src/node_modules/.pnpm — found ${vendoredZod4.length === 0 ? "none" : vendoredZod4.join(", ")}. \`#compiled/zod\` is the v4 copy (it exports fromJSONSchema); with two of them this gate cannot say which one rehydrates a tool schema (OPE-1751)`,
  );
  const eveVendoredZod = vendoredZod4[0];
  ok(
    typeof eveVendoredZod === "string" && rootZodVersion === eveVendoredZod,
    `zod: root zod ${rootZodVersion} != eve's vendored zod ${eveVendoredZod ?? "unknown"} — every session that mounts a connector tool with an allOf dies (OPE-1751). Pin the root zod to ${eveVendoredZod ?? "eve's vendored version"} exactly: the version in every package.json that declares zod AND the root \`overrides.zod\`, which is what stops npm nesting a private copy for the packages that pin zod exactly (@agent-browser/eve, @vercel/cli-config). Then \`npm install\` and confirm \`npm ls zod\` shows one version and exits 0`,
  );
  for (const dead of RETIRED) {
    ok(
      !src.includes(dead.symbol),
      `absent: ${where} must NOT contain \`${dead.symbol}\` — ${WHY[dead.why]}. A re-roll that ports an old __oe* block wholesale drags it back; port ONLY the __oeProjectToolSet projection helper and its one call site`,
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
  `\n✓ eve-install-integrity: ${n} assertions passed (${pins.length} pins all @${pinned}, patch file present, ${copies.length} installed cop${copies.length === 1 ? "y carries" : "ies carry"} the OE projection hook, the compaction event-contract stamp, a PRISTINE compaction.js (part 3 retired), all ${CARRIAGE.length} turnPolicy restore hunks and all ${SEMANTICS.length} HITL-answer semantics, and none of the ${RETIRED.length} retired symbols; root zod @${rootZodVersion} matches eve's vendored zod)\n`,
);
