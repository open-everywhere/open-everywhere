import { generateText } from "ai";
import {
  type ApprovalJudgeCompletion,
  type JudgePass,
  registerApprovalJudgeCompletion,
} from "@open-everywhere/core/agent/adapter-api.js";
import { applyGatewayOptions, gatewayLanguageModel, type GatewayRoutedDefaults } from "./gateway.js";

const SCRUTINY_MAX_OUTPUT_TOKENS = 512;

export function approvalJudgeCallSettings(
  pass: JudgePass,
  defaults: GatewayRoutedDefaults,
): { id: string; maxOutputTokens?: number; providerOptions?: Record<string, unknown> } {
  const options = applyGatewayOptions({}, {}, { id: defaults.id, defaultId: defaults.id }, defaults.gateway);
  return {
    id: defaults.id,
    ...(pass === "scrutiny" ? { maxOutputTokens: SCRUTINY_MAX_OUTPUT_TOKENS } : {}),
    ...(options.providerOptions !== undefined ? { providerOptions: options.providerOptions } : {}),
  };
}

function gatewayApprovalJudgeCompletion(defaults: GatewayRoutedDefaults): ApprovalJudgeCompletion {
  return async (prompt, pass) => {
    const s = approvalJudgeCallSettings(pass, defaults);
    const { text } = await generateText({
      model: gatewayLanguageModel(s.id, defaults.via),
      prompt,
      ...(s.maxOutputTokens !== undefined ? { maxOutputTokens: s.maxOutputTokens } : {}),
      ...(s.providerOptions !== undefined
        ? { providerOptions: s.providerOptions as Parameters<typeof generateText>[0]["providerOptions"] }
        : {}),
    });
    return text;
  };
}

export function registerGatewayApprovalJudge(defaults: GatewayRoutedDefaults): void {
  registerApprovalJudgeCompletion(gatewayApprovalJudgeCompletion(defaults));
}
