import { experimental_transcribe as transcribe } from "ai";
import { type ModelDataPolicy, dataPolicyActive, dataPolicyRows, getOperatorSecret, getSettings } from "@open-everywhere/core/agent/adapter-api.js";
import { gatewayTargetHost, gatewayTranscriptionModel, sharedHostPlaneFetch } from "./gateway.js";

export type TranscriptionVia = "gateway" | "deepinfra" | "self-hosted";

export interface TranscriptionRouteSpec {
  readonly via: TranscriptionVia;
  readonly id: string;
  readonly baseUrl?: string;
}

export interface TranscriptionRoleSpec {
  readonly primary: TranscriptionRouteSpec;
  readonly fallback?: TranscriptionRouteSpec;
}

export interface TimedSpan {
  readonly text: string;
  readonly startSecond: number;
  readonly endSecond: number;
}

export interface TimedTranscript {
  readonly text: string;
  readonly segments: readonly TimedSpan[];
  readonly words: readonly TimedSpan[];
  readonly durationSeconds?: number;
  readonly costUsd?: number;
}

export interface TranscribeRequest {
  readonly audio: Uint8Array;
  readonly mediaType: string;
  readonly prompt?: string;
  readonly abortSignal?: AbortSignal;
}

export interface TranscriptionDeps {
  readonly gateway?: (modelId: string, req: TranscribeRequest) => Promise<TimedTranscript>;
  readonly fetch?: typeof fetch;
  readonly hostPlane?: (hosts: readonly string[]) => typeof fetch | undefined;
  readonly secret?: (name: string) => Promise<string>;
  readonly attemptTimeoutMs?: number;
  readonly warn?: (message: string) => void;
  readonly dataPolicy?: () => ModelDataPolicy;
}

export const DEEPINFRA_SECRET = "DEEPINFRA_API_KEY";
const DEEPINFRA_HOST = "api.deepinfra.com";

const ATTEMPT_TIMEOUT_MS = 40_000;

export function assertTranscriptionRole(role: TranscriptionRoleSpec): void {
  for (const [slot, r] of [["primary", role.primary], ["fallback", role.fallback]] as const) {
    if (r === undefined) continue;
    if (r.id.trim() === "") throw new Error(`transcription ${slot} route: the model id is empty`);
    if (r.via === "self-hosted") {
      if (r.baseUrl === undefined) throw new Error(`transcription ${slot} route: a self-hosted route needs baseUrl`);
      const u = new URL(r.baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`transcription ${slot} route: baseUrl must be http or https`);
      if (u.username !== "" || u.password !== "") throw new Error(`transcription ${slot} route: baseUrl must not carry credentials`);
    } else if (r.baseUrl !== undefined) {
      throw new Error(`transcription ${slot} route: baseUrl is for a self-hosted route only`);
    }
  }
}

function routeHost(r: TranscriptionRouteSpec): string {
  if (r.via === "deepinfra") return DEEPINFRA_HOST;
  if (r.via === "self-hosted") return new URL(r.baseUrl ?? "").hostname;
  return "the AI Gateway";
}

function routePhrase(r: TranscriptionRouteSpec): string {
  if (r.via === "gateway") return `this deployment's own AI Gateway to \`${r.id}\``;
  if (r.via === "deepinfra") return `DeepInfra (${DEEPINFRA_HOST}) to \`${r.id}\``;
  return `this deployment's own speech server at ${routeHost(r)} (\`${r.id}\`)`;
}

export function roleDisclosure(role: TranscriptionRoleSpec): string {
  const head = `Audio goes, in chunks of about a minute, through ${routePhrase(role.primary)}.`;
  return role.fallback === undefined ? head : `${head} If that fails, it goes through ${routePhrase(role.fallback)} instead.`;
}

