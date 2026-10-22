import browserExtension from "@agent-browser/eve";

import assert from "node:assert/strict";
import { agentBrowserEnabled, loadAgentBrowserConfig, resetAgentBrowserConfigForTest } from "../agent/browser/config.js";
import { registerAgentBrowser, BROWSER_SESSION_NAME } from "../agent/browser/register.js";
import { agentBrowserSandboxHooks, type BakeableSandbox } from "../agent/browser/sandbox.js";
import { installAgentBrowser, type EveSandboxSession } from "@agent-browser/eve/sandbox";
import {
  registeredBrowserToolkit,
  resetBrowserToolkitForTest,
  resolveBrowserKit,
  extraEgressHosts,
  resetExtraEgressHostsForTest,
  overrideSettingsForTest,
  resetSettingsForTest,
  _setBrowserHostsForTest,
  resetBrowserHostsForTest,
  isLoopbackBrowseHost,
  type BrowserHostDeclaration,
} from "@open-everywhere/core/agent/adapter-api.js";

const ro = (host: string, extra: Partial<BrowserHostDeclaration> = {}): BrowserHostDeclaration => ({
  host,
  methods: ["GET", "HEAD"],
  why: "test fixture",
  ...extra,
});

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const saved = process.env.VERCEL;
function setEnv(values: { enabled?: boolean; hosts?: BrowserHostDeclaration[]; platform?: string }): void {
  overrideSettingsForTest({ browser: { enabled: values.enabled ?? false } });
  if (values.hosts === undefined) resetBrowserHostsForTest();
  else _setBrowserHostsForTest(values.hosts);
  if ((values.platform ?? "vercel") === "vercel") process.env.VERCEL = "1";
  else delete process.env.VERCEL;
  resetAgentBrowserConfigForTest();
}

{
  setEnv({});
  ok(!agentBrowserEnabled(), "flag unset ⇒ disabled");
  ok(loadAgentBrowserConfig() === undefined, "flag unset ⇒ no config");

  setEnv({ hosts: [ro("qa.example.com")] });
  ok(loadAgentBrowserConfig() === undefined, "a declaration without the flag ⇒ still no config (the flag is the master switch)");

  setEnv({ enabled: true });
  ok(agentBrowserEnabled(), "`browser.enabled: true` ⇒ enabled");
  ok(loadAgentBrowserConfig() === undefined, "flag on with NO declared host ⇒ no config (fail closed)");

  setEnv({ enabled: true, hosts: [] });
  ok(loadAgentBrowserConfig() === undefined, "flag on with an EMPTY declaration ⇒ no config (fail closed)");

  setEnv({ enabled: true, hosts: [ro("localhost"), ro("qa.example.com")] });
  const cfg = loadAgentBrowserConfig();
  ok(cfg !== undefined && cfg.domains.join("|") === "localhost|qa.example.com", "an armed declaration yields the hostnames in declaration order");
  ok(loadAgentBrowserConfig() === cfg, "config is memoized per process");
}

{
  ok(isLoopbackBrowseHost("localhost") && isLoopbackBrowseHost("127.0.0.1") && isLoopbackBrowseHost("::1"), "loopback classifier: localhost/127.0.0.1/::1");
  ok(!isLoopbackBrowseHost("qa.example.com"), "loopback classifier: a DNS name is not loopback");
}

{
  resetBrowserToolkitForTest();
  resetExtraEgressHostsForTest();
  setEnv({
    enabled: true,
    hosts: [
      ro("localhost"),
      ro("qa.example.com"),
      ro("preview.vercel.app", { methods: ["GET", "HEAD", "POST"], credential: "vendor-login" }),
    ],
  });
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
  ok((bound as { session?: string }).session === BROWSER_SESSION_NAME, "bound config: session pinned (the vendor default reads sandbox.id, which eve ≥0.69 does not give)");

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

  ok(!names.includes("browser_evaluate"), "OPE-1624: no host declares `evaluate: true` ⇒ browser_evaluate does NOT mount (structural absence, wall 1)");

  const hosts = extraEgressHosts();
  ok(hosts.includes("qa.example.com"), "an UNCREDENTIALED non-loopback host rides the extra-egress seam (outer containment wall armed)");
  ok(!hosts.includes("localhost"), "loopback stays OFF the egress allowlist (it never leaves the sandbox VM)");
  ok(
    !hosts.includes("preview.vercel.app"),
    "a CREDENTIALED host stays OFF the bare seam — access/egress.ts compiles its narrowed, credential-stamped rule instead",
  );
}

