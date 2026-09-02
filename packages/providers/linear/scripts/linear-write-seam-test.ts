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
const EVE_LINEAR_DIR = join(PKG_ROOT, "..", "..", "..", "node_modules", "eve", "dist", "src", "public", "channels", "linear");

function eveTransportNames(): string[] {
  const read = (file: string): string => {
    try {
      return readFileSync(join(EVE_LINEAR_DIR, file), "utf8");
    } catch (err) {
      throw new Error(
        `linear-write-seam: cannot read eve's ${file} at ${EVE_LINEAR_DIR} — an eve bump moved or renamed it. ` +
          "Find the new home of eve's Linear transport declarations and update EVE_LINEAR_DIR (and the " +
          "eve-upgrade-check skill's checklist). Do NOT fall back to a hand-written list.",
        { cause: err },
      );
    }
  };
  const declared = new Set([...read("api.d.ts").matchAll(/export declare function ([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  const reExportedFromApi = /export \{([^}]*)\} from "[^"]*channels\/linear\/api\.js";/.exec(read("index.d.ts"));
  if (reExportedFromApi === null) {
    throw new Error(`linear-write-seam: eve's index.d.ts no longer re-exports from channels/linear/api.js — read ${EVE_LINEAR_DIR}/index.d.ts and update this derivation.`);
  }
  const exposed = reExportedFromApi[1]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith("type "));
  const names = exposed.filter((name) => declared.has(name)).sort();
  if (names.length === 0) {
    throw new Error(`linear-write-seam: derived ZERO HTTP-issuing eve exports from ${EVE_LINEAR_DIR} — §2 would then match nothing and pass over every offender.`);
  }
  return names;
}

const EVE_TRANSPORT_NAMES = eveTransportNames();
const EVE_TRANSPORT = new RegExp(`\\b(?:${EVE_TRANSPORT_NAMES.join("|")})\\b`);
const CHANNEL_CONFIG = /linearChannel\(\s*\{/g;
const CHANNEL_CONFIG_WITH_API = /linearChannel\(\s*\{[^}]*?\bapi:\s*linearChannelApi\(/gs;
const CHANNEL_CONFIG_INDIRECT = /linearChannel\((?!\s*\{)/g;

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

  ok(EVE_TRANSPORT_NAMES.includes("callLinearGraphQL"), `§0 the derived eve-transport inventory names the query transport the seam wraps (derived: ${EVE_TRANSPORT_NAMES.join(", ")})`);
  ok(EVE_TRANSPORT_NAMES.includes("createLinearAgentActivity"), "§0 …and the Agent-Activity transport the mention route's terminal answer rides");
  ok(!EVE_TRANSPORT_NAMES.includes("LinearApiError"), "🔴 §0 …and NOT eve's error class — it issues no request, and matching it would flag `catch (e) { if (e instanceof LinearApiError) }` in every honest file");
  for (const name of EVE_TRANSPORT_NAMES) {
    ok(EVE_TRANSPORT.test(stripComments(`import { ${name} } from "eve/channels/linear";`)), `§0 the eve-transport matcher DOES match a direct import of eve's \`${name}\``);
    ok(EVE_TRANSPORT.test(stripComments(`await ${name}({});`)), `§0 …and a direct call to it`);
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
  eq("const c = linearChannel( { api: linearChannelApi(), credentials: x });".match(CHANNEL_CONFIG_WITH_API)?.length, 1, "§0 …and whitespace before the literal does not hide a wired config");

  const indirectConfig = "const cfg = { credentials: x };\nconst c = linearChannel(cfg);";
  eq(indirectConfig.match(CHANNEL_CONFIG)?.length, undefined, "🔴 §0 the literal matcher genuinely CANNOT see an indirect config — this is the hole, stated");
  eq(indirectConfig.match(CHANNEL_CONFIG_INDIRECT)?.length, 1, "🔴 §0 …and the indirect matcher DOES see it, which is what closes the hole");
  eq("const c = linearChannel({ api: linearChannelApi() });".match(CHANNEL_CONFIG_INDIRECT)?.length, undefined, "🔴 §0 NEGATIVE CONTROL: an inline literal is NOT an indirect config — otherwise §4 would red on every honest call site");
  eq("const c = linearChannel(  { api: linearChannelApi() });".match(CHANNEL_CONFIG_INDIRECT)?.length, undefined, "§0 …with whitespace either");
  eq("const c = linearChannel(buildConfig(org));".match(CHANNEL_CONFIG_INDIRECT)?.length, 1, "§0 …and a config returned by a call is indirect too");
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
    `🔴 §2 only \`${SEAM_REL}\` may name eve's Linear transport — a file naming any of eve's HTTP-issuing \`eve/channels/linear\` exports directly has NO 429 backoff, and one this package never calls would make its request from inside eve where no other section can see it. Route it through \`callLinear\` / \`createLinearActivity\`, or widen the seam. Watched (derived from eve): ${EVE_TRANSPORT_NAMES.join(", ")}. Found ${offenders.length}: ${offenders.join(", ")}`,
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
  const indirect: string[] = [];
  for (const file of AGENT_FILES) {
    if ((stripComments(readFileSync(file, "utf8")).match(CHANNEL_CONFIG_INDIRECT)?.length ?? 0) > 0) indirect.push(relative(PKG_ROOT, file));
  }
  eq(
    indirect,
    [],
    `🔴 §4 every \`linearChannel(…)\` call must pass its config as an INLINE object literal — this gate reads the \`api:\` out of the literal and can read nothing else, so a config built elsewhere and passed by name would carry no 429 backoff with every assertion here still green. Found ${indirect.length}: ${indirect.join(", ")}`,
  );

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
