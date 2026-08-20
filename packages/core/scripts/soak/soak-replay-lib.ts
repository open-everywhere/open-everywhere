import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type {
  CacheEvidence,
  EndpointsResponse,
  ModelCallsQueryOpts,
  ModelCallsReadResult,
  ModelCallWireRow,
  ReplayOutcome,
  ReplayRequest,
  ReplaySummary,
  ToolCallSummary,
  TriggerBinding,
} from "./soak-replay-types.js";

export function buildModelCallsQuery(opts: ModelCallsQueryOpts): string {
  const params = new URLSearchParams();
  if (opts.turnId) params.set("turnId", opts.turnId);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.includeBody !== undefined) params.set("body", opts.includeBody ? "1" : "0");
  return params.toString();
}

export function parseModelCallsResponse(json: unknown): ModelCallsReadResult {
  const o = json as Record<string, unknown> | null;
  if (o === null || typeof o !== "object") throw new Error("model-calls response is not an object");
  if (typeof o.sessionId !== "string") throw new Error("model-calls response missing sessionId");
  if (!Array.isArray(o.captures)) throw new Error("model-calls response missing captures[]");
  return {
    sessionId: o.sessionId,
    count: typeof o.count === "number" ? o.count : o.captures.length,
    includeBody: o.includeBody === true,
    captures: o.captures as readonly ModelCallWireRow[],
  };
}

export function pickCutPoint(rows: readonly ModelCallWireRow[], opts: { readonly turnId?: string; readonly stepIndex?: number } = {}): ModelCallWireRow {
  let candidates = rows;
  if (opts.turnId !== undefined) candidates = candidates.filter((r) => r.turnId === opts.turnId);
  const turns = new Set(candidates.map((r) => r.turnId));
  if (turns.size === 0) throw new Error("pickCutPoint: no rows to choose from");
  if (turns.size > 1) throw new Error(`pickCutPoint: rows span ${turns.size} turns — pass turnId to narrow to one`);
  if (opts.stepIndex !== undefined) {
    const row = candidates.find((r) => r.stepIndex === opts.stepIndex);
    if (!row) throw new Error(`pickCutPoint: no row at stepIndex ${opts.stepIndex}`);
    return row;
  }
  return candidates.reduce((deepest, r) => (r.stepIndex > deepest.stepIndex ? r : deepest));
}

export const SUPPORTED_CAPTURE_SCHEMA_VERSIONS: readonly number[] = [1];

export interface DecodedCapture {
  readonly options: unknown;
  readonly serialised: string;
}

export function decodeCaptureBody(row: ModelCallWireRow): DecodedCapture {
  if (row.truncated) throw new Error(`decodeCaptureBody: row seq=${row.seq} was truncated at capture time — no body was stored; this capture cannot be replayed`);
  if (row.bodyGzipB64.length === 0) throw new Error(`decodeCaptureBody: row seq=${row.seq} has an empty body`);
  if (!SUPPORTED_CAPTURE_SCHEMA_VERSIONS.includes(row.schemaVersion)) {
    throw new Error(`decodeCaptureBody: row seq=${row.seq} has schemaVersion ${row.schemaVersion}, this bench supports [${SUPPORTED_CAPTURE_SCHEMA_VERSIONS.join(", ")}]`);
  }
  const serialised = gunzipSync(Buffer.from(row.bodyGzipB64, "base64")).toString("utf8");
  const actualSha = createHash("sha256").update(serialised, "utf8").digest("hex");
  if (actualSha !== row.sha256) {
    throw new Error(`decodeCaptureBody: row seq=${row.seq} sha256 mismatch — stored ${row.sha256}, decompressed body hashes to ${actualSha}. Refusing to replay a body that does not match its own recorded hash.`);
  }
  return { options: JSON.parse(serialised) as unknown, serialised };
}

const DEFAULT_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v4/ai";

export function gatewayBaseUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env.OE_AI_GATEWAY_URL?.trim();
  return override && override.length > 0 ? override : DEFAULT_GATEWAY_BASE_URL;
}

export function endpointsUrl(gatewayOrigin: string, modelId: string): string {
  return `${gatewayOrigin.replace(/\/+$/, "")}/v1/models/${modelId}/endpoints`;
}

