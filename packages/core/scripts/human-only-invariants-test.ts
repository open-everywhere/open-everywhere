import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTECTED_HUMAN_ONLY_EXPORTS, findProtectedImports, type ProtectedImportSite } from "../agent/access/human-only-invariants-manifest.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const sitesIn = (src: string): ProtectedImportSite[] => findProtectedImports("fixture.ts", src);

{
  const clean = `
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";

export async function execute(input, ctx) {
  return requestApproval({ org: ctx.org, kind: "ticket.create", args: input, scopeKey: ctx.scopeKey, requestedBy: ctx.principalId, channelId: ctx.channelId }, {});
}`;
  ok(sitesIn(clean).length === 0, "synthetic: a propose-only tool (requestApproval/autoApprovedNote) is CLEAN");

  const decideDirect = `import { resolveApprovalClick } from "../approvals/flow.js";`;
  ok(sitesIn(decideDirect).length === 1, "synthetic: 🔴 a direct import of resolveApprovalClick from its own module is SEEN");
  ok(sitesIn(`const GLOB = "src/*";\n${decideDirect}`).length === 1, "synthetic: 🔴 OPE-2559: a `/*` inside a STRING hides no import below it");
  ok(sitesIn(`const SLASHES = /\\/*/;\n${decideDirect}`).length === 1, "synthetic: 🔴 OPE-2559: …nor does a `/*` inside a REGEX");
  ok(sitesIn(decideDirect)[0]!.name === "resolveApprovalClick", "synthetic: …reported under its own name");
  ok(
    sitesIn(decideDirect)[0]!.group.exportNames.includes("clickerMayDecide"),
    "synthetic: …grouped with clickerMayDecide/handleApprovalPayload — the whole decide surface, not just this one name",
  );

  const decideViaBarrel = `import { resolveApprovalClick, cardPosterFor } from "@open-everywhere/core/agent/adapter-api.js";`;
  ok(sitesIn(decideViaBarrel).length === 1, "synthetic: 🔴 the SAME import reached via the adapter-api barrel is SEEN too");
  ok(sitesIn(decideViaBarrel)[0]!.name === "resolveApprovalClick", "synthetic: …and only the protected name is flagged — cardPosterFor (an ordinary, unprotected co-import) is not");

  ok(sitesIn(`import { clickerMayDecide } from "../approvals/flow.js";`).length === 1, "synthetic: 🔴 clickerMayDecide is SEEN");

  ok(sitesIn(`import { handleApprovalPayload } from "../approvals/flow.js";`).length === 1, "synthetic: 🔴 handleApprovalPayload is SEEN");

  const trustWrite = `import { registerSurfaces } from "../identity/trust.js";`;
  ok(sitesIn(trustWrite).length === 1, "synthetic: 🔴 registerSurfaces (the trust registry's ONE write path) is SEEN");
  ok(sitesIn(trustWrite)[0]!.group.reason.includes("boot-time"), "synthetic: …grouped under the trust-registry reason");

  ok(sitesIn(`import { defineSurface } from "../identity/trust.js";`).length === 0, "synthetic: defineSurface (no side effect) is NOT flagged — only registerSurfaces is the write path");

  ok(sitesIn(`import Slack, { resolveApprovalClick } from "../approvals/flow.js";`).length === 1, "synthetic: 🔴 a combined default+named import (`import Default, { X } from`) is STILL seen");

  const aliased = `import { resolveApprovalClick as decideCard } from "../approvals/flow.js";`;
  ok(sitesIn(aliased).length === 1 && sitesIn(aliased)[0]!.name === "resolveApprovalClick", "synthetic: 🔴 a renamed import (`as decideCard`) is STILL seen, under its real name — an alias cannot launder the capability");

  const multiline = `
import {
  requestApproval,
  autoApprovedNote,
  resolveApprovalClick,
} from "../approvals/flow.js";`;
  ok(sitesIn(multiline).length === 1, "synthetic: a protected name buried in a multi-line import block is still SEEN");

  ok(sitesIn(`export { resolveApprovalClick } from "../approvals/flow.js";`).length === 1, "synthetic: a re-export (not just an import) of a protected name is SEEN too");

  const namespaceStatic = `
import * as flow from "../approvals/flow.js";
export async function execute(input, ctx) {
  return flow.resolveApprovalClick({ org: ctx.org, id: input.id, decision: "approve", clickerId: ctx.principalId });
}`;
  ok(sitesIn(namespaceStatic).length === 1 && sitesIn(namespaceStatic)[0]!.name === "resolveApprovalClick", "synthetic: 🔴 a static namespace import (`import * as flow`) FOLLOWED by `flow.resolveApprovalClick(...)` is SEEN — the review's first named gap");
  ok(sitesIn(`
import * as flow from "../approvals/flow.js";
export async function execute(input, ctx) {
  return flow.requestApproval({ org: ctx.org, kind: "x", args: input, scopeKey: ctx.scopeKey, requestedBy: ctx.principalId, channelId: ctx.channelId }, {});
}`).length === 0, "synthetic: the SAME namespace shape reaching only `flow.requestApproval` (an unprotected, legitimate propose call) is CLEAN");

  ok(sitesIn(`const { resolveApprovalClick } = await import("../approvals/flow.js");`).length === 1, "synthetic: 🔴 a destructured dynamic import — the review's second named gap — is SEEN");
  ok(sitesIn(`const { resolveApprovalClick } = import("../approvals/flow.js");`).length === 1, "synthetic: …and the bare (un-awaited, `.then`-style) form is SEEN too — `await` is not required syntactically");

  const dynamicNamespace = `
async function execute() {
  const flow = await import("../approvals/flow.js");
  return flow.clickerMayDecide(row, "U1", "slack", "T1");
}`;
  ok(sitesIn(dynamicNamespace).length === 1 && sitesIn(dynamicNamespace)[0]!.name === "clickerMayDecide", "synthetic: 🔴 a dynamic import bound to a plain const, then accessed by member (`flow.clickerMayDecide`), is SEEN");

  ok(sitesIn(`return (await import("../identity/trust.js")).registerSurfaces(next);`).length === 1, "synthetic: 🔴 an inline dynamic import accessed with no binding (`(await import(...)).registerSurfaces(...)`) is SEEN");

  ok(sitesIn(`const label = row.resolveApprovalClick ? "carded" : "auto";`).length === 0, "synthetic: a `.resolveApprovalClick` PROPERTY READ on ordinary data (not a namespace handle) is not flagged — no alias was ever bound from an import");

  ok(sitesIn(`// this tool must never import resolveApprovalClick or registerSurfaces`).length === 0, "synthetic: a name mentioned only in a COMMENT is not a site — otherwise this invariant's own documentation would fail its own lint");
  ok(
    sitesIn(`
/**
 * See approvals/flow.ts's resolveApprovalClick for the decide core.
 */
import { requestApproval } from "../approvals/flow.js";`).length === 0,
    "synthetic: a block-comment mention above an UNRELATED clean import does not manufacture a site",
  );
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
function tsFilesUnder(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith("-test.ts")) out.push(full);
  }
  return out;
}
function isGitIgnored(dir: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", dir], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
{
  const toolRoots = [join(repoRoot, "packages", "core", "agent", "tools")];
  const providersDir = join(repoRoot, "packages", "providers");
  for (const p of readdirSync(providersDir)) {
    const t = join(providersDir, p, "agent", "tools");
    try {
      if (statSync(t).isDirectory()) toolRoots.push(t);
    } catch {
    }
  }
  const appTools = join(repoRoot, "agent", "tools");
  try {
    if (statSync(appTools).isDirectory() && !isGitIgnored(appTools)) toolRoots.push(appTools);
  } catch {
  }
  const files = toolRoots.flatMap(tsFilesUnder);
  ok(files.length > 30, `real: the scan actually read the tool roster (${files.length} files across ${toolRoots.length} dir(s)) — a green over an empty file list is a green produced by blindness`);
  ok(toolRoots.length >= 3, `real: at least core + two provider bundles ship a tools/ dir today (linear, notion, slack) — found ${toolRoots.length}`);
  ok(files.every((f) => !relative(repoRoot, f).startsWith(`agent${"/"}tools${"/"}`)), "real: 🔴 the GENERATED repo-root agent/tools/ stubs (oe build output, gitignored) are excluded from the scan — they are not source, and counting them would inflate the roster with re-export shims nobody authored");

  const sites = files.flatMap((f) => findProtectedImports(relative(repoRoot, f), readFileSync(f, "utf8")));
  ok(
    sites.length === 0,
    `real: 🔴 THE INVARIANT ITSELF — no agent-tool file imports a human-only export (${sites.map((s) => `${s.file}:${s.line} ${s.name}`).join(", ")})`,
  );

  const proposeMentions = files.filter((f) => readFileSync(f, "utf8").includes("requestApproval")).length;
  ok(proposeMentions >= 15, `real: the tool roster's propose side is still substantial (${proposeMentions} file(s) call requestApproval) — this is the population the invariant is ABOUT, and it should not collapse to zero`);
}

{
  ok(PROTECTED_HUMAN_ONLY_EXPORTS.length >= 2, "vocabulary: at least the two shipped surfaces (approval-decide, trust-write) are declared");
  const allNames = PROTECTED_HUMAN_ONLY_EXPORTS.flatMap((g) => g.exportNames);
  ok(allNames.includes("resolveApprovalClick") && allNames.includes("clickerMayDecide") && allNames.includes("handleApprovalPayload"), "vocabulary: the whole approval-decide surface is covered — the core decide function, the approver-standing check it calls, and the click route's entry point");
  ok(allNames.includes("registerSurfaces"), "vocabulary: the trust registry's write path is covered");
  ok(new Set(allNames).size === allNames.length, "vocabulary: no name is declared twice across groups — a duplicate would just mean the second group's reason never surfaces");
}

console.log(`✓ human-only-invariants: ${passed} assertions passed`);

// proves: AP-HUMANONLY-clickerMayDecide, AP-HUMANONLY-handleApprovalPayload, AP-HUMANONLY-registerSurfaces
// proves: AP-HUMANONLY-resolveApprovalClick, AP-MOD-core-access-human-only-invariants-manifest