export async function storeOnlySecret(
  name: string,
  resolve: (name: string) => Promise<{ readonly value: string; readonly source: string }> = getOperatorSecret,
): Promise<string> {
  const resolved = await resolve(name);
  if (resolved.source !== "db") {
    throw new Error(`secret "${name}" resolves only from the environment; the DeepInfra transcription route reads the secret store and nothing else. Store it with \`oe secret set ${name}\``);
  }
  return resolved.value;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function parseSpans(raw: unknown): TimedSpan[] {
  if (!Array.isArray(raw)) return [];
  const out: TimedSpan[] = [];
  for (const e of raw as Record<string, unknown>[]) {
    if (e === null || typeof e !== "object") continue;
    const text = typeof e.text === "string" ? e.text : typeof e.word === "string" ? e.word : undefined;
    const start = num(e.start ?? e.startSecond);
    const end = num(e.end ?? e.endSecond);
    if (text === undefined || start === undefined || end === undefined || end < start) continue;
    out.push({ text: text.trim(), startSecond: start, endSecond: end });
  }
  return out;
}

function spansAreWords(spans: readonly TimedSpan[]): boolean {
  return spans.length > 0 && spans.every((s) => s.text !== "" && !/\s/.test(s.text));
}

export function parseTranscriptionBody(body: unknown): TimedTranscript {
  if (body === null || typeof body !== "object") throw new Error("transcription response is not a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.text !== "string") throw new Error("transcription response has no text");
  const segments = parseSpans(b.segments);
  const words = parseSpans(b.words);
  const status = b.inference_status as Record<string, unknown> | undefined;
  const cost = num(status?.cost);
  const duration = num(b.duration);
  return {
    text: b.text.trim(),
    segments,
    words: words.length > 0 ? words : spansAreWords(segments) ? segments : [],
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
    ...(cost !== undefined ? { costUsd: cost } : {}),
  };
}

const lateFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

const defaultGateway = async (modelId: string, req: TranscribeRequest): Promise<TimedTranscript> => {
  const r = await transcribe({ model: gatewayTranscriptionModel(modelId), audio: req.audio, ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}) });
  const segments = r.segments.map((s) => ({ text: s.text.trim(), startSecond: s.startSecond, endSecond: s.endSecond }));
  const cost = num((r.providerMetadata?.gateway as Record<string, unknown> | undefined)?.cost);
  return {
    text: r.text.trim(),
    segments,
    words: spansAreWords(segments) ? segments : [],
    ...(r.durationInSeconds !== undefined ? { durationSeconds: r.durationInSeconds } : {}),
    ...(cost !== undefined ? { costUsd: cost } : {}),
  };
};

function fileName(mediaType: string): string {
  const sub = mediaType.split(";")[0]!.split("/")[1] ?? "bin";
  return `chunk.${sub.replace(/[^a-z0-9]/gi, "") || "bin"}`;
}

