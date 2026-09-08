import { AsyncLocalStorage } from "node:async_hooks";
import "eve/tools/web_fetch";
import type { ToolContext, ToolDefinition } from "eve/tools";
import type { BindableContext } from "../identity/binding.js";
import { assertEgressHop, type ReachDeps } from "./host-egress.js";

interface HopScope {
  readonly ctx: BindableContext;
  readonly tool: string;
  readonly deps: Omit<ReachDeps, "tool">;
}

interface HopHookGlobals {
  __oeWebFetchHopGuard?: (rawUrl: string, hop: number) => Promise<void>;
  __oeWebFetchHopPatched?: boolean;
  __oeWebFetchHopScope?: AsyncLocalStorage<HopScope>;
}
const hookGlobals = globalThis as HopHookGlobals;

const hopScope = (hookGlobals.__oeWebFetchHopScope ??= new AsyncLocalStorage<HopScope>());

export const HOP_HOOK_ABSENT =
  "the per-hop redirect fence is not installed in the framework's dispatch (the committed eve patch did not apply), " +
  "so a redirect could reach a host this session's egress allow-list never declared — refusing the fetch rather than the check.";

hookGlobals.__oeWebFetchHopGuard = async (rawUrl: string, hop: number): Promise<void> => {
  const scope = hopScope.getStore();
  if (scope === undefined) {
    throw new Error(
      `web_fetch: a redirect to "${rawUrl}" was offered outside the egress fence's scope, so no allow-list could decide it — refusing to follow it.`,
    );
  }
  await assertEgressHop(scope.ctx, rawUrl, hop, { ...scope.deps, tool: scope.tool });
};

export function withEgressFence<I, O>(toolName: string, tool: ToolDefinition<I, O>, deps: Omit<ReachDeps, "tool"> = {}): ToolDefinition<I, O> {
  return {
    ...tool,
    async execute(input: I, ctx: ToolContext): Promise<O> {
      const url = (input as { url?: unknown } | null | undefined)?.url;
      if (typeof url !== "string" || url.trim() === "") {
        throw new Error(`${toolName}: no \`url\` to check against this session's egress allow-list — refusing.`);
      }
      if (hookGlobals.__oeWebFetchHopPatched !== true) {
        throw new Error(`${toolName}: ${HOP_HOOK_ABSENT}`);
      }
      const bindable = ctx as unknown as BindableContext;
      await assertEgressHop(bindable, url, 0, { ...deps, tool: toolName });
      return await hopScope.run({ ctx: bindable, tool: toolName, deps }, async () => (await tool.execute(input, ctx)) as O);
    },
  };
}
