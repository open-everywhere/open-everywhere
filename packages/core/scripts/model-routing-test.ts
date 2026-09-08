import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineDomain, domainMatchFor, modelRouteFor, statusVerbsFor, type Domain } from "../agent/memory/domain.js";
import type { BindableContext } from "../agent/identity/binding.js";
import {
  applyRoute,
  isSupervisorSession,
  makeRoutedModel,
  resolvePrimaryModel,
  resolveRoute,
  type ModelBackend,
  type RoutableModel,
  type RoutedCallOptions,
  type RoutingDeps,
} from "../agent/model/routing.js";
import {
  dmAnchorDomain,
  dmWindowKey,
  formatWindowToken,
  isSupervisorShapedToken,
  saltSupervisorGeneration,
  taskWindowId,
} from "../agent/channels/window-key.js";
import { stampModelCall, readModelStamp } from "../agent/model/model-stamp.js";
import { renderSupervisorPersona, REPLY_STYLE_RUBRIC } from "../agent/instructions/access.js";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const C_TXN = "slack/T1/C_TXN";
const C_OTHER = "slack/T1/C_OTHER";
const DEFAULT_ID = "zai/glm-5.2";
const UTILITY_ID = "deepseek/deepseek-v4-flash";

const domains: Domain[] = [
  defineDomain({
    name: "org",
    match: "org",
    models: { primary: { id: DEFAULT_ID, providers: ["fireworks"], reasoning: "medium" }, utility: { id: "zai/glm-4.5-air" } },
  }),
  defineDomain({ name: "txn", reach: [C_TXN], models: { primary: { reasoning: "high" } } }),
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
  defineDomain({ name: "exec", reach: [C_TXN], models: { primary: { id: "anthropic/claude-sonnet-5" } } }),
];
const swapped = modelRouteFor("primary", C_TXN, domains2);
ok(swapped.id === "anthropic/claude-sonnet-5" && swapped.providers === undefined, "changing id DROPS the inherited pin (an upstream pinned for one model is wrong for another)");
const repinned = modelRouteFor("primary", C_TXN, [
  domains2[0],
  defineDomain({ name: "exec", reach: [C_TXN], models: { primary: { id: "anthropic/claude-sonnet-5", providers: ["anthropic"] } } }),
]);
ok(JSON.stringify(repinned.providers) === JSON.stringify(["anthropic"]), "a route may pin its own providers with its own id");

ok(modelRouteFor("primary", C_TXN, [defineDomain({ name: "txn", reach: [C_TXN] })]).id === undefined, "domain without models + no org → empty route");

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
    defineDomain({ name: "explicit", reach: [D_PARTNER], models: { primary: { id: "vendor/explicit-model" } } }),
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
  const domains = [defineDomain({ name: "team", reach: [C_TXN], statusVerbs: ["Reviewing"] })];
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
function fakeBackend(calls: FakeCall[], backendMark = false): ModelBackend {
  return {
    model: (id) => fakeModel(id, calls),
    applyOptions: (route, options, ids) => (backendMark ? { ...options, marked: { route, ids } } : options),
  };
}
function fakeDeps(domainList: () => readonly Domain[], calls: FakeCall[], backendMark = false): RoutingDeps {
  return { domains: domainList, backend: fakeBackend(calls, backendMark) };
}

function slackChannelCtx(team: string, channel: string): BindableContext {
  return {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: { team_id: team, channel_id: channel, channel_type: "channel", is_private: "false", trust_checked: "true" },
          principalId: "U1",
          principalType: "user",
        },
      },
    },
  };
}
function slackSupervisorCtx(team: string, channel: string, gen: number): BindableContext {
  return {
    channel: { kind: "slack", continuationToken: `${channel}:oe-sup:g${gen}` },
    session: {
      auth: {
        current: {
          attributes: { team_id: team, channel_id: channel, channel_type: "channel", is_private: "false", trust_checked: "true" },
          principalId: "U1",
          principalType: "user",
        },
      },
    },
  };
}
function slackDmCtx(team: string, dmId: string): BindableContext {
  return {
    channel: { kind: "slack" },
    session: {
      auth: {
        current: {
          attributes: { team_id: team, channel_id: dmId, channel_type: "im", dm_partner_trust: "internal" },
          principalId: "U1",
          principalType: "user",
        },
      },
    },
  };
}

