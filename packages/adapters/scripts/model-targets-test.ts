import { generateText } from "ai";
import {
  _resetBareModelRoutesForTest,
  bareModelFallbacks,
  bareModelRoutes,
  bareModelRoutesUnregistered,
  bareModelVia,
  registerBareModelRoutes,
  type Domain,
  type ModelTarget,
  type ModelTargets,
  assertRouteTargets,
  defineSettings,
  mergeDataPolicy,
  overrideSettingsForTest,
  resolvableModels,
  settingDocs,
  validateModelTargets,
  viaProblem,
} from "@open-everywhere/core/agent/adapter-api.js";
import { _resetBareGapNoticeForTest, dataPolicyCallError, foreignProviderGuard, gatewayLanguageModel, gatewayModelBackend, gatewayTargetHost, policyModel, targetBaseUrl, withTargetRows } from "../agent/model/gateway.js";
import { dreamCallSettings } from "../agent/model/dream-judge.js";
import { probeGatewayRoute, type ConfigCheckCache } from "../agent/model/gateway-probe.js";
import { checkModelConfig, configCheckSummary, judgeModelEndpoints, modelEndpointsUrl, parseEndpoints, type EndpointFacts } from "../agent/model/model-config-check.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
const json = (v: unknown): string => JSON.stringify(v);
type AnyOpts = Record<string, unknown>;
const gwOf = (o: { providerOptions?: AnyOpts }): AnyOpts => (o.providerOptions?.["gateway"] ?? {}) as AnyOpts;
const throws = (f: () => unknown, needle: string): boolean => {
  try {
    f();
    return false;
  } catch (e) {
    return String(e).includes(needle);
  }
};

const GW: ModelTarget = { kind: "vercel-ai-gateway" };
const MODEL = "openai/gpt-6-luna";

{
  const refuses = (v: unknown, needle = "models.targets"): boolean => throws(() => defineSettings({ models: { targets: v as ModelTargets } }), needle);
  ok(!refuses({ gateway: GW }), "setting: the shipped shape is valid");
  ok(!refuses({ gateway: { kind: "vercel-ai-gateway", url: "https://relay.example.invalid/v4/ai", providers: { only: ["openai", "azure"], order: ["azure"] }, options: { caching: "auto" } } }), "setting: every key set is valid");
  ok(!refuses({ gateway: GW, eu: { kind: "vercel-ai-gateway", url: "http://gw.eu.internal:8080/v4/ai" } }), "setting: a second named target on http is valid");
  ok(refuses({ gateway: { kind: "openrouter" } }, "kind must be one of"), "setting: an unknown kind fails config load");
  ok(refuses({ gateway: {} }, "kind must be one of"), "setting: a missing kind fails config load");
  ok(refuses({ eu: GW }, `must name a "gateway" target`), "setting: no `gateway` target fails config load (it is the default via)");
  ok(refuses({ gateway: { ...GW, url: "not a url" } }, "url is not a URL"), "setting: an unparseable url fails config load");
  ok(refuses({ gateway: { ...GW, url: "ftp://x.invalid" } }, "http or https"), "setting: a non-http url fails config load");
  ok(refuses({ gateway: { ...GW, providers: { only: [] } } }, "non-empty list"), "setting: an empty only fails config load (it would read as no filter)");
  ok(refuses({ gateway: { ...GW, providers: { only: ["openai", "openai"] } } }, "twice"), "setting: a duplicate slug fails config load");
  ok(refuses({ gateway: { ...GW, providers: { allow: ["openai"] } } }, `unknown providers key "allow"`), "setting: an unknown providers key fails config load, by name");
  ok(refuses({ gateway: { ...GW, providers: { only: ["openai"], order: ["azure"] } } }, "which providers.only does not allow"), "setting: an order outside only fails config load");
  ok(refuses({ gateway: { ...GW, options: { only: ["x"] } } }, "set providers.only instead"), "setting: options.only fails config load and names the typed row");
  ok(refuses({ gateway: { ...GW, options: { zeroDataRetention: true } } }, "models.dataPolicy.zeroRetention"), "setting: options.zeroDataRetention names models.dataPolicy");
  ok(refuses({ gateway: { ...GW, extra: 1 } }, `unknown key "extra"`), "setting: an unknown target key fails config load");
  ok(refuses({ Gateway: GW }, "lowercase"), "setting: a target name outside the grammar fails config load");
  ok(validateModelTargets({ gateway: GW }) === undefined, "setting: the validator accepts the shipped value");
  const doc = settingDocs().find((d) => d.path === "models.targets");
  ok(doc !== undefined && doc.shipped.includes("gateway: Vercel AI Gateway"), "setting: the operator table carries the row, shipped as one plain gateway");
}

