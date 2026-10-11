import { getOperationalStore } from "../operational/provider.js";
import type { SurfaceMode, ToolUsageEntry, ToolUsageOutcome } from "../operational/store.js";
import { isConnectorOpTool, parseQualifiedToolName } from "../access/consequence.js";

export function toolUsageNames(toolName: string): { readonly connector: string; readonly tool: string } {
  try {
    if (isConnectorOpTool(toolName) && parseQualifiedToolName(toolName)?.namespace === undefined) {
      const sep = toolName.indexOf("__");
      return { connector: toolName.slice(0, sep), tool: toolName.slice(sep + 2) };
    }
  } catch {
  }
  return { connector: "", tool: toolName };
}

export function toolUsageOutcome(status: unknown, isError: unknown): ToolUsageOutcome {
  if (status === "rejected") return "rejected";
  if (status === "failed" || isError === true) return "error";
  return "ok";
}

async function appendToolUsage(entry: ToolUsageEntry): Promise<void> {
  try {
    await getOperationalStore().appendToolUsage(entry);
  } catch (err) {
    console.warn(`[open-everywhere:tool-usage] dropped a "${entry.event}" row for ${entry.connector ? `${entry.connector}/` : ""}${entry.tool}: ${String(err)}`);
  }
}

export interface PendingToolCall {
  readonly org: string;
  readonly ts: string;
  readonly surfaceKey: string;
  readonly surfaceMode?: SurfaceMode;
  readonly principalId?: string;
  readonly sessionId: string;
  readonly connector: string;
  readonly tool: string;
  readonly outcome: ToolUsageOutcome;
  readonly callId?: string;
}

export interface StepUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
}

const MAX_OPEN_STEPS = 512;
const openSteps = new Map<string, PendingToolCall[]>();

export function toolStepKey(sessionId: string, turnId: string, stepIndex: number): string {
  return `${sessionId}\u0000${turnId}\u0000${stepIndex}`;
}

export function bufferToolCall(stepKey: string, call: PendingToolCall): void {
  const calls = openSteps.get(stepKey);
  if (calls) {
    calls.push(call);
    return;
  }
  if (openSteps.size >= MAX_OPEN_STEPS) {
    const oldest = openSteps.keys().next().value;
    if (oldest !== undefined) openSteps.delete(oldest);
  }
  openSteps.set(stepKey, [call]);
}

function share(total: number | undefined, n: number): number {
  return typeof total === "number" && Number.isFinite(total) && total > 0 ? total / n : 0;
}

export async function flushToolStep(stepKey: string, usage: StepUsage | undefined, model: string | undefined): Promise<ToolUsageEntry[]> {
  const buffered = openSteps.get(stepKey);
  if (!buffered || buffered.length === 0) return [];
  openSteps.delete(stepKey);
  const calls = dropWrappers(buffered);
  const n = calls.length;
  const rows = calls.map(
    ({ callId: _callId, ...c }): ToolUsageEntry => ({
      ...c,
      event: "call",
      ...(model !== undefined ? { model } : {}),
      inputTokens: share(usage?.inputTokens, n),
      outputTokens: share(usage?.outputTokens, n),
      cacheReadTokens: share(usage?.cacheReadTokens, n),
    }),
  );
  for (const row of rows) await appendToolUsage(row);
  return rows;
}

function dropWrappers(calls: readonly PendingToolCall[]): PendingToolCall[] {
  const ids = new Set(calls.map((c) => c.callId).filter((id): id is string => id !== undefined));
  const parents = new Set<string>();
  for (const id of ids) {
    const m = /^(.*):\d+$/u.exec(id);
    if (m && ids.has(m[1]!)) parents.add(m[1]!);
  }
  return calls.filter((c) => c.callId === undefined || !parents.has(c.callId));
}

export async function flushToolTurn(sessionId: string, turnId: string): Promise<number> {
  const prefix = `${sessionId}\u0000${turnId}\u0000`;
  let written = 0;
  for (const key of [...openSteps.keys()]) {
    if (key.startsWith(prefix)) written += (await flushToolStep(key, undefined, undefined)).length;
  }
  return written;
}

export function _resetToolUsageBufferForTest(): void {
  openSteps.clear();
}

const CONNECTOR_OP_CARD_KIND = "op.connector";

export async function recordToolCard(input: {
  readonly org: string;
  readonly kind: string;
  readonly args: unknown;
  readonly surfaceKey: string;
  readonly principalId: string;
  readonly ts?: string;
}): Promise<void> {
  let names: { readonly connector: string; readonly tool: string } = { connector: "", tool: input.kind };
  if (input.kind === CONNECTOR_OP_CARD_KIND) {
    const tool = (input.args as { readonly tool?: unknown } | null)?.tool;
    if (typeof tool === "string" && tool.length > 0) names = toolUsageNames(tool);
  }
  await appendToolUsage({
    org: input.org,
    ts: input.ts ?? new Date().toISOString(),
    surfaceKey: input.surfaceKey,
    principalId: input.principalId,
    sessionId: "",
    event: "card",
    connector: names.connector,
    tool: names.tool,
    outcome: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
  });
}
