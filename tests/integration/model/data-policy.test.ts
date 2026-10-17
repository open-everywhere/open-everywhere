import { expect, test } from "vitest";

import { afterThisTest, bootAgent, setEnvForRunningAgent } from "../harness";

type CallableModel = { doGenerate(options: Record<string, unknown>): Promise<unknown> };
type DefaultProvider = { languageModel(id: string): CallableModel };

const MODEL = "deepseek/deepseek-v4-flash-0731";

test("the booted host resolves a bare model id through the policy provider, which carries models.dataPolicy and fails closed (OPE-2535)", async () => {
  await bootAgent();
  const provider = (globalThis as { AI_SDK_DEFAULT_PROVIDER?: DefaultProvider }).AI_SDK_DEFAULT_PROVIDER;
  expect(provider, "the booted bundle installed the adapter's default provider").toBeDefined();

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ models: { dataPolicy: { zeroRetention: true, region: "eu" } } });
  afterThisTest(() => settings.overrideSettingsForTest({ models: { dataPolicy: {} } }));
  const hadKey = process.env.AI_GATEWAY_API_KEY;
  setEnvForRunningAgent("AI_GATEWAY_API_KEY", "test-key-not-a-secret");
  afterThisTest(() => {
    if (hadKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else setEnvForRunningAgent("AI_GATEWAY_API_KEY", hadKey);
  });

  const sent: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input instanceof Request ? input.url : input).includes("ai-gateway")) return realFetch(input, init);
    sent.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ error: { message: `No provider for ${MODEL} supports the requested inference region.`, type: "invalid_request_error" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  let err: unknown;
  try {
    await provider!.languageModel(MODEL).doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  } catch (e) {
    err = e;
  } finally {
    globalThis.fetch = realFetch;
  }

  expect(sent).toHaveLength(1);
  const gw = (sent[0]!["providerOptions"] as Record<string, Record<string, unknown>> | undefined)?.["gateway"];
  expect(gw?.["zeroDataRetention"], "the request carries zeroRetention").toBe(true);
  expect(gw?.["inferenceRegion"], "the request carries the region").toEqual({ scope: "zone", geoRegion: "eu" });
  expect(err instanceof Error ? err.message : String(err), "the refusal names the rows and the model").toContain(`models.dataPolicy (zeroRetention, region eu): no provider serves "${MODEL}"`);
});
