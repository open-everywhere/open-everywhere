import { gateway, generateText } from "ai";
import {
  type ImageDescribeRequest,
  type ImageDescribeResult,
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

export function gatewayImageDescriber(defaults: GatewayVisionDefaults): ImageDescriber {
  return {
    async describe(req: ImageDescribeRequest): Promise<ImageDescribeResult> {
      const { text } = await generateText({
        model: gateway(defaults.id),
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
      return parseVisionResult(text);
    },
  };
}

export function registerGatewayImageDescriber(defaults: GatewayVisionDefaults): void {
  registerImageDescriber(gatewayImageDescriber(defaults));
}