export function parseEndpointsResponse(json: unknown): EndpointsResponse {
  const o = json as Record<string, unknown> | null;
  const data = o?.data as Record<string, unknown> | undefined;
  if (data === undefined || typeof data !== "object") throw new Error("endpoints response missing data object");
  const endpoints = data.endpoints;
  if (!Array.isArray(endpoints)) throw new Error("endpoints response missing data.endpoints[]");
  const providers = endpoints
    .map((e) => (e as Record<string, unknown> | null)?.provider_name)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  return { modelId: typeof data.id === "string" ? data.id : "", providers };
}

export async function fetchServingProviders(gatewayOrigin: string, apiKey: string, modelId: string): Promise<EndpointsResponse> {
  const res = await fetch(endpointsUrl(gatewayOrigin, modelId), {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
  });
  const json = (await res.json()) as unknown;
  if (!res.ok) throw new Error(`provider-endpoints probe failed for ${modelId}: HTTP ${res.status} — ${JSON.stringify(json).slice(0, 500)}`);
  return parseEndpointsResponse(json);
}

export function chooseProvider(providers: readonly string[], opts: { readonly only?: string } = {}): string {
  if (providers.length === 0) throw new Error("chooseProvider: no serving providers reported for this model — cannot pin a batch to nothing");
  if (opts.only !== undefined) {
    if (!providers.includes(opts.only)) {
      throw new Error(`chooseProvider: requested provider "${opts.only}" is not among this model's reported serving providers [${providers.join(", ")}]`);
    }
    return opts.only;
  }
  return providers[0];
}

export function pinProvider(options: unknown, provider: string): unknown {
  const o = (options ?? {}) as Record<string, unknown>;
  const priorProviderOptions = (o.providerOptions as Record<string, unknown> | undefined) ?? {};
  const priorGateway = (priorProviderOptions.gateway as Record<string, unknown> | undefined) ?? {};
  const gatewayOpts: Record<string, unknown> = { ...priorGateway, only: [provider] };
  delete gatewayOpts.order;
  return { ...o, providerOptions: { ...priorProviderOptions, gateway: gatewayOpts } };
}

