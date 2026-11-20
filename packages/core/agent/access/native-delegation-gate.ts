import { nativeAgentAllowedNow } from "./native-delegation-state.js";

/** eve's built-in delegation tool. On eve 1.x it mounts on every root session, and no file can withhold it. */
const NATIVE_AGENT_TOOL = "agent";

/** The refusal a seat reads when it calls the built-in `agent` without the per-wake verdict that admits it. */
export const NATIVE_AGENT_REFUSED_MESSAGE =
  "agent: this conversation does not start agent tasks. The call was NOT started. Forward a job with `work` when this conversation offers it, or answer yourself. Do not retry this call.";

/**
 * The per-wake `agent` verdict, enforced at call time. On eve 0.x the seat cut removed `agent` from
 * every session whose verdict is not `allow`. On eve 1.x eve mounts `agent` from its own root
 * defaults, so the seat cut cannot reach it. The root `approval` policy is the last edge before a
 * call to `agent` starts a task, so the verdict refuses the call there. It answers only for `agent`:
 * a declared subagent and every other tool keep their own decision.
 */
export function nativeAgentRefusal(toolName: string, allowed: () => boolean = nativeAgentAllowedNow): string | undefined {
  if (toolName !== NATIVE_AGENT_TOOL) return undefined;
  return allowed() ? undefined : NATIVE_AGENT_REFUSED_MESSAGE;
}
