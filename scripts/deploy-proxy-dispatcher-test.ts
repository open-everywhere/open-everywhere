import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installProxyDispatcher, proxyUrlFromEnv, HTTPS_PROXY_ENV_NAMES, HTTP_PROXY_ENV_NAMES } from "./deploy/proxy-dispatcher.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

function attempt(env: Record<string, string | undefined>): {
  used: string | undefined;
  installs: unknown[];
  options: { httpsProxy?: string; httpProxy?: string }[];
} {
  const installs: unknown[] = [];
  const options: { httpsProxy?: string; httpProxy?: string }[] = [];
  const used = installProxyDispatcher({
    env,
    install: (dispatcher) => installs.push(dispatcher),
    makeAgent: (opts) => {
      options.push(opts);
      return { agent: true };
    },
  });
  return { used, installs, options };
}

{
  ok(proxyUrlFromEnv({}) === undefined, "an environment with no proxy variable declares no proxy");
  ok(proxyUrlFromEnv({ HTTPS_PROXY: "http://p:1" }) === "http://p:1", "HTTPS_PROXY is read");
  ok(proxyUrlFromEnv({ https_proxy: "http://p:2" }) === "http://p:2", "the lowercase curl spelling is read too");
  ok(proxyUrlFromEnv({ GLOBAL_AGENT_HTTPS_PROXY: "http://p:3" }) === "http://p:3", "the global-agent spelling is read");
  ok(proxyUrlFromEnv({ HTTP_PROXY: "http://p:4" }) === "http://p:4", "HTTP_PROXY alone still declares a proxy");
  ok(proxyUrlFromEnv({ HTTPS_PROXY: "   " }) === undefined, "a blank value is not a declaration");
  ok(
    proxyUrlFromEnv({ HTTPS_PROXY: "http://s:1", HTTP_PROXY: "http://c:1" }) === "http://s:1",
    "HTTPS wins over HTTP, because every rung here dials https",
  );
  ok(HTTPS_PROXY_ENV_NAMES.length === 3 && HTTP_PROXY_ENV_NAMES.length === 3, "both name lists are the three spellings the header names");
}

{
  const bare = attempt({});
  ok(bare.used === undefined, "no proxy variable means no proxy reported");
  ok(bare.installs.length === 0, "…and NOTHING is installed — the operator's own machine is untouched");
  ok(bare.options.length === 0, "…and no agent is even built");

  const proxied = attempt({ HTTPS_PROXY: "http://proxy.internal:3128" });
  ok(proxied.used === "http://proxy.internal:3128", "a declared proxy is reported back, so a rung can log which route it took");
  ok(proxied.installs.length === 1, "…and exactly one dispatcher is installed");
  ok(proxied.options[0]?.httpsProxy === "http://proxy.internal:3128", "…built with the https proxy the environment declared");
  ok(proxied.options[0]?.httpProxy === undefined, "…and with no http proxy, because none was declared");

  const both = attempt({ HTTPS_PROXY: "http://s:1", http_proxy: "http://c:1" });
  ok(both.options[0]?.httpsProxy === "http://s:1" && both.options[0]?.httpProxy === "http://c:1", "both schemes are passed on when both are declared");

  const globalAgentOnly = attempt({ GLOBAL_AGENT_HTTPS_PROXY: "http://agent:8080" });
  ok(globalAgentOnly.installs.length === 1, "a sandbox that sets only the global-agent name still gets a dispatcher");
  ok(globalAgentOnly.options[0]?.httpsProxy === "http://agent:8080", "…built from that name");
}

{
  const ciGate = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "deploy", "ci-gate-lib.ts"), "utf8");
  const body = ciGate.slice(ciGate.indexOf("export const realGithubApiFetch"));
  const end = body.indexOf("\n};");
  const fn = body.slice(0, end === -1 ? undefined : end);
  ok(fn.includes("ensureProxyDispatcher()"), "the shared GitHub REST transport installs the dispatcher before it fetches");
  ok(fn.includes("await fetch("), "…and the negative control: this really is the function that fetches");
  ok(ciGate.includes('from "./proxy-dispatcher.js"'), "…imported from the one module that owns the transport");
}

console.log(`✓ deploy proxy dispatcher: ${n} assertions`);
