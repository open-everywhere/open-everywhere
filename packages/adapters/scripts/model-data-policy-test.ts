import { experimental_transcribe as transcribe, generateText } from "ai";
import {
  type ModelDataPolicy,
  defineSettings,
  overrideSettingsForTest,
  resetSettingsForTest,
  settingDocs,
} from "@open-everywhere/core/agent/adapter-api.js";
import {
  dataPolicyCallError,
  foreignProviderGuard,
  gatewayLanguageModel,
  gatewayModelBackend,
  gatewayTranscriptionModel,
  policyModel,
  vercelDataPolicyOptions,
  withDataPolicy,
} from "../agent/model/gateway.js";
import { gatewayImageDescriber } from "../agent/model/gateway-vision.js";
import { routeTransport } from "../agent/model/transcription-routes.js";

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

const MODEL = "deepseek/deepseek-v4-flash-0731";
const FULL: ModelDataPolicy = { zeroRetention: true, noTraining: true, region: "eu" };
const LIVE_REFUSAL = `No provider for ${MODEL} supports the requested inference region. Providers considered: alibaba (scope=zone, geoRegion=eu).`;

{
  const refuses = (v: unknown): boolean => {
    try {
      defineSettings({ models: { dataPolicy: v as ModelDataPolicy } });
      return false;
    } catch (e) {
      return String(e).includes("models.dataPolicy");
    }
  };
  ok(!refuses({}), "setting: {} is valid");
  ok(!refuses(FULL), "setting: every row set is valid");
  ok(!refuses({ region: "us" }), "setting: region us is valid");
  ok(refuses({ region: "asia" }), "setting: an unknown region fails config load");
  ok(refuses({ zeroRetention: "yes" }), "setting: a non-boolean row fails config load");
  ok(refuses({ zeroRetentionn: true }), "setting: an unknown row fails config load, by name");
  ok(refuses([]), "setting: an array fails config load");
  const doc = settingDocs().find((d) => d.path === "models.dataPolicy");
  ok(doc !== undefined && doc.shipped.includes("{}"), "setting: the operator table carries the row, shipped empty");
}

ok(json(vercelDataPolicyOptions({})) === "{}", "mapping: {} adds no key");
ok(json(vercelDataPolicyOptions({ zeroRetention: true })) === json({ zeroDataRetention: true }), "mapping: zeroRetention → zeroDataRetention");
ok(json(vercelDataPolicyOptions({ noTraining: true })) === json({ disallowPromptTraining: true }), "mapping: noTraining → disallowPromptTraining");
ok(json(vercelDataPolicyOptions({ region: "eu" })) === json({ inferenceRegion: { scope: "zone", geoRegion: "eu" } }), "mapping: region eu → inferenceRegion zone eu");
ok(json(vercelDataPolicyOptions({ zeroRetention: false, noTraining: false })) === "{}", "mapping: a false row adds no key");

{
  const call = { prompt: [], providerOptions: { gateway: { caching: "auto", order: ["zai"], zeroDataRetention: false }, openai: { x: 1 } } };
  const merged = withDataPolicy(call, FULL);
  ok(gwOf(merged).zeroDataRetention === true, "merge: the policy WINS over a call's own `zeroDataRetention: false`");
  ok(gwOf(merged).caching === "auto" && json(gwOf(merged).order) === json(["zai"]), "merge: the call's other gateway keys pass through");
  ok(json(merged.providerOptions["openai"]) === json({ x: 1 }), "merge: another provider's options pass through");
  ok(gwOf(call).zeroDataRetention === false, "merge: the input is not mutated");
  ok(withDataPolicy(call, {}) === call, "merge: an empty policy returns the same options object");
  const bare: { prompt: unknown[]; providerOptions?: AnyOpts } = { prompt: [] };
  ok(gwOf(withDataPolicy(bare, { region: "us" })).inferenceRegion !== undefined, "merge: a bare call (the compaction shape) gets the rows");
}

