import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinSuiteStore } from "../../core/scripts/_suite-store.js";
import {
  BOX_LABEL,
  browserPlaneRefusal,
  browserRunsInBox,
  overrideSettingsForTest,
  pushSessionEgressPolicy,
  _setBrowserHostsForTest,
  resetBrowserHostsForTest,
  registerLongLivedBoxBackend,
  resetSessionBoxesForTest,
  resetSettingsForTest,
  type BoxSpec,
} from "@open-everywhere/core/agent/adapter-api.js";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import {
  BOX_DNS_SUFFIX,
  BOX_EGRESS_CA_ENV,
  BOX_EGRESS_PROXY_ENV,
  boxProxyPolicy,
  createDockerBoxBackend,
  dockerRunArgs,
  liveDockerBoxEgressProxy,
  selectLongLivedBoxBackend,
  type BoxDockerRunner,
} from "../agent/sandbox/long-lived-box.js";
import { boxedBrowserExecute, createQaBoxDriver, qaBoxSpec, QA_BOX_MAX_MINUTES, TRUST_EGRESS_CA, type BoxExec } from "../agent/browser/docker-box.js";
import { agentBrowserSandboxHooks } from "../agent/browser/sandbox.js";
import { loadAgentBrowserConfig, resetAgentBrowserConfigForTest } from "../agent/browser/config.js";

pinSuiteStore("browser-box-egress");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

