export interface FetchStubCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

export type FetchStubResponder = (url: URL, init: RequestInit | undefined) => Response | undefined;

export interface HostFetchStub {
  readonly calls: readonly FetchStubCall[];
  uninstall(): void;
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (typeof input === "object" && input !== null && "url" in input) return String((input as { url: unknown }).url);
  return "";
}

export function installHostFetchStub(hostPrefix: string, respond: FetchStubResponder): HostFetchStub {
  const calls: FetchStubCall[] = [];
  const originalFetch = globalThis.fetch;
  const patched: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    if (!url.startsWith(hostPrefix)) return originalFetch(input, init);
    calls.push({ url, init });
    const answer = respond(new URL(url), init);
    if (answer) return answer;
    return new Response(JSON.stringify({ error: `oe_integration_stub_unhandled ${url}` }), {
      status: 501,
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = patched;

  let uninstalled = false;
  return {
    calls,
    uninstall() {
      if (uninstalled) return;
      uninstalled = true;
      if (globalThis.fetch === patched) globalThis.fetch = originalFetch;
    },
  };
}
