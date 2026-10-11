import { createHash, createHmac, randomBytes } from "node:crypto";
import { processRegistrySlot } from "../lib/process-registry.js";

export function mintBoxKey(): string {
  return randomBytes(32).toString("hex");
}

export function boxAuthHeader(key: string, method: string, path: string, body: string, now: number = Date.now()): string {
  const digest = createHash("sha256").update(body).digest("hex");
  const sig = createHmac("sha256", key).update(`${now}\n${method}\n${path}\n${digest}`).digest("hex");
  return `${now}.${sig}`;
}

export interface BoxResponse {
  readonly status: number;
  readonly json?: Record<string, unknown>;
  readonly bytes?: Uint8Array;
}

export type BoxTransport = (req: { readonly url: string; readonly method: "GET" | "POST"; readonly headers: Record<string, string>; readonly body?: string; readonly timeoutMs: number }) => Promise<BoxResponse>;

const defaultTransport: BoxTransport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
    signal: AbortSignal.timeout(req.timeoutMs),
    redirect: "error",
  });
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
};

const TRANSPORT = processRegistrySlot<BoxTransport>("personal-browser-box-transport.v1");

export function setBoxTransportForTest(t: BoxTransport): () => void {
  const prev = TRANSPORT.get();
  TRANSPORT.set(t);
  return () => {
    TRANSPORT.set(prev);
  };
}

export class BoxCallError extends Error {
  constructor(message: string, readonly unreachable: boolean) {
    super(message);
    this.name = "BoxCallError";
  }
}

export async function callBox(
  box: { readonly url: string; readonly key: string },
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  timeoutMs = 45_000,
): Promise<BoxResponse> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers: Record<string, string> = { "x-oe-box-auth": boxAuthHeader(box.key, method, path, raw) };
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: BoxResponse;
  try {
    res = await (TRANSPORT.get() ?? defaultTransport)({ url: `${box.url.replace(/\/+$/, "")}${path}`, method, headers, ...(body !== undefined ? { body: raw } : {}), timeoutMs });
  } catch {
    throw new BoxCallError(`the browser box did not answer ${method} ${path}`, true);
  }
  if (res.status !== 200) throw new BoxCallError(`the browser box answered ${method} ${path} with ${res.status}`, res.status === 401 || res.status >= 500);
  return res;
}
