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

function vendorNormalised(rel: string): string {
  const m = /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(.+)$/.exec(rel);
  return m === null ? rel : `node_modules:${m[1]}`;
}

function pinNormalisedMatchSet(re: RegExp, expected: readonly string[], what: string, guidance: string): void {
  const found = new Set([...distFilesMatching(re)].map(vendorNormalised));
  const unexpected = [...found].filter((f) => !expected.includes(f));
  if (unexpected.length > 0) {
    console.error(`\u2717 eve ${eveVersion} has NEW ${what}: ${unexpected.join(", ")}\n  ${guidance}`);
    process.exit(1);
  }
  passed++;
  for (const e of expected) ok(found.has(e), `eve still names ${what} in ${e} (the site is not gone/renamed)`);
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
  ["runtime/connections/mcp-client.js", "runtime/connections/scoped-authorization.js"],
  "modules naming the connection-token funnel entry (resolveScopedToken)",
  "The 'injection, not exposure' claim (docs/security/credentials-and-planes.md:75) was verified against exactly\n" +
    "  these two. Read each new site and confirm the token cannot reach the model or the sandbox BEFORE widening this list.",
);

pinMatchSet(
  /\bcreateAuthorizationExecution\b/g,
  [
    "execution/catalog/connection-auth.js",
    "runtime/authorization-context.js",
    "runtime/connections/scoped-authorization.js",
  ],
  "modules holding an authorization EXECUTION (createAuthorizationExecution — its getToken resolves a bearer)",
  "Each holder is a candidate bearer-holder. Read the new site: if it calls `.getToken` on the execution it is a\n" +
    "  FOURTH place the raw bearer flows, and §1c below must be extended with it BEFORE this list is widened.",
);

