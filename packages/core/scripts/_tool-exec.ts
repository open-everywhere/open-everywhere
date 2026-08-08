type AnyToolLike = { execute: (...args: never[]) => unknown };

export type ToolResult<T extends AnyToolLike> = Exclude<Awaited<ReturnType<T["execute"]>>, AsyncIterable<unknown>>;

export function execTool<T extends AnyToolLike>(tool: T): (...args: Parameters<T["execute"]>) => Promise<ToolResult<T>> {
  return tool.execute as unknown as (...args: Parameters<T["execute"]>) => Promise<ToolResult<T>>;
}
