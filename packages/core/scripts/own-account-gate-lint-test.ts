import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialGrantConnectors } from "../agent/access/credential-grant.js";
import {
  checkOwnAccountGateSites,
  findOwnAccountGateSites,
  OWN_ACCOUNT_GATE_CALL,
  OWN_ACCOUNT_GATE_MARKER,
  type OwnAccountGateFile,
} from "../agent/access/own-account-gate-manifest.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const gated = (connector: string): string =>
  [
    "export async function assertActingIdentity(ctx: BindableContext, tool: string): Promise<void> {",
    `  // ${OWN_ACCOUNT_GATE_MARKER} ${connector} — the marker the lint reads.`,
    `  const verdict = await ${OWN_ACCOUNT_GATE_CALL}(ctx, VENDOR, tool);`,
    "  if (verdict.refusal !== undefined) throw new Error(verdict.refusal);",
    "}",
  ].join("\n");

{
  const files: OwnAccountGateFile[] = [{ file: "a/notion-acting-identity.ts", source: gated("notion") }];
  eq(checkOwnAccountGateSites(files, ["notion"]), [], "a marked gate for the one admitted connector is clean");
  const sites = findOwnAccountGateSites(files);
  eq(sites.length, 1, "…and the checker really saw one call — an empty scan would pass every case below vacuously");
  eq(sites[0]?.connector, "notion", "…joined to the connector its marker declared");
}

{
  const files: OwnAccountGateFile[] = [{ file: "a/notion-acting-identity.ts", source: gated("notion") }];
  const problems = checkOwnAccountGateSites(files, ["linear", "notion"]);
  eq(problems.length, 1, "🔴 a connector added to CREDENTIAL_GRANT_ROLES with no gated read site is ONE problem");
  ok(problems[0]?.includes("linear"), "…and the message names the connector that is unguarded");
  ok(problems[0]?.includes("CREDENTIAL_GRANT_ROLES"), "…and the list it was added to");
  ok(problems[0]?.includes(OWN_ACCOUNT_GATE_CALL), "…and tells the author which call to add");
}

{
  const source = `  const verdict = await ${OWN_ACCOUNT_GATE_CALL}(ctx, VENDOR, tool);`;
  const problems = checkOwnAccountGateSites([{ file: "a/unmarked.ts", source }], []);
  eq(problems.length, 1, "an unmarked gate call is a problem on its own");
  ok(problems[0]?.startsWith("a/unmarked.ts:1 —"), "…reported at its file and line");
  const both = checkOwnAccountGateSites([{ file: "a/unmarked.ts", source }], ["notion"]);
  eq(both.length, 2, "🔴 an unmarked call covers no connector — the ungated-connector arm still fires beside it");
}

{
  const problems = checkOwnAccountGateSites([{ file: "a/stale.ts", source: gated("dropbox") }], ["notion"]);
  eq(problems.length, 2, "a stale gate reds twice: the marked connector is not admitted, and the admitted one is not gated");
  ok(
    problems.some((p) => p.includes("dropbox") && p.includes("NEITHER list recognises") && p.includes("only ever REFUSE")),
    "…and one message says what a stale join actually does: the gate still recognises the ask, and can only refuse it",
  );
}

{
  const files: OwnAccountGateFile[] = [
    { file: "a/notion-acting-identity.ts", source: gated("notion") },
    { file: "b/github-acting-identity.ts", source: gated("github") },
  ];

  eq(
    checkOwnAccountGateSites(files, ["notion"], ["github"]),
    [],
    "🔴 a gate for a connector that only DECLARES humanActing.supported is clean — it refuses by design",
  );

  const undeclared = checkOwnAccountGateSites(files, ["notion"], []);
  eq(undeclared.length, 1, "🔴 …and the SAME gate reds when nothing declares humanActing.supported for it");
  ok(undeclared[0]?.includes("github"), "…naming the connector neither list recognises");
  ok(undeclared[0]?.includes("human-acting"), "…and telling the author the second route out");

  const neither = checkOwnAccountGateSites(
    [...files, { file: "c/stale.ts", source: gated("dropbox") }],
    ["notion"],
    ["github"],
  );
  eq(neither.length, 1, "🔴 a gate for a connector in NEITHER list is still a stale join");
  ok(neither[0]?.includes("dropbox"), "…and it is the unrecognised connector that reds, not the declared one");
  ok(!neither[0]?.includes("github"), "…the declared connector is not swept in with it");

  eq(
    checkOwnAccountGateSites(files, ["notion"]).length,
    1,
    "🔴 omitting humanActingConnectors reds — the parameter defaults to the strict reading, never to a pass",
  );

  const bothLists = checkOwnAccountGateSites(files, ["notion", "linear"], ["github", "linear"]);
  eq(bothLists.length, 1, "🔴 a connector in CREDENTIAL_GRANT_ROLES with no gated site still reds, humanActing or not");
  ok(bothLists[0]?.includes("linear"), "…naming the ungated connector");
  ok(bothLists[0]?.includes("CREDENTIAL_GRANT_ROLES"), "…and it is rule 1 that fired, not rule 3");
}

