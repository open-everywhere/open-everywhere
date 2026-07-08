import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineDomain, domainMatchFor, modelRouteFor, statusVerbsFor, type Domain } from "../agent/memory/domain.js";
import {
  applyRoute,
  createDomainRoutedModel,
  type ModelBackend,
  type RoutableModel,
  type RoutedCallOptions,
  type RoutingDeps,
} from "../agent/model/routing.js";
import { stampModelCall, readModelStamp } from "../agent/model/model-stamp.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

{
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("eve/package.json"));
  const abs = (rel: string) => pathToFileURL(join(root, rel)).href;
  const keys = await import(abs("dist/src/context/keys.js"));
  const runtimeKeys = await import(abs("dist/src/runtime/sessions/runtime-context-keys.js"));
  ok(keys.AuthKey !== undefined, "eve still exports AuthKey (routing's ALS reach)");
  ok(keys.InitiatorAuthKey !== undefined, "eve still exports InitiatorAuthKey (routing's ALS reach)");
  ok(runtimeKeys.ChannelKey !== undefined, "eve still exports ChannelKey (routing's ALS reach)");
}

const C_TXN = "slack/T1/C_TXN";
const C_OTHER = "slack/T1/C_OTHER";
const DEFAULT_ID = "zai/glm-5.2";

const domains: Domain[] = [
  defineDomain({
    name: "org",
    match: "org",
    models: { primary: { id: DEFAULT_ID, providers: ["fireworks"], reasoning: "medium" }, utility: { id: "zai/glm-4.5-air" } },
  }),
  defineDomain({ name: "txn", channels: [C_TXN], models: { primary: { reasoning: "high" } } }),
];

ok(
  JSON.stringify(modelRouteFor("primary", C_OTHER, domains)) ===
    JSON.stringify({ id: DEFAULT_ID, providers: ["fireworks"], reasoning: "medium" }),
  "unassigned channel gets the org route",
);
const merged = modelRouteFor("primary", C_TXN, domains);
ok(merged.id === DEFAULT_ID && merged.reasoning === "high", "domain overlay merges FIELD-BY-FIELD (reasoning overridden, id inherited)");
ok(JSON.stringify(merged.providers) === JSON.stringify(["fireworks"]), "pin survives when the overlay does not change the id");
ok(modelRouteFor("utility", C_TXN, domains).id === "zai/glm-4.5-air", "utility role inherits org when domain has no utility route");
ok(JSON.stringify(modelRouteFor("primary", C_TXN, [])) === "{}", "no domains → empty route (agent static defaults)");

const domains2: Domain[] = [
  defineDomain({ name: "org", match: "org", models: { primary: { id: DEFAULT_ID, providers: ["fireworks"] } } }),
  defineDomain({ name: "exec", channels: [C_TXN], models: { primary: { id: "anthropic/claude-sonnet-5" } } }),
];
const swapped = modelRouteFor("primary", C_TXN, domains2);
ok(swapped.id === "anthropic/claude-sonnet-5" && swapped.providers === undefined, "changing id DROPS the inherited pin (an upstream pinned for one model is wrong for another)");
const repinned = modelRouteFor("primary", C_TXN, [
  domains2[0],
  defineDomain({ name: "exec", channels: [C_TXN], models: { primary: { id: "anthropic/claude-sonnet-5", providers: ["anthropic"] } } }),
]);
ok(JSON.stringify(repinned.providers) === JSON.stringify(["anthropic"]), "a route may pin its own providers with its own id");

ok(modelRouteFor("primary", C_TXN, [defineDomain({ name: "txn", channels: [C_TXN] })]).id === undefined, "domain without models + no org → empty route");

ok(domainMatchFor("dm", "internal") === "dm", "internal DM partner classifies to the dm criteria layer");
ok(domainMatchFor("dm", "external") === "public", "external DM partner classifies to the public criteria layer");
ok(domainMatchFor("channel", "external") === "public", "an externally-shared/guest channel classifies to public");
ok(domainMatchFor("channel", "internal") === undefined, "a normal internal channel classifies to no criteria layer");
ok(domainMatchFor("mpim", "internal") === undefined, "a group chat classifies to no criteria layer (execution-only, mirrors resolve.ts's mpim → NONE)");
ok(domainMatchFor("mpim", "external") === undefined, "a group chat classifies to no criteria layer regardless of trust");

