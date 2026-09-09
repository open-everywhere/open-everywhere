import assert from "node:assert/strict";
import { parseVisionResult, visionCallError, visionCallUsage } from "../agent/model/gateway-vision.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  const r = parseVisionResult('{"description": "A bar chart of Q3 revenue.", "ocr_text": "Q3 $4.2M"}');
  ok(r.description === "A bar chart of Q3 revenue." && r.ocrText === "Q3 $4.2M", "parses the strict-JSON description + ocr_text");
}
{
  const r = parseVisionResult('prose before {"description": "A cat.", "ocr_text": ""} and after');
  ok(r.description === "A cat." && r.ocrText === undefined, "extracts JSON wrapped in prose; empty ocr_text → omitted");
}
{
  const r = parseVisionResult('{"description": "", "ocr_text": "INVOICE #42"}');
  ok(r.description === "(no description returned)" && r.ocrText === "INVOICE #42", "OCR-only (empty description) → placeholder description + the OCR");
}

{
  const r = parseVisionResult("It's a photo of a whiteboard with a flow diagram.");
  ok(r.description === "It's a photo of a whiteboard with a flow diagram." && r.ocrText === undefined, "non-JSON completion → whole text as the description");
}
{
  const r = parseVisionResult("   ");
  ok(r.description === "(no description returned)" && r.ocrText === undefined, "empty/whitespace completion → placeholder, never throws");
}
{
  const r = parseVisionResult("{ not valid json ]");
  ok(r.description === "{ not valid json ]" && r.ocrText === undefined, "malformed JSON → raw-text fallback (no throw)");
}

{
  const e = visionCallError("alibaba/qwen3-vl-instruct", new Error("Your team has restricted access to this provider. Providers considered: alibaba"));
  ok(/^vision model "alibaba\/qwen3-vl-instruct": /.test(e.message), "a failed vision call is re-thrown prefixed with the ROLE'S model id");
  ok(/restricted access to this provider/.test(e.message), "…and the upstream refusal text is preserved verbatim after the prefix");
  ok(visionCallError("m", "a plain string throw").message === 'vision model "m": a plain string throw', "a non-Error throw is stringified, never dropped");
}

{
  const u = visionCallUsage("alibaba/qwen3-vl-instruct", {
    usage: {
      inputTokens: 1500,
      outputTokens: 120,
      inputTokenDetails: { cacheReadTokens: 40, cacheWriteTokens: 9 },
      outputTokenDetails: { reasoningTokens: 64 },
    },
    providerMetadata: { gateway: { cost: 0.00042, generationId: "gen_abc123" } },
  });
  ok(u.model === "alibaba/qwen3-vl-instruct", "usage names the model the ROLE ASKED FOR (the gateway publishes no resolved-model field; inventing one would be worse)");
  ok(u.inputTokens === 1500 && u.outputTokens === 120, "usage carries in/out tokens");
  ok(u.cacheReadTokens === 40 && u.cacheWriteTokens === 9, "🔴 cache tokens are read from the NESTED usage.inputTokenDetails, exactly where eve reads them");
  ok(u.reasoningTokens === 64, "🔴 reasoning tokens are read from the NESTED usage.outputTokenDetails — the ONLY live producer of the dimension, and a silent drift would be invisible");
  ok(u.costUsd === 0.00042, "the gateway's measured cost rides through (→ cost_source 'measured')");
  ok(u.generationId === "gen_abc123", "the gateway generation id rides through (the join key to the gateway's billing record)");
}
{
  const u = visionCallUsage("m", { providerMetadata: { gateway: { cost: "0.0031" } } });
  ok(u.costUsd === 0.0031, "🔴 a gateway cost delivered as a NUMERIC STRING is coerced, same as eve's extractGatewayCostUsd — otherwise a measured vision call would silently record $0");
  ok(u.inputTokens === undefined && u.outputTokens === undefined, "no usage block → no invented token counts");
}
{
  const u = visionCallUsage("m", {});
  ok(u.model === "m" && Object.keys(u).length === 1, "a response with neither usage nor gateway metadata yields the model id alone — nothing fabricated");
  const junk = visionCallUsage("m", { providerMetadata: { gateway: "not-an-object" } as never, usage: { inputTokens: Number.NaN } as never });
  ok(junk.costUsd === undefined && junk.generationId === undefined, "junk provider metadata is ignored rather than trusted (this number reaches a money column)");
  ok(junk.inputTokens === undefined, "🔴 a NaN token count is DROPPED, not propagated — NaN is a number, and this column is one a cap sums");
}

console.log(`✓ gateway-vision: ${n} assertions passed (strict-JSON parse + OCR-only + raw-text fallback + malformed/empty + model-id error attribution + OPE-403 usage extraction: nested cache tokens, string cost, junk metadata)`);