{
  const refused400 = (): Error => Object.assign(new Error(LIVE_REFUSAL), { statusCode: 400, isRetryable: false });
  const named = dataPolicyCallError(MODEL, { zeroRetention: true, region: "eu" }, refused400());
  ok(named instanceof Error && named.message.startsWith("models.dataPolicy (zeroRetention, region eu): no provider serves"), "refusal: the error names the rows");
  ok(named instanceof Error && named.message.includes(MODEL) && named.message.includes("does not fall back"), "refusal: the error names the model and says it fails closed");
  const outage = Object.assign(new Error("No available providers right now"), { statusCode: 503, isRetryable: true });
  ok(dataPolicyCallError(MODEL, FULL, outage) === outage, "refusal: a retryable 5xx with the same words is an outage — it passes unchanged and does not blame the rows");
  const other = new Error("rate limited");
  ok(dataPolicyCallError(MODEL, FULL, other) === other, "refusal: an unrelated error passes unchanged");
  const raw = refused400();
  ok(dataPolicyCallError(MODEL, {}, raw) === raw, "refusal: with no policy the gateway's own error passes unchanged");
}

{
  overrideSettingsForTest({ models: { dataPolicy: FULL } });
  const seen: AnyOpts[] = [];
  class Fake {
    readonly modelId = MODEL;
    get provider(): string {
      return "gateway";
    }
    async doGenerate(o: AnyOpts): Promise<string> {
      seen.push(o);
      return "g";
    }
    async doStream(o: AnyOpts): Promise<string> {
      seen.push(o);
      throw Object.assign(new Error(LIVE_REFUSAL), { statusCode: 400 });
    }
  }
  const m = policyModel(new Fake());
  ok(m instanceof Fake && m.modelId === MODEL && m.provider === "gateway", "proxy: the model keeps its class, id and provider");
  let noOpts: unknown;
  try {
    await (m.doGenerate as (o?: unknown) => Promise<string>)(undefined);
  } catch (e) {
    noOpts = e;
  }
  ok(noOpts instanceof Error && noOpts.message.startsWith("models.dataPolicy (") && seen.length === 0, "proxy: a call with no options object cannot carry the rows — it refuses and sends nothing");
  ok((await m.doGenerate({ prompt: [] })) === "g" && gwOf(seen[0]!).zeroDataRetention === true, "proxy: doGenerate carries the rows");
  let streamErr: unknown;
  try {
    await m.doStream({ prompt: [], providerOptions: { gateway: { disallowPromptTraining: false } } });
  } catch (e) {
    streamErr = e;
  }
  ok(gwOf(seen[1]!).disallowPromptTraining === true, "proxy: doStream carries the rows, over the call's own");
  ok(streamErr instanceof Error && streamErr.message.includes("models.dataPolicy (zeroRetention, noTraining, region eu)"), "proxy: a refusal names the rows");
  resetSettingsForTest();
  await m.doGenerate({ prompt: [] });
  ok(seen[2]!["providerOptions"] === undefined, "proxy: the policy is read per call — reset, and the next call carries no rows");
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
const refusal = (): Response =>
  new Response(JSON.stringify({ error: { message: LIVE_REFUSAL, type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
const bodyGw = (c: Captured): AnyOpts => ((c.body["providerOptions"] as AnyOpts | undefined)?.["gateway"] ?? {}) as AnyOpts;

overrideSettingsForTest({ models: { dataPolicy: { zeroRetention: true, region: "eu" } } });
try {
  await withGateway(textReply, async (calls) => {
    await generateText({ model: gatewayModelBackend({ caching: "auto" }).model(MODEL), prompt: "hi" });
    ok(bodyGw(calls[0]!).zeroDataRetention === true && json(bodyGw(calls[0]!).inferenceRegion) === json({ scope: "zone", geoRegion: "eu" }), "wire: the turn backend's request carries the rows");
  });
  await withGateway(textReply, async (calls) => {
    await generateText({ model: gatewayLanguageModel(MODEL), prompt: "hi", providerOptions: { gateway: { zeroDataRetention: false } } });
    ok(bodyGw(calls[0]!).zeroDataRetention === true, "wire: a side call's request carries the rows, over its own `false`");
  });
  await withGateway(textReply, async (calls) => {
    await gatewayImageDescriber({ id: "alibaba/qwen3-vl-instruct" }).describe({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
    ok(bodyGw(calls[0]!).zeroDataRetention === true, "wire: the image describer's request carries the rows");
  });
  await withGateway(textReply, async (calls) => {
    await generateText({ model: MODEL, prompt: "hi" });
    ok(calls.length === 1 && bodyGw(calls[0]!).zeroDataRetention === true, "wire: a bare model id string resolves through the policy provider");
  });
  {
    const dp = (globalThis as { AI_SDK_DEFAULT_PROVIDER?: Record<string, unknown> }).AI_SDK_DEFAULT_PROVIDER!;
    const build = (member: string, id: string): Record<string, (o: unknown) => Promise<unknown>> =>
      (dp[member] as (id: string) => Record<string, (o: unknown) => Promise<unknown>>)(id);
    for (const [member, method, opts] of [
      ["evaluationModel", "doEvaluate", { state: { messages: [] }, questions: [] }],
      ["evaluation", "doEvaluate", { state: { messages: [] }, questions: [] }],
      ["rerankingModel", "doRerank", { documents: { type: "text", values: ["a"] }, query: "q" }],
      ["chat", "doGenerate", { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }],
    ] as const) {
      await withGateway(refusal, async (calls) => {
        try {
          await build(member, MODEL)[method]!(opts);
        } catch {
        }
        ok(calls.length === 1 && bodyGw(calls[0]!).zeroDataRetention === true, `wire: the default provider's \`${member}\` sends ${method} with the rows`);
      });
    }
    const t = dp["experimental_transcription"] as { getToken?: (o?: unknown) => unknown };
    ok(typeof t.getToken === "function", "provider: a wrapped member keeps its own properties (experimental_transcription.getToken)");
    const refusesSilently = async (label: string, needle: string, call: () => Promise<unknown> | unknown): Promise<void> => {
      await withGateway(textReply, async (calls) => {
        let err: unknown;
        try {
          await call();
        } catch (e) {
          err = e;
        }
        ok(err instanceof Error && err.message.includes(needle) && calls.length === 0, `${label} refuses under a policy and sends nothing`);
      });
    };
    await refusesSilently("provider: a streaming-transcription session token", "experimental_transcription.getToken cannot carry the rows", () => t.getToken!({ model: "spacexai/grok-stt" }));
    const rt = dp["experimental_realtime"] as ((id: string) => { doCreateClientSecret(o?: unknown): Promise<unknown> }) & { getToken?: (o?: unknown) => unknown };
    await refusesSilently("provider: a realtime session token", "experimental_realtime.getToken cannot carry the rows", () => rt.getToken!({ model: "openai/gpt-realtime" }));
    await refusesSilently("provider: a realtime client secret", "doCreateClientSecret cannot carry the rows", () => rt("openai/gpt-realtime").doCreateClientSecret({}));
    await withGateway(refusal, async (calls) => {
      try {
        await (dp["experimental_batch"] as () => { doStartBatch(o: unknown): Promise<unknown> })().doStartBatch({
          requests: [{ id: "a", type: "text", modelId: MODEL, options: { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], providerOptions: { gateway: { zeroDataRetention: false } } } }],
        });
      } catch {
      }
      const reqs = (calls[0]?.body["requests"] ?? []) as { options?: { providerOptions?: AnyOpts } }[];
      const reqGw = (reqs[0]?.options?.providerOptions?.["gateway"] ?? {}) as AnyOpts;
      ok(calls.length === 1 && reqGw.zeroDataRetention === true, `wire: a batch request carries the rows over its own \`false\` (body: ${JSON.stringify(calls[0]?.body ?? {}).slice(0, 200)})`);
    });
    ok(typeof dp["getCredits"] === "function" && dp["tools"] !== undefined, "provider: account reads and the tool catalogue pass through");
  }
  {
    let sentForeign = 0;
    let mintedForeign = 0;
    const foreign = Object.assign((id: string) => ({ modelId: id, doGenerate: async () => (sentForeign++, "f") }), {
      experimental_transcription: Object.assign((id: string) => ({ modelId: id }), { getToken: async () => (mintedForeign++, "tok") }),
    });
    const guarded = foreignProviderGuard(foreign) as unknown as ((id: string) => { doGenerate(o: unknown): Promise<unknown> }) & {
      experimental_transcription: { getToken(): Promise<unknown> };
    };
    let tokErr: unknown;
    try {
      await guarded.experimental_transcription.getToken();
    } catch (e) {
      tokErr = e;
    }
    ok(tokErr instanceof Error && tokErr.message.includes("cannot carry the rows") && mintedForeign === 0, "foreign provider: a member's token call refuses under a policy and mints nothing");
    let err: unknown;
    try {
      await guarded("x").doGenerate({ prompt: [] });
    } catch (e) {
      err = e;
    }
    ok(err instanceof Error && err.message.includes("not the gateway adapter's") && sentForeign === 0, "foreign provider: under a policy a call refuses with the guard's own words and sends nothing");
    resetSettingsForTest();
    ok((await guarded("x").doGenerate({ prompt: [] })) === "f" && sentForeign === 1, "foreign provider: with no policy it runs untouched");
    ok((await guarded.experimental_transcription.getToken()) === "tok" && mintedForeign === 1, "foreign provider: with no policy a member's token call runs untouched");
    overrideSettingsForTest({ models: { dataPolicy: { zeroRetention: true, region: "eu" } } });
  }
  {
    const { execFileSync } = await import("node:child_process");
    const run = (mode: string): { kept: boolean; own: boolean; refused: string; sent: number; errors: string[] } =>
      JSON.parse(
        execFileSync(process.execPath, ["--import", "tsx", "scripts/_default-provider-install-fixture.ts", mode], { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } })
          .trim()
          .split("\n")
          .pop()!,
      );
    const foreign = run("foreign");
    ok(foreign.kept, "install: a foreign default provider is kept, behind the guard");
    ok(foreign.refused.includes("not the gateway adapter's") && foreign.sent === 0, "install: under a policy a call through it refuses with the guard's own words and sends nothing");
    ok(foreign.errors.some((e) => e.includes("AI_SDK_DEFAULT_PROVIDER was already set")), "install: the boot reports the foreign provider");
    const nul = run("null");
    ok(nul.own && nul.errors.length === 0, "install: a `null` default provider is replaced by the policy provider");
  }
  await withGateway(
    () => new Response(JSON.stringify({ text: "hello", segments: [] }), { status: 200, headers: { "content-type": "application/json" } }),
    async (calls) => {
      await transcribe({ model: gatewayTranscriptionModel("spacexai/grok-stt"), audio: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]) });
      ok(bodyGw(calls[0]!).zeroDataRetention === true, "wire: a gateway transcription request carries the rows");
    },
  );
  await withGateway(refusal, async (calls) => {
    let err: unknown;
    try {
      await generateText({ model: gatewayLanguageModel(MODEL), prompt: "hi", maxRetries: 0 });
    } catch (e) {
      err = e;
    }
    const msg = err instanceof Error ? err.message : String(err);
    ok(msg.includes("models.dataPolicy (zeroRetention, region eu)") && msg.includes(MODEL), "fail closed: the refusal names the rows and the model");
    ok(calls.length === 1, "fail closed: one request, no fallback to another model or provider");
  });
  {
    let sent = 0;
    const f = (async () => {
      sent++;
      return new Response(JSON.stringify({ text: "x" }), { status: 200 });
    }) as unknown as typeof fetch;
    const route = { via: "deepinfra" as const, id: "Qwen/Qwen3-ASR-1.7B" };
    let err: unknown;
    try {
      await routeTransport(route, { fetch: f, secret: async () => "k", dataPolicy: () => ({ zeroRetention: true }) })({ audio: new Uint8Array([1]), mediaType: "audio/wav" });
    } catch (e) {
      err = e;
    }
    ok(err instanceof Error && err.message.includes("models.dataPolicy (zeroRetention)") && sent === 0, "deepinfra: refuses under a policy, and sends nothing");
    await routeTransport(route, { fetch: f, secret: async () => "k", dataPolicy: () => ({}) })({ audio: new Uint8Array([1]), mediaType: "audio/wav" });
    ok(sent === 1, "deepinfra: with no policy the route sends as before");
  }
} finally {
  resetSettingsForTest();
}

await withGateway(textReply, async (calls) => {
  await generateText({ model: gatewayLanguageModel(MODEL), prompt: "hi" });
  const g = bodyGw(calls[0]!);
  ok(g.zeroDataRetention === undefined && g.disallowPromptTraining === undefined && g.inferenceRegion === undefined, "shipped: no policy key on the wire");
});

console.log(`model-data-policy: ${passed} assertions passed`);