{
  const source = [
    `// ${OWN_ACCOUNT_GATE_MARKER} notion`,
    "const somethingElse = 1;",
    `const verdict = await ${OWN_ACCOUNT_GATE_CALL}(ctx, VENDOR, tool);`,
  ].join("\n");
  const sites = findOwnAccountGateSites([{ file: "a/detached.ts", source }]);
  eq(sites.length, 1, "the call is still found");
  eq(sites[0]?.connector, undefined, "🔴 …but the marker above the statement is NOT inherited by it");
}

{
  const commentedOut = [
    "export async function assertActingIdentity(ctx: BindableContext, tool: string): Promise<void> {",
    `  // ${OWN_ACCOUNT_GATE_MARKER} notion — the marker the lint reads.`,
    `  // const verdict = await ${OWN_ACCOUNT_GATE_CALL}(ctx, VENDOR, tool);   // TODO: put this back`,
    "}",
  ].join("\n");
  eq(findOwnAccountGateSites([{ file: "a/commented.ts", source: commentedOut }]), [], "a commented-out gate call is not a call site");
  const problems = checkOwnAccountGateSites([{ file: "a/commented.ts", source: commentedOut }], ["notion"]);
  eq(problems.length, 1, "🔴 …so the connector reads as UNGATED and rule 1 reds — a marker over dead text vouches for nothing");
  ok(problems[0]?.includes("notion"), "…naming the connector left unguarded");

  const quoted = [
    "const banner = `call ${OWN} or await connectorActingIdentityForTurn(ctx, VENDOR, tool) first`;",
    `const doc = "await ${OWN_ACCOUNT_GATE_CALL}(ctx, VENDOR, tool)";`,
    `const note = 'await ${OWN_ACCOUNT_GATE_CALL}(ctx, VENDOR, tool)';`,
  ].join("\n");
  eq(findOwnAccountGateSites([{ file: "a/quoted.ts", source: quoted }]), [], "a quoted gate call — template, double or single quoted — is not a call site either");

  const blockComment = ["/**", ` * await ${OWN_ACCOUNT_GATE_CALL}(ctx, VENDOR, tool);`, " */"].join("\n");
  eq(findOwnAccountGateSites([{ file: "a/block.ts", source: blockComment }]), [], "…nor is one inside a block comment");

  const afterComment = ["/* a note", "   spanning two lines */", `await ${OWN_ACCOUNT_GATE_CALL}(ctx, VENDOR, tool);`].join("\n");
  const real = findOwnAccountGateSites([{ file: "a/after.ts", source: afterComment }]);
  eq(real.length, 1, "🔴 the blanking does not hide a REAL call — otherwise every case above would pass vacuously");
  eq(real[0]?.line, 3, "…and it keeps the line number the source has");
}

{
  const source = [
    `import { ${OWN_ACCOUNT_GATE_CALL} } from "./own-account-gate.js";`,
    `export { ${OWN_ACCOUNT_GATE_CALL} } from "./connections/own-account-gate.js";`,
    `export async function ${OWN_ACCOUNT_GATE_CALL}(ctx: BindableContext, vendor: OwnAccountVendor, tool: string) {`,
    "  return decide();",
    "}",
    `/** See {@link ${OWN_ACCOUNT_GATE_CALL}} for the live binding. */`,
  ].join("\n");
  eq(findOwnAccountGateSites([{ file: "a/own-account-gate.ts", source }]), [], "the binding's own declaration, import, re-export and doc link are not call sites");
}

{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const tsFilesUnder = (dir: string): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of entries) {
      if (name === "node_modules" || name === "dist" || name === "generated") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
    }
    return out;
  };
  const roots = [join(root, "packages", "core", "agent"), join(root, "agent")];
  for (const p of readdirSync(join(root, "packages", "providers"))) {
    const agentDir = join(root, "packages", "providers", p, "agent");
    try {
      if (statSync(agentDir).isDirectory()) roots.push(agentDir);
    } catch {
    }
  }
  const files: OwnAccountGateFile[] = [];
  for (const dir of roots) for (const full of tsFilesUnder(dir)) files.push({ file: relative(root, full), source: readFileSync(full, "utf8") });

  const connectors = credentialGrantConnectors();
  ok(connectors.length > 0, "the reviewed list is not empty — an empty one would make the real-tree check vacuous");

  const declaredByTree = findOwnAccountGateSites(files)
    .map((s) => s.connector)
    .filter((c): c is string => c !== undefined);
  eq(
    checkOwnAccountGateSites(files, connectors, declaredByTree),
    [],
    "🔴 the shipped tree gates every connector it admits a credential grant for, and every gate names its connector",
  );
  ok(findOwnAccountGateSites(files).length > 0, "…and the scan really found the shipped gate call(s)");
  ok(declaredByTree.includes("notion"), "…including the notion gate, so `declaredByTree` is a real set and not an empty one");
}

console.log(`own-account-gate-lint: ${n} assertions passed.`);