{
  const deps = fakeDeps(() => domains2, []);
  const r = await resolveRoute("primary", C_TXN, undefined, DEFAULT_ID, deps);
  ok(r.id === "anthropic/claude-sonnet-5", "resolveRoute: an explicit channel domain routes its model");
  const rOther = await resolveRoute("primary", C_OTHER, undefined, DEFAULT_ID, deps);
  ok(rOther.id === DEFAULT_ID && JSON.stringify(rOther.providers) === JSON.stringify(["fireworks"]), "resolveRoute: an unassigned channel gets the org route (default id + pin)");
}
{
  const deps = fakeDeps(() => dmDomains, []);
  const r = await resolveRoute("primary", D_PARTNER, "dm", DEFAULT_ID, deps);
  ok(r.id === "vendor/dm-model" && r.reasoning === "medium", "resolveRoute: surfaceMatch='dm' routes through the dm criteria domain");
  const rNoMatch = await resolveRoute("primary", D_PARTNER, undefined, DEFAULT_ID, deps);
  ok(rNoMatch.id === DEFAULT_ID, "resolveRoute: no surfaceMatch → org only (dm criteria layer not consulted)");
}
{
  const deps = fakeDeps(() => domains2, []);
  const FORCED = "deepseek/deepseek-v4-flash";
  const prev = process.env.OE_FORCE_MODEL;
  process.env.OE_FORCE_MODEL = FORCED;
  try {
    const rPinned = await resolveRoute("primary", C_TXN, undefined, DEFAULT_ID, deps);
    ok(rPinned.id === FORCED && rPinned.tier === undefined, "resolveRoute: OE_FORCE_MODEL overrides a domain's concrete id pin");
    const rDefault = await resolveRoute("primary", C_OTHER, undefined, DEFAULT_ID, deps);
    ok(rDefault.id === FORCED, "resolveRoute: OE_FORCE_MODEL overrides the org default id too");
  } finally {
    if (prev === undefined) delete process.env.OE_FORCE_MODEL;
    else process.env.OE_FORCE_MODEL = prev;
  }
  const rRestored = await resolveRoute("primary", C_TXN, undefined, DEFAULT_ID, deps);
  ok(rRestored.id === "anthropic/claude-sonnet-5", "resolveRoute: unset OE_FORCE_MODEL restores per-domain routing");
}
{
  const threw = fakeDeps(() => {
    throw new Error("config not registered");
  }, []);
  const r = await resolveRoute("primary", C_TXN, undefined, DEFAULT_ID, threw);
  ok(JSON.stringify(r) === "{}", "resolveRoute: a throwing domains() → {} (fail-soft, default model)");
}

{
  const calls: FakeCall[] = [];
  const m = makeRoutedModel(() => ({ id: "anthropic/claude-sonnet-5" }), { id: DEFAULT_ID }, fakeBackend(calls, true));
  ok(m.modelId === DEFAULT_ID && m.provider === "test", "makeRoutedModel: reports the default identity");
  await m.doGenerate(turnCall);
  ok(calls.length === 1 && calls[0].id === "anthropic/claude-sonnet-5", "makeRoutedModel: doGenerate dispatches to the baked route's inner model");
  const marked = calls[0].options.marked as { route: { id?: string }; ids: { id: string; defaultId: string } };
  ok(marked.ids.id === "anthropic/claude-sonnet-5" && marked.ids.defaultId === DEFAULT_ID, "makeRoutedModel: backend.applyOptions receives the route + both ids (vendor mapping seam)");
  await m.doStream(turnCall);
  ok(calls.length === 2 && calls[1].id === "anthropic/claude-sonnet-5", "makeRoutedModel: doStream dispatches to the baked route's inner model");
}
{
  const calls: FakeCall[] = [];
  const m = makeRoutedModel(() => ({}), { id: DEFAULT_ID }, fakeBackend(calls));
  await m.doGenerate(turnCall);
  ok(calls[0].id === DEFAULT_ID, "makeRoutedModel: an empty route dispatches to the default model");
}
{
  const made: string[] = [];
  const calls: FakeCall[] = [];
  const backend: ModelBackend = {
    model: (id) => {
      made.push(id);
      return fakeModel(id, calls);
    },
    applyOptions: (_r, o) => o,
  };
  const m = makeRoutedModel(() => ({ id: "anthropic/claude-sonnet-5" }), { id: DEFAULT_ID }, backend);
  await m.doGenerate(turnCall);
  await m.doGenerate(turnCall);
  ok(made.filter((id) => id === "anthropic/claude-sonnet-5").length === 1, "makeRoutedModel: inner model construction memoized per id");
}

