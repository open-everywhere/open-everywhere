export interface ModelCallWireRow {
  readonly seq: number;
  readonly org: string;
  readonly surfaceKey: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly ts: string;
  readonly model: string;
  readonly provider: string;
  readonly schemaVersion: number;
  readonly sha256: string;
  readonly bodyBytes: number;
  readonly bodyGzipB64: string;
  readonly truncated: boolean;
}

export interface ModelCallsQueryOpts {
  readonly turnId?: string;
  readonly limit?: number;
  readonly includeBody?: boolean;
}

export interface ModelCallsReadResult {
  readonly sessionId: string;
  readonly count: number;
  readonly includeBody: boolean;
  readonly captures: readonly ModelCallWireRow[];
}

export interface ReplayRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface CacheEvidence {
  readonly inputTokens: number | undefined;
  readonly cachedInputTokens: number | undefined;
  readonly hit: boolean;
}

export interface TriggerBinding {
  readonly id?: string;
  readonly threadSessionId?: string;
  readonly container?: string;
}

export interface ToolCallSummary {
  readonly toolName: string;
  readonly argsText: string;
}

export interface ReplayOutcome {
  readonly index: number;
  readonly status: number;
  readonly ok: boolean;
  readonly tools: readonly ToolCallSummary[];
  readonly answerText: string;
  readonly cache: CacheEvidence;
  readonly boundToTrigger: boolean | undefined;
  readonly tellHit: string | null;
  readonly error?: string;
}

export interface ReplaySummary {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepIndex: number;
  readonly model: string;
  readonly n: number;
  readonly outcomes: readonly ReplayOutcome[];
  readonly majorityTool: string | null;
  readonly toolConsistency: number;
  readonly bindingConsistency: number | null;
  readonly coldReplays: readonly number[];
}