{
  resetBrowserToolkitForTest();
  resetExtraEgressHostsForTest();
  setEnv({ enabled: true, hosts: [ro("qa.example.com", { evaluate: true })] });
  ok(registerAgentBrowser(loadAgentBrowserConfig()!) === true, "re-arms with an evaluate-armed host");
  ok(Object.keys(registeredBrowserToolkit() ?? {}).includes("browser_evaluate"), "a host declaring `evaluate: true` re-adds browser_evaluate to the kit");

  resetBrowserToolkitForTest();
  resetExtraEgressHostsForTest();
  setEnv({
    enabled: true,
    hosts: [ro("localhost"), ro("qa.example.com"), ro("preview.vercel.app", { methods: ["GET", "HEAD", "POST"], credential: "vendor-login" })],
  });
  ok(registerAgentBrowser(loadAgentBrowserConfig()!) === true, "restored the section-4 arming");
}

{
  const kit = registeredBrowserToolkit();
  ok(kit !== undefined, "kit still registered for the real-path run");
  const nav = kit!["browser_navigate"];
  const commands: string[] = [];
  const fakeSandbox = {
    id: "qa-vm",
    run: async ({ command }: { command: string }) => {
      commands.push(command);
      return { exitCode: 0, stdout: JSON.stringify({ success: true, data: { url: "https://qa.example.com/" } }), stderr: "" };
    },
  };
  const taskCtx = {
    session: { auth: { current: { attributes: { oe_grain: "task" } } } },
    getSandbox: async () => fakeSandbox,
  };
  const out = (await (nav.execute as (i: unknown, c: unknown) => Promise<unknown>)({ action: "goto", url: "https://qa.example.com/" }, taskCtx)) as {
    url?: string;
  } | null;
  ok(commands.length === 1, `navigate issues exactly ONE CLI command — no auto-install probe (got ${commands.length}: ${commands.join(" | ")})`);
  const cmd = commands[0] ?? "";
  ok(cmd.includes("--allowed-domains localhost,qa.example.com,preview.vercel.app"), `the ISSUED command carries the operator allowlist (inner wall armed): ${cmd}`);
  ok(cmd.includes("--content-boundaries"), "the issued command wraps page output in boundary markers (untrusted input)");
  ok(cmd.includes("--session"), "the issued command pins the per-sandbox browser session");
  ok(cmd.includes("--json"), "the issued command requests the structured envelope");
  ok(out !== null && out.url === "https://qa.example.com/", "the parsed --json envelope data flows back as the tool result");

  const idlessCommands: string[] = [];
  const idlessSandbox = {
    run: async ({ command }: { command: string }) => {
      idlessCommands.push(command);
      return { exitCode: 0, stdout: JSON.stringify({ success: true, data: { url: "https://qa.example.com/" } }), stderr: "" };
    },
  };
  let idlessError: unknown;
  try {
    await (nav.execute as (i: unknown, c: unknown) => Promise<unknown>)(
      { action: "goto", url: "https://qa.example.com/" },
      { ...taskCtx, getSandbox: async () => idlessSandbox },
    );
  } catch (err) {
    idlessError = err;
  }
  ok(idlessError === undefined, `navigate runs on an id-less sandbox (the eve ≥0.69 SandboxSession shape) — threw: ${String(idlessError)}`);
  ok(idlessCommands.length === 1 && idlessCommands[0]!.includes(`--session ${BROWSER_SESSION_NAME}`), `the id-less call pins the bound session name: ${idlessCommands.join(" | ")}`);
}

{
  ok(resolveBrowserKit("task") !== null, "armed: a task (worker) seat mounts the kit");
  ok(resolveBrowserKit("standing") === null, "armed: a standing seat gets NOTHING (wide-hands doctrine, structural absence)");
  ok(resolveBrowserKit("thread") === null, "armed: a thread seat gets nothing");
  overrideSettingsForTest({ delegation: { oneshotAgent: false } });
  ok(resolveBrowserKit("native") !== null, "delegation DISARMED: a native mention keeps wide hands ⇒ the kit mounts");
  overrideSettingsForTest({ delegation: { oneshotAgent: true } });
  ok(resolveBrowserKit("native") === null, "delegation ARMED: a native mention is a delegating seat ⇒ no kit (the negative control)");
  resetSettingsForTest();

  resetBrowserToolkitForTest();
  ok(resolveBrowserKit("task") === null, "unarmed: null on every grain — flag-off mounts nothing (byte-identical)");
}

