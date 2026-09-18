import { asConsentResumeRecord, resumeAfterConsent, type ConsentResumeOutcome } from "./consent-resume.js";
import type { ConsentCarriage } from "./user-auth-flow.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";

export const OE_OAUTH_CALLBACK_PATH = "/oauth/v1/callback";

export interface OeOauthCallbackArgs {
  readonly state: string;
  readonly code: string;
}

export interface OeOauthCallbackResult {
  readonly ok: boolean;
  readonly connectionName?: string;
  readonly detail?: string;
  readonly subject?: { readonly type: "app" } | { readonly type: "user"; readonly id: string };
  readonly rebound?: boolean;
  readonly consent?: ConsentCarriage;
}

export type OeOauthCallbackCompleter = (args: OeOauthCallbackArgs) => Promise<OeOauthCallbackResult>;

let registered: OeOauthCallbackCompleter | undefined;

export function registerOeOauthCallbackCompleter(fn: OeOauthCallbackCompleter): void {
  registered = fn;
}

export function resetOeOauthCallbackCompleter(): void {
  registered = undefined;
}

export function resolveOeOauthCallbackCompleter(): OeOauthCallbackCompleter | null {
  return registered ?? null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(status: number, title: string, body: string): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
    `<h1 style="font-size:1.25rem">${esc(title)}</h1><p>${body}</p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function handleOeOauthCallback(
  req: Request,
  complete: OeOauthCallbackCompleter | null,
  deps: OeOauthCallbackDeps = {},
): Promise<Response> {
  if (!complete) return new Response("not found", { status: 404 });

  const url = new URL(req.url);
  const q = (name: string): string | undefined => {
    const v = (url.searchParams.get(name) ?? "").trim();
    return v.length > 0 ? v : undefined;
  };

  const state = q("state");
  const code = q("code");
  const error = q("error");

  if (error) {
    const desc = q("error_description");
    return page(
      400,
      "Authorization was not granted",
      `The provider returned <code>${esc(error)}</code>${desc ? `: ${esc(desc)}` : ""}. You can close this tab and try again.`,
    );
  }
  if (!state) return page(400, "Missing authorization state", "This link is missing its <code>state</code> parameter and cannot be completed.");
  if (!code) return page(400, "Missing authorization code", "This link is missing its <code>code</code> parameter and cannot be completed.");

  let result: OeOauthCallbackResult;
  try {
    result = await complete({ state, code });
  } catch (err) {
    return page(502, "Could not complete the connection", `The authorization exchange failed: ${esc(err instanceof Error ? err.message : String(err))}.`);
  }
  if (!result.ok) {
    return page(502, "Could not complete the connection", `The authorization exchange was rejected${result.detail ? `: ${esc(result.detail)}` : ""}.`);
  }
  await auditCredentialBound(result, deps);
  const resumed = await runConsentResume(result, deps);
  return page(
    200,
    "Connection authorized",
    `The connection${result.connectionName ? ` <strong>${esc(result.connectionName)}</strong>` : ""} is now authorized. ` +
      `${resumeClause(resumed)} You can close this tab.`,
  );
}

export interface OeOauthCallbackDeps {
  readonly resume?: typeof resumeAfterConsent;
  readonly audit?: typeof appendAudit;
  readonly org?: () => string;
}

async function auditCredentialBound(result: OeOauthCallbackResult, deps: OeOauthCallbackDeps): Promise<void> {
  const subject = result.subject;
  if (!subject) return;
  try {
    await (deps.audit ?? appendAudit)({
      org: (deps.org ?? deploymentOrg)(),
      platform: "oauth",
      workspace: "callback",
      action: "connector.credential_bound",
      detail: {
        connector: result.connectionName ?? "unknown",
        subject: subject.type,
        rebound: result.rebound === true,
      },
    });
  } catch {
  }
}

async function runConsentResume(
  result: OeOauthCallbackResult,
  deps: OeOauthCallbackDeps,
): Promise<ConsentResumeOutcome | undefined> {
  const record = asConsentResumeRecord(result.consent);
  if (!record) return undefined;
  try {
    return await (deps.resume ?? resumeAfterConsent)(record);
  } catch {
    return undefined;
  }
}

function resumeClause(outcome: ConsentResumeOutcome | undefined): string {
  if (!outcome) return "";
  if (!outcome.delivered) return "Go back to your conversation and ask again — I could not reach it from here.";
  switch (outcome.verdict) {
    case "offer":
      return "I've said so in your conversation — tell me there to carry on with the request you paused.";
    case "expired":
      return "The request you paused is too old to pick up on its own; ask me again in your conversation.";
  }
}
