import { createHmac, timingSafeEqual } from "node:crypto";
import { createCredentialIntake, completeCredentialIntake, type RequestCredentialIntakeInput, type CredentialIntakeDeps } from "./intake.js";
import { getOperationalStore } from "../operational/provider.js";

export const INTAKE_PAGE_PATH = "/connect/v1/intake";

export const INTAKE_PAGE_KEY_ENV = "OE_INTAKE_PAGE_SIGNING_KEY";

const TOKEN_FIELD = "t";
const VALUE_FIELD = "k";

export function intakePageSigningKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = (env[INTAKE_PAGE_KEY_ENV] ?? "").trim();
  return v.length > 0 ? v : undefined;
}

export function intakePageBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = (env.OE_PUBLIC_BASE_URL ?? "").trim();
  if (explicit.length > 0) {
    const withScheme = /^https?:\/\//i.test(explicit) ? explicit : `https://${explicit}`;
    return withScheme.replace(/\/+$/, "");
  }
  const host = (env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim() || (env.VERCEL_URL ?? "").trim();
  return host.length > 0 ? `https://${host.replace(/\/+$/, "")}` : undefined;
}

export function intakePageAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return intakePageSigningKey(env) !== undefined && intakePageBaseUrl(env) !== undefined;
}

export interface IntakePageClaims {
  readonly v: 1;
  readonly org: string;
  readonly id: string;
  readonly rb: string;
  readonly exp: number;
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

export function mintIntakePageToken(claims: IntakePageClaims, secret: string): string {
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${payloadB64}.${sign(secret, payloadB64)}`;
}

export function verifyIntakePageToken(token: string, secret: string, now: number = Date.now()): IntakePageClaims | null {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const expected = sign(secret, payloadB64);
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expected);
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
  if (typeof c.org !== "string" || !c.org) return null;
  if (typeof c.id !== "string" || !c.id) return null;
  if (typeof c.rb !== "string" || !c.rb) return null;
  if (typeof c.exp !== "number" || !Number.isFinite(c.exp)) return null;
  if (c.exp <= now) return null;
  return { v: 1, org: c.org, id: c.id, rb: c.rb, exp: c.exp };
}

export interface IssueIntakePageLinkDeps extends CredentialIntakeDeps {
  readonly env?: NodeJS.ProcessEnv;
}

export async function issueIntakePageLink(
  input: RequestCredentialIntakeInput,
  deps: IssueIntakePageLinkDeps = {},
): Promise<{ id: string; url: string } | undefined> {
  const env = deps.env ?? process.env;
  const secret = intakePageSigningKey(env);
  const base = intakePageBaseUrl(env);
  if (!secret || !base) return undefined;

  const { id, expiresAt } = await createCredentialIntake(input, deps);
  const token = mintIntakePageToken(
    { v: 1, org: input.org, id, rb: input.requestedBy, exp: Date.parse(expiresAt) },
    secret,
  );
  const url = `${base}${INTAKE_PAGE_PATH}?${TOKEN_FIELD}=${encodeURIComponent(token)}`;
  return { id, url };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const PAGE_STYLE =
  "font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff";

function htmlResponse(status: number, title: string, inner: string): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<title>${esc(title)}</title></head>` +
    `<body style="${PAGE_STYLE}"><h1 style="font-size:1.25rem">${esc(title)}</h1>${inner}</body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function invalidPage(): Response {
  return htmlResponse(
    404,
    "This link is not valid",
    `<p>This credential link is not valid, or it has already been used or expired. Ask for a fresh one where you were given it.</p>`,
  );
}

function formPage(token: string, provider: string, domain: string | undefined, notice?: string): Response {
  const forWhom = domain ? `${esc(provider)} key for ${esc(domain)}` : `${esc(provider)} key`;
  const noticeHtml = notice ? `<p style="color:#b00020">${esc(notice)}</p>` : "";
  const inner =
    `<p>Enter the <strong>${forWhom}</strong>. It is stored encrypted on this deployment; the agent never sees it, and this link works only once.</p>` +
    noticeHtml +
    `<form method="post" action="${esc(INTAKE_PAGE_PATH)}" autocomplete="off">` +
    `<input type="hidden" name="${TOKEN_FIELD}" value="${esc(token)}">` +
    `<label for="k" style="display:block;font-weight:600;margin:.75rem 0 .25rem">API key</label>` +
    `<input id="k" name="${VALUE_FIELD}" type="password" autocomplete="off" spellcheck="false" ` +
    `style="width:100%;box-sizing:border-box;padding:.6rem;font:inherit;border:1px solid #ccc;border-radius:.4rem">` +
    `<button type="submit" style="margin-top:1rem;padding:.6rem 1.2rem;font:inherit;font-weight:600;color:#fff;background:#1a56db;border:0;border-radius:.4rem;cursor:pointer">Store securely</button>` +
    `</form>`;
  return htmlResponse(200, "Enter an API key", inner);
}

export interface IntakePageHandlerDeps extends CredentialIntakeDeps {
  readonly env?: NodeJS.ProcessEnv;
}

export async function handleIntakePageGet(req: Request, deps: IntakePageHandlerDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const secret = intakePageSigningKey(env);
  if (!secret) return new Response("not found", { status: 404 });

  const now = (deps.now ?? (() => new Date()))().getTime();
  const token = new URL(req.url).searchParams.get(TOKEN_FIELD) ?? "";
  const claims = verifyIntakePageToken(token, secret, now);
  if (!claims) return invalidPage();

  const intake = await getOperationalStore().getCredentialIntake(claims.org, claims.id);
  if (!intake || intake.usedAt || intake.requestedBy !== claims.rb || Date.parse(intake.expiresAt) <= now) {
    return invalidPage();
  }
  return formPage(token, intake.provider, intake.domain);
}

export async function handleIntakePagePost(req: Request, deps: IntakePageHandlerDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const secret = intakePageSigningKey(env);
  if (!secret) return new Response("not found", { status: 404 });

  const now = (deps.now ?? (() => new Date()))().getTime();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return invalidPage();
  }
  const token = typeof form.get(TOKEN_FIELD) === "string" ? (form.get(TOKEN_FIELD) as string) : "";
  const value = typeof form.get(VALUE_FIELD) === "string" ? (form.get(VALUE_FIELD) as string) : "";

  const claims = verifyIntakePageToken(token, secret, now);
  if (!claims) return invalidPage();

  if (!value.trim()) {
    const intake = await getOperationalStore().getCredentialIntake(claims.org, claims.id);
    if (!intake || intake.usedAt || intake.requestedBy !== claims.rb || Date.parse(intake.expiresAt) <= now) return invalidPage();
    return formPage(token, intake.provider, intake.domain, "Enter the API key.");
  }

  const result = await completeCredentialIntake(
    { org: claims.org, id: claims.id, value, submittedBy: claims.rb, audit: { platform: "web", workspace: "intake-page", surface: INTAKE_PAGE_PATH } },
    deps,
  );
  if (!result.ok) {
    if (result.code === "empty") {
      const intake = await getOperationalStore().getCredentialIntake(claims.org, claims.id);
      if (intake && !intake.usedAt) return formPage(token, intake.provider, intake.domain, "Enter the API key.");
    }
    return invalidPage();
  }

  const forWhom = result.domain ? `${esc(result.provider)} key for ${esc(result.domain)}` : `${esc(result.provider)} key`;
  return htmlResponse(
    200,
    "API key stored",
    `<p>Your <strong>${forWhom}</strong> was stored securely. The agent never saw the value, and this link is now used up. You can close this tab.</p>`,
  );
}
