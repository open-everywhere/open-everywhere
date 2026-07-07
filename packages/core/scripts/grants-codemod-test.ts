import { assertBindingsValid, assertBundlesValid, type Binding, type Bundle, type Connection } from "../agent/access/bundle.js";
import { resolveAccess } from "../agent/access/resolver.js";
import { grantSentence, planAccessDelta, renderDelta, OUT_OF_VOCABULARY, type AccessDelta, type PlanContext } from "../agent/access/delta.js";
import {
  applyDelta,
  emptyGrantsFile,
  overlayBundleName,
  parseGrantsFile,
  parseGrantsText,
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
  { name: "notion", connections: [notionRest], connectors: ["notion"] },
  { name: "linear-basket", connectors: ["linear"] },
];
const codeBindings: Binding[] = [
  { bundle: "org-default", scope: { level: "org" } },
  { bundle: "notion", scope: { level: "channel", workspace: "T1", channel: "C1" } },
  { bundle: "linear-basket", scope: { level: "channel", workspace: "T1", channel: "C9" } },
];

const scope = { workspace: "T1", channel: "C1" } as const;

function ctxFor(workspace: string, channel: string): PlanContext {
  return {
    scope: { workspace, channel },
    access: resolveAccess({ mode: "channel", platform: "slack", workspace, channel }, codeBundles, codeBindings),
    bundles: codeBundles,
  };
}

{
  const d = planAccessDelta({ kind: "widen-connection", connection: "notion-rest", addMethods: ["patch"], addPathPrefixes: ["/v1/pages"] }, ctxFor("T1", "C1"));
  ok(d.kind === "widen-connection", "widen: plans a widen-connection delta");
  if (d.kind === "widen-connection") {
    ok(d.addMethods.length === 1 && d.addMethods[0] === "PATCH", "widen: method uppercased + validated");
    ok(d.addPathPrefixes.length === 1 && d.addPathPrefixes[0] === "/v1/pages", "widen: prefix accepted");
    ok(d.baseConnection.id === "notion-rest" && d.baseConnection.secretRef === "NOTION_API_KEY", "widen: base connection frozen into the delta");
    ok(d.scope.workspace === "T1" && d.scope.channel === "C1", "widen: scope is the requesting scope");
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
  const bindings: Binding[] = [{ bundle: "b", scope: { level: "channel", workspace: "T1", channel: "C1" } }];
  const ctx: PlanContext = {
    scope,
    access: resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel: "C1" }, bundles, bindings),
    bundles,
  };
  throwsWith(() => planAccessDelta({ kind: "widen-connection", connection: "open", addMethods: ["POST"] }, ctx), "already allows every method", "widen: unrestricted methods → refuse");
  throwsWith(() => planAccessDelta({ kind: "widen-connection", connection: "open", addPathPrefixes: ["/x"] }, ctx), "already allows", "widen: unrestricted paths → refuse (adding would narrow)");
}

{
  const d = planAccessDelta({ kind: "grant-connector", connector: "linear" }, ctxFor("T1", "C1"));
  ok(d.kind === "grant-connector" && d.connector === "linear", "grant: plans a grant-connector delta for a defined, not-yet-effective connector");
  throwsWith(() => planAccessDelta({ kind: "grant-connector", connector: "notion" }, ctxFor("T1", "C1")), "already granted to this channel", "grant: refuses an already-effective connector");
  throwsWith(() => planAccessDelta({ kind: "grant-connector", connector: "jira" }, ctxFor("T1", "C1")), OUT_OF_VOCABULARY, "grant: undefined connector → human-PR fallback wording");
  throwsWith(() => planAccessDelta({ kind: "grant-connector" }, ctxFor("T1", "C1")), OUT_OF_VOCABULARY, "grant: missing connector name → human-PR fallback wording");
}

throwsWith(() => planAccessDelta({ kind: "add-repo" }, ctxFor("T1", "C1")), OUT_OF_VOCABULARY, "vocabulary: unknown kind (e.g. add-repo) refuses with the human-PR fallback");
throwsWith(
  () => planAccessDelta({ kind: "grant-connector", connector: "linear" }, { ...ctxFor("T1", "C1"), scope: { workspace: "slack/T1", channel: "C1" } }),
  "bare platform ids",
  "vocabulary: a surface-key scope (contains /) is refused defensively",
);

