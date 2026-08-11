import assert from "node:assert/strict";
import { parseVisionResult, visionCallError } from "../agent/model/gateway-vision.js";

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

console.log(`✓ gateway-vision: ${n} assertions passed (strict-JSON parse + OCR-only + raw-text fallback + malformed/empty + model-id error attribution)`);
