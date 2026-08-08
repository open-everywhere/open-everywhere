import type { ToolContext, ToolDefinition } from "eve/tools";
import type { BindableContext } from "../identity/binding.js";
import { assertEgressReach, type ReachDeps } from "./host-egress.js";

export function withEgressFence(toolName: string, tool: ToolDefinition, deps: Omit<ReachDeps, "tool"> = {}): ToolDefinition {
  return {
    ...tool,
    async execute(input: unknown, ctx: ToolContext) {
      const url = (input as { url?: unknown } | null | undefined)?.url;
      if (typeof url !== "string" || url.trim() === "") {
        throw new Error(`${toolName}: no \`url\` to check against this session's egress allow-list — refusing.`);
      }
      await assertEgressReach(ctx as unknown as BindableContext, url, { ...deps, tool: toolName });
      return tool.execute(input, ctx);
    },
  };
}