{
  const targets: ModelTargets = { gateway: GW, eu: GW };
  const dom = (models: Domain["models"]): Domain => ({ name: "team", reach: [], models }) as unknown as Domain;
  ok(!throws(() => assertRouteTargets([dom({ primary: { id: MODEL, via: "eu", providerOrder: ["azure"] } })], [], targets), "x"), "routes: a known via and providerOrder pass");
  ok(throws(() => assertRouteTargets([dom({ utility: { via: "us" } })], [], targets), `via "us" names no target`), "routes: an unknown via fails config load, naming the route");
  ok(
    throws(() => assertRouteTargets([dom({ primary: { id: MODEL, providers: ["fireworks"] } as never })], [], targets), `"providers" was renamed "providerOrder"`),
    "routes: the 0.7.0 key `providers` fails config load and names the new key",
  );
  ok(throws(() => assertRouteTargets([], [{ name: "qa", models: { supervisor: { via: "nope" } } }], targets), `role "qa" supervisor route`), "routes: a role route is checked too");
  ok(viaProblem(undefined, targets, "x") === undefined && viaProblem("eu", targets, "x") === undefined, "via: absent and known pass");
  ok(viaProblem("us", targets, `stack role "vision"`)?.includes(`stack role "vision": via "us"`) === true, "via: an unknown one names the role");
}

{
  const dom = { name: "t", reach: [], models: { primary: { id: "a/x", via: "eu" }, utility: { tier: "low" } } } as unknown as Domain;
  const got = resolvableModels([{ id: MODEL }, { id: MODEL }, { id: "a/v", via: "gateway" }], [dom], [], "f/forced");
  ok(
    json(got) === json([{ id: MODEL }, { id: "a/v" }, { id: "a/x", via: "eu" }, { id: "f/forced" }, { id: "f/forced", via: "eu" }]),
    "resolvable: roles, a route's concrete id on its target, and models.force on every target in use, deduped",
  );
}

{
  const call = { prompt: [], providerOptions: { gateway: { caching: "auto" } } };
  ok(withTargetRows(call, GW, {}) === call, "rows: the shipped target and no policy return the options unchanged (no request byte changes)");
  const only = withTargetRows(call, { ...GW, providers: { only: ["openai", "azure"] } }, {});
  ok(json(gwOf(only).only) === json(["openai", "azure"]) && gwOf(only).caching === "auto", "rows: providers.only rides the call, beside its own keys");
  const narrowed = withTargetRows({ providerOptions: { gateway: { only: ["azure", "bedrock"] } } }, { ...GW, providers: { only: ["openai", "azure"] } }, {});
  ok(json(gwOf(narrowed).only) === json(["azure"]), "rows: a call's own only NARROWS the target's to the intersection, never widens it");
  ok(
    throws(() => withTargetRows({ providerOptions: { gateway: { only: ["bedrock"] } } }, { ...GW, providers: { only: ["openai"] } }, {}), "models.targets.gateway.providers.only (openai)"),
    "rows: an empty intersection REFUSES (an empty only would read as no filter)",
  );
  const ordered = withTargetRows(call, { ...GW, providers: { order: ["azure", "openai"] } }, {});
  ok(json(gwOf(ordered).order) === json(["azure", "openai"]), "rows: providers.order applies when the call names no order");
  const routeOrder = withTargetRows({ providerOptions: { gateway: { order: ["openai"] } } }, { ...GW, providers: { order: ["azure"] } }, {});
  ok(json(gwOf(routeOrder).order) === json(["openai"]), "rows: a route's providerOrder (the call's order) wins over the target's");
  const floor = withTargetRows({ providerOptions: { gateway: { caching: "off" } } }, { ...GW, options: { caching: "auto", user: "u" } }, {});
  ok(gwOf(floor).caching === "off" && gwOf(floor).user === "u", "rows: target options are a floor: the call's own key wins, a missing key is added");
  const both = withTargetRows(call, { ...GW, providers: { only: ["openai"] } }, { zeroRetention: true });
  ok(gwOf(both).zeroDataRetention === true && json(gwOf(both).only) === json(["openai"]), "rows: the policy and only ride the same call");
}