interface AclDecision {
  readonly allow: boolean;
  readonly headers?: Record<string, string>;
}
interface Store {
  get(ip: string): unknown;
  delete(ip: string): boolean;
  decide(ip: string, req: { host: string; method?: string; path?: string }): AclDecision;
}
const acl = (await import(new URL("../../../deploy/egress-proxy/control/acl.ts", import.meta.url).href)) as { PolicyStore: new () => Store };
const handlers = (await import(new URL("../../../deploy/egress-proxy/control/handlers.ts", import.meta.url).href)) as {
  handlePolicyPush(store: Store, input: { body: unknown; remoteAddr: string; authOk: boolean }): { status: number; body: unknown };
  handleAcl(store: Store, q: { src?: string; host?: string; method?: string; path?: string; auth?: string }, token?: string): { decision: AclDecision };
};
const TOKEN = "tok-browser-box";
const APP_IP = "172.30.0.2";
const BOX_IP = "172.30.0.9";
let store = new acl.PolicyStore();
let failPushFor: string | undefined;
const pushes: { sourceIp: string | undefined; policy: unknown }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
  const authOk = auth === `Bearer ${TOKEN}`;
  if (url.pathname === "/policy" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { sourceIp?: string; policy?: unknown };
    if (failPushFor !== undefined && body.sourceIp === failPushFor) return new Response("{}", { status: 503 });
    pushes.push({ sourceIp: body.sourceIp, policy: body.policy });
    const r = handlers.handlePolicyPush(store, { body, remoteAddr: APP_IP, authOk });
    return new Response(JSON.stringify(r.body), { status: r.status });
  }
  if (url.pathname === "/policy" && init?.method === "DELETE") {
    if (!authOk) return new Response("{}", { status: 401 });
    const removed = store.delete(url.searchParams.get("sourceIp") ?? APP_IP);
    return new Response(JSON.stringify({ ok: true, removed }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const decide = (src: string, host: string): AclDecision => handlers.handleAcl(store, { src, host, method: "GET", path: "/" }, TOKEN).decision;

interface DockerCall {
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}
let internal = "true";
let boxIp = BOX_IP;
const calls: DockerCall[] = [];
const fakeDocker: BoxDockerRunner = async (args, env) => {
  calls.push({ args: [...args], ...(env !== undefined ? { env } : {}) });
  if (args[0] === "network") return `${internal}\n`;
  if (args[0] === "run") return "c0ffee\n";
  if (args[0] === "inspect" && String(args[2]).includes("NetworkSettings")) return `${boxIp}\n`;
  if (args[0] === "inspect") return `/${String(args[args.length - 1])}\trunning\t2026-10-23T00:00:00Z\tbrowser-qa\tref\n`;
  return "";
};
const verbs = (): string[] => calls.map((c) => c.args[0]!);
const okExec: BoxExec = async () => ({ exitCode: 0, stdout: "", stderr: "" });

process.env.OE_EGRESS_PROXY_TOKEN = TOKEN;
const savedProxy = { upper: process.env.HTTPS_PROXY, lower: process.env.https_proxy, no: process.env.NO_PROXY, noLower: process.env.no_proxy };
process.env.HTTPS_PROXY = "http://oe-egress-proxy:3128";
process.env.https_proxy = "http://oe-egress-proxy:3128";
delete process.env.NO_PROXY;
delete process.env.no_proxy;
const DOCKER_ROUTE = {
  sandbox: { selfHostBackend: "justbash" as const, boxDockerNetwork: "oe-net-box" },
  egress: { proxyUrl: "http://oe-egress-proxy:8080" },
  browser: { enabled: true, boxImage: "oe-browser-qa:1" },
};
overrideSettingsForTest(DOCKER_ROUTE);

const SECRET = "Bearer vendor-secret-value";
const sessionPolicy = {
  allow: {
    "docs.example": [],
    "support.vendor.example": [{ transform: [{ headers: { authorization: SECRET } }] }],
  },
} as unknown as SandboxNetworkPolicy;

const backend = createDockerBoxBackend(fakeDocker, () => "n1", liveDockerBoxEgressProxy());
registerLongLivedBoxBackend(backend);

{
  const placement = { network: "oe-net-box", forwardProxy: "http://oe-egress-proxy:3128" };
  const args = dockerRunArgs(qaBoxSpec("sess-1", "oe-browser-qa:1"), "oe-box-browser-qa-x-n1", 60, placement);
  const joined = args.join(" ");
  ok(joined.includes("--network oe-net-box") && !joined.includes("--network none"), "behind the proxy, the box joins the internal network (an empty allow-list is a deny-all push, not --network none)");
  ok(!joined.includes("--publish"), "behind the proxy, no port is published on the host");
  ok(args.includes(BOX_EGRESS_PROXY_ENV) && args.includes(BOX_EGRESS_CA_ENV) && args.includes("HTTPS_PROXY"), "the proxy and CA env go by NAME only");
  ok(!joined.includes("oe-egress-proxy:3128"), "🔴 no env VALUE sits on the argv");
  ok(joined.includes("--cap-drop ALL") && joined.includes("--user pwuser"), "the box keeps its hardening behind the proxy");
  const browser: BoxSpec = { ...qaBoxSpec("s", "img"), purpose: "browser", port: 8080, egress: { allow: ["mail.example.com"] } };
  const pb = dockerRunArgs(browser, "b", 60, placement).join(" ");
  ok(!pb.includes("--publish") && pb.includes("--network-alias b.oe-box"), "a personal-browser box with a port and a host list opens behind the proxy, under the alias the app's NO_PROXY names");
  assert.throws(() => dockerRunArgs({ ...browser, purpose: "meeting" }, "m", 60, placement), /cannot run behind the egress proxy/);
  n++;
  ok(!dockerRunArgs({ ...browser, network: "oe-net-boxctl" }, "b", 60, placement).join(" ").includes("oe-net-boxctl"), "the box's own network is not on the run line: the open connects it after the push");
  assert.throws(() => dockerRunArgs(browser, "b", 60), /cannot enforce a host allow-list/);
  n++;
  ok(boxProxyPolicy({ allow: [] }) === "deny-all", "an empty list is deny-all at the proxy");
  assert.throws(() => dockerRunArgs({ ...browser, egress: "open" }, "b", 60, placement), /cannot run with open egress/);
  n++;
  ok(JSON.stringify(boxProxyPolicy({ allow: ["a.example"] })) === '{"allow":["a.example"]}', "a host list goes to the proxy as the list");
}

{
  ok(browserPlaneRefusal() === undefined && browserRunsInBox(), "the docker route behind the proxy, with a network and an image, arms the plane in a container");
  ok(selectLongLivedBoxBackend().enforcesHostAllowList === true && selectLongLivedBoxBackend().backend === "docker", "the selected box backend is docker behind the proxy, and it holds a host list");
  _setBrowserHostsForTest([{ host: "docs.example", methods: ["GET", "HEAD"], why: "test fixture" }]);
  resetAgentBrowserConfigForTest();
  ok(loadAgentBrowserConfig() !== undefined, "the config arms on the docker route behind the proxy");
  ok(Object.keys(agentBrowserSandboxHooks(async () => undefined)).length === 0, "🔴 the session sandbox bakes no browser there (the image carries it)");
  resetBrowserHostsForTest();
  resetAgentBrowserConfigForTest();
  overrideSettingsForTest({ browser: { boxImage: "" } });
  ok(/browser\.boxImage/.test(browserPlaneRefusal() ?? "") && !browserRunsInBox(), "🔴 no image: the plane refuses and names browser.boxImage");
  overrideSettingsForTest({ browser: { boxImage: "oe-browser-qa:1" }, sandbox: { boxDockerNetwork: "" } });
  ok(/justbash backend runs no native binary/.test(browserPlaneRefusal() ?? ""), "🔴 no network: the justbash refusal stands");
  ok(selectLongLivedBoxBackend().backend === "justbash", "no network: the box backend is just-bash, which refuses");
  overrideSettingsForTest({ sandbox: { boxDockerNetwork: "oe-net-box" }, egress: { proxyUrl: "" } });
  ok(browserPlaneRefusal() !== undefined, "🔴 no proxy: the plane refuses");
  overrideSettingsForTest(DOCKER_ROUTE);
}

{
  const driver = createQaBoxDriver({ exec: okExec });
  await assert.rejects(driver.sandboxFor("sess-1"), /pushed no egress policy/);
  n++;
  ok(verbs().includes("stop"), "🔴 a container whose session has no known policy is stopped, never left open");
  ok(store.get(BOX_IP) === undefined, "🔴 and its IP's policy is dropped at the proxy (the drop ran)");

  calls.length = 0;
  pushes.length = 0;
  await pushSessionEgressPolicy(sessionPolicy, { auditId: "slack/T1/C1", boxSession: "sess-1" });
  ok(decide(APP_IP, "docs.example").allow, "the session push lands for the app's own IP");
  ok(decide(BOX_IP, "docs.example").allow === false, "no container is bound yet: its IP stays at default deny");

  pushes.length = 0;
  const sandbox = await driver.sandboxFor("sess-1");
  ok(sandbox.id.startsWith("oe-box-browser-qa-"), "the session's sandbox for the vendor tools is its container");
  const run = calls.find((c) => c.args[0] === "run")!;
  ok(verbs().slice(0, 3).join(",") === "network,run,inspect", "the open checks the network is internal, then runs, then reads the box IP");
  ok(pushes[0]?.sourceIp === BOX_IP && pushes[0]?.policy === "deny-all", "🔴 the backend first pushes deny-all for the container's own IP");
  ok(pushes[1]?.sourceIp === BOX_IP && JSON.stringify(pushes[1]?.policy) === JSON.stringify(sessionPolicy), "🔴 the bind then pushes the session's own compiled policy for the container's IP");
  {
    await assert.rejects(backend.open({ ...qaBoxSpec("pb", "oe-personal-browser:1"), purpose: "browser", port: 8080, egress: { allow: ["mail.example.com"] } }), /needs its own network/);
    n++;
    calls.length = 0;
    const opened = await backend.open({ ...qaBoxSpec("pb", "oe-personal-browser:1"), purpose: "browser", port: 8080, network: "oe-net-boxctl", egress: { allow: ["mail.example.com"] } });
    ok(opened.url === `http://${opened.name}.${BOX_DNS_SUFFIX}:8080` && BOX_DNS_SUFFIX === "oe-box", "a personal-browser box behind the proxy is reached at its alias (the `.oe-box` the overlay's NO_PROXY names)");
    ok(calls.some((c) => c.args.join(" ") === "network inspect --format {{.Internal}} oe-net-boxctl"), "🔴 the box's own network is checked internal too");
    const connect = calls.findIndex((c) => c.args[0] === "network" && c.args[1] === "connect");
    ok(connect > 0 && calls[connect]!.args.join(" ") === `network connect --alias ${opened.name}.oe-box oe-net-boxctl ${opened.name}`, "the box joins its own network under its alias, after the push");
    ok(decide(BOX_IP, "mail.example.com").allow && !decide(BOX_IP, "docs.example").allow, "🔴 a personal-browser box is held to its own host list at the proxy (no session policy, no credential)");
    await backend.stop(opened.name);
    ok(decide(BOX_IP, "docs.example").allow === false && decide(BOX_IP, "mail.example.com").allow === false, "its stop drops that list");
    await pushSessionEgressPolicy(sessionPolicy, { boxSession: "sess-1" });
  }

  ok(decide(BOX_IP, "docs.example").allow, "🔴 a declared host is reachable from the browser container");
  ok(decide(BOX_IP, "evil.example").allow === false, "🔴 an undeclared host is refused at the proxy");
  ok(decide("172.30.0.77", "docs.example").allow === false, "🔴 another container on the network gets nothing: the policy is keyed on this container's IP");
  ok(decide(BOX_IP, "support.vendor.example").headers?.authorization === SECRET, "🔴 the proxy stamps the declared credential on the vendor request (Tier B)");
  const handed = JSON.stringify({ args: run.args, env: run.env });
  ok(!handed.includes("vendor-secret-value"), "🔴 the credential never enters the container: not in its env, not on its argv");
  ok(run.env?.[BOX_EGRESS_PROXY_ENV] === "http://oe-egress-proxy:3128" && run.env?.HTTPS_PROXY === "http://oe-egress-proxy:3128", "the container sends its traffic to the app's own forward proxy");
  ok(run.args.includes(`oe.box.${BOX_LABEL}=browser-qa`) && !run.args.join(" ").includes("sess-1"), "the container is labelled browser-qa and its label carries a hash, never the session id");
  ok(run.args.includes(`${QA_BOX_MAX_MINUTES * 60}s`), "the container has its hard cap");

  const narrowed = { allow: { "docs.example": [] } } as unknown as SandboxNetworkPolicy;
  await pushSessionEgressPolicy(narrowed, { boxSession: "sess-1" });
  ok(decide(BOX_IP, "support.vendor.example").allow === false, "🔴 a later push for the session narrows the container too");
  ok(decide(BOX_IP, "docs.example").allow, "and keeps what the session still reaches");
  failPushFor = BOX_IP;
  await assert.rejects(pushSessionEgressPolicy(sessionPolicy, { boxSession: "sess-1" }), /rejected \(HTTP 503\)/);
  n++;
  failPushFor = undefined;
  await pushSessionEgressPolicy(sessionPolicy, { boxSession: "sess-1" });

  const execs: { name: string; command: string }[] = [];
  const exec: BoxExec = async (name, command) => {
    execs.push({ name, command });
    if (command.startsWith("base64")) return { exitCode: 0, stdout: Buffer.from("PNGBYTES").toString("base64"), stderr: "" };
    return { exitCode: 0, stdout: '{"success":true,"data":{"path":"/tmp/shot.png"}}', stderr: "" };
  };
  const driver2 = createQaBoxDriver({ exec });
  await pushSessionEgressPolicy(sessionPolicy, { boxSession: "sess-2" });
  boxIp = "172.30.0.10";
  const written: { path: string; content: Uint8Array }[] = [];
  const ctx = {
    session: { id: "sess-2" },
    abortSignal: undefined,
    getSandbox: async () => ({ writeBinaryFile: async (o: { path: string; content: Uint8Array }) => void written.push(o), readBinaryFile: async () => null }),
  };
  let seenSandboxId: string | undefined;
  const vendorScreenshot = async (_input: unknown, c: { getSandbox(): Promise<{ id: string; run(o: { command: string }): Promise<{ stdout: string }> }> }) => {
    const sb = await c.getSandbox();
    seenSandboxId = sb.id;
    const r = await sb.run({ command: "agent-browser screenshot --json" });
    return (JSON.parse(r.stdout) as { data: unknown }).data;
  };
  const wrapped = boxedBrowserExecute("browser_screenshot", vendorScreenshot as never, driver2);
  const out = (await wrapped({}, ctx)) as { path?: string };
  ok(seenSandboxId?.startsWith("oe-box-browser-qa-") === true, "🔴 the vendor tool's sandbox is the session's container, not the session sandbox");
  ok(execs[0]?.command === TRUST_EGRESS_CA, "the open first trusts the proxy's CA in the container (a no-op under Tier A)");
  ok(execs[1]?.command === "agent-browser screenshot --json" && execs[1]?.name.startsWith("oe-box-browser-qa-"), "its `run` is a docker exec in that container");
  ok(out.path === "/tmp/shot.png" && written[0]?.path === "/tmp/shot.png" && Buffer.from(written[0]!.content).toString() === "PNGBYTES", "the screenshot is copied back into the session sandbox at the same path");
  ok(decide("172.30.0.10", "docs.example").allow, "the second session's container got its session's policy");
  await assert.rejects(boxedBrowserExecute("browser_snapshot", vendorScreenshot as never, driver2)({}, { getSandbox: ctx.getSandbox }), /no session id/);
  n++;

  calls.length = 0;
  await driver.close("sess-1");
  ok(verbs().includes("stop"), "the close stops the container");
  ok(decide(BOX_IP, "docs.example").allow === false, "🔴 after the close the container's IP is back at default deny");
  ok(decide(APP_IP, "docs.example").allow, "and the session's own policy stays");
  calls.length = 0;
  await driver.close("sess-1");
  ok(!verbs().includes("stop"), "a second close stops nothing");
  await driver2.close("sess-2");
}

// proves: ENV-163
{
  const savedCa = process.env.NODE_EXTRA_CA_CERTS;
  const dir = mkdtempSync(join(tmpdir(), "oe-box-ca-"));
  const caFile = join(dir, "oe-egress-ca.crt");
  writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n");
  try {
    process.env.NODE_EXTRA_CA_CERTS = caFile;
    calls.length = 0;
    const withCa = await backend.open(qaBoxSpec("ca-1", "oe-browser-qa:1"));
    const run = calls.find((c) => c.args[0] === "run")!;
    ok(run.env?.[BOX_EGRESS_CA_ENV]?.includes("BEGIN CERTIFICATE") === true && !run.args.join(" ").includes("BEGIN CERTIFICATE"), "the proxy's CA (NODE_EXTRA_CA_CERTS) reaches the box by env, never on the argv");
    await backend.stop(withCa.name);
    process.env.NODE_EXTRA_CA_CERTS = join(dir, "absent.crt");
    calls.length = 0;
    const noCa = await backend.open(qaBoxSpec("ca-2", "oe-browser-qa:1"));
    ok(calls.find((c) => c.args[0] === "run")!.env?.[BOX_EGRESS_CA_ENV] === undefined, "no CA file (Tier A): no CA is passed");
    await backend.stop(noCa.name);
  } finally {
    if (savedCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = savedCa;
  }
}

{
  store = new acl.PolicyStore();
  calls.length = 0;
  internal = "false";
  const spec = qaBoxSpec("sess-3", "oe-browser-qa:1");
  await assert.rejects(backend.open(spec), /is not internal/);
  n++;
  ok(!verbs().includes("run"), "🔴 a network that is not internal refuses BEFORE any container runs");
  internal = "true";
  calls.length = 0;
  failPushFor = BOX_IP;
  boxIp = BOX_IP;
  await assert.rejects(backend.open(spec), /rejected \(HTTP 503\)/);
  n++;
  ok(verbs().includes("run") && verbs().includes("stop"), "🔴 a failed push stops the container it started");
  failPushFor = undefined;
  calls.length = 0;
  boxIp = "";
  await assert.rejects(backend.open(spec), /has no IP/);
  n++;
  ok(verbs().includes("stop"), "🔴 a container with no IP on the network is stopped");
  boxIp = BOX_IP;
  await assert.rejects(backend.open({ ...spec, purpose: "meeting" }), /cannot run behind the egress proxy/);
  n++;
  await pushSessionEgressPolicy(sessionPolicy, { boxSession: "sess-4" });
  calls.length = 0;
  const failing = createQaBoxDriver({ exec: okExec, bind: async () => { throw new Error("bind refused"); } });
  await assert.rejects(failing.sandboxFor("sess-4"), /bind refused/);
  n++;
  ok(verbs().includes("stop") && store.get(BOX_IP) === undefined, "🔴 a failed bind stops the container and drops its policy");
  calls.length = 0;
  const untrusting = createQaBoxDriver({ exec: async () => ({ exitCode: 1, stdout: "", stderr: "certutil: not found" }) });
  await assert.rejects(untrusting.sandboxFor("sess-4"), /could not trust the egress proxy's CA/);
  n++;
  ok(verbs().includes("stop") && store.get(BOX_IP) === undefined, "🔴 a CA trust that fails stops the container and drops its policy");

  await pushSessionEgressPolicy(sessionPolicy, { boxSession: "sess-5" });
  const capped = createQaBoxDriver({ exec: okExec, capMs: 20 });
  await capped.sandboxFor("sess-5");
  ok(decide(BOX_IP, "docs.example").allow, "the capped container holds its session's policy");
  await new Promise((r) => setTimeout(r, 80));
  ok(store.get(BOX_IP) === undefined, "🔴 at the cap the driver closes the container and drops its IP's policy");
  pushes.length = 0;
  await pushSessionEgressPolicy(sessionPolicy, { boxSession: "sess-5" });
  ok(!pushes.some((p) => p.sourceIp === BOX_IP), "🔴 after the cap, the session's push reaches no old container IP");

  const gone = createQaBoxDriver({ exec: okExec });
  await gone.sandboxFor("sess-5");
  const first = (await gone.sandboxFor("sess-5")).id;
  const realStatus = backend.status.bind(backend);
  let dead = true;
  (backend as { status: typeof backend.status }).status = async (name) => {
    if (dead && name === first) {
      dead = false;
      return undefined;
    }
    return await realStatus(name);
  };
  calls.length = 0;
  pushes.length = 0;
  await gone.sandboxFor("sess-5");
  (backend as { status: typeof backend.status }).status = realStatus;
  ok(verbs().includes("stop") && verbs().includes("run"), "🔴 a container that is gone is closed (its IP unbound and dropped) and a fresh one opens");
  await gone.close("sess-5");
}

globalThis.fetch = realFetch;
for (const [k, v] of [["HTTPS_PROXY", savedProxy.upper], ["https_proxy", savedProxy.lower], ["NO_PROXY", savedProxy.no], ["no_proxy", savedProxy.noLower]] as const) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
resetSessionBoxesForTest();
resetSettingsForTest();
console.log(`✓ browser-box-egress-test: ${n} assertions`);