const PRIMARY_DEFAULTS = { primary: { id: DEFAULT_ID } };
{
  const calls: FakeCall[] = [];
  const m = await resolvePrimaryModel(slackChannelCtx("T1", "C_TXN"), PRIMARY_DEFAULTS, fakeDeps(() => domains2, calls));
  ok(m !== null, "resolvePrimaryModel: a routed surface returns a wrapped model (not null → fallback)");
  await m!.doGenerate(turnCall);
  ok(calls[0].id === "anthropic/claude-sonnet-5", "resolvePrimaryModel: routes from ctx.session.auth (no ALS, no surface hint)");
}
{
  const calls: FakeCall[] = [];
  const m = await resolvePrimaryModel(slackDmCtx("T1", "D_PARTNER"), PRIMARY_DEFAULTS, fakeDeps(() => dmDomains, calls));
  ok(m !== null, "resolvePrimaryModel: a DM surface routes via the dm criteria domain");
  await m!.doGenerate(turnCall);
  ok(calls[0].id === "vendor/dm-model", "resolvePrimaryModel: DM/public criteria routing survives via ctx (no surface hint)");
}
{
  const calls: FakeCall[] = [];
  const onlyExec = () => [defineDomain({ name: "exec", reach: [C_TXN], models: { primary: { id: "anthropic/claude-sonnet-5" } } })];
  const m = await resolvePrimaryModel(slackChannelCtx("T1", "C_OTHER"), PRIMARY_DEFAULTS, fakeDeps(onlyExec, calls, true));
  ok(m.modelId === DEFAULT_ID, "resolvePrimaryModel: a surface that routes to nothing returns the DEFAULT model concretely — never null (OPE-412)");
  await m.doGenerate(turnCall);
  ok(calls[0].id === DEFAULT_ID, "resolvePrimaryModel: …and the call really lands on the default — exactly the model eve's static fallback would have run");
  ok(calls[0].options["marked"] === undefined, "resolvePrimaryModel: …and it is the BARE default, not a routed wrapper (a no-op route still skips wrapper construction)");
}
{
  const calls: FakeCall[] = [];
  const onlyExec = () => [defineDomain({ name: "exec", reach: [C_TXN], models: { primary: { id: "anthropic/claude-sonnet-5" } } })];
  const m = await resolvePrimaryModel({} as BindableContext, PRIMARY_DEFAULTS, fakeDeps(onlyExec, calls, true));
  ok(m.modelId === DEFAULT_ID, "resolvePrimaryModel: an identity-less ctx does not throw (fail-soft → the default model, no matching domain)");
  await m.doGenerate(turnCall);
  ok(calls[0].options["marked"] === undefined, "resolvePrimaryModel: …and the fail-soft return is the bare default, not a wrapper");
}
{
  const calls: FakeCall[] = [];
  const m = await resolvePrimaryModel(slackChannelCtx("T1", "C_TXN"), PRIMARY_DEFAULTS, fakeDeps(() => {
    throw new Error("config exploded");
  }, calls, true));
  ok(m.modelId === DEFAULT_ID, "resolvePrimaryModel: a throwing config → the default model, no throw (fail-soft)");
  await m.doGenerate(turnCall);
  ok(calls[0].id === DEFAULT_ID, "resolvePrimaryModel: …and that default really is what gets called");
}

ok(isSupervisorSession(slackSupervisorCtx("T1", "C_TXN", 3)), "isSupervisorSession: a ctx with the oe-sup:g<n> continuation token is a supervisor session");
ok(!isSupervisorSession(slackChannelCtx("T1", "C_TXN")), "isSupervisorSession: an ordinary channel ctx (no supervisor token) is NOT a supervisor session");
ok(!isSupervisorSession(slackDmCtx("T1", "D_PARTNER")), "isSupervisorSession: a DM ctx is NOT a supervisor session");
ok(isSupervisorSession({ channel: { kind: "slack", continuationToken: "oe-sup:g12" } } as BindableContext), "isSupervisorSession: the bare sentinel form also matches");
ok(!isSupervisorSession({ channel: { kind: "slack", continuationToken: "C_TXN:1720000000.0001" } } as BindableContext), "isSupervisorSession: a real thread continuation token does NOT match");

