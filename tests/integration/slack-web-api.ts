export interface SlackApiCall {
  readonly method: string;
  readonly params: URLSearchParams;
}

export type SlackApiResponder = (method: string, params: URLSearchParams) => Record<string, unknown> | undefined;

export interface SlackWebApiStub {
  readonly calls: readonly SlackApiCall[];
  uninstall(): void;
}

const SLACK_API_PREFIX = "https://slack.com/api/";

const STUB_BOT_TOKEN = "xoxb-integration-stub-token";

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (typeof input === "object" && input !== null && "url" in input) return String((input as { url: unknown }).url);
  return "";
}

function paramsOf(init: unknown): URLSearchParams {
  const body = (init as { body?: unknown } | undefined)?.body;
  if (typeof body === "string") return new URLSearchParams(body);
  if (body instanceof URLSearchParams) return body;
  return new URLSearchParams();
}

export function installSlackWebApiStub(respond: SlackApiResponder): SlackWebApiStub {
  const calls: SlackApiCall[] = [];
  const originalFetch = globalThis.fetch;
  const hadToken = Object.prototype.hasOwnProperty.call(process.env, "SLACK_BOT_TOKEN");
  const previousToken = process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_BOT_TOKEN = STUB_BOT_TOKEN;

  const patched: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    if (!url.startsWith(SLACK_API_PREFIX)) return originalFetch(input, init);
    const method = url.slice(SLACK_API_PREFIX.length).split("?")[0] ?? "";
    const params = paramsOf(init);
    calls.push({ method, params });
    const answer = respond(method, params) ?? { ok: false, error: `oe_integration_stub_unhandled_${method}` };
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  globalThis.fetch = patched;

  let uninstalled = false;
  return {
    calls,
    uninstall() {
      if (uninstalled) return;
      uninstalled = true;
      if (globalThis.fetch === patched) globalThis.fetch = originalFetch;
      if (hadToken) process.env.SLACK_BOT_TOKEN = previousToken;
      else delete process.env.SLACK_BOT_TOKEN;
    },
  };
}
