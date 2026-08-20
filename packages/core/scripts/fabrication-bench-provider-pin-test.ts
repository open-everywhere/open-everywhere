import assert from "node:assert/strict";
import { withPatchedFetch } from "./_fetch-test-utils.js";
import { fetchServingProviders, chooseProvider } from "./soak/soak-replay-lib.js";
import {
  BENCH_JUDGE_FLOOR,
  benchCheckJudgeFloor,
  benchGatewayOrigin,
  buildRequest,
  pinBenchRequest,
} from "./eval/fabrication-bench.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepEqual(a, b, label);
  n++;
};

function fakeFetch(
  handler: (url: string, init: RequestInit | undefined) => { status: number; body: unknown },
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const { status, body } = handler(url, init);
    const text = JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => text,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  if (!init?.body) return {};
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

async function main(): Promise<void> {
  eq(
    benchGatewayOrigin(),
    "https://ai-gateway.vercel.sh",
    "benchGatewayOrigin: strips the /v1/chat/completions path down to the bare origin fetchServingProviders needs",
  );

  {
    const body = buildRequest({ model: "openai/gpt-5.6-luna", system: "s", user: "u", withTools: true, effort: "high" });
    const pinned = pinBenchRequest(body, "azure") as unknown as Record<string, unknown>;
    eq(
      (pinned.providerOptions as { gateway: { only: string[] } }).gateway.only,
      ["azure"],
      "pinBenchRequest: sets providerOptions.gateway.only to exactly the pinned provider",
    );
    eq(pinned.model, "openai/gpt-5.6-luna", "pinBenchRequest: every other field survives untouched (model)");
    eq(pinned.tools, body.tools, "pinBenchRequest: every other field survives untouched (tools)");
    eq(pinned.reasoning_effort, "high", "pinBenchRequest: every other field survives untouched (reasoning_effort)");
  }

  {
    const body = buildRequest({ model: "openai/gpt-5.6-luna", system: "s", user: "u", withTools: false, effort: "high" });
    ok(
      (body as unknown as Record<string, unknown>).providerOptions === undefined,
      "🔴 NEGATIVE CONTROL: buildRequest's own output carries no providerOptions before pinBenchRequest runs",
    );
  }

  {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fake = fakeFetch((url, init) => {
      seen.push({ url, init });
      if (url.endsWith("/endpoints")) {
        return { status: 200, body: { data: { id: "openai/gpt-5.6-luna", endpoints: [{ provider_name: "azure" }, { provider_name: "bedrock" }] } } };
      }
      return { status: 200, body: {} };
    });
    await withPatchedFetch(fake, async () => {
      const endpoints = await fetchServingProviders(benchGatewayOrigin(), "sk-live-stub", "openai/gpt-5.6-luna");
      eq(endpoints.providers, ["azure", "bedrock"], "fetchServingProviders/stub: providers extracted from the stub's endpoints route");
      const probedUrl = seen[seen.length - 1].url;
      eq(
        probedUrl,
        "https://ai-gateway.vercel.sh/v1/models/openai/gpt-5.6-luna/endpoints",
        "fetchServingProviders: probed exactly the origin benchGatewayOrigin() derives from GATEWAY, not a hardcoded second literal",
      );
      eq(chooseProvider(endpoints.providers), "azure", "chooseProvider: the endpoints route's own first-ranked provider, unpinned by --only");
    });
  }

  {
    const seen: Record<string, unknown>[] = [];
    const fake = fakeFetch((_url, init) => {
      const body = bodyOf(init);
      seen.push(body);
      const messages = body.messages as { content: string }[] | undefined;
      const userMsg = messages?.[1]?.content ?? "";
      const matched = BENCH_JUDGE_FLOOR.find((c) => userMsg.includes(`THE ASSISTANT'S MESSAGE:\n${c.text}`));
      const verdict = matched?.want ?? "HONEST";
      return { status: 200, body: { choices: [{ message: { content: JSON.stringify({ verdict, why: "stub" }) } }] } };
    });

    await withPatchedFetch(fake, async () => {
      const result = await benchCheckJudgeFloor("sk-live-stub", "openai/gpt-5.6-luna", { hidden: "H", visible: "V", trigger: "T" }, 1, "bedrock");
      ok(result.passed, "benchCheckJudgeFloor: passes when the stub answers every must-pass case correctly");
      eq(seen.length, BENCH_JUDGE_FLOOR.length, "benchCheckJudgeFloor: posts exactly one request per floor case at repeats=1");
      for (const [i, body] of seen.entries()) {
        ok(
          JSON.stringify(body.providerOptions).includes('"only":["bedrock"]'),
          `🔴 benchCheckJudgeFloor draw ${i}: the request actually POSTed carries providerOptions.gateway.only:["bedrock"]`,
        );
      }
    });
  }

  {
    const seen: Record<string, unknown>[] = [];
    const fake = fakeFetch((_url, init) => {
      const body = bodyOf(init);
      seen.push(body);
      const messages = body.messages as { content: string }[] | undefined;
      const userMsg = messages?.[1]?.content ?? "";
      const matched = BENCH_JUDGE_FLOOR.find((c) => userMsg.includes(`THE ASSISTANT'S MESSAGE:\n${c.text}`));
      const verdict = matched?.want ?? "HONEST";
      return { status: 200, body: { choices: [{ message: { content: JSON.stringify({ verdict, why: "stub" }) } }] } };
    });

    await withPatchedFetch(fake, async () => {
      const result = await benchCheckJudgeFloor("sk-live-stub", "openai/gpt-5.6-luna", { hidden: "H", visible: "V", trigger: "T" }, 1);
      ok(result.passed, "benchCheckJudgeFloor: still passes with no provider — the pin is optional, not required for correctness");
      ok(seen.length > 0, "sanity: the stub actually received requests");
      for (const body of seen) {
        ok(
          body.providerOptions === undefined,
          "🔴 NEGATIVE CONTROL: benchCheckJudgeFloor with no `provider` argument posts an UNPINNED body",
        );
      }
    });
  }

  console.log(`✓ ${n} fabrication-bench-provider-pin assertions passed`);
}

await main();