{
  const DM_SURFACE = "slack/T1/D999";
  const dmWindowTok = formatWindowToken(dmWindowKey(DM_SURFACE, 4));
  const dmWindowCtx = { channel: { kind: "slack", continuationToken: dmWindowTok } } as BindableContext;
  ok(!isSupervisorSession(dmWindowCtx), "isSupervisorSession: a DM WINDOW token does NOT resolve the supervisor role — a DM routes to the primary model");
  ok(!isSupervisorSession({ channel: { kind: "unified", continuationToken: `unified:${dmWindowTok}` } } as BindableContext), "…including through eve's `unified:` send prefix (the strip happens inside the codec)");
  ok(!isSupervisorSession({ channel: { kind: "slack", continuationToken: saltSupervisorGeneration(dmWindowTok) } } as BindableContext), "…and for a ROTATED (salted) DM window token");
  ok(isSupervisorShapedToken(dmWindowTok), "…but the DM window token IS still supervisor-SHAPED — the fix lives in isSupervisorSession, NOT in the codec (spend + rotation keep the broad predicate)");
  const dmWorkerTok = formatWindowToken({ domain: dmAnchorDomain(DM_SURFACE), windowId: taskWindowId("slack/T1/D999", "D999", "n1"), generation: 0 });
  ok(isSupervisorSession({ channel: { kind: "unified", continuationToken: dmWorkerTok } } as BindableContext), "a DM-ANCHORED WORKER (t/ grain, OPE-306) still IS a supervisor session — behaviour-neutral, the exclusion is standing-grain-only");
  ok(isSupervisorSession({ channel: { kind: "unified", continuationToken: formatWindowToken({ domain: "payments", windowId: "payments", generation: 4 }) } } as BindableContext), "a NAMED-domain standing window is still a supervisor session");

  ok(renderSupervisorPersona(dmWindowCtx) === "", "renderSupervisorPersona renders NOTHING on a DM window — the re-seat preserves the DM's current posture rather than changing it");
}

