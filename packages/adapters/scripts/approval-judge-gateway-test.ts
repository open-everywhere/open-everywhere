import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { approvalJudgeCallSettings, resolvedApprovalJudgeCallSettings } from "../agent/model/approval-judge.js";
import { readModelStamp } from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const DEFAULTS = { id: "openai/gpt-5.6-luna", gateway: { zeroDataRetention: true, caching: "auto" } };

{
  const s = approvalJudgeCallSettings("verdict", DEFAULTS);
  ok(s.id === DEFAULTS.id, "verdict: the fixed judge-role id, never a routed one — there is no scope parameter to route by");
  ok(s.maxOutputTokens === undefined, "verdict: the full-reasoning pass carries no output cap");
  ok((s.providerOptions?.gateway as Record<string, unknown>)?.zeroDataRetention === true, "verdict: gateway defaults (ZDR) ride the call");
}

{
  const s = approvalJudgeCallSettings("scrutiny", DEFAULTS);
  ok(s.id === DEFAULTS.id, "scrutiny: same fixed id — the cost split is call settings, not a second model");
  ok(typeof s.maxOutputTokens === "number" && s.maxOutputTokens <= 16, "scrutiny: a one-word output budget makes pass 1 the cheap gate");
  ok((s.providerOptions?.gateway as Record<string, unknown>)?.caching === "auto", "scrutiny: the SHARED prompt prefix rides gateway caching (the CC cost trick)");
}

{
  const s = approvalJudgeCallSettings("verdict", { id: "openai/gpt-5.6-luna" });
  ok(s.providerOptions === undefined, "bare: no gateway defaults ⇒ no providerOptions fabricated");
}

{
  ok(readModelStamp() === null, "stamp: nothing stamped before any call");
  const outside = resolvedApprovalJudgeCallSettings("scrutiny", DEFAULTS);
  ok(outside.id === DEFAULTS.id && readModelStamp() === null, "stamp: sessionless call is a no-op, never a throw");

  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const { ContextContainer, contextStorage } = await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href);
  await contextStorage.run(new ContextContainer(), async () => {
    const inside = resolvedApprovalJudgeCallSettings("verdict", DEFAULTS);
    ok(inside.id === DEFAULTS.id && readModelStamp() === DEFAULTS.id, "stamp: inside a session the resolved id is stamped for hooks/spend.ts");
  });
}

console.log(`✓ approval-judge-gateway: ${passed} assertions — pass → settings mapping (fixed role id, scrutiny budget, gateway defaults) and the model stamp`);
