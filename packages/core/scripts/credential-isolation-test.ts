import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileNetworkPolicy } from "../agent/access/egress.js";
import { resolveHeaders, envBroker, registerBroker, ENV_BROKER } from "../agent/access/credentials.js";
import { mintGitReadBroker, mergeGitReadBroker, brokerAuthHeader, GIT_BROKER_HOSTS } from "../agent/scm/broker.js";
import { checkoutCommand, checkoutCommandBrokered } from "../agent/scm/git.js";
import type { EffectiveAccess, ReachableHost } from "../agent/access/resolver.js";
import type { Connection } from "../agent/access/bundle.js";
import type { GitHubApp } from "../agent/scm/app.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const distSrc = join(eveRoot, "dist", "src");
const eveVersion = (JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")) as { version: string }).version;
const read = (rel: string): string => readFileSync(join(distSrc, rel), "utf8");

function distFiles(sub = "."): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.endsWith(".js")) out.push(relative(distSrc, abs).replaceAll("\\", "/"));
    }
  };
  walk(join(distSrc, sub));
  return out;
}

function distFilesMatching(re: RegExp, sub = "."): Set<string> {
  const found = new Set<string>();
  for (const rel of distFiles(sub)) {
    re.lastIndex = 0;
    if (re.test(readFileSync(join(distSrc, rel), "utf8"))) found.add(rel);
  }
  return found;
}

function pinMatchSet(re: RegExp, expected: readonly string[], what: string, guidance: string): void {
  const found = distFilesMatching(re);
  const unexpected = [...found].filter((f) => !expected.includes(f));
  if (unexpected.length > 0) {
    console.error(`✗ eve ${eveVersion} has NEW ${what}: ${unexpected.join(", ")}\n  ${guidance}`);
    process.exit(1);
  }
  passed++;
  for (const e of expected) ok(found.has(e), `eve still names ${what} in ${e} (the site is not gone/renamed)`);
}

console.log(`credential-isolation: verifying against installed eve ${eveVersion}`);

{
  const scoped = read("runtime/connections/scoped-authorization.js");
  ok(/async function resolveScopedToken\(\w+\)\{/.test(scoped), "eve still funnels connection-token resolution through resolveScopedToken");
  ok(
    /await \w+\.getToken\(\{connection:\w+,principal:\w+\}\)/.test(scoped),
    "resolveScopedToken still invokes the connection's getToken as a PLAIN in-process call (no transport, no sandbox hop)",
  );
}

pinMatchSet(
  /\bresolveScopedToken\b/g,
  ["execution/tool-auth.js", "runtime/connections/mcp-client.js", "runtime/connections/scoped-authorization.js"],
  "modules touching a resolved connection token (resolveScopedToken)",
  "The 'injection, not exposure' claim (docs/security/credentials-and-planes.md:41) was verified against exactly\n" +
    "  three. Read each new site and confirm the token cannot reach the model or the sandbox BEFORE widening this list.",
);

{
  const connectionFiles = distFiles("runtime/connections");
  ok(connectionFiles.length > 5, "eve's runtime/connections tree is present and non-trivial (the sweep below is meaningful)");
  const touchingSandbox = connectionFiles.filter((rel) => /sandbox/i.test(readFileSync(join(distSrc, rel), "utf8")));
  if (touchingSandbox.length > 0) {
    console.error(
      `✗ eve ${eveVersion}'s connection runtime now references a sandbox: ${touchingSandbox.join(", ")}\n` +
        `  docs/security/credentials-and-planes.md:41 claims "the sandbox isn't even in the loop" for the connector\n` +
        `  plane. Read the new reference: if a connector call can now traverse a sandbox, the DOC IS WRONG and must\n` +
        `  be corrected before this expectation is widened.`,
    );
    process.exit(1);
  }
  passed++;
}

{
  const mcp = read("runtime/connections/mcp-client.js");
  ok(
    /\w+\.Authorization=`Bearer \$\{\(await resolveToken\(\w+,\w+\)\)\.token\}`/.test(mcp),
    "mcp-client resolveHeaders still stamps `Authorization: Bearer <token>` host-side, into the transport header map",
  );
  ok(
    /import\{[^}]*\bresolveHeaders\b[^}]*\}from"#runtime\/connections\/mcp-client\.js"/.test(read("runtime/connections/openapi-client.js")),
    "the OpenAPI connection client still shares mcp-client's ONE header-attach seam (no second credential path)",
  );
}