{
  const d = planAccessDelta({ kind: "grant-connector", connector: "linear" }, ctxFor("T1", "C1"));
  ok(grantSentence(d) === 'Grant connector "linear" to channel C1 (workspace T1)', "grantSentence: connector form");
  const w = planAccessDelta({ kind: "widen-connection", connection: "notion-rest", addMethods: ["PATCH"], addPathPrefixes: ["/v1/pages"] }, ctxFor("T1", "C1"));
  ok(grantSentence(w).includes("PATCH") && grantSentence(w).includes("/v1/pages") && grantSentence(w).includes("notion-rest"), "grantSentence: widen form names methods, prefixes, connection");
  ok(renderDelta(w).join("\n").includes("+ methods: PATCH"), "renderDelta: shows the exact additions");
}

{
  const good = parseGrantsText('{ "bundles": [], "bindings": [] }');
  ok(good.bundles.length === 0 && good.bindings.length === 0, "parse: empty grants file parses");
  const withComment = parseGrantsFile({ $comment: "docs", bundles: [], bindings: [] });
  ok(withComment.bundles.length === 0, "parse: $comment is tolerated (docs pointer in the data file)");
  throwsWith(() => parseGrantsText("nonsense"), "not valid JSON", "parse: garbage text refuses");
  throwsWith(() => parseGrantsFile({ bundles: [], bindings: [], extra: 1 }), "unknown top-level key", "parse: unknown top-level key refuses");
  throwsWith(() => parseGrantsFile({ bundles: [{ name: "sneaky" }], bindings: [] }), '"grants:"-prefixed name', "parse: non-namespaced bundle name refuses");
  throwsWith(
    () => parseGrantsFile({ bundles: [{ name: "grants:T1/C1", repos: ["a/b"] }], bindings: [] }),
    'has field "repos"',
    "parse: an overlay bundle carrying repos (outside v1 vocabulary) refuses",
  );
  throwsWith(
    () => parseGrantsFile({ bundles: [], bindings: [{ bundle: "grants:T1/C1", scope: { level: "workspace", workspace: "T1" } }] }),
    "must be channel-scoped",
    "parse: a non-channel overlay binding refuses (the overlay never binds wider)",
  );
  throwsWith(
    () => parseGrantsFile({ bundles: [{ name: "grants:T1/C1", connections: [{ id: "x" }] }], bindings: [] }),
    "malformed connection",
    "parse: a malformed connection refuses",
  );
}

{
  const messy: GrantsFile = {
    bundles: [
      { name: "grants:T1/C2", connectors: ["zeta", "alpha"] },
      { name: "grants:T1/C1", connections: [{ ...notionRest, methods: ["POST", "GET"], pathPrefixes: ["/v1/search", "/a"] }] },
    ],
    bindings: [
      { bundle: "grants:T1/C2", scope: { level: "channel", workspace: "T1", channel: "C2" } },
      { bundle: "grants:T1/C1", scope: { level: "channel", workspace: "T1", channel: "C1" } },
    ],
  };
  const text = stringifyGrants(messy);
  ok(text.endsWith("}\n"), "stringify: trailing newline");
  ok(text.indexOf('"grants:T1/C1"') < text.indexOf('"grants:T1/C2"'), "stringify: bundles sorted by name");
  ok(text.indexOf('"GET"') < text.indexOf('"POST"'), "stringify: methods in canonical HTTP order");
  ok(text.indexOf('"alpha"') < text.indexOf('"zeta"'), "stringify: connectors sorted");
  ok(text.indexOf('"/a"') < text.indexOf('"/v1/search"'), "stringify: pathPrefixes sorted");
  ok(stringifyGrants(parseGrantsText(text)) === text, "stringify: parse ∘ stringify is a fixpoint (round-trip stable)");
  const idPos = text.indexOf('"id"');
  ok(idPos >= 0 && idPos < text.indexOf('"credentialType"') && text.indexOf('"credentialType"') < text.indexOf('"secretRef"'), "stringify: canonical connection key order");
}

const grantLinear: AccessDelta = { kind: "grant-connector", scope, connector: "linear" };

