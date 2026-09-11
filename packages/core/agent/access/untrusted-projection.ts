import { hostAuthoredModelOutput, ingestUntrustedModelOutput, UNTRUSTED_OPEN } from "./untrusted.js";
import { declaredContentOriginForToolName } from "./connector-content-origin-state.js";
import { restrictToolsetForJobWake } from "./job-posture.js";
import { currentJobWakePosture } from "./job-session-state.js";
import { restrictToolsetForLeanSeat } from "./lean-seat.js";
import { currentLeanSeatIsDm, currentLeanSeatPosture } from "./lean-seat-state.js";
import { restrictToolsetForWorkerSeat } from "./worker-seat.js";
import { currentHaltStamp } from "./halt-state.js";
import { currentWorkerWake } from "./worker-seat-state.js";
import { restrictToolsetForInvokerPosture } from "./invoker-posture.js";
import { currentInvokerPosture } from "./invoker-posture-state.js";
import { nativeAgentAllowedNow } from "./native-delegation-state.js";
import { TASK_CHILD_TOOL_NAME, TASK_PARENT_TOOL_NAMES } from "./background-tasks.js";
import { refuseAgentContinuation } from "./worker-continuation.js";
import { claimWorkerToolsetEvidence, currentWorkerToolsetIdentity } from "./worker-toolset-state.js";
import { auditWorkerToolset } from "../audit/worker-toolset.js";

const AUTH_PENDING_BRAND = "__eveAuthorizationPending";

function isAuthPendingOutput(output: unknown): boolean {
  return typeof output === "object" && output !== null && (output as Record<string, unknown>)[AUTH_PENDING_BRAND] === true;
}

interface ToolModelOutputShape {
  type: string;
  value: unknown;
}

interface AiSdkToolLike {
  execute?: (...args: unknown[]) => unknown;
  toModelOutput?: (args: { output: unknown; toolCallId: string }) => ToolModelOutputShape | Promise<ToolModelOutputShape>;
}

const authoredProjectionNames = new Set<string>();

export function registerAuthoredProjectionName(name: string): void {
  authoredProjectionNames.add(name);
}

export function registeredProjectionNames(): readonly string[] {
  return [...authoredProjectionNames];
}

const variantProjectedNames = new Set<string>();

export function setVariantProjectedName(mountedName: string, projected: boolean): void {
  if (projected) variantProjectedNames.add(mountedName);
  else variantProjectedNames.delete(mountedName);
}

export function variantProjectedNameList(): readonly string[] {
  return [...variantProjectedNames];
}

function isConnectorExternalName(name: string): boolean {
  return (name.includes("__") || name === "connection_search") && !authoredProjectionNames.has(name);
}

function isStatusOnlyConnectionSearch(output: unknown): boolean {
  if (!Array.isArray(output) || output.length === 0) return false;
  return output.every((el) => {
    if (el === null || typeof el !== "object") return false;
    const row = el as Record<string, unknown>;
    if ("tool" in row || "qualifiedName" in row) return false;
    return typeof row.error === "string" || row.needsAuthorization === true;
  });
}

export function recordWorkerToolset(tools: readonly string[], withheld: readonly string[]): void {
  try {
    const who = currentWorkerToolsetIdentity();
    if (who === null) return;
    const reason = claimWorkerToolsetEvidence(JSON.stringify([...tools].sort()));
    if (reason === null) return;
    void auditWorkerToolset({ who, reason, tools, withheld }).catch(() => undefined);
  } catch {
  }
}

export const HALTED_WITHHELD_TOOLS: readonly string[] = ["web_search", "web_fetch"];

export function projectToolSet(toolset: Record<string, unknown>): void {
  if (currentJobWakePosture() === "restricted") restrictToolsetForJobWake(toolset);
  else if (currentLeanSeatPosture() === "lean") restrictToolsetForLeanSeat(toolset, currentLeanSeatIsDm());

  const workerWake = currentWorkerWake();
  const workerWithheld = workerWake ? restrictToolsetForWorkerSeat(toolset) : [];
  restrictToolsetForInvokerPosture(toolset, currentInvokerPosture(), workerWake);

  if (currentHaltStamp() === true) {
    for (const name of HALTED_WITHHELD_TOOLS) delete toolset[name];
  }

  const agentAllowed = nativeAgentAllowedNow();
  if (toolset["agent"] !== undefined && !agentAllowed) {
    delete toolset["agent"];
  }

  if (!agentAllowed) {
    for (const name of TASK_PARENT_TOOL_NAMES) {
      if (toolset[name] !== undefined) delete toolset[name];
    }
  }
  if (!workerWake && toolset[TASK_CHILD_TOOL_NAME] !== undefined) {
    delete toolset[TASK_CHILD_TOOL_NAME];
  }

  refuseAgentContinuation(toolset);

  if (workerWake) recordWorkerToolset(Object.keys(toolset), workerWithheld);

  for (const [name, raw] of Object.entries(toolset)) {
    if (raw === null || typeof raw !== "object") continue;
    const tool = raw as AiSdkToolLike;

    if (isConnectorExternalName(name) && typeof tool.execute === "function") {
      const prev = tool.toModelOutput?.bind(tool);
      tool.toModelOutput = async (args) => {
        const output = args?.output;
        if (isAuthPendingOutput(output)) {
          if (prev !== undefined) return prev(args);
          return { type: "text", value: "Authorization required. Waiting for the user to sign in." };
        }
        let base: ToolModelOutputShape | undefined;
        let text: string;
        if (prev !== undefined) {
          base = await prev(args);
          text = base.type === "text" ? String(base.value) : JSON.stringify(base.value ?? null);
        } else {
          text = typeof output === "string" ? output : JSON.stringify(output ?? null);
        }
        if (base !== undefined && base.type === "text" && variantProjectedNames.has(name) && text.startsWith(`${UNTRUSTED_OPEN} `)) {
          return base;
        }
        if (name === "connection_search" && isStatusOnlyConnectionSearch(output)) {
          return hostAuthoredModelOutput(text, { source: `connector ${name}` });
        }
        const grantContentOrigin = declaredContentOriginForToolName(name);
        return ingestUntrustedModelOutput(text, {
          source: `connector ${name}`,
          ingestion: { kind: "connector", label: name, ...(grantContentOrigin !== undefined ? { grantContentOrigin } : {}) },
        });
      };
    }
  }
}

const HOOK_KEY = "__oeToolResultProjection";

export function installToolResultProjectionHook(): void {
  (globalThis as Record<string, unknown>)[HOOK_KEY] = projectToolSet;
}

installToolResultProjectionHook();
