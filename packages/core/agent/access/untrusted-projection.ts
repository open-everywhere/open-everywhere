import { hostAuthoredModelOutput, ingestUntrustedModelOutput, UNTRUSTED_OPEN } from "./untrusted.js";
import { declaredContentOriginForToolName } from "./connector-content-origin-state.js";
import { restrictToolsetForJobWake } from "./job-posture.js";
import { currentJobWakePosture } from "./job-session-state.js";
import { restrictToolsetForLeanSeat } from "./lean-seat.js";
import { currentLeanSeatIsDm, currentLeanSeatPosture } from "./lean-seat-state.js";
import { restrictToolsetForWorkerSeat } from "./worker-seat.js";
import { currentWorkerWake } from "./worker-seat-state.js";
import { restrictToolsetForInvokerPosture } from "./invoker-posture.js";
import { currentInvokerPosture } from "./invoker-posture-state.js";
import { nativeSubagentEnabled } from "./delegation-flag.js";
import { nativeAgentAllowedNow } from "./native-delegation-state.js";
import { TASK_CHILD_TOOL_NAME, TASK_PARENT_TOOL_NAMES } from "./background-tasks.js";
import { refuseAgentContinuation } from "./worker-continuation.js";

const AUTH_PENDING_BRAND = "__eveAuthorizationPending";

function isAuthPendingOutput(output: unknown): boolean {
  return typeof output === "object" && output !== null && (output as Record<string, unknown>)[AUTH_PENDING_BRAND] === true;
}

export interface ToolModelOutputShape {
  type: string;
  value: unknown;
}

type AuthoredProjection = (output: unknown) => ToolModelOutputShape | Promise<ToolModelOutputShape>;

interface AiSdkToolLike {
  execute?: (...args: unknown[]) => unknown;
  toModelOutput?: (args: { output: unknown; toolCallId: string }) => ToolModelOutputShape | Promise<ToolModelOutputShape>;
}

const authoredProjections = new Map<string, AuthoredProjection>();

export function registerReplayModelProjection(name: string, projection: AuthoredProjection): void {
  authoredProjections.set(name, projection);
}

export function registeredProjectionNames(): readonly string[] {
  return [...authoredProjections.keys()];
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
  return (name.includes("__") || name === "connection_search") && !authoredProjections.has(name);
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

export function projectToolSet(toolset: Record<string, unknown>): void {
  if (currentJobWakePosture() === "restricted") restrictToolsetForJobWake(toolset);
  else if (currentLeanSeatPosture() === "lean") restrictToolsetForLeanSeat(toolset, currentLeanSeatIsDm());

  const workerWake = currentWorkerWake();
  if (workerWake) restrictToolsetForWorkerSeat(toolset);
  restrictToolsetForInvokerPosture(toolset, currentInvokerPosture(), workerWake);

  const nativeRegime = nativeSubagentEnabled();
  const agentAllowed = nativeRegime && nativeAgentAllowedNow();
  if (nativeRegime && toolset["agent"] !== undefined && !agentAllowed) {
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

  for (const [name, raw] of Object.entries(toolset)) {
    if (raw === null || typeof raw !== "object") continue;
    const tool = raw as AiSdkToolLike;

    const authored = authoredProjections.get(name);
    if (authored !== undefined) {
      if (typeof tool.execute !== "function") continue;
      const prev = tool.toModelOutput?.bind(tool);
      tool.toModelOutput = async (args) => {
        if (isAuthPendingOutput(args?.output) && prev !== undefined) return prev(args);
        return await authored(args?.output);
      };
      continue;
    }

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
