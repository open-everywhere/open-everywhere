import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
    `copies: ${where} carries the __oeProjectToolSet hook (OPE-73) — an unpatched copy means authored toModelOutput is dropped on session-mounted dynamic tools, so untrusted-content envelopes never reach the model (prompt-injection containment regression)`,
  );
  const compactionFile = join(eveDir, COMPACTION);
  ok(
    existsSync(compactionFile),
    `density: ${where}/${COMPACTION} exists (if eve moved the harness file, the OPE-689 hunk and eve-compaction-density-test.ts are both stale)`,
  );
  ok(
    readFileSync(compactionFile, "utf8").includes("__oeCompactionDensityConfig("),
    `density: ${where} carries the __oeCompactionDensityConfig correction (OPE-689) — without it compactMessages re-checks size with JSON.stringify/4 while shouldCompact counts the provider's real token figure, so a dense session emits compaction.completed having compacted NOTHING and the generation wedges`,
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
  `\n✓ eve-install-integrity: ${n} assertions passed (${pins.length} pins all @${pinned}, patch file present, ${copies.length} installed cop${copies.length === 1 ? "y carries" : "ies carry"} the OE projection hook, the compaction density correction, all ${CARRIAGE.length} turnPolicy restore hunks and all ${SEMANTICS.length} HITL-answer semantics, and none of the ${RETIRED.length} retired symbols)\n`,
);