{
  const refuses = (v: unknown, needle = "models.targets"): boolean => throws(() => defineSettings({ models: { targets: v as ModelTargets } }), needle);
  const MISTRAL: ModelTarget = { ...GW, providers: { only: ["mistral"] }, dataPolicy: { zeroRetention: true } };
  ok(!refuses({ gateway: GW, mistral: MISTRAL }), "target policy: a target with its own dataPolicy is valid");
  ok(refuses({ gateway: GW, mistral: { ...GW, dataPolicy: { zeroRetention: "yes" } } }, `target "mistral": dataPolicy zeroRetention must be true or false`), "target policy: a malformed row fails config load and names the target");
  ok(refuses({ gateway: GW, mistral: { ...GW, dataPolicy: { region: "asia" } } }, "dataPolicy region must be one of"), "target policy: an unknown region fails config load");
  ok(refuses({ gateway: GW, mistral: { ...GW, dataPolicy: { retention: true } } }, `dataPolicy unknown row "retention"`), "target policy: an unknown row fails config load");

  const call = { prompt: [], providerOptions: { gateway: { caching: "auto" } } };
  const rows = withTargetRows(call, MISTRAL, {});
  ok(gwOf(rows).zeroDataRetention === true && json(gwOf(rows).only) === json(["mistral"]), "target policy: a call through the target carries its zero-retention row and its provider pin");
  const weakened = withTargetRows({ providerOptions: { gateway: { zeroDataRetention: false } } }, MISTRAL, {});
  ok(gwOf(weakened).zeroDataRetention === true, "target policy: a call's own `zeroDataRetention: false` cannot remove the target's row");
  ok(withTargetRows(call, GW, {}) === call, "target policy: a target with no rows still changes no request byte");
  const plusGlobal = withTargetRows(call, MISTRAL, { noTraining: true });
  ok(gwOf(plusGlobal).zeroDataRetention === true && gwOf(plusGlobal).disallowPromptTraining === true, "target policy: the target's rows and models.dataPolicy ride the same call");

  ok(json(mergeDataPolicy({}, { zeroRetention: true })) === json({ zeroRetention: true }), "merge: a target row is added");
  ok(json(mergeDataPolicy({ zeroRetention: true }, { zeroRetention: false })) === json({ zeroRetention: true }), "merge: a target's false never removes a deployment row");
  ok(json(mergeDataPolicy({ region: "eu" }, { region: "eu", noTraining: true })) === json({ noTraining: true, region: "eu" }), "merge: the same region twice is one region");
  ok(throws(() => mergeDataPolicy({ region: "eu" }, { region: "us" }), "cannot both be met"), "merge: two different regions refuse, they never pick one");
  ok(
    throws(() => withTargetRows(call, { ...GW, dataPolicy: { region: "us" } }, { region: "eu" }, "mistral"), "models.targets.mistral.dataPolicy: models.dataPolicy (region eu)"),
    "target policy: a call under two different regions refuses before it is sent",
  );

  const live = Object.assign(new Error("No available providers match the 'only' filter"), { statusCode: 400, isRetryable: false });
  const named = dataPolicyCallError(MODEL, {}, live, { ...GW, dataPolicy: { zeroRetention: true } }, "mistral") as Error;
  ok(named !== live && named.message.startsWith(`models.targets.mistral.dataPolicy (zeroRetention): no provider serves "${MODEL}"`), `target policy: a refusal names the target's own row — got ${named.message}`);
}

{
  const only: ModelTarget = { ...GW, providers: { only: ["openai"] } };
  const live = Object.assign(new Error("No available providers match the 'only' filter"), { statusCode: 400, isRetryable: false });
  const e = dataPolicyCallError(MODEL, {}, live, only, "gateway") as Error;
  ok(e !== live && e.message.startsWith(`models.targets.gateway.providers.only (openai): no provider serves "${MODEL}"`), "refusal: an only refusal names the target row and the model");
  const both = dataPolicyCallError(MODEL, { region: "eu" }, live, only, "gateway") as Error;
  ok(both.message.startsWith("models.dataPolicy (region eu) + models.targets.gateway.providers.only (openai):"), "refusal: both demands are named");
  ok(dataPolicyCallError(MODEL, {}, live, GW, "gateway") === live, "refusal: with no demand the error passes unchanged");
}

