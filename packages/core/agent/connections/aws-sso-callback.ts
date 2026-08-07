export const OE_AWS_SSO_CALLBACK_PATH = "/oauth/v1/aws-sso/callback";

export interface AwsSsoCallbackArgs {
  readonly state: string;
  readonly code: string;
}

export interface AwsSsoCallbackResult {
  readonly principalSubject: string;
}

export interface AwsSsoCallbackCompleter {
  complete(args: AwsSsoCallbackArgs): Promise<AwsSsoCallbackResult>;
}

let registered: AwsSsoCallbackCompleter | undefined;

export function registerAwsSsoCallbackCompleter(completer: AwsSsoCallbackCompleter): void {
  registered = completer;
}

export function resetAwsSsoCallbackCompleter(): void {
  registered = undefined;
}

export function awsSsoCallbackCompleter(): AwsSsoCallbackCompleter | undefined {
  return registered;
}

export function requireAwsSsoCallbackCompleter(): AwsSsoCallbackCompleter {
  if (!registered) {
    throw new Error(
      "no AWS-SSO callback completer is registered — the AWS adapter (packages/adapters/agent/aws) is " +
        "not wired. Register it at boot (register-adapters.ts). Fail-closed: no per-user AWS SSO link.",
    );
  }
  return registered;
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

export async function handleAwsSsoCallback(req: Request): Promise<Response> {
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

  try {
    await requireAwsSsoCallbackCompleter().complete({ state, code });
  } catch {
    return page(502, "Could not complete the connection", "The AWS sign-in could not be completed. You can close this tab and try again.");
  }
  return page(200, "AWS account linked", "Your AWS account is now linked. You can close this tab and return to the conversation.");
}
