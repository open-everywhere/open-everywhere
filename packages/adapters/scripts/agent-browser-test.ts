import assert from "node:assert/strict";
import {
  agentBrowserEnabled,
  loadAgentBrowserConfig,
  parseAgentBrowserDomains,
  isLoopbackBrowseHost,
  resetAgentBrowserConfigForTest,
} from "../agent/browser/config.js";
import { registerAgentBrowser } from "../agent/browser/register.js";
import { agentBrowserSandboxHooks, type BakeableSandbox } from "../agent/browser/sandbox.js";
import { installAgentBrowser } from "@agent-browser/eve/sandbox";
import browserExtension from "@agent-browser/eve";
import {
  registeredBrowserToolkit,
  resetBrowserToolkitForTest,
  resolveBrowserKit,
  extraEgressHosts,
  resetExtraEgressHostsForTest,
} from "@open-everywhere/core/agent/adapter-api.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const ENV_KEYS = ["OE_AGENT_BROWSER", "OE_AGENT_BROWSER_DOMAINS", "OE_PLATFORM"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const k of ENV_KEYS) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
  resetAgentBrowserConfigForTest();
}

{
  setEnv({});
  ok(!agentBrowserEnabled(), "flag unset ⇒ disabled");
  ok(loadAgentBrowserConfig() === undefined, "flag unset ⇒ no config");

  setEnv({ OE_AGENT_BROWSER_DOMAINS: "qa.example.com" });
  ok(loadAgentBrowserConfig() === undefined, "domains without the flag ⇒ still no config (the flag is the master switch)");

  setEnv({ OE_AGENT_BROWSER: "1" });
  ok(agentBrowserEnabled(), "flag=1 ⇒ enabled");
  ok(loadAgentBrowserConfig() === undefined, "flag on with NO domain allowlist ⇒ no config (fail closed)");

  setEnv({ OE_AGENT_BROWSER: "1", OE_AGENT_BROWSER_DOMAINS: "  , ," });
  ok(loadAgentBrowserConfig() === undefined, "flag on with an empty allowlist ⇒ no config (fail closed)");

  setEnv({ OE_AGENT_BROWSER: "1", OE_AGENT_BROWSER_DOMAINS: "qa.example.com,*.example.com" });
  ok(loadAgentBrowserConfig() === undefined, "ANY invalid entry (wildcard) invalidates the whole config — no partial allowlist");

  setEnv({ OE_AGENT_BROWSER: "1", OE_AGENT_BROWSER_DOMAINS: "localhost, QA.Example.com ,qa.example.com" });
  const cfg = loadAgentBrowserConfig();
  ok(cfg !== undefined && cfg.domains.join("|") === "localhost|qa.example.com", "valid list parses: trimmed, lowercased, deduped, order-preserving");
  ok(loadAgentBrowserConfig() === cfg, "config is memoized per process");
}

{
  const good = parseAgentBrowserDomains("localhost,127.0.0.1,preview.vercel.app,my-app.example.co");
  ok(good.problems.length === 0 && good.domains.length === 4, "loopback + dotted DNS names all accepted");

  for (const [raw, why] of [
    ["*.example.com", "wildcard"],
    ["https://example.com", "scheme"],
    ["example.com/path", "path"],
    ["example.com:8080", "port"],
    ["169.254.169.254", "metadata IP"],
    ["10.0.0.5", "private-range IP"],
    ["intranet", "single dotless label"],
    ["example.c0m", "non-alphabetic TLD"],
  ] as const) {
    ok(parseAgentBrowserDomains(raw).problems.length > 0, `rejects ${why}: "${raw}"`);
  }

  ok(isLoopbackBrowseHost("localhost") && isLoopbackBrowseHost("127.0.0.1") && isLoopbackBrowseHost("::1"), "loopback classifier: localhost/127.0.0.1/::1");
  ok(!isLoopbackBrowseHost("qa.example.com"), "loopback classifier: a DNS name is not loopback");
}

{
  ok(
    (globalThis as Record<symbol, unknown>)[Symbol.for("eve.ext-config-scope")] === undefined,
    "the ambient extension-config scope is released after import (no later defineExtension can capture it)",
  );
}