const D_PARTNER = "slack/T1/D_PARTNER";
const dmDomains: Domain[] = [
  defineDomain({ name: "org", match: "org", models: { primary: { id: DEFAULT_ID, reasoning: "medium" } } }),
  defineDomain({ name: "dm", match: "dm", models: { primary: { id: "vendor/dm-model" } } }),
];
{
  const r = modelRouteFor("primary", D_PARTNER, dmDomains, [], "dm");
  ok(r.id === "vendor/dm-model" && r.reasoning === "medium", "a DM surface (surfaceMatch=dm) picks up the dm criteria domain's model, inheriting org's reasoning");
}
{
  const r = modelRouteFor("primary", D_PARTNER, dmDomains, [], undefined);
  ok(r.id === DEFAULT_ID && r.reasoning === "medium", "the same channel key WITHOUT surfaceMatch=dm does not see the dm criteria route (org only)");
}
{
  const withExplicit: Domain[] = [
    ...dmDomains,
    defineDomain({ name: "explicit", channels: [D_PARTNER], models: { primary: { id: "vendor/explicit-model" } } }),
  ];
  const r = modelRouteFor("primary", D_PARTNER, withExplicit, [], "dm");
  ok(r.id === "vendor/explicit-model", "an explicit domain still overrides the dm criteria layer");
}
{
  const pubDomains: Domain[] = [
    defineDomain({ name: "org", match: "org", models: { primary: { id: DEFAULT_ID } } }),
    defineDomain({ name: "public", match: "public", models: { primary: { id: "vendor/public-model" } } }),
  ];
  const r = modelRouteFor("primary", "slack/T1/C_GUEST", pubDomains, [], "public");
  ok(r.id === "vendor/public-model", "an external surface (surfaceMatch=public) picks up the public criteria domain's model");
  ok(modelRouteFor("primary", "slack/T1/C_GUEST", pubDomains, [], undefined).id === DEFAULT_ID, "the same channel without surfaceMatch=public falls back to org only");
}

{
  const domains = [defineDomain({ name: "team", channels: [C_TXN], statusVerbs: ["Reviewing"] })];
  const withoutParam = statusVerbsFor(C_TXN, domains);
  const withUndefinedMatch = statusVerbsFor(C_TXN, domains, [], undefined);
  ok(JSON.stringify(withoutParam) === JSON.stringify(withUndefinedMatch), "statusVerbsFor: an explicit undefined surfaceMatch reproduces the no-arg call exactly");
}

const turnCall: RoutedCallOptions = { prompt: [], reasoning: "medium" };
{
  const r = applyRoute({}, turnCall, DEFAULT_ID);
  ok(r.id === DEFAULT_ID && r.options === turnCall, "empty route → default id, options untouched (same reference)");
}
{
  const r = applyRoute({ id: "anthropic/claude-sonnet-5" }, turnCall, DEFAULT_ID);
  ok(r.id === "anthropic/claude-sonnet-5", "routed id wins");
  ok(r.options.reasoning === "medium", "no route reasoning → call reasoning untouched");
}
{
  const r = applyRoute({ reasoning: "high" }, turnCall, DEFAULT_ID);
  ok(r.options.reasoning === "high", "route reasoning overrides the call's");
  ok(turnCall.reasoning === "medium", "original call options not mutated");
}

interface FakeCall {
  id: string;
  options: RoutedCallOptions;
}
function fakeModel(id: string, calls: FakeCall[]): RoutableModel {
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: id,
    supportedUrls: {},
    doGenerate: async (options: RoutedCallOptions) => {
      calls.push({ id, options });
      return { ok: true };
    },
    doStream: async (options: RoutedCallOptions) => {
      calls.push({ id, options });
      return { ok: true };
    },
  };
}
function fakeDeps(
  surfaceKey: () => Promise<string | null>,
  domainList: () => readonly Domain[],
  calls: FakeCall[],
  backendMark = false,
): RoutingDeps {
  const backend: ModelBackend = {
    model: (id) => fakeModel(id, calls),
    applyOptions: (route, options, ids) =>
      backendMark ? { ...options, marked: { route, ids } } : options,
  };
  return { surfaceKey, domains: domainList, backend };
}

const calls: FakeCall[] = [];
const routed = createDomainRoutedModel("primary", { id: DEFAULT_ID }, fakeDeps(async () => C_TXN, () => domains2, calls, true));
ok(routed.modelId === DEFAULT_ID && routed.provider === "test", "wrapper reports the default identity");
await routed.doGenerate(turnCall);
ok(calls.length === 1 && calls[0].id === "anthropic/claude-sonnet-5", "doGenerate dispatches to the routed inner model");
{
  const marked = calls[0].options.marked as { route: { id?: string }; ids: { id: string; defaultId: string } };
  ok(marked.ids.id === "anthropic/claude-sonnet-5" && marked.ids.defaultId === DEFAULT_ID, "backend.applyOptions receives the route + both ids (vendor mapping seam)");
}
await routed.doStream(turnCall);
ok(calls.length === 2 && calls[1].id === "anthropic/claude-sonnet-5", "doStream dispatches to the routed inner model");

{
  const c: FakeCall[] = [];
  const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, fakeDeps(async () => C_OTHER, () => [defineDomain({ name: "exec", channels: [C_TXN], models: { primary: { id: "anthropic/claude-sonnet-5" } } })], c));
  await m.doGenerate(turnCall);
  ok(c[0].id === DEFAULT_ID, "surface in no routed domain → default model");
}