{
  const r1 = applyDelta(emptyGrantsFile(), grantLinear);
  ok(r1.changed, "apply(grant): empty file → changed");
  ok(r1.bundleName === "grants:T1/C1" && overlayBundleName(scope) === "grants:T1/C1", "apply(grant): canonical overlay bundle name");
  ok(r1.grants.bundles.length === 1 && r1.grants.bundles[0].connectors?.join() === "linear", "apply(grant): connector landed in the overlay bundle");
  ok(r1.grants.bindings.length === 1 && r1.grants.bindings[0].scope.channel === "C1", "apply(grant): a channel binding for the requesting scope was created");

  ok(stringifyGrants(applyDelta(emptyGrantsFile(), grantLinear).grants) === stringifyGrants(r1.grants), "apply(grant): deterministic bytes");

  const r2 = applyDelta(r1.grants, grantLinear);
  ok(!r2.changed, "apply(grant): re-apply is a no-op (changed: false)");
  ok(stringifyGrants(r2.grants) === stringifyGrants(r1.grants), "apply(grant): re-apply leaves identical bytes");

  const r3 = applyDelta(r1.grants, { kind: "grant-connector", scope, connector: "asana" });
  ok(r3.changed && r3.grants.bundles.length === 1 && r3.grants.bundles[0].connectors?.join(",") === "asana,linear", "apply(grant): second connector joins the same overlay bundle, sorted");

  const r4 = applyDelta(r3.grants, { kind: "grant-connector", scope: { workspace: "T1", channel: "C2" }, connector: "linear" });
  ok(r4.changed && r4.grants.bundles.length === 2 && r4.bundleName === "grants:T1/C2", "apply(grant): a different scope gets its own overlay bundle");

  assertBundlesValid([...codeBundles, ...r4.grants.bundles]);
  assertBindingsValid([...codeBindings, ...r4.grants.bindings], [...codeBundles, ...r4.grants.bundles]);
  ok(true, "apply(grant): merged code+overlay config passes assertBundlesValid/assertBindingsValid");
}

{
  const multiBound: GrantsFile = {
    bundles: [{ name: "grants:T1/C1", connectors: ["linear"] }],
    bindings: [
      { bundle: "grants:T1/C1", scope: { level: "channel", workspace: "T1", channel: "C1" } },
      { bundle: "grants:T1/C1", scope: { level: "channel", workspace: "T1", channel: "C7" } },
    ],
  };
  const before = stringifyGrants(multiBound);

  const r = applyDelta(multiBound, { kind: "grant-connector", scope, connector: "asana" });
  ok(r.changed, "invariant: delta against a multi-bound canonical bundle still applies");
  ok(r.bundleName === "grants:T1/C1#2", "invariant: ...but into a FRESH single-bound clone bundle (#2), never the multi-bound one");
  const untouched = r.grants.bundles.find((b) => b.name === "grants:T1/C1");
  ok(JSON.stringify(untouched) === JSON.stringify(multiBound.bundles[0]), "invariant: the multi-bound bundle is byte-identical after the codemod");
  ok(stringifyGrants(multiBound) === before, "invariant: input file object untouched (pure)");
  const newBindings = r.grants.bindings.filter((b) => b.bundle === "grants:T1/C1#2");
  ok(newBindings.length === 1 && newBindings[0].scope.channel === "C1" && newBindings[0].scope.workspace === "T1", "invariant: the clone is bound to exactly the requesting scope");

  const r2 = applyDelta(multiBound, { kind: "grant-connector", scope, connector: "linear" });
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
  const here = resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel: "C1" }, merged.bundles, merged.bindings);
  ok(here.connections.find((c) => c.id === "notion-rest")?.methods?.includes("PATCH") === true, "apply(widen): requesting scope's effective access gained PATCH (narrowest-wins override)");
  const elsewhere = resolveAccess({ mode: "channel", platform: "slack", workspace: "T1", channel: "C9" }, merged.bundles, merged.bindings);
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
  () => applyDelta(emptyGrantsFile(), { kind: "grant-connector", scope: { workspace: "slack/T1", channel: "C1" }, connector: "x" }),
  "bare platform ids",
  "apply: refuses a surface-key scope",
);
ok(new GrantsCodemodError("x") instanceof Error, "GrantsCodemodError is an Error (refusal type is catchable)");

console.log(`grants-codemod-test: ${passed} assertions passed`);
