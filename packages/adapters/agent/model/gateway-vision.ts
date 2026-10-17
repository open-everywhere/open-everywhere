import { generateText } from "ai";
import { gatewayLanguageModel } from "./gateway.js";
import {
  type ImageDescribeRequest,
  type ImageDescribeResult,
  type ImageDescribeUsage,
  type ImageDescriber,
  registerImageDescriber,
} from "@open-everywhere/core/agent/adapter-api.js";

export interface GatewayVisionDefaults {
  readonly id: string;
  readonly gateway?: Record<string, unknown>;
}

const VISION_PROMPT =
  "You are a vision assistant reducing an image to text for a text-only agent. Look at the " +
  "image and reply with STRICT JSON only, no prose outside it: " +
  '{"description": "<a plain, factual description of what the image shows>", ' +
  '"ocr_text": "<ALL text visible in the image, transcribed verbatim; empty string if none>"}. ' +
  "Describe only what is actually visible — never invent detail you cannot see.";

export function parseVisionResult(text: string): ImageDescribeResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      const description = typeof o["description"] === "string" ? o["description"].trim() : "";
      const ocrRaw = typeof o["ocr_text"] === "string" ? o["ocr_text"].trim() : "";
      if (description.length > 0 || ocrRaw.length > 0) {
        return { description: description.length > 0 ? description : "(no description returned)", ...(ocrRaw.length > 0 ? { ocrText: ocrRaw } : {}) };
      }
    } catch {
    }
  }
  const raw = text.trim();
  return { description: raw.length > 0 ? raw : "(no description returned)" };
}

export function visionCallError(id: string, err: unknown): Error {
  return new Error(`vision model "${id}": ${err instanceof Error ? err.message : String(err)}`);
}

interface VisionCallTelemetry {
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly inputTokenDetails?: { readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number };
    readonly outputTokenDetails?: { readonly reasoningTokens?: number };
  };
  readonly providerMetadata?: Record<string, unknown>;
}

export function visionCallUsage(id: string, res: VisionCallTelemetry): ImageDescribeUsage {
  const u = res.usage;
  const gw = ((): Record<string, unknown> | undefined => {
    const raw = res.providerMetadata?.["gateway"];
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  })();
  const costUsd = ((): number | undefined => {
    const raw = gw?.["cost"];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  })();
  const generationId = typeof gw?.["generationId"] === "string" && (gw["generationId"] as string).length > 0 ? (gw["generationId"] as string) : undefined;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const tok = {
    inputTokens: num(u?.inputTokens),
    outputTokens: num(u?.outputTokens),
    cacheReadTokens: num(u?.inputTokenDetails?.cacheReadTokens),
    cacheWriteTokens: num(u?.inputTokenDetails?.cacheWriteTokens),
    reasoningTokens: num(u?.outputTokenDetails?.reasoningTokens),
  };
  return {
    model: id,
    ...(tok.inputTokens !== undefined ? { inputTokens: tok.inputTokens } : {}),
    ...(tok.outputTokens !== undefined ? { outputTokens: tok.outputTokens } : {}),
    ...(tok.cacheReadTokens !== undefined ? { cacheReadTokens: tok.cacheReadTokens } : {}),
    ...(tok.cacheWriteTokens !== undefined ? { cacheWriteTokens: tok.cacheWriteTokens } : {}),
    ...(tok.reasoningTokens !== undefined ? { reasoningTokens: tok.reasoningTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(generationId !== undefined ? { generationId } : {}),
  };
}

export function gatewayImageDescriber(defaults: GatewayVisionDefaults): ImageDescriber {
  return {
    async describe(req: ImageDescribeRequest): Promise<ImageDescribeResult> {
      let res: { text: string } & VisionCallTelemetry;
      try {
        res = await generateText({
          model: gatewayLanguageModel(defaults.id),
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: req.hint ? `${VISION_PROMPT}\nContext hint: ${req.hint}` : VISION_PROMPT },
                { type: "image", image: req.bytes, mediaType: req.mimeType },
              ],
            },
          ],
          ...(defaults.gateway !== undefined
            ? { providerOptions: { gateway: defaults.gateway } as Parameters<typeof generateText>[0]["providerOptions"] }
            : {}),
        });
      } catch (err) {
        throw visionCallError(defaults.id, err);
      }
      return { ...parseVisionResult(res.text), usage: visionCallUsage(defaults.id, res) };
    },
  };
}

export function registerGatewayImageDescriber(defaults: GatewayVisionDefaults): void {
  registerImageDescriber(gatewayImageDescriber(defaults));
}
