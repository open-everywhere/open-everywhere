import { createCredentialIntake, completeCredentialIntake, type RequestCredentialIntakeInput, type CredentialIntakeDeps } from "./intake.js";
import { getOperationalStore } from "../operational/provider.js";
import { mintPageToken, pageBaseUrl, verifyPageToken, isReservedGrantConnector, PAGE_TOKEN_KEY_ENV, type PageTokenClaims } from "./page-token.js";
import { getOrMintSelfSecret, selfSecretsArmed } from "./self-secrets.js";
import type { CredentialIntakeRow } from "../operational/store.js";

export const INTAKE_PAGE_PATH = "/connect/v1/intake";

export const INTAKE_PAGE_KEY_ENV = PAGE_TOKEN_KEY_ENV;

const TOKEN_FIELD = "t";
const VALUE_FIELD = "k";

export async function intakePageSigningKey(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return getOrMintSelfSecret(PAGE_TOKEN_KEY_ENV, { env });
}

export function intakePageBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return pageBaseUrl(env);
}

export function intakePageAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return selfSecretsArmed() && intakePageBaseUrl(env) !== undefined;
}

export type IntakePageClaims = Omit<PageTokenClaims, "aud">;

export function mintIntakePageToken(claims: IntakePageClaims, secret: string): string {
  return mintPageToken({ ...claims, aud: "intake" }, secret);
}

export function verifyIntakePageToken(token: string, secret: string, now: number = Date.now()): IntakePageClaims | null {
  const c = verifyPageToken(token, secret, "intake", now);
  return c ? { v: c.v, org: c.org, id: c.id, rb: c.rb, exp: c.exp } : null;
}

export interface IssueIntakePageLinkDeps extends CredentialIntakeDeps {
  readonly env?: NodeJS.ProcessEnv;
}

export async function issueIntakePageLink(
  input: RequestCredentialIntakeInput,
  deps: IssueIntakePageLinkDeps = {},
): Promise<{ id: string; url: string } | undefined> {
  const env = deps.env ?? process.env;
  const base = intakePageBaseUrl(env);
  if (!base || !selfSecretsArmed()) return undefined;
  const secret = await intakePageSigningKey(env);

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

function formPage(token: string, connector: string, domain: string | undefined, notice?: string): Response {
  const forWhom = domain ? `${esc(connector)} key for ${esc(domain)}` : `${esc(connector)} key`;
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

function intakeRowOpen(row: CredentialIntakeRow | null, boundTo: string, nowMs: number): row is CredentialIntakeRow {
  return (
    row !== null &&
    !row.usedAt &&
    !isReservedGrantConnector(row.connector) &&
    row.requestedBy === boundTo &&
    Date.parse(row.expiresAt) > nowMs
  );
}

export async function handleIntakePageGet(req: Request, deps: IntakePageHandlerDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  if (!selfSecretsArmed()) return new Response("not found", { status: 404 });
  const secret = await intakePageSigningKey(env);

  const now = (deps.now ?? (() => new Date()))().getTime();
  const token = new URL(req.url).searchParams.get(TOKEN_FIELD) ?? "";
  const claims = verifyIntakePageToken(token, secret, now);
  if (!claims) return invalidPage();

  const intake = await getOperationalStore().getCredentialIntake(claims.org, claims.id);
  if (!intakeRowOpen(intake, claims.rb, now)) return invalidPage();
  return formPage(token, intake.connector, intake.domain);
}

export async function handleIntakePagePost(req: Request, deps: IntakePageHandlerDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  if (!selfSecretsArmed()) return new Response("not found", { status: 404 });
  const secret = await intakePageSigningKey(env);

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
    if (!intakeRowOpen(intake, claims.rb, now)) return invalidPage();
    return formPage(token, intake.connector, intake.domain, "Enter the API key.");
  }

  const result = await completeCredentialIntake(
    { org: claims.org, id: claims.id, value, submittedBy: claims.rb, audit: { platform: "web", workspace: "intake-page", surface: INTAKE_PAGE_PATH } },
    deps,
  );
  if (!result.ok) {
    if (result.code === "empty") {
      const intake = await getOperationalStore().getCredentialIntake(claims.org, claims.id);
      if (intakeRowOpen(intake, claims.rb, now)) return formPage(token, intake.connector, intake.domain, "Enter the API key.");
    }
    return invalidPage();
  }

  const forWhom = result.domain ? `${esc(result.connector)} key for ${esc(result.domain)}` : `${esc(result.connector)} key`;
  return htmlResponse(
    200,
    "API key stored",
    `<p>Your <strong>${forWhom}</strong> was stored securely. The agent never saw the value, and this link is now used up. You can close this tab.</p>`,
  );
}
