import { randomUUID } from "node:crypto";
import { getOperationalStore } from "../operational/provider.js";
import { mintPageToken, pageBaseUrl, pageTokenSigningKey, verifyPageToken } from "../credentials/page-token.js";
import type { CredentialIntakeRow } from "../operational/store.js";

export const REVEAL_PAGE_PATH = "/connect/v1/reveal";

export const REVEAL_GRANT_PROVIDER = "webhook-reveal";

export const REVEAL_GRANT_TTL_MS = 15 * 60_000;

const TOKEN_FIELD = "t";

export function revealPageAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return pageTokenSigningKey(env) !== undefined && pageBaseUrl(env) !== undefined;
}

export interface RevealGrantDeps {
  readonly getStore?: () => Pick<ReturnType<typeof getOperationalStore>, "addCredentialIntake" | "getCredentialIntake" | "consumeCredentialIntake" | "getStoredCredential">;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly newId?: () => string;
}

export interface IssueRevealLinkInput {
  readonly org: string;
  readonly ref: string;
  readonly revealTo: string;
  readonly label: string;
}

export async function issueRevealLink(input: IssueRevealLinkInput, deps: RevealGrantDeps = {}): Promise<{ id: string; url: string } | undefined> {
  const env = deps.env ?? process.env;
  const secret = pageTokenSigningKey(env);
  const base = pageBaseUrl(env);
  if (!secret || !base) return undefined;

  const now = (deps.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + REVEAL_GRANT_TTL_MS).toISOString();
  const id = (deps.newId ?? randomUUID)();
  await (deps.getStore ?? getOperationalStore)().addCredentialIntake({
    org: input.org,
    id,
    ref: input.ref,
    provider: REVEAL_GRANT_PROVIDER,
    domain: input.label,
    requestedBy: input.revealTo,
    channelId: REVEAL_PAGE_PATH,
    createdAt: now.toISOString(),
    expiresAt,
  });
  const token = mintPageToken({ v: 1, aud: "reveal", org: input.org, id, rb: input.revealTo, exp: Date.parse(expiresAt) }, secret);
  return { id, url: `${base}${REVEAL_PAGE_PATH}?${TOKEN_FIELD}=${encodeURIComponent(token)}` };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const PAGE_STYLE =
  "font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff";

function htmlResponse(status: number, title: string, inner: string): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<meta name="referrer" content="no-referrer">` +
    `<title>${esc(title)}</title></head>` +
    `<body style="${PAGE_STYLE}"><h1 style="font-size:1.25rem">${esc(title)}</h1>${inner}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function invalidPage(): Response {
  return htmlResponse(
    404,
    "This link is not valid",
    `<p>This link is not valid, or it has already been used or expired. Secrets are shown once and cannot be shown again — ` +
      `ask for the webhook to be <strong>rotated</strong>, which issues a fresh secret and a fresh link.</p>`,
  );
}

function confirmPage(token: string, label: string): Response {
  const inner =
    `<p>You're about to see the signing secret for the <strong>${esc(label)}</strong> webhook.</p>` +
    `<p><strong>It is shown once.</strong> Nothing here or anywhere else can show it to you again — if you lose it, ` +
    `the webhook has to be rotated, which issues a new secret. Have the place you're pasting it into open before you continue.</p>` +
    `<form method="post" action="${esc(REVEAL_PAGE_PATH)}" autocomplete="off">` +
    `<input type="hidden" name="${TOKEN_FIELD}" value="${esc(token)}">` +
    `<button type="submit" style="margin-top:.5rem;padding:.6rem 1.2rem;font:inherit;font-weight:600;color:#fff;background:#1a56db;border:0;border-radius:.4rem;cursor:pointer">Show the secret</button>` +
    `</form>`;
  return htmlResponse(200, "Show a webhook signing secret", inner);
}

function secretPage(label: string, endpointUrl: string | undefined, secret: string): Response {
  const endpoint = endpointUrl
    ? `<p style="margin-top:1.5rem">Point the sender at this URL:</p>` +
      `<pre style="background:#f5f5f5;padding:.75rem;border-radius:.4rem;overflow-x:auto"><code>${esc(endpointUrl)}</code></pre>`
    : "";
  const inner =
    `<p>The signing secret for the <strong>${esc(label)}</strong> webhook. <strong>Copy it now</strong> — this page cannot be reloaded ` +
    `and the secret cannot be shown again.</p>` +
    `<pre style="background:#f5f5f5;padding:.75rem;border-radius:.4rem;overflow-x:auto"><code>${esc(secret)}</code></pre>` +
    endpoint +
    `<p style="margin-top:1.5rem;color:#666">This link is now used up. You can close this tab.</p>`;
  return htmlResponse(200, "Webhook signing secret", inner);
}

export interface RevealPageDeps extends RevealGrantDeps {
  readonly readSecret?: (ref: string) => Promise<string | null>;
  readonly endpointUrl?: (ref: string) => string | undefined;
}

function grantOpen(row: CredentialIntakeRow | null, boundTo: string, nowMs: number): row is CredentialIntakeRow {
  return (
    row !== null &&
    !row.usedAt &&
    row.provider === REVEAL_GRANT_PROVIDER &&
    row.requestedBy === boundTo &&
    Date.parse(row.expiresAt) > nowMs
  );
}

export async function handleRevealGet(req: Request, deps: RevealPageDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const secret = pageTokenSigningKey(env);
  if (!secret) return new Response("not found", { status: 404 });

  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const token = new URL(req.url).searchParams.get(TOKEN_FIELD) ?? "";
  const claims = verifyPageToken(token, secret, "reveal", nowMs);
  if (!claims) return invalidPage();

  const row = await (deps.getStore ?? getOperationalStore)().getCredentialIntake(claims.org, claims.id);
  if (!grantOpen(row, claims.rb, nowMs)) return invalidPage();
  return confirmPage(token, row.domain ?? "webhook");
}

export async function handleRevealPost(req: Request, deps: RevealPageDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const signingKey = pageTokenSigningKey(env);
  if (!signingKey) return new Response("not found", { status: 404 });

  const now = (deps.now ?? (() => new Date()))();
  const nowMs = now.getTime();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return invalidPage();
  }
  const token = typeof form.get(TOKEN_FIELD) === "string" ? (form.get(TOKEN_FIELD) as string) : "";
  const claims = verifyPageToken(token, signingKey, "reveal", nowMs);
  if (!claims) return invalidPage();

  const store = (deps.getStore ?? getOperationalStore)();
  const row = await store.getCredentialIntake(claims.org, claims.id);
  if (!grantOpen(row, claims.rb, nowMs)) return invalidPage();

  const won = await store.consumeCredentialIntake(claims.org, claims.id, now.toISOString());
  if (!won) return invalidPage();

  const readSecret = deps.readSecret ?? liveReadSecret;
  let value: string | null;
  try {
    value = await readSecret(row.ref);
  } catch {
    return invalidPage();
  }
  if (!value) return invalidPage();

  return secretPage(row.domain ?? "webhook", (deps.endpointUrl ?? ((r) => revealEndpointUrl(r, env)))(row.ref), value);
}

export function revealEndpointUrl(ref: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const base = pageBaseUrl(env);
  const hookId = ref.startsWith("hook:") ? ref.slice("hook:".length) : undefined;
  return base && hookId && !hookId.includes(":") ? `${base}/webhooks/${hookId}` : undefined;
}

async function liveReadSecret(ref: string): Promise<string | null> {
  const { encryptedKvVault } = await import("../credentials/kv-vault.js");
  return encryptedKvVault().read(ref);
}
