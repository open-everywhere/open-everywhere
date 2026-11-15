import { capResult, maxResultChars } from "./result-cap.js";
import { reduceResultBody } from "./result-reduce.js";
import { noteToolResultLoop } from "./loop-breaker.js";

export interface ResultControlContext {
  readonly source?: string;
  readonly toolName?: string;
}

export interface ControlledResult {
  readonly body: string;
  readonly nudge: string | null;
}

export function capResultBody(content: string): string {
  return capResult(content);
}

export async function controlToolResult(content: string, ctx: ResultControlContext = {}): Promise<ControlledResult> {
  const limit = maxResultChars();
  const reduced = await reduceResultBody(content, limit, {
    source: "untrusted-result",
    ...(ctx.toolName !== undefined ? { toolName: ctx.toolName } : {}),
  });
  return { body: capResult(reduced, limit), nudge: noteToolResultLoop(ctx.source, content) };
}

export function controlHostResult(content: string, ctx: ResultControlContext = {}): ControlledResult {
  return { body: capResult(content), nudge: noteToolResultLoop(ctx.source, content) };
}

export function appendLoopNudge(rendered: string, nudge: string | null): string {
  return nudge ? `${rendered}\n\n${nudge}` : rendered;
}
