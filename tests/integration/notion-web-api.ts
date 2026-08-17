import { installHostFetchStub, type FetchStubCall } from "./fetch-stub";

export interface NotionApiCall {
  readonly method: string;
  readonly path: string;
  readonly search: URLSearchParams;
  readonly body: unknown;
}

export type NotionApiResponder = (call: NotionApiCall) => { readonly status?: number; readonly body: unknown } | undefined;

export interface NotionApiStub {
  readonly calls: readonly NotionApiCall[];
  uninstall(): void;
}

const NOTION_API_PREFIX = "https://api.notion.com";

function jsonBodyOf(init: RequestInit | undefined): unknown {
  const raw = init?.body;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function toNotionApiCall(call: FetchStubCall, url: URL): NotionApiCall {
  return {
    method: (call.init?.method ?? "GET").toUpperCase(),
    path: url.pathname,
    search: url.searchParams,
    body: jsonBodyOf(call.init),
  };
}

export function installNotionApiStub(respond: NotionApiResponder): NotionApiStub {
  const calls: NotionApiCall[] = [];
  const stub = installHostFetchStub(NOTION_API_PREFIX, (url, init) => {
    const call = toNotionApiCall({ url: url.href, init }, url);
    calls.push(call);
    const answer = respond(call);
    if (!answer) {
      return new Response(
        JSON.stringify({ object: "error", status: 404, code: "object_not_found", message: `oe_integration_stub_unhandled ${call.method} ${call.path}` }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  });

  let uninstalled = false;
  return {
    calls,
    uninstall() {
      if (uninstalled) return;
      uninstalled = true;
      stub.uninstall();
    },
  };
}
