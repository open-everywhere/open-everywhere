import { defineHook } from "eve/hooks";
import { appendAudit } from "../audit/audit.js";
import { auditSurfaceModeFrom, isSubagentChildContext, isUnifiedWindowContext, type BindableContext } from "../identity/binding.js";
import { bridgeableQuestionOf } from "../channels/question-bridge.js";
import { resolveReplyTarget } from "../channels/reply-post.js";
import { resolvePartition } from "../memory/partition.js";
import { optional } from "./control-refusal.js";
import { approvalCallOf } from "./approval-raised.js";

export const NATIVE_INPUT_REQUESTED_AUDIT_ACTION = "turn.native_input_requested";

export default defineHook({
  events: {
    "interaction.opened": optional("native-input-audit", async (event, ctx) => {
      const question = bridgeableQuestionOf(event.data);
      if (!question) return;
      const bindable = ctx as unknown as BindableContext;
      if (isUnifiedWindowContext(bindable)) return;
      if (isSubagentChildContext(bindable)) return;
      const target = resolveReplyTarget(bindable);
      if (target === null) return;
      const p = resolvePartition(bindable);
      const toolName = approvalCallOf(event.data, ctx.view)?.toolName ?? question.toolName;
      await appendAudit({
        action: NATIVE_INPUT_REQUESTED_AUDIT_ACTION,
        detail: { kind: question.kind, platform: target.platform, requestId: question.requestId, toolName },
        org: p.org,
        platform: p.platform,
        surface: p.surface,
        ...auditSurfaceModeFrom(bindable),
        workspace: p.workspace,
      });
    }),
  },
});