{
  resetBrowserToolkitForTest();
  resetExtraEgressHostsForTest();
  setEnv({ OE_AGENT_BROWSER: "1", OE_AGENT_BROWSER_DOMAINS: "localhost,qa.example.com,preview.vercel.app" });
  const cfg = loadAgentBrowserConfig();
  ok(cfg !== undefined, "arming config parses");
  ok(registerAgentBrowser(cfg!) === true, "registerAgentBrowser arms (extension config binding took)");

  const bound = browserExtension.config as unknown as {
    allowedDomains?: string[];
    autoInstall: boolean;
    contentBoundaries: boolean;
    inlineScreenshots: boolean;
  };
  ok(bound.autoInstall === false, "bound config: autoInstall OFF (pre-bake doctrine — never install mid-session)");
  ok((bound.allowedDomains ?? []).join("|") === "localhost|qa.example.com|preview.vercel.app", "bound config: allowedDomains = the operator list (inner containment wall armed)");
  ok(bound.contentBoundaries === true, "bound config: contentBoundaries ON (page text is untrusted input)");
  ok(bound.inlineScreenshots === false, "bound config: inlineScreenshots OFF (no multi-MB base64 in durable transcripts)");

  const kit = registeredBrowserToolkit();
  ok(kit !== undefined, "toolkit registered");
  const names = Object.keys(kit!);
  ok(names.length >= 20, `the full vendor tool set registered (${names.length} tools)`);
  ok(names.every((t) => t.startsWith("browser_") && !t.includes("__")), "every tool is browser_-prefixed with no __ (the connector-op separator)");
  for (const expected of ["browser_navigate", "browser_snapshot", "browser_screenshot", "browser_click", "browser_read", "browser_close"]) {
    ok(names.includes(expected), `registered: ${expected}`);
  }
  const nav = kit!["browser_navigate"];
  ok(typeof nav.description === "string" && nav.description.length > 0 && typeof nav.execute === "function", "entries keep the vendor description + an execute (backstop-wrapped)");
  ok(names.every((t) => (kit![t] as { approval?: unknown }).approval === undefined), "no entry carries an approval policy (replay constraint)");

  const hosts = extraEgressHosts();
  ok(hosts.includes("qa.example.com") && hosts.includes("preview.vercel.app"), "non-loopback domains ride the extra-egress seam (outer containment wall armed)");
  ok(!hosts.includes("localhost"), "loopback stays OFF the egress allowlist (it never leaves the sandbox VM)");
}

{
  ok(resolveBrowserKit("task") !== null, "armed: a task (worker) seat mounts the kit");
  ok(resolveBrowserKit("standing") === null, "armed: a standing seat gets NOTHING (wide-hands doctrine, structural absence)");
  ok(resolveBrowserKit("thread") === null, "armed: a thread seat gets nothing");
  if (process.env.OE_ONESHOT_AGENT !== "1") {
    ok(resolveBrowserKit("native") !== null, "armed, delegation flag off: a native mention keeps wide hands ⇒ kit mounts");
  }

  resetBrowserToolkitForTest();
  ok(resolveBrowserKit("task") === null, "unarmed: null on every grain — flag-off mounts nothing (byte-identical)");
}

{
  setEnv({});
  ok(Object.keys(agentBrowserSandboxHooks()).length === 0, "flag off ⇒ hooks are {} (defineSandbox carries NO bootstrap/revalidationKey property)");

  setEnv({ OE_AGENT_BROWSER: "1", OE_PLATFORM: "vercel" });
  ok(Object.keys(agentBrowserSandboxHooks()).length === 0, "flag on but no allowlist ⇒ no bake (fail closed)");

  setEnv({ OE_AGENT_BROWSER: "1", OE_AGENT_BROWSER_DOMAINS: "localhost", OE_PLATFORM: "self-host" });
  ok(Object.keys(agentBrowserSandboxHooks()).length === 0, "armed but off-Vercel ⇒ no bake (self-host image has no Chromium — the browser_qa MVP posture)");

  setEnv({ OE_AGENT_BROWSER: "1", OE_AGENT_BROWSER_DOMAINS: "localhost", OE_PLATFORM: "vercel" });
  const installed: string[] = [];
  const hooks = agentBrowserSandboxHooks(async (sb) => {
    installed.push(sb.id);
  });
  ok("bootstrap" in hooks && "revalidationKey" in hooks, "armed on Vercel ⇒ bootstrap + revalidationKey present");
  if ("revalidationKey" in hooks) {
    const key = hooks.revalidationKey();
    ok(typeof key === "string" && key.includes("agent-browser"), `revalidationKey pins the bake (${key})`);
    await hooks.bootstrap({ use: async () => ({ id: "tpl-1", run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }) });
    ok(installed.length === 1 && installed[0] === "tpl-1", "bootstrap opens the template session and runs the installer exactly once");
  }

  const commands: string[] = [];
  const recorder: BakeableSandbox = {
    id: "rec",
    run: async ({ command }) => {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  await installAgentBrowser(recorder);
  ok(commands.length === 3, `default install issues 3 commands (got ${commands.length})`);
  ok(/apt-get|dnf/.test(commands[0] ?? ""), "install 1/3: Chromium system dependencies (apt/dnf)");
  ok(/npm.*install -g.*agent-browser@\d/.test(commands[1] ?? ""), "install 2/3: agent-browser CLI pinned to the package-matched version");
  ok(/agent-browser.*install/.test(commands[2] ?? ""), "install 3/3: `agent-browser install` fetches Chromium into the template");
}

for (const k of ENV_KEYS) {
  if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k]!;
}
resetAgentBrowserConfigForTest();
resetBrowserToolkitForTest();
resetExtraEgressHostsForTest();

console.log(`\n✓ agent-browser: ${n} assertions passed (flag gating fail-closed + domain parse + config binding tripwire + toolkit/egress registration + grain policy + pre-bake hooks)\n`);
