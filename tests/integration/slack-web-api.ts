import { installHostFetchStub } from "./fetch-stub";

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

function paramsOf(init: RequestInit | undefined): URLSearchParams {
  const body = init?.body;
  if (typeof body === "string") return new URLSearchParams(body);
  if (body instanceof URLSearchParams) return body;
  return new URLSearchParams();
}

export function installSlackWebApiStub(respond: SlackApiResponder): SlackWebApiStub {
  const calls: SlackApiCall[] = [];
  const hadToken = Object.prototype.hasOwnProperty.call(process.env, "SLACK_BOT_TOKEN");
  const previousToken = process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_BOT_TOKEN = STUB_BOT_TOKEN;

  const stub = installHostFetchStub(SLACK_API_PREFIX, (url, init) => {
    const method = url.href.slice(SLACK_API_PREFIX.length).split("?")[0] ?? "";
    const params = paramsOf(init);
    calls.push({ method, params });
    const answer = respond(method, params) ?? { ok: false, error: `oe_integration_stub_unhandled_${method}` };
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  });

  let uninstalled = false;
  return {
    calls,
    uninstall() {
      if (uninstalled) return;
      uninstalled = true;
      stub.uninstall();
      if (hadToken) process.env.SLACK_BOT_TOKEN = previousToken;
      else delete process.env.SLACK_BOT_TOKEN;
    },
  };
}
