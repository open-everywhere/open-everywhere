import type { ToolContext, ToolDefinition } from "eve/tools";
import type { BindableContext } from "../identity/binding.js";
import { assertEgressReach, type ReachDeps } from "./host-egress.js";

export function withEgressFence<I, O>(toolName: string, tool: ToolDefinition<I, O>, deps: Omit<ReachDeps, "tool"> = {}): ToolDefinition<I, O> {
  return {
    ...tool,
    async execute(input: I, ctx: ToolContext): Promise<O> {
      const url = (input as { url?: unknown } | null | undefined)?.url;
      if (typeof url !== "string" || url.trim() === "") {
        throw new Error(`${toolName}: no \`url\` to check against this session's egress allow-list — refusing.`);
      }
      await assertEgressReach(ctx as unknown as BindableContext, url, { ...deps, tool: toolName });
      return (await tool.execute(input, ctx)) as O;
    },
  };
}