{
  const c: FakeCall[] = [];
  const base = fakeDeps(async () => D_PARTNER, () => dmDomains, c);
  const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, { ...base, surfaceMatch: async () => "dm" });
  await m.doGenerate(turnCall);
  ok(c[0].id === "vendor/dm-model", "wrapper: deps.surfaceMatch()='dm' routes a DM call through the dm criteria domain end-to-end");
}
{
  const c: FakeCall[] = [];
  const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, fakeDeps(async () => D_PARTNER, () => dmDomains, c));
  await m.doGenerate(turnCall);
  ok(c[0].id === DEFAULT_ID, "wrapper: no surfaceMatch dep at all → back-compat, org-only route (dm criteria layer never consulted)");
}
{
  const c: FakeCall[] = [];
  const base = fakeDeps(async () => D_PARTNER, () => dmDomains, c);
  const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, {
    ...base,
    surfaceMatch: async () => {
      throw new Error("match resolution exploded");
    },
  });
  await m.doGenerate(turnCall);
  ok(c[0].id === DEFAULT_ID, "wrapper: surfaceMatch() throwing → fail-soft, org-only route, no throw");
}

{
  const c: FakeCall[] = [];
  const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, fakeDeps(async () => null, () => domains2, c));
  await m.doGenerate(turnCall);
  ok(c[0].id === DEFAULT_ID, "null surface (no ALS) → default model, no throw");
}

{
  const c: FakeCall[] = [];
  const m = createDomainRoutedModel(
    "primary",
    { id: DEFAULT_ID },
    fakeDeps(
      async () => {
        throw new Error("als exploded");
      },
      () => domains2,
      c,
    ),
  );
  await m.doGenerate(turnCall);
  ok(c[0].id === DEFAULT_ID, "surface lookup failure → default model, no throw (fail-soft)");
}

{
  const c: FakeCall[] = [];
  const m = createDomainRoutedModel(
    "primary",
    { id: DEFAULT_ID },
    fakeDeps(
      async () => C_TXN,
      () => {
        throw new Error("config not registered");
      },
      c,
    ),
  );
  await m.doGenerate(turnCall);
  ok(c[0].id === DEFAULT_ID, "config failure → default model, no throw (fail-soft)");
}

{
  const made: string[] = [];
  const c: FakeCall[] = [];
  const base = fakeDeps(async () => C_TXN, () => domains2, c);
  const deps: RoutingDeps = {
    ...base,
    backend: {
      ...base.backend,
      model: (id) => {
        made.push(id);
        return fakeModel(id, c);
      },
    },
  };
  const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, deps);
  await m.doGenerate(turnCall);
  await m.doGenerate(turnCall);
  ok(made.filter((id) => id === "anthropic/claude-sonnet-5").length === 1, "inner model construction memoized per id");
}

{
  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
  const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));

  ok(readModelStamp() === null, "model-stamp: read outside a session context -> null (fail-soft)");
  stampModelCall("should-not-throw");
  ok(readModelStamp() === null, "model-stamp: a stamp attempted outside a session is a no-op");

  await contextStorage.run(new ContextContainer(), async () => {
    ok(readModelStamp() === null, "model-stamp: a fresh session starts unstamped");
    const c: FakeCall[] = [];
    const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, fakeDeps(async () => C_TXN, () => domains2, c));
    await m.doGenerate(turnCall);
    ok(readModelStamp() === "anthropic/claude-sonnet-5", "model-stamp: dispatch() stamps THIS call's resolved routed id");

    const c2: FakeCall[] = [];
    const utility = createDomainRoutedModel("utility", { id: DEFAULT_ID }, fakeDeps(async () => C_OTHER, () => domains2, c2));
    await utility.doGenerate(turnCall);
    ok(readModelStamp() === DEFAULT_ID, "model-stamp: a later call in the same session overwrites the earlier stamp");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    ok(readModelStamp() === null, "model-stamp: a DIFFERENT session is unaffected by a previous session's stamp");
  });

  {
    const c: FakeCall[] = [];
    const m = createDomainRoutedModel("primary", { id: DEFAULT_ID }, fakeDeps(async () => C_TXN, () => domains2, c));
    await m.doGenerate(turnCall);
    ok(c[0].id === "anthropic/claude-sonnet-5", "model-stamp: a sessionless dispatch still calls the routed model (stamp no-ops, doesn't block)");
  }
}

{
  const { liveIdentity } = await import("../agent/model/routing.js");
  const { setSurfaceHintMatch, surfaceHintMatch } = await import("../agent/model/surface-hint.js");

  setSurfaceHintMatch(undefined);
  ok(surfaceHintMatch() === undefined, "surface-hint: match slot defaults to undefined");
  ok((await liveIdentity.surfaceMatch?.()) === undefined, "hosted fallback: no hint stamped → surfaceMatch undefined (org ← explicit only)");

  setSurfaceHintMatch("dm");
  ok(surfaceHintMatch() === "dm", "surface-hint: setSurfaceHintMatch roundtrips");
  ok((await liveIdentity.surfaceMatch?.()) === "dm", "hosted fallback: stamped dm hint → surfaceMatch resolves dm without an ALS ctx");

  setSurfaceHintMatch("public");
  ok((await liveIdentity.surfaceMatch?.()) === "public", "hosted fallback: stamped public hint → surfaceMatch resolves public");

  setSurfaceHintMatch(undefined);
}

console.log(`model-routing: ${passed} assertions passed`);