{
  // eve 1.x's catalog sign-in (completeConnectionSignIn, which replaces eve 0.x's connection-tools.js) creates an
  // execution to complete an interactive sign-in and returns it as `auth`. connection-entry.js then calls
  // handleError and isJustAuthorized on it, and search.js passes it to the listing. None of the three
  // resolves the bearer.
  ok(
    !/\bgetToken\b/.test(read("execution/catalog/connection-auth.js")),
    "execution/catalog/connection-auth.js never calls getToken — it holds an authorization execution for complete/isJustAuthorized only",
  );
  ok(
    /\w+\.complete\(\w+\)/.test(read("execution/catalog/connection-auth.js")) &&
      /\w+\.isJustAuthorized\(\w+\)/.test(read("execution/catalog/connection-auth.js")),
    "…and it still CALLS complete and isJustAuthorized on that execution (the two uses this classification rests on)",
  );
  for (const rel of ["execution/catalog/connection-entry.js", "execution/catalog/search.js"]) {
    ok(/\bcompleteConnectionSignIn\(/.test(read(rel)), `${rel} still receives the sign-in execution from completeConnectionSignIn (the pin below is not vacuous)`);
    ok(!/\bgetToken\b/.test(read(rel)), `${rel} never names getToken — the execution it receives is used for sign-in only`);
  }
  ok(
    /\w+\.auth\.handleError\(/.test(read("execution/catalog/connection-entry.js")) && /\w+\.auth\.isJustAuthorized\(/.test(read("execution/catalog/connection-entry.js")),
    "connection-entry.js still calls handleError and isJustAuthorized on the execution",
  );
  ok(
    /await \w+\.getToken\(/.test(read("runtime/authorization-context.js")),
    "runtime/authorization-context.js still awaits the execution's getToken (it is the module that holds the resolved value)",
  );
}

pinNormalisedMatchSet(
  /\.getToken\(/g,
  [
    "runtime/connections/scoped-authorization.js",
    "runtime/authorization-context.js",
    "execution/tool-auth.js",

    "tools/definition.js",

    "compiled/@chat-adapter/slack/index.js",
    "compiled/@photon-ai/chat-adapter-imessage/index.js",
    "public/models/openai/chatgpt/transport.js",
    "internal/model-auth/available-models.js",
    "internal/model-auth/development-broker-server.js",

    "compiled/jsonc-parser/index.js",
    "compiled/shadcn-registry/index.js",
    // A lexer's token reader (the workflow bundle's parser), not a credential.
    "compiled/_chunks/workflow/run-CBoukBsx.js",

    // The Vercel Queue and Schedules clients send the platform's own OIDC token to the platform API
    // (another plane). The workflow chunk bundles the same queue client.
    "compiled/@vercel/queue/index.js",
    "compiled/@vercel/schedules/index.js",
    "compiled/_chunks/workflow/dist-74tor0XD.js",

    // eve 1.x's git extension: its `gh` tool resolves a user's GitHub connection token with ctx.getToken
    // and hands it to a sandbox shell. That is exposure, not injection. OE never mounts the extension,
    // and the import sweep below fails if a product agent source imports it.
    "extensions/git/extension/lib/gh-tool.js",
    "extensions/git/extension/lib/github-shell.js",
  ],
  "modules CALLING .getToken( anywhere in the dist",
  "Read the new site before widening this list. If it calls `.getToken` on an authorization EXECUTION it is a\n" +
    "  FOURTH place the raw connection bearer flows — docs/security/credentials-and-planes.md:75 claims there are three,\n" +
    "  and the DOC is what changes first. If it is another plane's token, a lexer, or a string, say which, here.",
);

{
  const connectionFiles = distFiles("runtime/connections");
  ok(connectionFiles.length > 5, "eve's runtime/connections tree is present and non-trivial (the sweep below is meaningful)");
  const touchingSandbox = connectionFiles.filter((rel) => /sandbox/i.test(readFileSync(join(distSrc, rel), "utf8")));
  if (touchingSandbox.length > 0) {
    console.error(
      `✗ eve ${eveVersion}'s connection runtime now references a sandbox: ${touchingSandbox.join(", ")}\n` +
        `  docs/security/credentials-and-planes.md:75 claims "the sandbox isn't even in the loop" for the connector\n` +
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
    /let (\w+)=\{status:\w+\.status,statusText:\w+\.statusText,body:await readResponseBody\(\w+\)\};return \w+!==void 0&&\(\1\.location=\w+\),\1\}/.test(openapi),
    "the OpenAPI connector result is still {status, statusText, body}, plus `location` on eve 1.x (the URL of a CROSS-origin redirect that eve refused to follow; it reaches the model) — the request header map never rides out with it",
  );
}

{
  const openapi = read("runtime/connections/openapi-client.js");
  // The builder is the private method that resolves the credential headers (its name is minified).
  const start = openapi.search(/async#\w+\(\w+,\w+,\w+,\w+\)\{let \w+=await resolveProvidedArguments\([^]{0,200}?let \w+=await resolveHeaders\(/);
  ok(start > 0, "the OpenAPI request builder is still a private method on the client that resolves the credential headers (the qualification below reads its body)");
  const body = openapi.slice(start, start + 2000);
  ok(/location===`cookie`\?/.test(body), "the OpenAPI request builder still branches parameters on `location`");
  ok(
    /\w+\[\w+\.name\]=String\(\w+\)/.test(body),
    "eve STILL writes header-location parameters into the resolved-header map (so a spec-declared `Authorization` param would override the injected credential)",
  );
}

{
  // eve 1.x: applySecurity re-places the resolved bearer as the spec's security scheme says. For an `apiKey`
  // scheme `in: query` or `in: cookie` the raw token leaves the Authorization header and enters the request URL or
  // the Cookie header. fetchWithinOrigin follows same-origin redirects itself and returns a CROSS-origin redirect's
  // target URL as `location` in the tool result. A server that redirects cross-origin and keeps the query string
  // therefore hands a query-placed token back to the model. That is exposure, not injection.
  // docs/security/credentials-and-planes.md states the limit. Open Everywhere ships no eve OpenAPI connection
  // (the sweep below), and `oe build` refuses one in an app tree (scripts/openapi-connection-refusal.ts,
  // pinned by test:roster-build).
  const security = read("runtime/connections/openapi-security.js");
  ok(
    /function applySecurity\((\w+),\w+,(\w+),(\w+),(\w+)\)\{[^]*?delete \2\.Authorization,\1\.in===`header`\?\2\[\1\.name\]=(\w+):\1\.in===`query`\?\3\.set\(\1\.name,\5\):\4\.push\(`\$\{\1\.name\}=\$\{\5\}`\)/.test(security),
    "eve's applySecurity still moves the bearer into a header, the query string or a cookie, as the spec's apiKey scheme says",
  );
  const openapi = read("runtime/connections/openapi-client.js");
  ok(
    /if\((\w+)\.origin!==(\w+)\.origin\)return\{response:\w+,location:\1\.href\}/.test(openapi),
    "eve's fetchWithinOrigin still returns a cross-origin redirect target as `location` (the result route a query-placed token can ride)",
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
  ok(
    /getToken:\w+\.getToken,requireAuth:\w+\.requireAuth/.test(toolAuth),
    "eve still wires ctx.getToken and ctx.requireAuth onto the authored-tool context (the seam we abstain from is real)",
  );
  ok(
    /createAuthorizationContext\(\{scope:/.test(toolAuth),
    "that wiring still comes from createAuthorizationContext (the authored-tool context's auth capability)",
  );
  const authContext = read("runtime/authorization-context.js");
  ok(/async getToken\(\w+,\w+\)\{/.test(authContext), "eve still implements an async ctx.getToken");
  ok(/requireAuth\(\w+,\w+\)\{/.test(authContext), "eve still implements ctx.requireAuth");
  ok(
    /return await \w+\.getToken\(resolve\(/.test(authContext),
    "ctx.getToken still RETURNS the resolved token into the authored tool body (this is why we abstain: exposure, not injection)",
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
// The import and definer sweeps read CODE. A generated doc module embeds prose that names these modules on
// purpose (docs/security/credentials-and-planes.md), so it is not a mount site.
const OE_CODE_SOURCES = OE_SOURCES.filter((rel) => !rel.includes("/docs/generated/"));
ok(OE_SOURCES.length > 200, `the OE agent-source sweep found ${OE_SOURCES.length} files across ${AGENT_ROOTS.length} roots (the sweeps below are meaningful)`);

{
  const gitExtensionImporters = OE_CODE_SOURCES.filter((rel) => /["']eve\/extensions\/git(?:\/[^"']*)?["']/.test(codeOf(rel)));
  ok(
    gitExtensionImporters.length === 0,
    `no OE product agent source imports eve's git extension, whose gh tool hands a GitHub connection token to a sandbox shell — got ${gitExtensionImporters.join(", ")}`,
  );
}

{
  const openapiDefiners = OE_CODE_SOURCES.filter((rel) => /\bdefineOpenAPIConnection\b/.test(codeOf(rel)));
  ok(
    openapiDefiners.length === 0,
    `no OE agent source mounts an eve OpenAPI connection, whose apiKey query and cookie placement can expose the token (got: ${openapiDefiners.join(", ")})`,
  );
}

{
  const adopters = OE_SOURCES.filter((rel) => /\bctx\.getToken\s*\(/.test(codeOf(rel)) || /\bctx\.requireAuth\s*\(/.test(codeOf(rel)));
  if (adopters.length > 0) {
    console.error(
      `✗ ${adopters.join(", ")} now uses eve's inline ctx.getToken/ctx.requireAuth.\n` +
        `  This tree deliberately does NOT adopt that seam ("injection, not exposure"): it materialises a raw bearer\n` +
        `  as a JS value inside authored tool code, one careless return away from the model's context. Adopting it\n` +
        `  needs its own review AND a docs correction to docs/security/credentials-and-planes.md:75 — not a widened\n` +
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
  // eve 1.x: a sandbox provider's CONNECTION carries setNetworkPolicy as an `extensions` member, and
  // createConnectionSession merges the extensions UNDER eve's own session members. The setter is a host-side
  // closure the binding builds; nothing the sandbox runs can supply or replace it.
  const session = read("execution/sandbox/session.js");
  ok(/function createConnectionSession\(\w+\)\{/.test(session), "eve still builds the public SandboxSession in createConnectionSession");
  const merge =
    /let (\w+)=\w+\.extensions\?\?\{\};let (\w+)=Object\.keys\(\1\)\.filter\(\w+=>Object\.hasOwn\((\w+),\w+\)\|\|\w+===`delete`\|\|\w+===`stop`\);if\(\2\.length>0\)throw Error\(`Sandbox connection extensions cannot replace the session members eve provides/.exec(
      session,
    );
  ok(merge !== null, "createConnectionSession still refuses a connection extension that would replace an eve session member");
  ok(
    merge !== null && new RegExp(`return\\{\\.\\.\\.${merge[1]},\\.\\.\\.${merge[3]}\\}`).test(session),
    "…and spreads the binding's extensions FIRST, so eve's own members win (setNetworkPolicy arrives only as a binding extension)",
  );

  const vercel = read("execution/sandbox/bindings/vercel.js");
  ok(
    /extensions:\{name:\w+\.name,setNetworkPolicy:createVercelNetworkPolicySetter\(\w+\)\}/.test(vercel),
    "the Vercel binding's setNetworkPolicy extension is createVercelNetworkPolicySetter over the host-side SDK sandbox handle",
  );
  ok(
    /function createVercelNetworkPolicySetter\((\w+)\)\{return async (\w+)=>\{await \1\.update\(\{networkPolicy:toVercelNetworkPolicy\(\2\)\}\)\}\}/.test(
      read("execution/sandbox/bindings/vercel-base-runtime.js"),
    ),
    "…which applies the policy with the SDK's update() call from the host (the Vercel API), never with a command inside the sandbox",
  );

  const docker = read("execution/sandbox/bindings/docker-connection.js");
  ok(
    /extensions:\{setNetworkPolicy:(\w+)=>setDockerNetworkPolicy\(\w+,\w+,\1\)\}/.test(docker),
    "the Docker binding's setNetworkPolicy extension is setDockerNetworkPolicy over the host-side docker CLI",
  );
  const dockerNetwork = read("execution/sandbox/bindings/docker-network.js");
  ok(
    /function assertDockerNetworkPolicy\((\w+)\)\{if\(\1!==`allow-all`&&\1!==`deny-all`\)throw Error\(/.test(dockerNetwork) &&
      /async function setDockerNetworkPolicy\(\w+,\w+,(\w+)\)\{assertDockerNetworkPolicy\(\1\);/.test(dockerNetwork),
    "the Docker setter refuses every policy except allow-all and deny-all FIRST — a Docker sandbox can never carry a credential transform",
  );

  const defaultProvider = read("sandbox/providers/default.js");
  ok(
    /async function rejectJustBashNetworkPolicy\((\w+)\)\{if\(\1!==`allow-all`\)throw Error\(JUST_BASH_NETWORK_POLICY_MESSAGE\)\}/.test(defaultProvider),
    "DefaultSandbox's just-bash fallback setter accepts only allow-all — it can never carry a credential transform either",
  );
}

const EVE_POLICY_SITES = [
  "execution/sandbox/bindings/docker-connection.js",
  "execution/sandbox/bindings/vercel.js",
  "sandbox/providers/default.js",
  "public/channels/github/checkout.js",
  "public/channels/github/defaults.js",
  "self-modification/deployed-sandbox.js",
  "self-modification/git.js",
  "extensions/code/extension/lib/credentials.js",
];
pinMatchSet(
  /setNetworkPolicy/g,
  EVE_POLICY_SITES,
  "setNetworkPolicy",
  "docs/security/credentials-and-planes.md:216 claims the agent 'cannot reach in and widen its own egress policy'.\n" +
    "  Every known site is a host-side sandbox binding, DefaultSandbox's just-bash fallback, the GitHub channel's\n" +
    "  checkout, eve's self-modification sandbox or eve-code's credential broker. A site under a tools/ directory or harness/ would mean\n" +
    "  the model can reach it — that is a SECURITY FINDING and a docs correction, not an expectation to widen.",
);
{
  const offSandbox = [...distFilesMatching(/setNetworkPolicy/g)].filter(
    (f) =>
      !f.startsWith("execution/sandbox/bindings/") &&
      f !== "sandbox/providers/default.js" &&
      !f.startsWith("public/channels/github/") &&
      !f.startsWith("self-modification/") &&
      f !== "extensions/code/extension/lib/credentials.js",
  );
  ok(
    offSandbox.length === 0,
    `no module outside the sandbox bindings, DefaultSandbox, the GitHub channel, self-modification and eve-code's credential broker names setNetworkPolicy (got: ${offSandbox.join(", ")})`,
  );
  ok(
    !/setNetworkPolicy/.test(read("compiler/extension-compatibility.js")),
    "compiler/extension-compatibility.js no longer names setNetworkPolicy (eve 1.x dropped the 0.71.0 migration message)",
  );

  // eve's GitHub channel default `turn.started` checks the triggering repository out into the SESSION sandbox. It
  // installs gitHubGitBrokerNetworkPolicy: allow-all egress ("*": []) plus an installation token for every repository
  // of the installation, on github.com and codeload.github.com, and it never restores the policy. Open Everywhere's
  // native GitHub `turn.started` therefore never runs eve's default: it reacts itself and skips the checkout
  // (github-supervisor-test). These pins hold the eve facts that make the replacement complete and necessary.
  const ghDefaults = read("public/channels/github/defaults.js");
  ok(
    /async"turn\.started"\((\w+),(\w+)\)\{let\{channel:(\w+)\}=\2;if\(\w+\.progress\?\.reactions!==!1\)try\{await \3\.thread\.react\(`eyes`\)\}catch\((\w+)\)\{logError\(log,`GitHub reaction failed — swallowed`,\4\)\}await checkoutRepositoryForTurn\(\3,\2,\w+\)\}/.test(
      ghDefaults,
    ),
    "eve's GitHub default turn.started does exactly two things: the 👀 reaction and checkoutRepositoryForTurn (OE's replacement keeps the first)",
  );
  ok(
    /async function checkoutRepositoryForTurn\(\w+,(\w+),\w+\)\{let\{state:\w+\}=\w+;try\{let (\w+)=await \1\.getSandbox\(\);if\(!\(`setNetworkPolicy`in \2\)\)throw Error\(/.test(ghDefaults),
    "…and the checkout takes the SESSION sandbox through ctx.getSandbox() (the sandbox the model's tools run in)",
  );
  ok(
    (ghDefaults.match(/checkoutRepositoryForTurn\(/g) ?? []).length === 2,
    "checkoutRepositoryForTurn has exactly one call site in eve's GitHub defaults (turn.started) — no other forwarded default event runs the checkout",
  );
  const ghSandboxCalls = distFiles("public/channels/github").reduce((n, f) => n + (readFileSync(join(distSrc, f), "utf8").match(/getSandbox/g) ?? []).length, 0);
  ok(ghSandboxCalls === 1, `eve's GitHub channel names getSandbox exactly once, in checkoutRepositoryForTurn (got ${ghSandboxCalls})`);
  const channelSandboxUsers = distFiles("public/channels").filter((f) => /getSandbox|setNetworkPolicy/.test(readFileSync(join(distSrc, f), "utf8")));
  ok(
    channelSandboxUsers.every((f) => f.startsWith("public/channels/github/")),
    `no eve channel other than GitHub reaches the sandbox or its policy from a channel event (got: ${channelSandboxUsers.join(", ")})`,
  );
  ok(
    /await \w+\.setNetworkPolicy\(gitHubGitBrokerNetworkPolicy\(\w+\)\)/.test(read("public/channels/github/checkout.js")),
    "eve's GitHub checkout still installs gitHubGitBrokerNetworkPolicy on the sandbox it is given (the reason OE refuses it the session sandbox)",
  );
  ok(
    /function gitHubGitBrokerNetworkPolicy\(\w+\)\{let (\w+)=\[\{transform:\[\{headers:\{Authorization:`Basic \$\{Buffer\.from\(`x-access-token:\$\{\w+\}`\)\.toString\(`base64`\)\}`\}\}\]\}\];return\{allow:\{"\*":\[\],"github\.com":\1,"codeload\.github\.com":\1\}\}\}/.test(
      read("shared/git.js"),
    ),
    "gitHubGitBrokerNetworkPolicy is still allow-all plus the installation token on github.com and codeload.github.com",
  );

  const policySiteTools = EVE_POLICY_SITES.filter((f) => /\b(?:defineTool|createTool|inputSchema)\b/.test(read(f)));
  ok(
    policySiteTools.length === 0,
    `no eve module that names setNetworkPolicy defines a tool (got: ${policySiteTools.join(", ")}) — every policy value is host-decided`,
  );
  const eveCodePolicy = read("extensions/code/extension/lib/credentials.js");
  ok(!/\b(?:defineTool|createTool|inputSchema)\b/.test(eveCodePolicy), "eve-code's policy site defines NO tool — the header broker stays host-decided");
  const eveCodeImporters = OE_CODE_SOURCES.filter((rel) => /["']eve\/extensions\/code\b/.test(codeOf(rel)));
  ok(
    eveCodeImporters.length === 0,
    `this tree never imports eve/extensions/code (got: ${eveCodeImporters.join(", ")}) — its per-turn firewall hook is not mounted here`,
  );
  const selfModImporters = OE_CODE_SOURCES.filter((rel) => /["']eve\/extensions\/self-modification\b/.test(codeOf(rel)));
  ok(
    selfModImporters.length === 0,
    `this tree never imports eve/extensions/self-modification (got: ${selfModImporters.join(", ")}) — its GitHub-brokering sandbox is not mounted here`,
  );
  const selfModPolicySites = distFiles("self-modification").filter((f) => /setNetworkPolicy/.test(readFileSync(join(distSrc, f), "utf8")));
  const selfModPolicyTools = selfModPolicySites.filter((f) =>
    /\b(?:defineTool|createTool|inputSchema)\b/.test(readFileSync(join(distSrc, f), "utf8")),
  );
  ok(
    selfModPolicyTools.length === 0,
    `eve's self-modification policy sites still define NO tool (got: ${selfModPolicyTools.join(", ")}) — the baseline stays host-decided`,
  );
  ok(
    /async function withBrokeredGitHubCredential\(\w+,\w+,\w+\)\{[^]*?\}try\{await \w+\.setNetworkPolicy\(SELF_MODIFICATION_BASELINE_NETWORK_POLICY\)\}catch/.test(
      read("self-modification/git.js"),
    ),
    "eve's self-modification git broker still restores its baseline policy after the brokered command (the token does not outlive it)",
  );

  const toolDirs = [...distFiles()].filter((f) => /(?:^|\/)tools\//.test(f) && !f.startsWith("compiled/"));
  ok(toolDirs.length > 20, `the tool-module sweep found ${toolDirs.length} modules under a tools/ directory (the assertion below is not vacuous)`);
  const toolPolicies = toolDirs.filter((f) => /etworkPolicy/.test(readFileSync(join(distSrc, f), "utf8")));
  ok(
    toolPolicies.length === 0,
    `no eve module under any tools/ directory names a network policy (got: ${toolPolicies.join(", ")}) — a model holding eve's tools cannot name a policy value`,
  );
  ok(
    !/setNetworkPolicy/.test(read("context/build-callback-context.js")),
    "context/build-callback-context.js does not name setNetworkPolicy (eve 0.71.0 retired the pass-through)",
  );
}

const OE_POLICY_SEAM = "packages/core/agent/sandbox/network-policy.ts";
const OE_POLICY_CALLERS = ["packages/core/agent/hooks/egress.ts"];
const OE_MID_TURN_APPLIERS = [
  "packages/core/agent/tools/checkout_repo.ts",
  "packages/core/agent/tools/open_pull_request.ts",
];
{
  const direct = OE_SOURCES.filter((rel) => /\.setNetworkPolicy\s*\(/.test(codeOf(rel)));
  const unexpected = direct.filter((c) => c !== OE_POLICY_SEAM);
  if (unexpected.length > 0) {
    console.error(
      `✗ new sandbox.setNetworkPolicy call site(s): ${unexpected.join(", ")}\n` +
        `  Each one re-points the egress firewall mid-session. Route it through applyAndRecordEgressPolicy\n` +
        `  (hooks/egress.ts), so the hook's applied record names the policy in force (OPE-2303), and confirm the\n` +
        `  policy it applies is HOST-COMPUTED (no model-supplied host, path or header can reach a transform).`,
    );
    process.exit(1);
  }
  passed++;
  ok(direct.includes(OE_POLICY_SEAM), `${OE_POLICY_SEAM} still applies the policy host-side (the seam is not gone/renamed)`);

  const callers = OE_SOURCES.filter(
    (rel) => rel !== OE_POLICY_SEAM && (/\bapplySessionNetworkPolicy\s*\(/.test(codeOf(rel)) || /(?<!function\s)\bpushEgressPolicy\s*\(/.test(codeOf(rel))),
  );
  const unexpectedCallers = callers.filter((c) => !OE_POLICY_CALLERS.includes(c));
  if (unexpectedCallers.length > 0) {
    console.error(
      `✗ new applySessionNetworkPolicy / pushEgressPolicy caller(s): ${unexpectedCallers.join(", ")}\n` +
        `  Each one re-points the egress firewall mid-session. Route it through applyAndRecordEgressPolicy\n` +
        `  (hooks/egress.ts), so the hook's applied record names the policy in force (OPE-2303), and confirm the\n` +
        `  policy it applies is HOST-COMPUTED before widening this list.`,
    );
    process.exit(1);
  }
  passed++;
  for (const c of OE_POLICY_CALLERS) ok(callers.includes(c), `${c} still applies the policy host-side through the seam (the site is not gone/renamed)`);
  for (const c of OE_MID_TURN_APPLIERS) {
    ok(/\bapplyAndRecordEgressPolicy\s*\(/.test(codeOf(c)), `${c} applies its brokered policy through applyAndRecordEgressPolicy (OPE-2303)`);
  }
}

{
  const logging = read("execution/sandbox/logging-session.js");
  ok(/function createLoggingSandboxSession\(/.test(logging), "eve's bootstrap session wrapper is still present (the pins below are not vacuous)");
  ok(
    !/etworkPolicy|network policy/.test(logging),
    "eve's bootstrap session wrapper no longer names or LOGS a network policy (eve 0.71.0 removed the sink)",
  );
  ok(
    distFilesMatching(/formatNetworkPolicy|set network policy: \$\{/g).size === 0,
    "no module in eve's dist formats a network policy into a log line",
  );
  const wrapperUsers = [...distFilesMatching(/createLoggingSandboxSession\(/g)].filter((f) => !f.startsWith("execution/sandbox/logging-session"));
  ok(wrapperUsers.length > 0, "eve's sandbox bindings still install the policy-logging wrapper somewhere (the confinement check below is not vacuous)");
  ok(
    wrapperUsers.length === 1 && wrapperUsers[0] === "execution/sandbox/prewarm.js",
    `the bootstrap wrapper is installed only by execution/sandbox/prewarm.js, the template-preparation path (got: ${wrapperUsers.join(", ")})`,
  );
  ok(
    /await (\w+)\(createLoggingSandboxSession\(\{log:\w+,session:\w+\}\)\)/.test(read("execution/sandbox/prewarm.js")),
    "…which hands the wrapped session only to the app's prepare callback (OE's agent-browser bake, pinned below)",
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
    repoCapabilities: {}, resourceCapabilities: {},
   
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