{
  const persona = renderSupervisorPersona(slackSupervisorCtx("T1", "C_TXN", 3));
  ok(persona.startsWith("## This channel"), "renderSupervisorPersona: renders the Draft A block for a supervisor session");
  ok(
    persona.includes("standing session for this channel") && persona.includes("### Trust grades"),
    "renderSupervisorPersona: carries the standing-session identity + the trust-grades section",
  );
  ok(!/\bSlack\b/.test(persona), "renderSupervisorPersona: never names the surface (renderSurface injects it)");
  ok(/redirect your task/.test(persona) && /escalate your access/.test(persona) && /wouldn't expect/.test(persona), "renderSupervisorPersona: carries all THREE escalation-valve triggers");
  ok(/ask_question/.test(persona), "renderSupervisorPersona: …and the remedy is a real question into the room, not a hedge");
  ok(/never an authority/.test(persona), "renderSupervisorPersona: marks display names/handles/filenames as author-chosen labels, not claims of standing");
  ok(!persona.includes("reply` posts mid-turn"), "renderSupervisorPersona: OMITS the ships-with-T1.6 reply-tool paragraph");
  ok(renderSupervisorPersona(slackChannelCtx("T1", "C_TXN")) === "", "renderSupervisorPersona: renders NOTHING for an ordinary channel session");
  ok(renderSupervisorPersona(slackDmCtx("T1", "D_PARTNER")) === "", "renderSupervisorPersona: renders NOTHING for a DM session");
}

{
  const rubric = REPLY_STYLE_RUBRIC;
  ok(rubric.startsWith("### How you write"), "reply-style rubric: the exported constant starts with the `How you write` header");
  ok(/one sentence/.test(rubric) && /Lead with the conclusion/.test(rubric), "reply-style rubric: concision-first (many messages need one sentence) + conclusion-first");
  ok(/BOTH surprising AND something the reader would act on/.test(rubric), "reply-style rubric: a detail must be BOTH surprising AND action-relevant, not either");
  ok(/narrating how you worked/.test(rubric) && /Give the finding, not the method/.test(rubric), "reply-style rubric: methodology narration is OUT");
  ok(/\*\*Provenance\*\*/.test(rubric) && /the logs say X/.test(rubric), "reply-style rubric: …but PROVENANCE stays in — OE surfaces where a fact came from");
  ok(/why you stayed quiet, why you are blocked/.test(rubric) && /is information/.test(rubric), "reply-style rubric: …and so does self-explanation + a stated uncertainty");
  ok(/NAMES A REAL THING/.test(rubric) && /`park`/.test(rubric) && /`ledger`/.test(rubric) && /`arm`/.test(rubric), "reply-style rubric: OE's own vocabulary is carved OUT of the banned-word list by name");
  ok(/overrides every line above/.test(rubric), "reply-style rubric: an explicit human request overrides the whole rubric");
  ok(/reviewer|review round|review_token|review: false|style review/i.test(rubric) === false, "🔴 reply-style rubric: the constant teaches NO reviewer gate — prose only (OPE-424 ruling)");
  ok(!renderSupervisorPersona(slackSupervisorCtx("T1", "C_TXN", 3)).includes("### How you write"), "🔴 OPE-542: the supervisor persona no longer carries the reply-style rubric — it moved to the global scope markdown");
  ok(!renderSupervisorPersona(slackChannelCtx("T1", "C_TXN")).includes("### How you write"), "…and an ordinary channel session's (empty) persona carries it even less");
}

const supDomains: Domain[] = [
  defineDomain({
    name: "org",
    match: "org",
    models: { primary: { id: DEFAULT_ID, reasoning: "medium" }, supervisor: { id: UTILITY_ID, reasoning: "low" } },
  }),
  defineDomain({ name: "txn", reach: [C_TXN], models: { primary: { reasoning: "high" } } }),
];
{
  const calls: FakeCall[] = [];
  const m = await resolvePrimaryModel(slackSupervisorCtx("T1", "C_TXN", 3), PRIMARY_DEFAULTS, fakeDeps(() => supDomains, calls));
  ok(m !== null, "supervisor session: returns a wrapped model");
  await m!.doGenerate(turnCall);
  ok(calls[0].id === UTILITY_ID, "supervisor session resolves the `supervisor` ModelRole (deepseek-v4-flash), NOT the channel's primary (glm-5.2)");
  ok(calls[0].options.reasoning === "low", "supervisor route carries its own reasoning (low)");
}
{
  const calls: FakeCall[] = [];
  const m = await resolvePrimaryModel(slackChannelCtx("T1", "C_TXN"), PRIMARY_DEFAULTS, fakeDeps(() => supDomains, calls));
  ok(m !== null, "non-supervisor turn in a supervisor-routed channel: returns a wrapped model");
  await m!.doGenerate(turnCall);
  ok(calls[0].id === DEFAULT_ID, "NON-supervisor turn still resolves `primary` (glm-5.2) — supervisor routing does NOT leak onto thread/turn sessions");
  ok(calls[0].options.reasoning === "high", "the non-supervisor turn keeps the channel's primary reasoning (high), untouched by the supervisor route");
}
{
  const calls: FakeCall[] = [];
  const m = await resolvePrimaryModel(slackSupervisorCtx("T1", "C_TXN", 1), PRIMARY_DEFAULTS, fakeDeps(() => domains2, calls));
  ok(m !== null, "supervisor session, no supervisor route: returns a wrapped model via the primary fallback");
  await m!.doGenerate(turnCall);
  ok(calls[0].id === "anthropic/claude-sonnet-5", "supervisor route UNSET → falls back to the channel's `primary` route (exec → sonnet); the role is inert until configured");
}
{
  const deps = fakeDeps(() => domains2, []);
  const rFallback = await resolveRoute("supervisor", C_TXN, undefined, DEFAULT_ID, deps, "primary");
  ok(rFallback.id === "anthropic/claude-sonnet-5", "resolveRoute: an unset `supervisor` role with fallbackRole='primary' resolves the primary route");
  const rNoFallback = await resolveRoute("supervisor", C_TXN, undefined, DEFAULT_ID, deps);
  ok(rNoFallback.id === undefined && rNoFallback.reasoning === undefined, "resolveRoute: an unset `supervisor` role with NO fallbackRole stays unrouted (id undefined → caller's default applies)");
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

    const calls: FakeCall[] = [];
    const m = makeRoutedModel(() => ({ id: "anthropic/claude-sonnet-5" }), { id: DEFAULT_ID }, fakeBackend(calls));
    await m.doGenerate(turnCall);
    ok(readModelStamp() === "anthropic/claude-sonnet-5", "model-stamp: dispatch() stamps THIS call's resolved routed id");

    await resolvePrimaryModel(slackChannelCtx("T1", "C_TXN"), PRIMARY_DEFAULTS, fakeDeps(() => domains, calls));
    ok(readModelStamp() === DEFAULT_ID, "model-stamp: the primary resolver stamps the route it resolved from ctx, over the prior stamp");
  });

  await contextStorage.run(new ContextContainer(), async () => {
    ok(readModelStamp() === null, "model-stamp: a DIFFERENT session is unaffected by a previous session's stamp");
  });

  {
    const calls: FakeCall[] = [];
    const m = makeRoutedModel(() => ({ id: "anthropic/claude-sonnet-5" }), { id: DEFAULT_ID }, fakeBackend(calls));
    await m.doGenerate(turnCall);
    ok(calls[0].id === "anthropic/claude-sonnet-5", "model-stamp: a sessionless dispatch still calls the routed model (stamp no-ops, doesn't block)");
  }

  {
    await contextStorage.run(new ContextContainer(), async () => {
      const m = await resolvePrimaryModel(slackChannelCtx("T1", "C_TXN"), PRIMARY_DEFAULTS, fakeDeps(() => domains2, []));
      ok(m !== null, "regression: a routed surface returns a wrapped model");
      ok(readModelStamp() === "anthropic/claude-sonnet-5", "regression: resolvePrimaryModel stamps the routed id at RESOLVE time — the spend hook sees it without the wrapper's doGenerate running");
    });
    await contextStorage.run(new ContextContainer(), async () => {
      const onlyExec = () => [defineDomain({ name: "exec", reach: [C_TXN], models: { primary: { id: "anthropic/claude-sonnet-5" } } })];
      const m = await resolvePrimaryModel(slackChannelCtx("T1", "C_OTHER"), PRIMARY_DEFAULTS, fakeDeps(onlyExec, []));
      ok(m.modelId === DEFAULT_ID, "regression: an unrouted surface returns the default model concretely (OPE-412 — eve 0.33 throws on a null return)");
      ok(readModelStamp() === DEFAULT_ID, "regression: the default/no-op path stamps the default id (row still priced)");
      ok(readModelStamp() === m.modelId, "regression: the stamped id and the RETURNED model agree — the audit row can no longer claim a model the resolver didn't hand back");
    });
    {
      const { resolveRuntimeModelSelection } = await import(abs("dist/src/runtime/agent/resolve-model.js"));
      const wrapper = await contextStorage.run(new ContextContainer(), async () =>
        resolvePrimaryModel(slackChannelCtx("T1", "C_TXN"), PRIMARY_DEFAULTS, fakeDeps(() => domains2, [])),
      );
      const selection = { model: wrapper, modelContextWindowTokens: 1_000_000 };
      const resolved = await resolveRuntimeModelSelection({ selection, durability: "step", state: new ContextContainer() });
      ok(resolved.model !== undefined, "regression: the resolver returns a model-INSTANCE selection — the shape eve honors at step scope");
      ok(resolved.reference?.contextWindowTokens === 1_000_000, "regression: the window stated on the selection reaches eve's reference — this is what rescales the compaction threshold");

      let durableError = "";
      try {
        await resolveRuntimeModelSelection({ selection, durability: "durable", state: new ContextContainer() });
      } catch (error) {
        durableError = error instanceof Error ? error.message : String(error);
      }
      ok(/must be serializable/.test(durableError), "regression: a model INSTANCE is REFUSED at durable (session/turn) scope — the routed wrapper only survives at step.started");

      let nullError = "";
      try {
        await resolveRuntimeModelSelection({ selection: null, durability: "step", state: new ContextContainer() });
      } catch (error) {
        nullError = error instanceof Error ? error.message : String(error);
      }
      ok(/returned no model/.test(nullError), "regression: eve throws on a null resolver return — every OE return path must be concrete (no `fallback` key exists)");
    }
  }
}

console.log(`model-routing: ${passed} assertions passed`);
