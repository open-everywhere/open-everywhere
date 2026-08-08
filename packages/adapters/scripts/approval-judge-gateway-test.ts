import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { approvalJudgeCallSettings } from "../agent/model/approval-judge.js";
import { readModelStamp, stampModelCall, withModelStampScope } from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const DEFAULTS = { id: "openai/gpt-5.6-luna", gateway: { caching: "auto" } };

{
  const s = approvalJudgeCallSettings("verdict", DEFAULTS);
  ok(s.id === DEFAULTS.id, "verdict: the fixed judge-role id, never a routed one — there is no scope parameter to route by");
  ok(s.maxOutputTokens === undefined, "verdict: the full-reasoning pass carries no output cap");
  ok((s.providerOptions?.gateway as Record<string, unknown>)?.caching === "auto", "verdict: the registered gateway defaults ride the call");
  ok(
    (s.providerOptions?.gateway as Record<string, unknown>)?.zeroDataRetention === undefined,
    "verdict: no ZDR pin is fabricated — the app passes what it registered and nothing else (OPE-323: ZDR is gateway org policy)",
  );
}

{
  const s = approvalJudgeCallSettings("scrutiny", DEFAULTS);
  ok(s.id === DEFAULTS.id, "scrutiny: same fixed id — the cost split is call settings, not a second model");
  ok(
    typeof s.maxOutputTokens === "number" && s.maxOutputTokens >= 16 && s.maxOutputTokens <= 2048,
    "scrutiny: a bounded output budget makes pass 1 the cheap gate (>=16: provider floor; the answer is one word but a reasoning model spends thinking tokens inside the cap)",
  );
  ok((s.providerOptions?.gateway as Record<string, unknown>)?.caching === "auto", "scrutiny: the SHARED prompt prefix rides gateway caching (the CC cost trick)");
}

{
  const s = approvalJudgeCallSettings("verdict", { id: "openai/gpt-5.6-luna" });
  ok(s.providerOptions === undefined, "bare: no gateway defaults ⇒ no providerOptions fabricated");
}

{
  ok(readModelStamp() === null, "stamp: nothing stamped before any call");
  await withModelStampScope(DEFAULTS.id, async () => {
    ok(readModelStamp() === null, "stamp: sessionless scope is a no-op, never a throw");
  });

  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const { ContextContainer, contextStorage } = await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href);
  await contextStorage.run(new ContextContainer(), async () => {
    stampModelCall("deepseek/seat-model");
    await withModelStampScope(DEFAULTS.id, async () => {
      ok(readModelStamp() === DEFAULTS.id, "stamp: the judge id is stamped DURING the call (its own usage attributes to it)");
    });
    ok(readModelStamp() === "deepseek/seat-model", "stamp: the seat's stamp is RESTORED after a completed call — step costing sees the seat model");

    let threw = false;
    try {
      await withModelStampScope(DEFAULTS.id, async () => {
        throw new Error("gateway resolution failed");
      });
    } catch {
      threw = true;
    }
    ok(threw, "stamp: the scope rethrows — failure semantics belong to the caller (core's fail-closed defer)");
    ok(readModelStamp() === "deepseek/seat-model", "stamp: the seat's stamp is RESTORED on the THROW path too — the live leak, pinned");
  });
}

console.log(`✓ approval-judge-gateway: ${passed} assertions — pass → settings mapping (fixed role id, scrutiny budget, gateway defaults) and the model stamp`);