{
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (m: unknown) => void warnings.push(String(m));
  try {
    ok(targetBaseUrl("gateway", GW, {}) === undefined, "url: no url and no env → the default endpoint");
    ok(targetBaseUrl("gateway", { ...GW, url: "https://a.invalid/v4/ai" }, {}) === "https://a.invalid/v4/ai" && warnings.length === 0, "url: the target url wins, with no warning");
    ok(targetBaseUrl("gateway", GW, { OE_AI_GATEWAY_URL: "https://env.invalid/v4/ai" }) === "https://env.invalid/v4/ai", "url: the deprecated env var still retargets the gateway target");
    ok(warnings.some((w) => w.includes("OE_AI_GATEWAY_URL is deprecated") && w.includes("models.targets.gateway.url")), "url: the env var warns, and names the setting to move to");
    ok(targetBaseUrl("eu", GW, { OE_AI_GATEWAY_URL: "https://env.invalid/v4/ai" }) === undefined, "url: the env var retargets only the `gateway` target");
    ok(targetBaseUrl("gateway", { ...GW, url: "https://a.invalid/v4/ai" }, { OE_AI_GATEWAY_URL: "https://env.invalid/v4/ai" }) === "https://a.invalid/v4/ai", "url: the setting wins over the env var");
    ok(warnings.some((w) => w.includes("is set and ignored")), "url: an ignored env var warns");
  } finally {
    console.warn = realWarn;
  }
}