export function buildReplayRequest(row: Pick<ModelCallWireRow, "model">, decoded: DecodedCapture, opts: { readonly apiKey: string; readonly baseUrl?: string }): ReplayRequest {
  const baseUrl = opts.baseUrl ?? gatewayBaseUrl();
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/language-model`,
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
      "ai-language-model-specification-version": "4",
      "ai-language-model-id": row.model,
      "ai-language-model-streaming": "false",
    },
    body: decoded.options,
  };
}

export function extractTriggerBinding(options: unknown): TriggerBinding | undefined {
  const text = collectStrings(options).join("\n");
  const match = /<message\b[^>]*\btrigger="true"[^>]*>/.exec(text);
  if (!match) return undefined;
  const tag = match[0];
  const attr = (name: string): string | undefined => {
    const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
    return m ? m[1] : undefined;
  };
  const binding: TriggerBinding = {
    id: attr("id"),
    threadSessionId: attr("thread-session-id"),
    container: attr("container"),
  };
  if (binding.id === undefined && binding.threadSessionId === undefined && binding.container === undefined) return undefined;
  return binding;
}

export function extractToolCalls(responseJson: unknown): ToolCallSummary[] {
  const content = contentArrayOf(responseJson);
  const out: ToolCallSummary[] = [];
  for (const part of content) {
    const p = part as Record<string, unknown>;
    if (p.type !== "tool-call") continue;
    const toolName = typeof p.toolName === "string" ? p.toolName : "unknown";
    const rawArgs = p.input ?? p.args ?? {};
    let argsText: string;
    try { argsText = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs); } catch { argsText = String(rawArgs); }
    out.push({ toolName, argsText });
  }
  return out;
}

export function extractAnswerText(responseJson: unknown): string {
  const content = contentArrayOf(responseJson);
  return content
    .filter((p) => (p as Record<string, unknown>).type === "text")
    .map((p) => String((p as Record<string, unknown>).text ?? ""))
    .join("\n")
    .trim();
}

function collectStrings(value: unknown, out: string[] = [], ancestors: unknown[] = []): string[] {
  if (typeof value === "string") { out.push(value); return out; }
  if (value === null || typeof value !== "object") return out;
  if (ancestors.includes(value)) return out;
  if (out.length > 5000) return out;
  ancestors.push(value);
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, ancestors);
  } else {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out, ancestors);
  }
  ancestors.pop();
  return out;
}

function contentArrayOf(responseJson: unknown): readonly unknown[] {
  const r = responseJson as Record<string, unknown> | null;
  const content = r?.content;
  return Array.isArray(content) ? content : [];
}

export function extractCacheEvidence(responseJson: unknown): CacheEvidence {
  const r = responseJson as Record<string, unknown> | null;
  const usage = r?.usage as Record<string, unknown> | undefined;
  const inputTokens = typeof usage?.inputTokens === "number" ? usage.inputTokens : undefined;
  const cachedInputTokens = typeof usage?.cachedInputTokens === "number" ? usage.cachedInputTokens : undefined;
  return { inputTokens, cachedInputTokens, hit: (cachedInputTokens ?? 0) > 0 };
}

export function boundToTrigger(binding: TriggerBinding | undefined, responseJson: unknown): boolean | undefined {
  if (binding === undefined) return undefined;
  const needles = [binding.id, binding.threadSessionId, binding.container].filter((v): v is string => typeof v === "string" && v.length > 0);
  if (needles.length === 0) return undefined;
  const haystack = JSON.stringify(contentArrayOf(responseJson));
  return needles.some((n) => haystack.includes(n));
}

export function tellPhraseMatch(text: string, tells: readonly string[] | undefined): string | null {
  if (!tells || tells.length === 0) return null;
  const lower = text.toLowerCase();
  for (const t of tells) {
    if (t.length > 0 && lower.includes(t.toLowerCase())) return t;
  }
  return null;
}

export async function fetchModelCalls(targetUrl: string, readToken: string, sessionId: string, opts: ModelCallsQueryOpts): Promise<ModelCallsReadResult> {
  const base = targetUrl.replace(/\/+$/, "");
  const qs = buildModelCallsQuery(opts);
  const res = await fetch(`${base}/control/v1/session/${encodeURIComponent(sessionId)}/model-calls${qs ? `?${qs}` : ""}`, {
    headers: { authorization: `Bearer ${readToken}`, accept: "application/json" },
  });
  const json = (await res.json()) as unknown;
  if (!res.ok) throw new Error(`model-calls read failed: HTTP ${res.status} — ${JSON.stringify(json).slice(0, 500)}`);
  return parseModelCallsResponse(json);
}

export async function postReplay(request: ReplayRequest): Promise<{ readonly status: number; readonly json: unknown }> {
  const r = await fetch(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(request.body) });
  const text = await r.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = { parseError: text.slice(0, 2000) }; }
  return { status: r.status, json };
}

export function summarizeReplaySet(meta: { readonly sessionId: string; readonly turnId: string; readonly stepIndex: number; readonly model: string; readonly pinnedProvider: string }, outcomes: readonly ReplayOutcome[]): ReplaySummary {
  const toolChoices = outcomes.map((o) => o.tools[0]?.toolName ?? null).filter((t): t is string => t !== null);
  const counts = new Map<string, number>();
  for (const t of toolChoices) counts.set(t, (counts.get(t) ?? 0) + 1);
  let majorityTool: string | null = null;
  let majorityCount = 0;
  for (const [tool, count] of counts) {
    if (count > majorityCount) { majorityTool = tool; majorityCount = count; }
  }
  const toolConsistency = toolChoices.length === 0 ? 0 : majorityCount / toolChoices.length;

  const bindingChecked = outcomes.filter((o) => o.boundToTrigger !== undefined);
  const bindingConsistency = bindingChecked.length === 0 ? null : bindingChecked.filter((o) => o.boundToTrigger === true).length / bindingChecked.length;

  const coldReplays = outcomes.filter((o) => o.index > 0 && o.ok && !o.cache.hit).map((o) => o.index);

  return {
    sessionId: meta.sessionId,
    turnId: meta.turnId,
    stepIndex: meta.stepIndex,
    model: meta.model,
    n: outcomes.length,
    outcomes,
    majorityTool,
    toolConsistency,
    bindingConsistency,
    coldReplays,
    pinnedProvider: meta.pinnedProvider,
  };
}
