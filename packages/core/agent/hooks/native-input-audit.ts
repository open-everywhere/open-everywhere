import { defineHook, type HookContext } from "eve/hooks";
import { appendAudit } from "../audit/audit.js";
import { isSubagentChildContext, isUnifiedWindowContext, type BindableContext } from "../identity/binding.js";
import { detectBridgeableInputRequest } from "../channels/question-bridge.js";
import { resolveReplyTarget } from "../channels/reply-post.js";
import { resolvePartition } from "../memory/partition.js";

export const NATIVE_INPUT_REQUESTED_AUDIT_ACTION = "turn.native_input_requested";

export default defineHook({
  events: {
    "input.requested": async (event, ctx: HookContext) => {
      try {
        const question = detectBridgeableInputRequest((event.data as { requests?: unknown } | undefined)?.requests);
        if (!question) return;
        const bindable = ctx as unknown as BindableContext;
        if (isUnifiedWindowContext(bindable)) return;
        if (isSubagentChildContext(bindable)) return;
        const target = resolveReplyTarget(bindable);
        if (target === null) return;
        const p = resolvePartition(bindable);
        await appendAudit({
          action: NATIVE_INPUT_REQUESTED_AUDIT_ACTION,
          detail: { kind: question.kind, platform: target.platform, requestId: question.requestId, toolName: question.toolName },
          org: p.org,
          platform: p.platform,
          surface: p.surface,
          workspace: p.workspace,
        });
      } catch (err) {
        console.warn(`[open-everywhere:native-input-audit] audit skipped: ${String(err)}`);
      }
    },
  },
});
