import { capResult } from "./result-cap.js";
import { getConfig, type AppConfig } from "./config.js";

export type ResultReduceSeam = "untrusted-result";

export interface ResultReduceContext {
  readonly source: ResultReduceSeam;
  readonly toolName?: string;
}

let ARM_TIMEOUT_MS = 8000;

export function resultArmTimeoutMs(): number {
  return ARM_TIMEOUT_MS;
}

export function _setResultArmTimeoutMsForTest(ms: number): void {
  ARM_TIMEOUT_MS = ms;
}

export function _resetResultArmTimeoutMsForTest(): void {
  ARM_TIMEOUT_MS = 8000;
}

const TIMED_OUT = Symbol("result-reduce-arm-timeout");

function registeredReduceResultArm(): AppConfig["reduceResult"] {
  try {
    return getConfig().reduceResult;
  } catch {
    return undefined;
  }
}

export async function reduceResultBody(body: string, limit: number, ctx: ResultReduceContext): Promise<string> {
  if (body.length <= limit) return body;
  const arm = registeredReduceResultArm();
  if (arm === undefined) return body;
  const answer = await runArm(arm, body, limit, ctx);
  if (answer === undefined) return body;
  return capResult(answer, limit);
}

async function runArm(
  arm: NonNullable<AppConfig["reduceResult"]>,
  body: string,
  limit: number,
  ctx: ResultReduceContext,
): Promise<string | undefined> {
  const where = ctx.toolName === undefined ? ctx.source : `${ctx.source} ${ctx.toolName}`;
  let answer: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ARM_TIMEOUT_MS);
    });
    answer = await Promise.race([Promise.resolve(arm(body, limit, ctx)), timeout]);
  } catch (err) {
    console.warn(`[open-everywhere:access] reduceResult arm threw for ${where}; kept the built-in truncation: ${String(err)}`);
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (answer === TIMED_OUT) {
    console.warn(`[open-everywhere:access] reduceResult arm exceeded ${ARM_TIMEOUT_MS}ms for ${where}; kept the built-in truncation`);
    return undefined;
  }
  if (answer === undefined) return undefined;
  if (typeof answer !== "string") {
    console.warn(
      `[open-everywhere:access] reduceResult arm returned ${typeof answer} for ${where}, which is not a string; kept the built-in truncation`,
    );
    return undefined;
  }
  if (answer.length === 0) {
    console.warn(`[open-everywhere:access] reduceResult arm returned an empty body for ${where}; kept the built-in truncation`);
    return undefined;
  }
  if (answer.length > limit) {
    console.warn(
      `[open-everywhere:access] reduceResult arm returned ${answer.length} chars for ${where}, over its ${limit} limit; the built-in cap re-applied`,
    );
  }
  return answer;
}
