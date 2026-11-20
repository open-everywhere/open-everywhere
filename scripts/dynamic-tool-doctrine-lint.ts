import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { codeOnly } from "./tidy/test-runner-inventory.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function agentTrees(): string[] {
  const trees = [join(REPO, "agent")];
  for (const base of ["packages", join("packages", "providers")]) {
    const dir = join(REPO, base);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "providers") continue;
      const tree = join(dir, entry, "agent");
      if (existsSync(tree)) trees.push(tree);
    }
  }
  return trees;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
}

const TOOLS_IMPORT = /import\s*\{[^}]*\bdefineDynamic\b[^}]*\}\s*from\s*"eve\/tools"/;
const HELPERS = /\b(?:sessionMountedTool|sessionVariantTool|windowGated|windowGatedKit)\s*\(/;
const HELPER_HOME = "packages/core/agent/access/window-gated.ts";

/**
 * The closed list of files that call eve's `defineDynamic(` directly and must NOT key their decision
 * with `memoized(`. Each entry names one file (no glob), the reason, and the test that fails if the
 * reason stops being true. The test carries the entry's marker in an assertion label, and this lint
 * checks that the named leg is in the package's test chain and runs a file that holds the marker. An entry whose file now calls
 * `memoized(`, or no longer calls `defineDynamic(`, is stale, and the lint refuses it.
 */
interface DoctrineExemption {
  readonly reason: string;
  /** The package that defines the leg, relative to the repository root. */
  readonly pkg: string;
  /** The npm script that runs the pinning test. */
  readonly leg: string;
}

const DOCTRINE_EXEMPTIONS: Readonly<Record<string, DoctrineExemption>> = {
  "packages/core/agent/access/seat-cut.ts": {
    reason:
      "The seat cut re-decides before each model call on purpose. A halt set in the middle of a session must remove " +
      "the halted tools on the very next model call (docs/security/control-plane.md). A seat memo would keep the " +
      "posture the session started with.",
    pkg: "packages/core",
    leg: "test:seat-cut",
  },
  "packages/core/agent/connections/connector-mount.ts": {
    reason:
      "The mount's listing is not stable for the session. Its own memo keys a good listing by session AND principal, " +
      "holds a refusal, a sign-in need or an anonymous listing for one turn only, and keeps no failed listing. " +
      "memoized(ctx, seatMemoKey(ctx), …) keys by session only, so a grant or a sign-in later in the session would " +
      "never reach the mount.",
    pkg: "packages/core",
    leg: "test:connector-mount",
  },
};

/** The text each pinning test carries in an assertion label. */
function exemptionMarker(file: string): string {
  return `[doctrine exemption: ${file}]`;
}

const problems: string[] = [];
let inScope = 0;
const exemptSeen = new Set<string>();

for (const tree of agentTrees()) {
  const files: string[] = [];
  walk(tree, files);
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const source = codeOnly(raw);
    const name = relative(REPO, file);
    const direct = TOOLS_IMPORT.test(raw) && source.includes("defineDynamic(");
    if (!direct && !HELPERS.test(source)) continue;
    inScope++;

    if (/defineDynamic\(\s*\{/.test(source)) {
      problems.push(
        `${name} passes an object to \`defineDynamic(\`. eve 1.x takes a function of the session, ` +
          "`defineDynamic(async (ctx) => value)`; the lifecycle-event map is gone.",
      );
    }

    const exemption = DOCTRINE_EXEMPTIONS[name];
    if (exemption !== undefined) {
      exemptSeen.add(name);
      if (!direct || source.includes("memoized(")) {
        problems.push(
          `${name} has a doctrine exemption, but it no longer calls \`defineDynamic(\` directly without \`memoized(\`. ` +
            "The exemption is stale: remove it from DOCTRINE_EXEMPTIONS.",
        );
      }
      continue;
    }

    if (direct && name !== HELPER_HOME && !source.includes("memoized(")) {
      problems.push(
        `${name} calls eve's \`defineDynamic(\` directly but never \`memoized(\`. eve runs a dynamic before EVERY model call, ` +
          "so a seat decision outside a memo can change in the middle of a session. Use sessionMountedTool / sessionVariantTool / " +
          "windowGated / windowGatedKit, or key the decision with memoized(ctx, seatMemoKey(ctx), …) from " +
          `${HELPER_HOME}.`,
      );
    }
  }
}

for (const [file, exemption] of Object.entries(DOCTRINE_EXEMPTIONS)) {
  if (/[*?[\]{}]/.test(file)) problems.push(`the doctrine exemption "${file}" is a pattern. An exemption names exactly one file.`);
  if (exemption.reason.trim().length === 0) problems.push(`the doctrine exemption for ${file} gives no reason.`);
  if (!exemptSeen.has(file)) {
    problems.push(`the doctrine exemption for ${file} names no dynamic tool file in an agent tree. Remove the stale exemption.`);
  }
  const manifest = join(REPO, exemption.pkg, "package.json");
  const scripts = existsSync(manifest) ? ((JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}) : {};
  const command = scripts[exemption.leg];
  if (command === undefined) {
    problems.push(`the doctrine exemption for ${file} names the leg ${exemption.pkg} \`${exemption.leg}\`, which does not exist.`);
    continue;
  }
  const chain = join(REPO, exemption.pkg, "test-chain.txt");
  const legs = existsSync(chain) ? readFileSync(chain, "utf8").split("\n").map((line) => line.trim()) : [];
  if (!legs.includes(exemption.leg)) {
    problems.push(
      `the doctrine exemption for ${file} names the leg ${exemption.pkg} \`${exemption.leg}\`, which is not in ` +
        `${exemption.pkg}/test-chain.txt. \`npm test\` would never run the pinning test.`,
    );
  }
  const marker = exemptionMarker(file);
  const testFiles = [...command.matchAll(/(?:^|\s)(\S+\.ts)\b/g)].map((m) => join(REPO, exemption.pkg, m[1]!)).filter((f) => existsSync(f));
  if (!testFiles.some((f) => readFileSync(f, "utf8").includes(marker))) {
    problems.push(
      `the doctrine exemption for ${file} has no pinning test: no file that ${exemption.pkg} \`${exemption.leg}\` runs carries ` +
        `"${marker}" in an assertion label. Pin the reason in a test that fails if the reason stops being true.`,
    );
  }
}

if (inScope === 0) {
  problems.push("the scan found NO dynamic tool file. That is a broken pattern, not a clean tree — check the patterns against how the tools are written today.");
}

if (problems.length > 0) {
  console.error(`dynamic tool doctrine: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log(
  `dynamic tool doctrine: ${inScope} dynamic tool files, all eve 1.x functions with a memoized seat, ` +
    `except ${exemptSeen.size} named exemption(s) that each carry a reason and a pinning test.`,
);
