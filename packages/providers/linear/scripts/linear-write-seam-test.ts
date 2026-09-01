import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

console.log("linear write seam (OPE-1234):");

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEAM_REL = "agent/channels/linear-graphql.ts";
const MINT_REL = "agent/channels/linear-credentials.ts";

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const BARE_FETCH = /(?<![.\w])fetch\s*\(/;
const OWN_TRANSPORT = /globalThis\.fetch/;
const EVE_TRANSPORT = /\b(?:callLinearGraphQL|createLinearAgentActivity|updateLinearAgentSession|createLinearAgentSessionOnIssue|createLinearAgentSessionOnComment|listLinearAgentSessionActivities)\b/;
const CHANNEL_CONFIG = /linearChannel\(\{/g;
const CHANNEL_CONFIG_WITH_API = /linearChannel\(\{[^}]*?\bapi:\s*linearChannelApi\(/gs;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

{
  ok(BARE_FETCH.test(stripComments("const res = await fetch(url);")), "§0 the bare-fetch matcher DOES match a real direct call");
  ok(BARE_FETCH.test(stripComments("const res = await  fetch  (url);")), "§0 …and is not fooled by whitespace before the paren");
  ok(!BARE_FETCH.test(stripComments("// const res = await fetch(url);\n")), "§0 …and a commented-out call is NOT an offender");
  ok(!BARE_FETCH.test(stripComments("/** prose naming fetch(url) */\nconst x = 1;")), "§0 …nor is prose in a block comment");
  ok(!BARE_FETCH.test(stripComments("const res = await opts.fetch(url);")), "§0 …nor is a call through an injected seam");

  ok(OWN_TRANSPORT.test(stripComments("const base = globalThis.fetch;")), "§0 the own-transport matcher DOES match a module reaching for the global");
  ok(!OWN_TRANSPORT.test(stripComments("// globalThis.fetch is what this module wraps\n")), "§0 …and prose about it is not a transport");

  ok(EVE_TRANSPORT.test(stripComments('import { callLinearGraphQL } from "eve/channels/linear";')), "§0 the eve-transport matcher DOES match a direct import");
  ok(EVE_TRANSPORT.test(stripComments("await createLinearAgentActivity({});")), "§0 …and a direct call");
  for (const name of ["updateLinearAgentSession", "createLinearAgentSessionOnIssue", "createLinearAgentSessionOnComment", "listLinearAgentSessionActivities"]) {
    ok(EVE_TRANSPORT.test(stripComments(`import { ${name} } from "eve/channels/linear";`)), `§0 …and eve's \`${name}\`, which no file calls today`);
  }
  ok(!EVE_TRANSPORT.test(stripComments("await callLinear({});")), "🔴 §0 …and does NOT match the OE seam that wraps it — otherwise §2 would flag every call site and prove nothing");
  ok(!EVE_TRANSPORT.test(stripComments("await createLinearActivity({});")), "§0 …nor the activity wrapper");
  ok(!EVE_TRANSPORT.test(stripComments("// callLinearGraphQL is what the seam delegates to\n")), "§0 …nor prose naming it");

  const oneConfig = "const c = linearChannel({ credentials: x });";
  const wiredConfig = "const c = linearChannel({ api: linearChannelApi(), credentials: x });";
  eq(oneConfig.match(CHANNEL_CONFIG)?.length, 1, "§0 the channel-config matcher DOES find a config");
  eq(oneConfig.match(CHANNEL_CONFIG_WITH_API)?.length, undefined, "🔴 §0 …and does NOT count an UNWIRED one as wired — otherwise §4 would pass over the exact defect it exists to catch");
  eq(wiredConfig.match(CHANNEL_CONFIG_WITH_API)?.length, 1, "§0 …while a wired one is counted");
  eq("const c = linearChannel({ api: somethingElse(), credentials: x });".match(CHANNEL_CONFIG_WITH_API)?.length, undefined, "§0 …and an `api` that is not the seam's does not count");
}

const AGENT_FILES = tsFiles(join(PKG_ROOT, "agent"));

{
  const seam = stripComments(readFileSync(join(PKG_ROOT, SEAM_REL), "utf8"));
  ok(/withRetryAfter\(\(\)\s*=>\s*baseFetch\(api\)\(input, init\)/.test(seam), "🔴 §1 the seam still dispatches through `withRetryAfter` — remove it and every Linear GraphQL call silently loses its backoff");
  ok(/return api\?\.fetch \?\? globalThis\.fetch;/.test(seam), "🔴 §1 …and resolves the transport PER ATTEMPT: `linearChannelApi()` runs at module load, so a captured base would freeze the fetch before the integration tier can replace it");
  ok(/surface:\s*LINEAR_SURFACE/.test(seam), "§1 the seam names the linear surface");
  ok(/retryingApi\(input\.api, input\.queryName\)/.test(seam), "§1 …and names each call by its own queryName, so an error can never report the wrong operation");
  ok(/callLinearGraphQL<T>\(\{\s*\.\.\.input, api: retryingApi/.test(seam), "🔴 §1 the query wrapper hands eve the RETRYING api — pass `input.api` through instead and every caller is bare again");
  ok(/createLinearAgentActivity\(\{\s*\.\.\.input, api: retryingApi/.test(seam), "🔴 §1 …and so does the Agent-Activity wrapper");
  ok(/export function linearChannelApi[\s\S]*?withRetryAfter\(/.test(seam), "🔴 §1 …and `linearChannelApi`, which is what carries the backoff into eve's OWN Agent-Session calls");
  ok(/operation: linearChannelOperation\(init\?\.body\)/.test(seam), "§1 the channel api names each call from its own GraphQL document");
}

{
  const offenders: string[] = [];
  for (const file of AGENT_FILES) {
    const rel = relative(PKG_ROOT, file);
    if (rel === SEAM_REL) continue;
    if (EVE_TRANSPORT.test(stripComments(readFileSync(file, "utf8")))) offenders.push(rel);
  }
  eq(
    offenders,
    [],
    `🔴 §2 only \`${SEAM_REL}\` may name eve's Linear transport — a file naming any of eve's six HTTP-issuing \`eve/channels/linear\` exports directly has NO 429 backoff, and one of the four this package never calls would make its request from inside eve where no other section can see it. Route it through \`callLinear\` / \`createLinearActivity\`, or widen the seam. Found ${offenders.length}: ${offenders.join(", ")}`,
  );
}

{
  const KNOWN_TRANSPORTS: ReadonlyArray<{ file: string; covered: boolean; why: string }> = [
    { file: SEAM_REL, covered: true, why: "callLinear / createLinearActivity — every GraphQL query and mutation this package issues, reads and writes alike" },
    {
      file: MINT_REL,
      covered: true,
      why: "mintLinearAppActorToken — the client-credentials token mint. Typed over LinearMintFetch ({ok,status,text,json}), not Response, so it takes the backoff through the withRetryAfterLoose shim (OPE-1288) rather than withRetryAfter directly. Held warm for the token's 30-day life, so it runs far less often than a call.",
    },
  ];

  const found: string[] = [];
  for (const file of AGENT_FILES) {
    if (OWN_TRANSPORT.test(stripComments(readFileSync(file, "utf8")))) found.push(relative(PKG_ROOT, file));
  }
  eq(
    found.slice().sort(),
    KNOWN_TRANSPORTS.map((t) => t.file).sort(),
    "🔴 §3 the modules that own a Linear transport are EXACTLY the tracked inventory — a NEW one appearing, or a listed one vanishing, reds here",
  );

  for (const entry of KNOWN_TRANSPORTS) {
    const src = stripComments(readFileSync(join(PKG_ROOT, entry.file), "utf8"));
    const wrapped = /withRetryAfter/.test(src);
    if (entry.covered) {
      ok(wrapped, `§3 \`${entry.file}\` is marked COVERED and must carry the backoff — it does not, so either the wrap was removed or the flag is wrong`);
    } else {
      ok(!wrapped, `§3 \`${entry.file}\` is marked UNCOVERED and must not carry the backoff — wrap it and mark it covered here and in docs/extending/provider-rate-limits.md`);
    }
  }
}

{
  for (const file of AGENT_FILES) {
    const src = stripComments(readFileSync(file, "utf8"));
    const configs = src.match(CHANNEL_CONFIG)?.length ?? 0;
    if (configs === 0) continue;
    const wired = src.match(CHANNEL_CONFIG_WITH_API)?.length ?? 0;
    eq(
      wired,
      configs,
      `🔴 §4 every \`linearChannel({…})\` in \`${relative(PKG_ROOT, file)}\` must pass \`api: linearChannelApi()\` — eve threads \`config.api\` into its default events, its LinearHandle and the agent-session dispatch, so a config without one posts the mention route's terminal answer with a bare fetch and loses it on the first 429. ${wired} of ${configs} are wired`,
    );
  }
  const totalConfigs = AGENT_FILES.reduce((sum, f) => sum + (stripComments(readFileSync(f, "utf8")).match(CHANNEL_CONFIG)?.length ?? 0), 0);
  eq(totalConfigs, 2, "§4 the package still builds exactly two Linear channels (the pristine per-org one and the native one) — a third needs the same api");
}

{
  const offenders: string[] = [];
  for (const file of AGENT_FILES) {
    if (BARE_FETCH.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative(PKG_ROOT, file));
  }
  eq(offenders, [], `🔴 §5 no file in the Linear agent tree may call the global fetch directly — found ${offenders.length}: ${offenders.join(", ")}`);
}

console.log(`  ${n} assertions passed`);