async function postForm(f: typeof fetch, url: string, form: FormData, headers: Record<string, string>, signal: AbortSignal | undefined): Promise<TimedTranscript> {
  const res = await f(url, { method: "POST", body: form, headers, ...(signal ? { signal } : {}) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  }
  return parseTranscriptionBody(await res.json());
}

function deepinfraCall(f: typeof fetch, secret: (name: string) => Promise<string>) {
  return async (r: TranscriptionRouteSpec, req: TranscribeRequest): Promise<TimedTranscript> => {
    const key = await secret(DEEPINFRA_SECRET);
    const form = new FormData();
    form.append("audio", new Blob([req.audio as Uint8Array<ArrayBuffer>], { type: req.mediaType }), fileName(req.mediaType));
    const path = r.id.split("/").map(encodeURIComponent).join("/");
    return await postForm(f, `https://${DEEPINFRA_HOST}/v1/inference/${path}`, form, { authorization: `Bearer ${key}` }, req.abortSignal);
  };
}

function selfHostedCall(f: typeof fetch) {
  return async (r: TranscriptionRouteSpec, req: TranscribeRequest): Promise<TimedTranscript> => {
    const form = new FormData();
    form.append("file", new Blob([req.audio as Uint8Array<ArrayBuffer>], { type: req.mediaType }), fileName(req.mediaType));
    form.append("model", r.id);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
    if (req.prompt !== undefined && req.prompt !== "") form.append("prompt", req.prompt);
    const base = (r.baseUrl ?? "").replace(/\/+$/, "");
    return await postForm(f, `${base}/audio/transcriptions`, form, {}, req.abortSignal);
  };
}

export function roleHostPlaneHosts(role: TranscriptionRoleSpec): string[] {
  const hosts = [gatewayTargetHost()];
  for (const r of [role.primary, role.fallback]) {
    if (r === undefined || r.via === "gateway") continue;
    const h = routeHost(r);
    if (!hosts.includes(h)) hosts.push(h);
  }
  return hosts;
}

export function routeTransport(r: TranscriptionRouteSpec, deps: TranscriptionDeps = {}): (req: TranscribeRequest) => Promise<TimedTranscript> {
  if (r.via === "gateway") {
    const g = deps.gateway ?? defaultGateway;
    return (req) => g(r.id, req);
  }
  const f = deps.fetch ?? (deps.hostPlane ?? sharedHostPlaneFetch)(roleHostPlaneHosts({ primary: r })) ?? lateFetch;
  if (r.via === "deepinfra") {
    const call = deepinfraCall(f, deps.secret ?? storeOnlySecret);
    const policy = deps.dataPolicy ?? (() => getSettings().models.dataPolicy);
    return async (req) => {
      const p = policy();
      if (dataPolicyActive(p)) {
        throw new Error(`models.dataPolicy (${dataPolicyRows(p).join(", ")}): the deepinfra route cannot carry these rows, so it refuses`);
      }
      return await call(r, req);
    };
  }
  const call = selfHostedCall(f);
  return (req) => call(r, req);
}

export interface RoleTranscript extends TimedTranscript {
  readonly answeredBy: "primary" | "fallback";
  readonly route: TranscriptionRouteSpec;
}

function describe(r: TranscriptionRouteSpec): string {
  return `${r.via}:${r.id}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function attempt(run: (req: TranscribeRequest) => Promise<TimedTranscript>, req: TranscribeRequest, timeoutMs: number): Promise<TimedTranscript> {
  const limit = new AbortController();
  const timer = setTimeout(() => limit.abort(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
  const signal = req.abortSignal ? AbortSignal.any([req.abortSignal, limit.signal]) : limit.signal;
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  try {
    return await Promise.race([run({ ...req, abortSignal: signal }), aborted]);
  } finally {
    clearTimeout(timer);
  }
}

export function transcribeWithFallback(role: TranscriptionRoleSpec, deps: TranscriptionDeps = {}): (req: TranscribeRequest) => Promise<RoleTranscript> {
  assertTranscriptionRole(role);
  const timeoutMs = deps.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const shared: TranscriptionDeps = { ...deps, fetch: deps.fetch ?? (deps.hostPlane ?? sharedHostPlaneFetch)(roleHostPlaneHosts(role)) ?? lateFetch };
  const primary = routeTransport(role.primary, shared);
  const fallback = role.fallback === undefined ? undefined : routeTransport(role.fallback, shared);
  return async (req) => {
    let first: unknown;
    try {
      return { ...(await attempt(primary, req, timeoutMs)), answeredBy: "primary", route: role.primary };
    } catch (err) {
      if (req.abortSignal?.aborted) throw err;
      first = err;
    }
    if (fallback === undefined || role.fallback === undefined) {
      throw new Error(`transcription failed on ${describe(role.primary)}: ${errText(first)}`);
    }
    warn(`[open-everywhere:transcription] ${describe(role.primary)} failed (${errText(first)}); trying the fallback ${describe(role.fallback)}`);
    try {
      return { ...(await attempt(fallback, req, timeoutMs)), answeredBy: "fallback", route: role.fallback };
    } catch (second) {
      throw new Error(`transcription failed on both routes — ${describe(role.primary)}: ${errText(first)}; ${describe(role.fallback)}: ${errText(second)}`);
    }
  };
}
