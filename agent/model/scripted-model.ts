import { processRegistryMap } from "@open-everywhere/core/agent/lib/process-registry.js";

export const SCRIPTED_MODEL_ENV = "OE_SCRIPTED_MODEL";

export const SCRIPTED_MODEL_ID = "open-everywhere/scripted-model";

export function scriptedModelArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SCRIPTED_MODEL_ENV] === "1";
}

export interface ScriptedCall {
  readonly tool: string;
  readonly input?: unknown;
  readonly id?: string;
}

export interface ScriptedStep {
  readonly say?: string;
  readonly calls?: readonly ScriptedCall[];
}

export interface SeatScript {
  readonly parent: readonly ScriptedStep[];
  readonly child?: readonly ScriptedStep[];
}

export type ScriptedRole = "parent" | "child";

export interface RecordedToolResult {
  readonly name: string;
  readonly isError: boolean;
  readonly output: unknown;
}

export interface RecordedRequest {
  readonly role: ScriptedRole;
  readonly sessionId: string | undefined;
  readonly turnId: string | undefined;
  readonly stepIndex: number;
  readonly pid: number;
  readonly tools: readonly string[];
  readonly toolResults: readonly RecordedToolResult[];
  readonly messages: readonly { readonly role: string; readonly text: string }[];
  readonly fault?: string;
}

export interface ResolveObservation {
  readonly role: ScriptedRole;
  readonly sessionId: string | undefined;
  readonly turnId: string | undefined;
  readonly stepIndex: number;
  readonly pid: number;
  readonly channelKind: string | undefined;
  readonly classifiedKind: string;
  readonly hasSessionParent: boolean;
  readonly fault?: string;
  readonly eventEcho?: unknown;
}

export interface ScriptedEntry {
  readonly script: SeatScript;
  readonly requests: RecordedRequest[];
  readonly resolves: ResolveObservation[];
  readonly baselines: Record<string, number>;
}

export const ANY_SESSION = "*";

export function scriptedStore(): Map<string, ScriptedEntry> {
  return processRegistryMap<ScriptedEntry>("scripted-model.v1");
}

export interface ScriptedHandle {
  readonly requests: readonly RecordedRequest[];
  readonly resolves: readonly ResolveObservation[];
  dispose(): void;
}

export function registerScript(script: SeatScript, sessionId: string = ANY_SESSION): ScriptedHandle {
  if (!scriptedModelArmed()) {
    throw new Error(
      `open-everywhere: registerScript called without ${SCRIPTED_MODEL_ENV}=1. ` +
        "Arm the process before the agent boots, or this script can never answer a model call.",
    );
  }
  const store = scriptedStore();
  if (store.has(sessionId)) {
    throw new Error(
      `open-everywhere: a script is already registered for "${sessionId}". ` +
        "Dispose the previous handle first — two live scripts for one key means a test leaked.",
    );
  }
  const entry: ScriptedEntry = { script, requests: [], resolves: [], baselines: {} };
  store.set(sessionId, entry);
  return {
    requests: entry.requests,
    resolves: entry.resolves,
    dispose: () => {
      store.delete(sessionId);
    },
  };
}