type Captured = { url: string; body: AnyOpts };
async function withGateway<T>(respond: (c: Captured) => Response, run: (calls: Captured[]) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const realKey = process.env.AI_GATEWAY_API_KEY;
  const calls: Captured[] = [];
  process.env.AI_GATEWAY_API_KEY = "test-key-not-a-secret";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as AnyOpts };
    calls.push(c);
    return respond(c);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = realKey;
  }
}
const textReply = (): Response =>
  new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const onlyRefusal = (): Response =>
  new Response(JSON.stringify({ error: { message: "No available providers match the 'only' filter", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
const bodyGw = (c: Captured): AnyOpts => ((c.body["providerOptions"] as AnyOpts | undefined)?.["gateway"] ?? {}) as AnyOpts;

delete process.env.OE_AI_GATEWAY_URL;
overrideSettingsForTest({
  models: {
    targets: {
      gateway: { kind: "vercel-ai-gateway", url: "https://relay.example.invalid/v4/ai", providers: { only: ["openai", "azure"] } },
      eu: { kind: "vercel-ai-gateway", url: "https://eu-gateway.example.invalid/v4/ai", providers: { order: ["azure"] }, options: { caching: "auto" } },
      mistral: { kind: "vercel-ai-gateway", url: "https://relay.example.invalid/v4/ai", providers: { only: ["mistral"] }, dataPolicy: { zeroRetention: true } },
    },
  },
});
await withGateway(textReply, async (calls) => {
  await generateText({ model: gatewayLanguageModel(MODEL), prompt: "hi" });
  ok(new URL(calls[0]!.url).host === "relay.example.invalid", "wire: the gateway target's url is where the call goes");
  ok(json(bodyGw(calls[0]!).only) === json(["openai", "azure"]), "wire: a side call carries the target's providers.only");
  ok(gatewayTargetHost() === "relay.example.invalid", "wire: the host plane declares the gateway target's own host");
});
await withGateway(textReply, async (calls) => {
  await generateText({ model: gatewayLanguageModel(MODEL, "eu"), prompt: "hi" });
  ok(new URL(calls[0]!.url).host === "eu-gateway.example.invalid", "wire: via picks the target, and its url");
  ok(json(bodyGw(calls[0]!).order) === json(["azure"]) && bodyGw(calls[0]!).caching === "auto" && bodyGw(calls[0]!).only === undefined, "wire: the via target's own rows ride the call, not the gateway target's");
});
await withGateway(textReply, async (calls) => {
  await generateText({ model: gatewayLanguageModel("mistral/mistral-small", "mistral"), prompt: "hi" });
  await generateText({ model: gatewayLanguageModel(MODEL), prompt: "hi" });
  ok(bodyGw(calls[0]!).zeroDataRetention === true && json(bodyGw(calls[0]!).only) === json(["mistral"]), "wire: a call via the mistral target carries its zero-retention row and its provider pin");
  ok(bodyGw(calls[1]!).zeroDataRetention === undefined && json(bodyGw(calls[1]!).only) === json(["openai", "azure"]), "wire: a call via the gateway target carries none of the mistral target's rows");
});
await withGateway(textReply, async (calls) => {
  const backend = gatewayModelBackend({ caching: "auto" }, "eu");
  await generateText({ model: backend.model(MODEL), prompt: "hi" });
  await generateText({ model: backend.model(MODEL, "gateway"), prompt: "hi" });
  ok(new URL(calls[0]!.url).host === "eu-gateway.example.invalid" && new URL(calls[1]!.url).host === "relay.example.invalid", "wire: the backend uses the role's via, and a route's via wins");
});
await withGateway(textReply, async (calls) => {
  await generateText({ model: MODEL, prompt: "hi" });
  ok(calls.length === 1 && new URL(calls[0]!.url).host === "relay.example.invalid" && json(bodyGw(calls[0]!).only) === json(["openai", "azure"]), "wire: a bare model id goes to the gateway target, with its only row");
});
{
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  const notes = (): number => logged.filter((l) => l.includes("does not call registerBareModelRoutes")).length;
  let unregisteredNotes = -1;
  let registeredNotes = -1;
  try {
    _resetBareGapNoticeForTest();
    await withGateway(textReply, async () => {
      await generateText({ model: MODEL, prompt: "hi" });
      await generateText({ model: MODEL, prompt: "hi" });
    });
    unregisteredNotes = notes();
    _resetBareGapNoticeForTest();
    registerBareModelRoutes([{ id: MODEL }]);
    await withGateway(textReply, async () => {
      await generateText({ model: MODEL, prompt: "hi" });
    });
    registeredNotes = notes() - unregisteredNotes;
  } finally {
    console.error = realError;
    _resetBareModelRoutesForTest();
  }
  ok(unregisteredNotes === 1, `wire: an unregistered app names the gap once, at the first bare-id call — got ${unregisteredNotes}`);
  ok(registeredNotes === 0, `wire: NEGATIVE CONTROL — a registered app logs nothing — got ${registeredNotes}`);
}
{
  const routes = bareModelRoutes([{ id: "mistral/mistral-small", via: "mistral" }, { id: MODEL }, { id: "mistral/mistral-small", via: "eu" }]);
  ok(json(bareModelVia("mistral/mistral-small", routes)) === json({ via: "mistral", source: "role" }), "bare id: the first role that names the id gives its via");
  ok(json(bareModelVia(MODEL, routes)) === json({ via: "gateway", source: "role" }), "bare id: a role with no via gives gateway");
  ok(json(bareModelVia("vendor/unnamed", routes)) === json({ via: "mistral", source: "default" }), "bare id: an id no role names takes the primary role's via, not gateway");
  ok(json(bareModelVia("vendor/unnamed", undefined)) === json({ via: "gateway", source: "default" }), "bare id: a process that registered no role uses gateway");
  ok(bareModelRoutes([]).fallback === "gateway", "bare id: no roles, the default is gateway");
  const fb = bareModelFallbacks([{ where: "subagent a", id: MODEL }, { where: "subagent b", id: "vendor/unnamed" }], routes);
  ok(json(fb) === json([{ where: "subagent b", id: "vendor/unnamed", via: "mistral" }]), "bare id: the fallback list names only the id no role names, with its target");
  ok(bareModelRoutesUnregistered(routes, null), "bare id: no registration while a role names mistral is flagged");
  ok(!bareModelRoutesUnregistered(routes, routes), "bare id: a registered table is not flagged");
  ok(!bareModelRoutesUnregistered(bareModelRoutes([{ id: MODEL }]), null), "bare id: no registration on an all-gateway stack is not flagged, because nothing leaves its target");
}
await withGateway(textReply, async (calls) => {
  registerBareModelRoutes([{ id: "mistral/mistral-small", via: "mistral" }, { id: MODEL }]);
  try {
    await generateText({ model: "mistral/mistral-small", prompt: "hi" });
    await generateText({ model: MODEL, prompt: "hi" });
    await generateText({ model: "vendor/unnamed", prompt: "hi" });
  } finally {
    _resetBareModelRoutesForTest();
  }
  const mistralRows = (c: Captured): boolean => bodyGw(c).zeroDataRetention === true && json(bodyGw(c).only) === json(["mistral"]);
  ok(calls.length === 3 && mistralRows(calls[0]!), "wire: a bare id a mistral role names carries the mistral target's pin and zero-retention row");
  ok(bodyGw(calls[1]!).zeroDataRetention === undefined && json(bodyGw(calls[1]!).only) === json(["openai", "azure"]), "wire: a bare id a gateway role names goes through the gateway target");
  ok(mistralRows(calls[2]!), "wire: a bare id no role names goes through the primary role's target, not gateway");
});
{
  registerBareModelRoutes([{ id: "mistral/mistral-small", via: "mistral" }]);
  let sent = 0;
  const foreign = foreignProviderGuard(((id: string) => ({ modelId: id, doGenerate: async () => (sent++, {}) })) as unknown as object) as unknown as (id: string) => {
    doGenerate: (o: unknown) => Promise<unknown>;
  };
  let msg = "";
  try {
    await foreign("mistral/mistral-small").doGenerate({}).catch((e: unknown) => (msg = String(e)));
  } finally {
    _resetBareModelRoutesForTest();
  }
  ok(msg.includes(`target "mistral"`) && msg.includes("refuses") && sent === 0, "wire: a foreign default provider refuses a bare id whose role goes through another target");
}
await withGateway(onlyRefusal, async (calls) => {
  let msg = "";
  try {
    await generateText({ model: gatewayLanguageModel(MODEL), prompt: "hi", maxRetries: 0 });
  } catch (e) {
    msg = String(e);
  }
  ok(msg.includes("models.targets.gateway.providers.only (openai, azure)") && calls.length === 1, "wire: the only refusal fails closed after ONE request, and names the row");
});
{
  const rowless = policyModel({ modelId: MODEL, doCreateClientSecret: async () => "secret" } as unknown as object) as { doCreateClientSecret: (o: unknown) => Promise<unknown> };
  let msg = "";
  await rowless.doCreateClientSecret({}).catch((e: unknown) => (msg = String(e)));
  ok(msg.includes("providers.only (openai, azure)") && msg.includes("cannot carry the rows"), "wire: a realtime client secret refuses under an only row");
}
{
  const foreign = foreignProviderGuard(((id: string) => ({ modelId: id, doGenerate: async () => ({}) })) as unknown as object) as unknown as (id: string) => { doGenerate: (o: unknown) => Promise<unknown> };
  let msg = "";
  await foreign(MODEL).doGenerate({}).catch((e: unknown) => (msg = String(e)));
  ok(msg.includes("providers.only (openai, azure)") && msg.includes("not the gateway adapter's"), "wire: a foreign default provider refuses under an only row");
  let seenBatch: { requests: { options: { providerOptions?: AnyOpts } }[] } | undefined;
  const batch = policyModel({ modelId: MODEL, doStartBatch: async (o: unknown) => void (seenBatch = o as typeof seenBatch) } as unknown as object) as { doStartBatch: (o: unknown) => Promise<unknown> };
  await batch.doStartBatch({ requests: [{ options: { providerOptions: { gateway: { only: ["openai", "bedrock"] } } } }, { options: {} }] });
  ok(
    json(gwOf(seenBatch!.requests[0]!.options).only) === json(["openai"]) && json(gwOf(seenBatch!.requests[1]!.options).only) === json(["openai", "azure"]),
    "wire: each batch request carries the only row, narrowed by its own list",
  );
}
{
  let msg = "";
  try {
    gatewayLanguageModel(MODEL, "us");
  } catch (e) {
    msg = String(e);
  }
  ok(msg.includes(`no target "us"`), "wire: an unknown via throws, naming the target");
  const s = dreamCallSettings({ via: "eu" }, { id: MODEL, via: "gateway" });
  ok(s.via === "eu" && dreamCallSettings({}, { id: MODEL, via: "eu" }).via === "eu", "side call: a route's via wins over the role's, and the role's applies otherwise");
}

const LUNA = {
  data: {
    id: MODEL,
    endpoints: [
      { provider_name: "azure", has_zdr: true, has_no_training: true },
      { provider_name: "bedrock", has_zdr: false, has_no_training: true, inference_regions: [{ scope: "zone", geo_region: "us" }] },
      { provider_name: "openai", has_zdr: true, has_no_training: true, inference_regions: [{ scope: "zone", geo_region: "us" }, { scope: "zone", geo_region: "eu" }] },
    ],
  },
};
const DEEPSEEK_ID = "deepseek/deepseek-v4-flash-0731";
const DEEPSEEK = {
  data: {
    id: DEEPSEEK_ID,
    endpoints: [
      { provider_name: "alibaba", has_zdr: true, has_no_training: true },
      { provider_name: "baseten", has_zdr: true, has_no_training: true, inference_regions: [{ scope: "zone", geo_region: "us" }] },
      { provider_name: "novita", has_no_training: false },
    ],
  },
};
{
  const luna = parseEndpoints(LUNA)!;
  ok(luna.length === 3 && luna[0]!.regions === undefined && json(luna[2]!.regions) === json(["us", "eu"]), "check: the endpoints parse, and a missing regions field stays unknown");
  ok(parseEndpoints({ error: {} }) === undefined, "check: a body that is not an endpoints read parses to undefined");
  const ds = parseEndpoints(DEEPSEEK)!;
  ok(ds[2]!.zdr === undefined, "check: a missing has_zdr is unknown, not false");
  ok(judgeModelEndpoints(MODEL, luna, GW, { zeroRetention: true, noTraining: true, region: "eu" }).length === 0, "check: luna meets every row (openai serves eu under ZDR)");
  const eu = judgeModelEndpoints(DEEPSEEK_ID, ds, GW, { region: "eu" });
  ok(eu.length === 1 && eu[0]!.met === "no" && eu[0]!.detail === `region eu: no provider for ${DEEPSEEK_ID}`, "check: region eu on deepseek is named, as the ticket's example says");
  ok(judgeModelEndpoints(DEEPSEEK_ID, ds, GW, { region: "us" }).length === 0, "check: region us on deepseek is met (baseten)");
  const zdrBedrock = judgeModelEndpoints(MODEL, luna, { ...GW, providers: { only: ["bedrock"] } }, { zeroRetention: true });
  ok(zdrBedrock.length === 1 && zdrBedrock[0]!.met === "no" && zdrBedrock[0]!.detail.startsWith("zeroRetention: no provider"), "check: only narrows the candidates before the rows are judged");
  const together = judgeModelEndpoints(MODEL, luna, { ...GW, providers: { only: ["azure", "bedrock"] } }, { zeroRetention: true, region: "us" });
  ok(together.length === 1 && together[0]!.detail.startsWith("zeroRetention + region us: no provider"), "check: rows that different providers meet, but none meets together, are named together");
  const none = judgeModelEndpoints(MODEL, luna, { ...GW, providers: { only: ["vertex"] } }, {});
  ok(none.length === 1 && none[0]!.detail === `providers.only: no allowed provider serves ${MODEL}`, "check: a model no allowed provider serves is named");
  const targetZdr = judgeModelEndpoints(MODEL, luna, { ...GW, providers: { only: ["bedrock"] }, dataPolicy: { zeroRetention: true } }, {}, "eu-only");
  ok(targetZdr.length === 1 && targetZdr[0]!.met === "no" && targetZdr[0]!.detail.startsWith("zeroRetention: no provider"), "check: a target's own zero-retention row is judged against its allowed providers");
  ok(targetZdr[0]!.row === "models.targets.eu-only.dataPolicy zeroRetention", `check: a row only the target demands names the target's row — got ${targetZdr[0]!.row}`);
  const globalZdr = judgeModelEndpoints(MODEL, luna, { ...GW, providers: { only: ["bedrock"] } }, { zeroRetention: true });
  ok(globalZdr[0]!.row === "models.dataPolicy zeroRetention", `check: a row the deployment demands keeps the models.dataPolicy name — got ${globalZdr[0]!.row}`);
  const mixed = judgeModelEndpoints(MODEL, luna, { ...GW, providers: { only: ["azure", "bedrock"] }, dataPolicy: { region: "us" } }, { zeroRetention: true }, "eu-only");
  ok(
    mixed.length === 1 && mixed[0]!.row === "models.dataPolicy zeroRetention + models.targets.eu-only.dataPolicy region us",
    `check: a joint label names each row by its own origin — got ${mixed[0]?.row}`,
  );
  ok(judgeModelEndpoints(MODEL, luna, { ...GW, dataPolicy: { zeroRetention: true } }, {}).length === 0, "check: a target's zero-retention row a provider meets is no finding");
  const clash = judgeModelEndpoints(MODEL, luna, { ...GW, dataPolicy: { region: "us" } }, { region: "eu" }, "mistral");
  ok(clash.length === 1 && clash[0]!.met === "no" && clash[0]!.detail.includes("two different regions"), "check: two different regions on one target are a 'no', never a pass");
  const unknownOnly: EndpointFacts[] = [{ provider: "x", zdr: undefined, noTraining: undefined, regions: undefined }];
  ok(judgeModelEndpoints(MODEL, unknownOnly, GW, { zeroRetention: true, region: "eu" })[0]?.met === "unknown", "check: unknown fields are unknown, never a pass");
  ok(modelEndpointsUrl(MODEL) === `https://ai-gateway.vercel.sh/v1/models/${MODEL}/endpoints`, "check: the default endpoints URL");
  ok(modelEndpointsUrl(MODEL, "https://relay.example.invalid/v4/ai") === `https://relay.example.invalid/v1/models/${MODEL}/endpoints`, "check: a target url moves the read to its origin");

  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("gpt-6-luna")) return new Response(JSON.stringify(LUNA), { status: 200 });
    if (url.includes("deepseek")) return new Response(JSON.stringify(DEEPSEEK), { status: 200 });
    if (url.includes("broken")) throw new Error("socket hang up at internal.host");
    return new Response(JSON.stringify({ error: { type: "model_not_found" } }), { status: 404 });
  }) as typeof fetch;
  const r = await checkModelConfig({
    models: [{ id: MODEL }, { id: MODEL }, { id: DEEPSEEK_ID }, { id: "nope/nope-1" }],
    targets: { gateway: { ...GW, providers: { only: ["openai", "alibaba", "baseten", "opneai"] } } },
    policy: { zeroRetention: true, region: "eu" },
    baseUrlFor: () => undefined,
    fetchImpl,
  });
  ok(r.met === "no" && r.checked === 3 && seen.length === 3, "check: one read per distinct model, and a demand no provider meets is a 'no'");
  const details = r.findings.map((f) => f.detail);
  ok(details.includes(`region eu: no provider for ${DEEPSEEK_ID}`), "check: the region row is named for deepseek");
  ok(details.includes("nope/nope-1: the gateway does not know this model"), "check: an unknown model id is named");
  const typo = r.findings.find((f) => f.detail === `providers.only: "opneai" serves none of the checked models`);
  ok(typo?.met === "unknown", "check: an only slug that serves nothing is named as a WARNING (a typo), never a 'no'");
  const typoOnly = await checkModelConfig({ models: [{ id: MODEL }], targets: { gateway: { ...GW, providers: { only: ["openai", "later"] } } }, policy: {}, baseUrlFor: () => undefined, fetchImpl });
  ok(typoOnly.met === "unknown", "check: a config whose only problem is an unused slug is not a 'no' (every call can be served)");
  ok(!details.some((d) => d.includes("gpt-6-luna")), "check: luna is met, so it is not named");
  ok(configCheckSummary(r).startsWith("model config: 2 problems — "), "check: the summary counts the problems");
  const relay = await checkModelConfig({ models: [{ id: "nope/nope-1" }], targets: { gateway: GW }, policy: {}, baseUrlFor: () => "https://relay.example.invalid/v4/ai", fetchImpl });
  ok(relay.met === "unknown" && relay.findings[0]!.detail.includes("does not serve the endpoints read"), "check: a relay's 404 on the endpoints read is unknown, never a 'no'");
  const broken = await checkModelConfig({ models: [{ id: "x/broken" }], targets: { gateway: GW }, policy: {}, baseUrlFor: () => undefined, fetchImpl });
  ok(broken.met === "unknown" && !configCheckSummary(broken).includes("internal.host"), "check: a failed read is unknown, and forwards no vendor error text");
  const unknownVia = await checkModelConfig({ models: [{ id: MODEL, via: "us" }], targets: { gateway: GW }, policy: {}, baseUrlFor: () => undefined, fetchImpl });
  ok(unknownVia.met === "no" && unknownVia.findings[0]!.detail.includes("via us"), "check: a via that names no target is a 'no'");

  overrideSettingsForTest({ models: { targets: { gateway: GW }, dataPolicy: { region: "eu" } } });
  const cache: ConfigCheckCache = {};
  let reads = 0;
  const probeFetch = (async (input: string | URL | Request) => {
    reads++;
    return String(input).endsWith("/catalog") ? new Response("{}", { status: 200 }) : fetchImpl(input);
  }) as typeof fetch;
  const deps = { env: { AI_GATEWAY_API_KEY: "k" }, vercel: false, fetchImpl: probeFetch, cache, models: () => [{ id: DEEPSEEK_ID }], now: () => 1_000 };
  const a = await probeGatewayRoute(deps);
  ok(a.met === "no" && a.detail.includes("demand that no provider can serve"), "probe: a demand no provider meets turns the model-route row 'no'");
  ok(!a.detail.includes("deepseek") && !a.detail.includes("region eu") && !/\d+ models?\b/.test(a.detail), `probe: the public detail carries no model id, row value or count — got ${a.detail}`);
  const readsAfterFirst = reads;
  await probeGatewayRoute(deps);
  ok(reads === readsAfterFirst + 1, "probe: a second status read within ten minutes reuses the config answer (only the catalog is read again)");
  const plain = await probeGatewayRoute({ env: { AI_GATEWAY_API_KEY: "k" }, vercel: false, fetchImpl: probeFetch, cache: {}, models: () => [{ id: MODEL }] });
  ok(plain.met === "yes" && plain.detail.includes("the model config can be served"), "probe: a config every provider can serve keeps 'yes', and says so");
  overrideSettingsForTest({ models: { targets: { gateway: { ...GW, providers: { only: ["openai", "later"] } } }, dataPolicy: {} } });
  const unused = await probeGatewayRoute({ env: { AI_GATEWAY_API_KEY: "k" }, vercel: false, fetchImpl: probeFetch, cache: {}, models: () => [{ id: MODEL }] });
  ok(
    unused.met === "yes" && unused.detail.includes("a providers.only name serves none of the checked models") && !unused.detail.includes("not fully measured") && !unused.detail.includes("later"),
    `probe: an unused only name is a warning on a measured config, with no name in the public detail — got ${unused.detail}`,
  );
}

console.log(`✓ model-targets: ${passed} assertions`);