{
  setEnv({});
  ok(Object.keys(agentBrowserSandboxHooks()).length === 0, "flag off ⇒ hooks are {} (defineSandbox carries NO bootstrap/revalidationKey property)");

  setEnv({ enabled: true, platform: "vercel" });
  ok(Object.keys(agentBrowserSandboxHooks()).length === 0, "flag on but no declared host ⇒ no bake (fail closed)");

  setEnv({ enabled: true, hosts: [ro("localhost")], platform: "self-host" });
  ok(Object.keys(agentBrowserSandboxHooks()).length === 0, "armed but off-Vercel ⇒ no bake (no self-host backend can run the browser inside the declared hosts)");

  setEnv({ enabled: true, hosts: [ro("localhost")], platform: "vercel" });
  const installed: string[] = [];
  const hooks = agentBrowserSandboxHooks(async (sb) => {
    installed.push(sb.id ?? "(no id — eve 0.69.0 sessions carry none)");
  });
  ok("bootstrap" in hooks && "revalidationKey" in hooks, "armed on Vercel ⇒ bootstrap + revalidationKey present");
  if ("revalidationKey" in hooks) {
    const key = hooks.revalidationKey();
    ok(typeof key === "string" && key.includes("agent-browser"), `revalidationKey pins the bake (${key})`);
    await hooks.bootstrap({ use: async () => ({ id: "tpl-1", run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }) });
    ok(installed.length === 1 && installed[0] === "tpl-1", "bootstrap opens the template session and runs the installer exactly once");
    await hooks.bootstrap({ use: async () => ({ run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }) });
    ok(
      installed.length === 2 && installed[1] === "(no id — eve 0.69.0 sessions carry none)",
      "🔴 a session with NO id still reaches the installer — the optional `BakeableSandbox.id` is not a field the bake depends on, which is what makes the app's `satisfies BakeableSandbox` honest rather than a cast over a missing field",
    );
  }

  const commands: string[] = [];
  const recorder: BakeableSandbox = {
    run: async ({ command }) => {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  await installAgentBrowser(recorder as EveSandboxSession);
  ok(commands.length === 3, `default install issues 3 commands (got ${commands.length})`);
  ok(/apt-get|dnf/.test(commands[0] ?? ""), "install 1/3: Chromium system dependencies (apt/dnf)");
  ok(/npm.*install -g.*agent-browser@\d/.test(commands[1] ?? ""), "install 2/3: agent-browser CLI pinned to the package-matched version");
  ok(/agent-browser.*install/.test(commands[2] ?? ""), "install 3/3: `agent-browser install` fetches Chromium into the template");
}

{
  resetBrowserToolkitForTest();
  resetExtraEgressHostsForTest();
  const declaration = [ro("qa.example.com"), ro("preview.vercel.app", { methods: ["GET", "HEAD", "POST"], credential: "vendor-login" })];

  setEnv({ enabled: true, hosts: declaration, platform: "self-host" });
  ok(agentBrowserEnabled(), "off-Vercel: the master flag is genuinely ARMED — the refusal below is the platform's, not the flag's");
  ok(loadAgentBrowserConfig() === undefined, "off-Vercel: the config loader refuses, so no arming path has a config to arm from");
  ok(Object.keys(agentBrowserSandboxHooks()).length === 0, "off-Vercel: nothing bakes");
  const mount = (): boolean => {
    const cfg = agentBrowserEnabled() ? loadAgentBrowserConfig() : undefined;
    return cfg ? registerAgentBrowser(cfg) : false;
  };
  ok(mount() === false, "🔴 off-Vercel: the app's own mount expression registers NOTHING — it never reaches registerAgentBrowser");
  ok(registeredBrowserToolkit() === undefined, "🔴 …so NO browser tool is registered");
  ok(extraEgressHosts().length === 0, "🔴 …and NO declared egress host is opened — the firewall reach stays byte-identical to flag-off");
  ok(resolveBrowserKit("task") === null, "off-Vercel: the grain resolver mounts nothing on the one wide-hands grain");

  setEnv({ enabled: true, hosts: declaration, platform: "vercel" });
  ok(mount() === true, "negative control: the SAME mount expression, the SAME declaration, arms on Vercel");
  ok(Object.keys(registeredBrowserToolkit() ?? {}).length > 0, "negative control: …and the tools are registered there");
  ok(extraEgressHosts().includes("qa.example.com"), "negative control: …and the uncredentialed declared host IS opened there");
  ok(resolveBrowserKit("task") !== null, "negative control: …and a worker seat resolves the kit there");
  delete process.env.VERCEL;
  ok(resolveBrowserKit("task") === null, "🔴 the resolver refuses off-Vercel even with 20 entries already registered (the second door stays shut)");
  process.env.VERCEL = "1";
  ok(resolveBrowserKit("task") !== null, "…and flipping the platform back re-admits it, so the arm above measured the platform and nothing else");

  resetBrowserToolkitForTest();
  resetExtraEgressHostsForTest();
}

if (saved === undefined) delete process.env.VERCEL;
else process.env.VERCEL = saved;
resetSettingsForTest();
resetAgentBrowserConfigForTest();
resetBrowserToolkitForTest();
resetExtraEgressHostsForTest();
resetBrowserHostsForTest();

console.log(
  `\n✓ agent-browser: ${n} assertions passed (flag gating fail-closed + host declaration + config binding tripwire + toolkit/egress registration + evaluate opt-in + grain policy + pre-bake hooks)\n`,
);
