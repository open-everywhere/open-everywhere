import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

import type { Env } from "./lib.js";

export const HTTPS_PROXY_ENV_NAMES = ["HTTPS_PROXY", "https_proxy", "GLOBAL_AGENT_HTTPS_PROXY"] as const;

export const HTTP_PROXY_ENV_NAMES = ["HTTP_PROXY", "http_proxy", "GLOBAL_AGENT_HTTP_PROXY"] as const;

const firstSet = (env: Env, names: readonly string[]): string | undefined => {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
};

export function proxyUrlFromEnv(env: Env): string | undefined {
  return firstSet(env, HTTPS_PROXY_ENV_NAMES) ?? firstSet(env, HTTP_PROXY_ENV_NAMES);
}

export interface ProxyDispatcherInput {
  readonly env?: Env;
  readonly install?: (dispatcher: unknown) => void;
  readonly makeAgent?: (options: { httpsProxy?: string; httpProxy?: string }) => unknown;
}

let installedProxy: string | undefined;
let installAttempted = false;

export function installProxyDispatcher(input: ProxyDispatcherInput = {}): string | undefined {
  const env = input.env ?? process.env;
  const install = input.install ?? ((dispatcher: unknown) => setGlobalDispatcher(dispatcher as never));
  const makeAgent = input.makeAgent ?? ((options) => new EnvHttpProxyAgent(options));

  const httpsProxy = firstSet(env, HTTPS_PROXY_ENV_NAMES);
  const httpProxy = firstSet(env, HTTP_PROXY_ENV_NAMES);
  const chosen = httpsProxy ?? httpProxy;
  if (chosen === undefined) return undefined;

  install(
    makeAgent({
      ...(httpsProxy === undefined ? {} : { httpsProxy }),
      ...(httpProxy === undefined ? {} : { httpProxy }),
    }),
  );
  return chosen;
}

export function ensureProxyDispatcher(): string | undefined {
  if (installAttempted) return installedProxy;
  installAttempted = true;
  try {
    installedProxy = installProxyDispatcher();
  } catch {
    installedProxy = undefined;
  }
  return installedProxy;
}
