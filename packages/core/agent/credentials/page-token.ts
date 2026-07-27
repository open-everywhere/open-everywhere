import { createHmac, timingSafeEqual } from "node:crypto";

export const PAGE_TOKEN_KEY_ENV = "OE_INTAKE_PAGE_SIGNING_KEY";

export type PageAudience = "intake" | "reveal";

export interface PageTokenClaims {
  readonly v: 1;
  readonly aud: PageAudience;
  readonly org: string;
  readonly id: string;
  readonly rb: string;
  readonly exp: number;
}

export function pageTokenSigningKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = (env[PAGE_TOKEN_KEY_ENV] ?? "").trim();
  return v.length > 0 ? v : undefined;
}

export function pageBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = (env.OE_PUBLIC_BASE_URL ?? "").trim();
  if (explicit.length > 0) {
    const withScheme = /^https?:\/\//i.test(explicit) ? explicit : `https://${explicit}`;
    return withScheme.replace(/\/+$/, "");
  }
  const host = (env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim() || (env.VERCEL_URL ?? "").trim();
  return host.length > 0 ? `https://${host.replace(/\/+$/, "")}` : undefined;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return Buffer.alloc(0);
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function sign(secret: string, payloadB64: string): string {
  return b64urlEncode(createHmac("sha256", secret).update(payloadB64, "utf8").digest());
}

export function mintPageToken(claims: PageTokenClaims, secret: string): string {
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${payloadB64}.${sign(secret, payloadB64)}`;
}

export function verifyPageToken(token: string, secret: string, expected: PageAudience, now: number = Date.now()): PageTokenClaims | null {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const expectedSig = sign(secret, payloadB64);
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    const raw = b64urlDecode(payloadB64);
    if (raw.length === 0) return null;
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  if (c.v !== 1) return null;
  if (c.aud !== expected) return null;
  if (typeof c.org !== "string" || !c.org) return null;
  if (typeof c.id !== "string" || !c.id) return null;
  if (typeof c.rb !== "string" || !c.rb) return null;
  if (typeof c.exp !== "number" || !Number.isFinite(c.exp)) return null;
  if (c.exp <= now) return null;
  return { v: 1, aud: expected, org: c.org, id: c.id, rb: c.rb, exp: c.exp };
}
