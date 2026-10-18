import { expect, test } from "vitest";

import { afterThisTest, bootAgent, setEnvForRunningAgent } from "../harness";

type CallableModel = { doGenerate(options: Record<string, unknown>): Promise<unknown> };
type DefaultProvider = { languageModel(id: string): CallableModel };
type Routes = { byId: ReadonlyMap<string, string>; fallback: string };

const SLOT = Symbol.for("open-everywhere.model.bareRoutes.v1");

test("the booted host registers its roles, and a bare id no role names goes through the primary role's target (OPE-2566)", async () => {
  await bootAgent();
  const box = (globalThis as { [k: symbol]: { oeSlot: Routes | null } | undefined })[SLOT];
  const booted = box?.oeSlot ?? null;
  expect(booted, "the booted app registered its roles for bare ids").not.toBeNull();
  const settings0 = (await import("@open-everywhere/core/agent/settings/settings.js")).getSettings().models;
  const { resolveStack } = await import("../../../agent/model/stacks.js");
  const stack = resolveStack(settings0.stack);
  const primaryId = settings0.force || settings0.primary || stack.primary.id;
  const expected = new Map<string, string>();
  for (const [role, spec] of Object.entries(stack)) {
    const id = role === "primary" ? primaryId : spec.id;
    if (!expected.has(id)) expected.set(id, spec.via ?? "gateway");
  }
  expect(new Map([...booted!.byId].sort()), "the registered table holds every role of the app's stack").toEqual(new Map([...expected].sort()));
  expect(booted!.fallback, "the deployment default is the primary role's target").toBe(stack.primary.via ?? "gateway");

  const provider = (globalThis as { AI_SDK_DEFAULT_PROVIDER?: DefaultProvider }).AI_SDK_DEFAULT_PROVIDER;
  expect(provider, "the booted bundle installed the adapter's default provider").toBeDefined();

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const { registerBareModelRoutes } = await import("@open-everywhere/core/agent/model/bare-model-via.js");
  const targets = settings.getSettings().models.targets;
  settings.overrideSettingsForTest({ models: { targets: { ...targets, mistral: { kind: "vercel-ai-gateway", providers: { only: ["mistral"] }, dataPolicy: { zeroRetention: true } } } } });
  afterThisTest(() => settings.overrideSettingsForTest({ models: { targets } }));
  registerBareModelRoutes([{ id: "mistral/mistral-small", via: "mistral" }]);
  afterThisTest(() => {
    box!.oeSlot = booted;
  });
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
    return new Response(JSON.stringify({ error: { message: "No available providers match the 'only' filter", type: "invalid_request_error" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  let err: unknown;
  try {
    await provider!.languageModel("vendor/unnamed").doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  } catch (e) {
    err = e;
  } finally {
    globalThis.fetch = realFetch;
  }

  expect(sent).toHaveLength(1);
  const gw = (sent[0]!["providerOptions"] as Record<string, Record<string, unknown>> | undefined)?.["gateway"];
  expect(gw?.["only"], "the request carries the primary target's provider pin, not gateway's").toEqual(["mistral"]);
  expect(gw?.["zeroDataRetention"], "the request carries the primary target's zero-retention row").toBe(true);
  expect(err instanceof Error ? err.message : String(err), "the refusal names the target's rows").toContain("models.targets.mistral.providers.only (mistral)");
});
