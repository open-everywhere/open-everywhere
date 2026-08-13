import { randomUUID } from "node:crypto";
import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { getConfig } from "../access/config.js";
import { escapeHtml as esc, securePageResponse, BUTTON_STYLE, CODE_BLOCK_STYLE } from "../credentials/page-chrome.js";
import { mintPageToken, pageBaseUrl, verifyPageToken, PAGE_TOKEN_KEY_ENV } from "../credentials/page-token.js";
import { getOrMintSelfSecret, selfSecretsArmed } from "../credentials/self-secrets.js";
import { webhookVerifier, type WebhookSenderGuidance } from "./verifier.js";
import type { CredentialIntakeRow } from "../operational/store.js";

export const REVEAL_PAGE_PATH = "/connect/v1/reveal";

export const REVEAL_GRANT_PROVIDER = "webhook-reveal";

export const REVEAL_GRANT_TTL_MS = 15 * 60_000;

const TOKEN_FIELD = "t";

export function revealPageAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return selfSecretsArmed() && pageBaseUrl(env) !== undefined;
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
  const base = pageBaseUrl(env);
  if (!base || !selfSecretsArmed()) return undefined;
  const secret = await getOrMintSelfSecret(PAGE_TOKEN_KEY_ENV, { env });

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

const htmlResponse = securePageResponse;

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
    `<button type="submit" style="${BUTTON_STYLE}">Show the secret</button>` +
    `</form>`;
  return htmlResponse(200, "Show a webhook signing secret", inner);
}

function guidanceHtml(g: WebhookSenderGuidance): string {
  const headers = g.headers.map((h) => `<li><code>${esc(h.name)}</code>: ${esc(h.value)}</li>`).join("");
  const notes = g.notes.map((t) => `<li style="margin-bottom:.35rem">${esc(t)}</li>`).join("");
  return (
    `<p style="margin-top:1.5rem">…and make it send these headers on every delivery:</p>` +
    `<ul style="padding-left:1.2rem">${headers}</ul>` +
    `<p>The signature is computed over exactly this, with no separator or whitespace of its own:</p>` +
    `<pre style="${CODE_BLOCK_STYLE}"><code>${esc(g.signedContent)}</code></pre>` +
    `<ul style="padding-left:1.2rem">${notes}</ul>`
  );
}

function secretPage(label: string, endpointUrl: string | undefined, secret: string, guidance?: WebhookSenderGuidance): Response {
  const endpoint = endpointUrl
    ? `<p style="margin-top:1.5rem">Point the sender at this URL:</p>` +
      `<pre style="${CODE_BLOCK_STYLE}"><code>${esc(endpointUrl)}</code></pre>`
    : "";
  const inner =
    `<p>The signing secret for the <strong>${esc(label)}</strong> webhook. <strong>Copy it now</strong> — this page cannot be reloaded ` +
    `and the secret cannot be shown again.</p>` +
    `<pre style="${CODE_BLOCK_STYLE}"><code>${esc(secret)}</code></pre>` +
    endpoint +
    (guidance ? guidanceHtml(guidance) : "") +
    `<p style="margin-top:1.5rem;color:#666">This link is now used up. You can close this tab.</p>`;
  return htmlResponse(200, "Webhook signing secret", inner);
}

export interface RevealPageDeps extends RevealGrantDeps {
  readonly readSecret?: (ref: string) => Promise<string | null>;
  readonly endpointUrl?: (ref: string) => string | undefined;
  readonly senderGuidance?: (ref: string, org: string) => Promise<WebhookSenderGuidance | undefined>;
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
  if (!selfSecretsArmed()) return new Response("not found", { status: 404 });
  const secret = await getOrMintSelfSecret(PAGE_TOKEN_KEY_ENV, { env });

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
  if (!selfSecretsArmed()) return new Response("not found", { status: 404 });
  const signingKey = await getOrMintSelfSecret(PAGE_TOKEN_KEY_ENV, { env });

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

  const hookId = revealedHookId(row.ref);
  await appendAudit({
    org: claims.org,
    platform: "web",
    workspace: "reveal-page",
    surface: REVEAL_PAGE_PATH,
    principalId: row.requestedBy,
    action: "webhook.secret_revealed",
    detail: {
      ...(hookId ? { hookId } : {}),
      ref: row.ref,
      grantId: claims.id,
      revealedAt: now.toISOString(),
    },
  });

  let guidance: WebhookSenderGuidance | undefined;
  try {
    guidance = await (deps.senderGuidance ?? liveSenderGuidance)(row.ref, claims.org);
  } catch {
    guidance = undefined;
  }

  return secretPage(row.domain ?? "webhook", (deps.endpointUrl ?? ((r) => revealEndpointUrl(r, env)))(row.ref), value, guidance);
}

async function liveSenderGuidance(ref: string, _org: string): Promise<WebhookSenderGuidance | undefined> {
  const hookId = revealedHookId(ref);
  if (!hookId) return undefined;
  let declared: { readonly source: string } | undefined;
  try {
    declared = (getConfig().loadWebhooks?.() ?? []).find((h) => h.id === hookId);
  } catch {
    declared = undefined;
  }
  return declared ? webhookVerifier(declared.source)?.senderGuidance?.() : undefined;
}

export function revealEndpointUrl(ref: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const base = pageBaseUrl(env);
  const hookId = revealedHookId(ref);
  return base && hookId ? `${base}/webhooks/${hookId}` : undefined;
}

export function revealedHookId(ref: string): string | undefined {
  const dbHook = "db:webhook:";
  if (ref.startsWith(dbHook)) {
    const rest = ref.slice(dbHook.length);
    return rest.length > 0 && !rest.includes(":") ? rest : undefined;
  }
  if (!ref.startsWith("hook:")) return undefined;
  const rest = ref.slice("hook:".length);
  return rest.length > 0 && !rest.includes(":") ? rest : undefined;
}

async function liveReadSecret(ref: string): Promise<string | null> {
  const { encryptedKvVault } = await import("../credentials/kv-vault.js");
  return encryptedKvVault().read(ref);
}