{
  const openapi = read("runtime/connections/openapi-client.js");
  ok(
    /return\{status:\w+\.status,statusText:\w+\.statusText,body:await readResponseBody\(\w+\)\}/.test(openapi),
    "the OpenAPI connector result is still {status, statusText, body} — the request header map never rides out with it",
  );
}

{
  const openapi = read("runtime/connections/openapi-client.js");
  const start = openapi.indexOf("async#f(");
  ok(start > 0, "the OpenAPI request builder is still a private method on the client (the qualification below reads its body)");
  const body = openapi.slice(start, start + 2000);
  ok(/location===`cookie`\?/.test(body), "the OpenAPI request builder still branches parameters on `location`");
  ok(
    /\w+\[\w+\.name\]=String\(\w+\)/.test(body),
    "eve STILL writes header-location parameters into the resolved-header map (so a spec-declared `Authorization` param would override the injected credential)",
  );
}

{
  const tokens = read("runtime/connections/authorization-tokens.js");
  const writeStart = tokens.indexOf("function writeCachedToken");
  ok(writeStart > 0, "authorization-tokens.js still defines writeCachedToken (the cache write site)");
  const writeBody = tokens.slice(writeStart, tokens.indexOf("function evictCachedToken"));
  ok(
    /setVirtualContext\(ConnectionAuthorizationTokensKey,/.test(writeBody),
    "the resolved connector token is still cached via setVirtualContext (the NON-persisted context tier)",
  );
  ok(
    !/\.set\(ConnectionAuthorizationTokensKey/.test(tokens),
    "nothing writes the connector-token cache into the DURABLE context tier (.set) — that tier is what gets serialized into the session store",
  );

  const container = read("context/container.js");
  ok(
    /setVirtualContext\(\w+,\w+\)\{this\._virtualValues\.set\(\w+\.name,\w+\)\}/.test(container),
    "ContextContainer.setVirtualContext still writes _virtualValues (separate from the durable map)",
  );
  ok(
    /\*entries\(\)\{for\(let\[\w+,\w+\]of this\._durableValues\)/.test(container),
    "ContextContainer.entries() — the ONLY enumeration of the container — still yields _durableValues ONLY",
  );

  ok(
    /function serializeContext\(\w+\)\{let \w+=\{\};for\(let\[\w+,\w+\]of \w+\.entries\(\)\)/.test(read("context/serialize.js")),
    "serializeContext still persists exactly what entries() yields — so a virtual-tier token can never be serialized",
  );
}

{
  const toolAuth = read("execution/tool-auth.js");
  ok(/async getToken\(\w+,\w+\)\{/.test(toolAuth), "eve still exposes ctx.getToken on the authored-tool context (the seam we abstain from is real)");
  ok(/requireAuth\(\w+,\w+\)\{/.test(toolAuth), "eve still exposes ctx.requireAuth on the authored-tool context");
  ok(
    /return await resolveInlineToken\(\{/.test(toolAuth),
    "ctx.getToken still RETURNS the resolved TokenResult into the authored tool body (this is why we abstain: exposure, not injection)",
  );
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENT_ROOTS = [
  "agent",
  "packages/core/agent",
  "packages/adapters/agent",
  ...readdirSync(join(repoRoot, "packages", "providers")).map((p) => `packages/providers/${p}/agent`),
].filter((r) => existsSync(join(repoRoot, r)));

function agentSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs, `${rel}/${entry}`);
        continue;
      }
      if (entry.endsWith(".ts")) out.push(`${rel}/${entry}`);
    }
  };
  for (const root of AGENT_ROOTS) walk(join(repoRoot, root), root);
  return out;
}

function codeOf(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const OE_SOURCES = agentSources();
ok(OE_SOURCES.length > 200, `the OE agent-source sweep found ${OE_SOURCES.length} files across ${AGENT_ROOTS.length} roots (the sweeps below are meaningful)`);

{
  const adopters = OE_SOURCES.filter((rel) => /\bctx\.getToken\s*\(/.test(codeOf(rel)) || /\bctx\.requireAuth\s*\(/.test(codeOf(rel)));
  if (adopters.length > 0) {
    console.error(
      `✗ ${adopters.join(", ")} now uses eve's inline ctx.getToken/ctx.requireAuth.\n` +
        `  This tree deliberately does NOT adopt that seam ("injection, not exposure"): it materialises a raw bearer\n` +
        `  as a JS value inside authored tool code, one careless return away from the model's context. Adopting it\n` +
        `  needs its own review AND a docs correction to docs/security/credentials-and-planes.md:41 — not a widened\n` +
        `  expectation here.`,
    );
    process.exit(1);
  }
  passed++;
}

{
  const definers = OE_SOURCES.filter((rel) => /\basync getToken\s*\(/.test(codeOf(rel)));
  ok(definers.length >= 2, `the getToken sweep found ${definers.length} implementation sites (the gate assertion below is not vacuous)`);
  const ungated = definers.filter((rel) => {
    const code = codeOf(rel);
    return !/\bassertConnectorGranted\b/.test(code) || !/\bassert\w*Granted\s*\(/.test(code);
  });
  if (ungated.length > 0) {
    console.error(
      `✗ ${ungated.join(", ")} implements a connection getToken WITHOUT the per-surface hard gate.\n` +
        `  assertConnectorGranted (access/connector-scope.ts) must run FIRST in every getToken, so an ungranted or\n` +
        `  unidentifiable surface never reaches a credential (docs/security/security-model.md §2, fail closed).\n` +
        `  Add the gate — do not widen this expectation.`,
    );
    process.exit(1);
  }
  passed++;
}

{
  const session = read("execution/sandbox/session.js");
  ok(
    /function buildSandboxSession\(\w+,\w+=async\(\)=>\{\}\)\{/.test(session),
    "buildSandboxSession still takes the network-policy setter as a host-side CLOSURE argument (defaulting to a no-op)",
  );
  ok(/setNetworkPolicy:\w+\}/.test(session), "the public SandboxSession still carries that closure as its setNetworkPolicy method");
}

const EVE_POLICY_SITES = [
  "execution/sandbox/bindings/just-bash-runtime.js",
  "execution/sandbox/bindings/microsandbox-lifecycle.js",
  "execution/sandbox/bindings/microsandbox-runtime.js",
  "execution/sandbox/logging-session.js",
  "execution/sandbox/session.js",
  "public/channels/github/checkout.js",
  "context/build-callback-context.js",
];
pinMatchSet(
  /setNetworkPolicy/g,
  EVE_POLICY_SITES,
  "setNetworkPolicy",
  "docs/security/credentials-and-planes.md:103 claims the agent 'cannot reach in and widen its own egress policy'.\n" +
    "  Every known site is a sandbox binding or a host-side channel. A site under public/tools/ or harness/ would mean\n" +
    "  the model can reach it — that is a SECURITY FINDING and a docs correction, not an expectation to widen.",
);
{
  const offSandbox = [...distFilesMatching(/setNetworkPolicy/g)].filter(
    (f) => !f.startsWith("execution/sandbox/") && !f.startsWith("public/channels/") && f !== "context/build-callback-context.js",
  );
  ok(offSandbox.length === 0, "no module outside execution/sandbox/** or public/channels/** names setNetworkPolicy (never on the model tool surface)");
  const cbctx = readFileSync(join(distSrc, "context/build-callback-context.js"), "utf8");
  const mentions = cbctx.match(/setNetworkPolicy[^,}]*/g) ?? [];
  ok(mentions.length > 0, "the reviewed 0.32.0 site still exists (drop the exemption when eve removes it)");
  ok(
    mentions.every((m) => /^setNetworkPolicy:[A-Za-z_$]{1,3}=>[A-Za-z_$]{1,3}\.setNetworkPolicy\([A-Za-z_$]{1,3}\)$/.test(m)),
    `context/build-callback-context.js setNetworkPolicy mentions are all verbatim pass-throughs (got: ${mentions.join(" | ")})`,
  );
  const toolSurface = distFiles("public/tools").filter((f) => /etworkPolicy/.test(readFileSync(join(distSrc, f), "utf8")));
  ok(toolSurface.length === 0, "eve's built-in TOOL definitions (public/tools/**) never mention a network policy — there is no model tool for it");
}

const OE_POLICY_CALLERS = [
  "packages/core/agent/hooks/egress.ts",
  "packages/core/agent/tools/checkout_repo.ts",
  "packages/core/agent/tools/open_pull_request.ts",
];
{
  const callers = OE_SOURCES.filter((rel) => /\.setNetworkPolicy\s*\(/.test(codeOf(rel)));
  const unexpected = callers.filter((c) => !OE_POLICY_CALLERS.includes(c));
  if (unexpected.length > 0) {
    console.error(
      `✗ new sandbox.setNetworkPolicy call site(s): ${unexpected.join(", ")}\n` +
        `  Each one re-points the egress firewall mid-session. Confirm the policy it applies is HOST-COMPUTED (no\n` +
        `  model-supplied host, path or header can reach a transform) before widening this list.`,
    );
    process.exit(1);
  }
  passed++;
  for (const c of OE_POLICY_CALLERS) ok(callers.includes(c), `${c} still applies the policy host-side (the site is not gone/renamed)`);
}

{
  const logging = read("execution/sandbox/logging-session.js");
  ok(
    /set network policy: \$\{formatNetworkPolicy\(\w+\)\}/.test(logging),
    "eve's bootstrap session wrapper still LOGS the network policy it is handed",
  );
  ok(
    /function formatNetworkPolicy\(\w+\)\{return truncateOneLine\(typeof \w+==`string`\?\w+:JSON\.stringify\(\w+,\(\w+,\w+\)=>\w+===`transform`\?`\[redacted\]`:\w+\)\)\}/.test(logging),
    "that log REDACTS the whole `transform` key (eve 0.44.0) — a bootstrap-time credential header can no longer reach it verbatim",
  );
  const wrapperUsers = [...distFilesMatching(/createLoggingSandboxSession\(/g)].filter((f) => !f.startsWith("execution/sandbox/logging-session"));
  ok(wrapperUsers.length > 0, "eve's sandbox bindings still install the policy-logging wrapper somewhere (the confinement check below is not vacuous)");
  ok(
    wrapperUsers.every((f) => f.startsWith("execution/sandbox/bindings/")),
    "the policy-logging wrapper is still only installed by sandbox BINDINGS on the template-bootstrap path (not on the live session)",
  );

  const bake = readFileSync(join(repoRoot, "packages/adapters/agent/browser/sandbox.ts"), "utf8");
  ok(!/setNetworkPolicy/.test(bake), "OE's only sandbox bootstrap (agent-browser pre-bake) never applies a network policy — nothing credentialed reaches the logged wrapper");
  ok(
    /interface BakeableSandbox \{[\s\S]*?\n\}/.test(bake) && !/interface BakeableSandbox \{[\s\S]*?setNetworkPolicy[\s\S]*?\n\}/.test(bake),
    "the bootstrap's sandbox type still exposes no policy setter — the bake cannot even name one",
  );
}

const SENTINEL = "oe-sentinel-secret-9f3a7c21-do-not-log";
const SENTINEL_REF = "OE_CREDENTIAL_ISOLATION_TEST_SECRET";

const conn = (id: string): Connection =>
  ({ id, credentialType: "bearer", secretRef: SENTINEL_REF, broker: ENV_BROKER, allowedWebsites: ["api.acme.test"] }) as unknown as Connection;

function access(hosts: ReachableHost[], connections: Connection[]): EffectiveAccess {
  return {
    mode: "channel",
    scopeKey: "test/ws/surface",
    connections,
    connectorCredentials: {},
    reachableHosts: hosts,
    repos: [],
   
    plugins: [],
    skills: [],
    subagents: [],
    connectors: [],
    instructionStack: [], preApprovalRules: [],
    warnings: [],
  } as unknown as EffectiveAccess;
}

function pathsContaining(value: unknown, needle: string, at = "$"): string[] {
  if (typeof value === "string") return value.includes(needle) ? [at] : [];
  if (Array.isArray(value)) return value.flatMap((v) => pathsContaining(v, needle, `${at}[]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => pathsContaining(v, needle, `${at}.${k}`));
  }
  return [];
}

{
  process.env[SENTINEL_REF] = SENTINEL;
  registerBroker(ENV_BROKER, envBroker);
  const policy = await compileNetworkPolicy(
    access([{ host: "api.acme.test", viaConnection: "acme" } as unknown as ReachableHost], [conn("acme")]),
    resolveHeaders,
    async (ids) => ids,
  );

  const hits = pathsContaining(policy, SENTINEL);
  ok(hits.length > 0, "the sentinel secret really did reach the compiled policy (the confinement assertion below is not vacuous)");
  ok(
    hits.every((p) => p === "$.allow.api.acme.test[].transform[].headers.authorization"),
    `the secret appears ONLY under allow.<host>[].transform[].headers — not in a match, a host key, or any other slot (saw: ${hits.join(", ")})`,
  );
  ok(
    !Object.keys((policy as { allow: Record<string, unknown> }).allow).some((k) => k.includes(SENTINEL)),
    "no compiled policy KEY (host name) carries the secret — host keys are what the egress hook logs and audits",
  );
  delete process.env[SENTINEL_REF];
}

{
  const fakeApp = {
    async tokensForRepos() {
      return { tokens: new Map([["acme", { token: SENTINEL }]]), ungranted: [] as string[] };
    },
  } as unknown as GitHubApp;
  const { rulesByOwner } = await mintGitReadBroker(fakeApp, ["acme/widgets", "attacker.test/evil"]);
  const merged = mergeGitReadBroker({ allow: { "api.acme.test": [] } }, rulesByOwner);
  const allow = (merged as { allow: Record<string, unknown> }).allow;

  const encoded = brokerAuthHeader(SENTINEL).Authorization;
  ok(!encoded.includes(SENTINEL), "the broker header really is encoded (so the confinement search below uses the right needle)");
  const credentialedHosts = Object.keys(allow).filter((h) => pathsContaining(allow[h], encoded).length > 0);
  ok(
    credentialedHosts.length === GIT_BROKER_HOSTS.length && GIT_BROKER_HOSTS.every((h) => credentialedHosts.includes(h)),
    `the git read token is injected on EXACTLY the module-constant broker hosts (${GIT_BROKER_HOSTS.join(", ")}) — a model-supplied repo string can never add a host`,
  );
  ok(!("attacker.test" in allow), "a hostile owner/repo argument does not become a reachable host");
  ok(
    JSON.stringify(allow[GIT_BROKER_HOSTS[0]]).includes("/acme/"),
    "path narrowing still comes from the GRANTED repo set's owner (the minted token map), not from the caller's argument",
  );
}

{
  ok(checkoutCommandBrokered.length === 3, "checkoutCommandBrokered still takes NO token parameter (repo, dir, identity) — the credential rides at the firewall");
  ok(checkoutCommand.length === 4, "the unenforced FALLBACK builder still takes a token (repo, token, dir, identity) — the two paths remain distinguishable");
  const brokered = checkoutCommandBrokered("acme/widgets", "widgets", { name: "n", email: "e" });
  ok(!/extraheader/.test(brokered), "the brokered clone command sets no http.extraheader — nothing credential-shaped enters the sandbox command");
  ok(
    /extraheader/.test(checkoutCommand("acme/widgets", SENTINEL, "widgets", { name: "n", email: "e" })),
    "the fallback path does inject in-sandbox (the contrast that makes the assertion above meaningful)",
  );
}

console.log(`✓ credential-isolation: ${passed} contract assertions passed against eve ${eveVersion}`);
