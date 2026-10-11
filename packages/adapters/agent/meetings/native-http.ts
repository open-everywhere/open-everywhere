export type NativeFetch = (url: string, init?: RequestInit) => Promise<Response>;

const NATIVE_CALL_TIMEOUT_MS = 30_000;

export const timedFetch: NativeFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(NATIVE_CALL_TIMEOUT_MS) });

const MAX_NATIVE_BODY_BYTES = 8 * 1024 * 1024;

export async function readCappedText(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_NATIVE_BODY_BYTES) throw new Error(`response body is ${declared} bytes, over the ${MAX_NATIVE_BODY_BYTES}-byte cap`);
  const text = await res.text();
  if (text.length > MAX_NATIVE_BODY_BYTES) throw new Error(`response body is over the ${MAX_NATIVE_BODY_BYTES}-byte cap`);
  return text;
}

export async function readJsonLoose(res: Response): Promise<Record<string, unknown>> {
  try {
    const v = JSON.parse(await readCappedText(res)) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function unexpectedStatus(what: string, status: number): Error {
  return new Error(`${what} answered HTTP ${status}`);
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

export class TokenCache {
  readonly #tokens = new Map<string, CachedToken>();
  get(key: string, now: number): string | undefined {
    const t = this.#tokens.get(key);
    return t !== undefined && t.expiresAt - 60_000 > now ? t.token : undefined;
  }
  set(key: string, token: string, expiresInSeconds: unknown, now: number): void {
    const s = typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 300;
    this.#tokens.set(key, { token, expiresAt: now + s * 1000 });
  }
}

export function onHost(raw: string, host: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.port === "" && (u.hostname === host || u.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}
