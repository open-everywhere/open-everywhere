import { installHostFetchStub, type FetchStubCall } from "./fetch-stub";

const LINEAR_API_PREFIX = "https://api.linear.app/graphql";

export interface LinearApiCall {
  readonly operation: string;
  readonly query: string;
  readonly variables: Record<string, unknown>;
}

export type LinearApiResponder = (call: LinearApiCall) => { readonly status?: number; readonly data: unknown } | undefined;

export interface LinearApiStub {
  readonly calls: readonly LinearApiCall[];
  uninstall(): void;
}

function operationNameOf(query: string): string {
  const m = /\b(?:query|mutation)\s+(\w+)/.exec(query);
  return m?.[1] ?? "";
}

function toLinearApiCall(init: RequestInit | undefined): LinearApiCall {
  const raw = init?.body;
  let parsed: { query?: unknown; variables?: unknown } = {};
  if (typeof raw === "string" && raw.length > 0) {
    try {
      parsed = JSON.parse(raw) as { query?: unknown; variables?: unknown };
    } catch {
      parsed = {};
    }
  }
  const query = typeof parsed.query === "string" ? parsed.query : "";
  const variables = typeof parsed.variables === "object" && parsed.variables !== null ? (parsed.variables as Record<string, unknown>) : {};
  return { operation: operationNameOf(query), query, variables };
}

export function installLinearApiStub(respond: LinearApiResponder): LinearApiStub {
  const calls: LinearApiCall[] = [];
  const stub = installHostFetchStub(LINEAR_API_PREFIX, (_url: URL, init: FetchStubCall["init"]) => {
    const call = toLinearApiCall(init);
    calls.push(call);
    const answer = respond(call);
    if (!answer) {
      return new Response(JSON.stringify({ errors: [{ message: `oe_integration_stub_unhandled ${call.operation || "(unnamed operation)"}` }] }), {
        status: answer === undefined ? 501 : (answer as { status?: number }).status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: answer.data }), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
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
