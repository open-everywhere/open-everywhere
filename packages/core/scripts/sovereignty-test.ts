import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  postgresHostFacts,
  renderSovereigntyReport,
  SOVEREIGNTY_PIECES,
  sovereigntyReport,
  type SovereigntyInput,
  type SovereigntyRow,
  type SovereigntySettings,
} from "../agent/ops/sovereignty.js";
import { appEnv, declaredSubagentModels, eveScriptTelemetry, gatherSovereigntyInput, namesWorkflowWorld, originRemoteHost, registersBareModelRoutes } from "../agent/ops/sovereignty-facts.js";
import { telemetrySwitches } from "../agent/observability/telemetry.js";
import { getSettings } from "../agent/settings/settings.js";
import { buildOpsServer, OPS_TOOL_NAMES } from "../agent/ops/server.js";
import { runSovereigntyCommand } from "./oe-sovereignty.js";
import { pinSuiteStore } from "./_suite-store.js";

pinSuiteStore("sovereignty");

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

const REPO = join(import.meta.dirname, "..", "..", "..");
const SECRET_PASSWORD = "s3cr3t-pa55word-zz";
const NEON_URL = `postgres://owner:${SECRET_PASSWORD}@ep-quiet-lab-123456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require`;

const SHIPPED: SovereigntySettings = {
  models: { stack: "american-closed", primary: "", force: "", dataPolicy: {}, targets: { gateway: { kind: "vercel-ai-gateway" } } },
  auditExport: { targets: [] },
  egress: { enforce: true, allowUnenforced: false },
  sandbox: { region: "" },
  memory: { provider: "" },
  observability: { logShip: { url: "" } },
  telemetry: { enabled: true, url: "" },
};

function report(over: Partial<SovereigntyInput> & { env?: NodeJS.ProcessEnv; settings?: SovereigntySettings }) {
  return sovereigntyReport({ env: {}, settings: SHIPPED, ...over });
}
function row(r: ReturnType<typeof sovereigntyReport>, piece: string): SovereigntyRow {
  const found = r.rows.find((x) => x.piece === piece);
  assert.ok(found, `row ${piece} exists`);
  return found;
}

{
  const r = report({ host: "vercel", env: { DATABASE_URL: NEON_URL } });
  ok("every piece of the ticket's map has one row, in order", JSON.stringify(r.rows.map((x) => x.piece)) === JSON.stringify(SOVEREIGNTY_PIECES));
  ok("every row answers all four questions", r.rows.every((x) => x.where && x.region && x.compellable && x.control));
  ok("a limits list is always printed", r.limits.length >= 4);
}

{
  const r = report({ host: "vercel", env: { DATABASE_URL: NEON_URL } });
  const text = JSON.stringify(r) + renderSovereigntyReport(r);
  ok("the DATABASE_URL password never reaches the report", !text.includes(SECRET_PASSWORD));
  ok("the DATABASE_URL host never reaches the report", !text.includes("ep-quiet-lab") && !text.includes("neon.tech"));
  ok("the DATABASE_URL user never reaches the report", !text.includes("owner:"));
  ok("a Neon host names Neon and its region", row(r, "memory").compellable.startsWith("Neon (US)") && row(r, "memory").region === "aws eu-central-1");
  ok("the audit row reads the same store and region", row(r, "audit").region === "aws eu-central-1" && row(r, "audit").where.includes("Postgres at DATABASE_URL"));
}

{
  ok("an RDS host names AWS and its region", postgresHostFacts("postgres://u:p@db1.abc.eu-west-1.rds.amazonaws.com:5432/x").region === "aws eu-west-1");
  ok("a Supabase pooler names its region", postgresHostFacts("postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/x").region === "aws eu-central-1");
  ok("a compose service name is a Postgres you run", postgresHostFacts("postgres://u:p@db:5432/x").operator.startsWith("a Postgres you run"));
  ok("localhost is a Postgres you run", postgresHostFacts("postgres://u:p@localhost/x").operator.startsWith("a Postgres you run"));
  const unknown = postgresHostFacts("postgres://u:p@pg.internal.example.org/x");
  ok("an unrecognised host is unknown, and not named", unknown.region.startsWith("unknown") && !JSON.stringify(unknown).includes("example.org"));
  ok("a value that does not parse is unknown", postgresHostFacts("not a url").region === "unknown");
}

{
  const r = report({ host: "docker", env: {} });
  ok("no DATABASE_URL: the operational store is the PGlite floor", row(r, "audit").where.includes("PGlite"));
  ok("no DATABASE_URL: memory is the git floor", row(r, "memory").where.includes(".open-everywhere-memory"));
  ok("self-hosted: the floor's holder is you", row(r, "memory").compellable.startsWith("you"));
  const pinned = report({ host: "docker", env: { DATABASE_URL: NEON_URL }, settings: { ...SHIPPED, memory: { provider: "notion" } } });
  const custom = report({ host: "docker", env: { DATABASE_URL: NEON_URL, OE_OPERATIONAL_PROVIDER: "acme-store" } });
  ok("🔴 a custom operational provider never borrows the DATABASE_URL region", !row(custom, "audit").region.includes("eu-central-1") && row(custom, "audit").region.includes('"acme-store" provider'));
  const vCustom = report({ host: "vercel", env: { OE_OPERATIONAL_PROVIDER: "acme-store" } });
  ok("🔴 on Vercel a custom store's credentials row names no DATABASE_URL", !row(vCustom, "credentials").compellable.includes("DATABASE_URL"));
  ok("…and a floor's names the function disk", row(report({ host: "vercel" }), "credentials").compellable.includes("function disk"));
  ok("memory.provider wins over DATABASE_URL, as at runtime", row(pinned, "memory").compellable === "Notion Labs (US)");
  const stale = report({ host: "docker", env: { DATABASE_URL: NEON_URL, OE_MEMORY_PROVIDER: "notion" } });
  ok("🔴 a stale OE_MEMORY_PROVIDER moves nothing: DATABASE_URL still selects postgres", row(stale, "memory").where === "Postgres at DATABASE_URL");
}

{
  const v = report({ host: "vercel" });
  const d = report({ host: "docker" });
  ok("on Vercel, transcripts live in Vercel Workflow", row(v, "transcripts").where.includes("Vercel Workflow") && row(v, "transcripts").compellable === "Vercel Inc. (US)");
  ok("self-hosted, transcripts live in .eve/.workflow-data", row(d, "transcripts").where.includes(".eve/.workflow-data"));
  ok("tool-call logs ride the same event stream", row(d, "tool-call logs").where.includes(".eve/.workflow-data"));
  const u = report({});
  ok("no host signal: the host is unknown and says how to set it", u.host === "unknown" && u.hostSource.includes("--host"));
  ok("an unknown host prints both answers", row(u, "transcripts").where.includes("on Vercel:") && row(u, "transcripts").where.includes("self-hosted:"));
  ok("VERCEL=1 detects Vercel", report({ env: { VERCEL: "1" } }).host === "vercel");
  ok("a linked .vercel/project.json detects Vercel", report({ vercelLinked: true }).hostSource === ".vercel/project.json");
  ok("--host wins over the detection", report({ host: "docker", env: { VERCEL: "1" } }).host === "docker");
  ok("sandbox.region is printed on Vercel", row(report({ host: "vercel", settings: { ...SHIPPED, sandbox: { region: "fra1" } } }), "compute").region.includes("sandbox: fra1 (sandbox.region)"));
  ok("🔴 vercel.json regions never become the Vercel Workflow region", !row(report({ host: "vercel", vercelRegions: ["fra1"] }), "transcripts").region.includes("fra1"));
  ok("vercel.json regions are printed", row(report({ host: "vercel", vercelRegions: ["fra1"] }), "compute").region.startsWith("functions: fra1 (vercel.json regions)"));
}

{
  const key = "k".repeat(44);
  const r = report({ host: "vercel", env: { DATABASE_URL: NEON_URL, OE_CREDENTIAL_ENCRYPTION_KEY: key } });
  ok("the credential key is reported set", row(r, "credentials").control.endsWith("is set"));
  ok("the credential key value never reaches the report", !JSON.stringify(r).includes(key));
  ok("on Vercel the report says Vercel holds both the key and the DSN", row(r, "credentials").compellable.includes("Vercel alone can reach both"));
  ok("an unset key is reported NOT set", row(report({}), "credentials").control.endsWith("NOT set"));
}

{
  const tele = (t: { enabled?: boolean; url?: string }, env: NodeJS.ProcessEnv = {}) =>
    report({ env, settings: { ...SHIPPED, telemetry: { ...SHIPPED.telemetry, ...t } } });
  ok("telemetry ships to the default collector by default", row(report({}), "telemetry").where.includes("oe-telemetry.vercel.app"));
  ok("telemetry.enabled: false sends nothing", row(tele({ enabled: false }), "telemetry").where.startsWith("nowhere"));
  ok("DO_NOT_TRACK=1 sends nothing", row(report({ env: { DO_NOT_TRACK: "1" } }), "telemetry").compellable.startsWith("nobody"));
  ok("🔴 a stale OE_TELEMETRY=off is not reported as off", row(report({ env: { OE_TELEMETRY: "off" } }), "telemetry").where.includes("oe-telemetry.vercel.app"));
  ok("🔴 a stale OE_TELEMETRY_OTLP_URL is not reported as a redirect", !row(report({ env: { OE_TELEMETRY_OTLP_URL: "https://x.example/v1/logs" } }), "telemetry").where.includes("x.example"));
  const unparsed = tele({ url: "otel.acme.example/v1/logs?token=abc123" });
  ok("🔴 a redirect that does not parse never prints the raw value", !JSON.stringify(unparsed).includes("abc123") && row(unparsed, "telemetry").where.includes("does not parse"));
  const emptyHost = tele({ url: "localhost:4318/v1/logs?token=abc123" });
  ok("🔴 a redirect with an empty hostname never prints the raw value", !JSON.stringify(emptyHost).includes("abc123"));
  const redirected = tele({ url: "https://otel.acme.example/v1/logs?token=abc123" });
  ok("a redirect names the collector's host", row(redirected, "telemetry").where === "your collector at otel.acme.example");
  ok("a redirect never prints the URL's path or query", !JSON.stringify(redirected).includes("abc123"));
  ok("telemetry.enabled: false beats a redirect", row(tele({ enabled: false, url: "https://x.example/v1/logs" }), "telemetry").where.startsWith("nowhere"));
}

{
  ok("the default gateway is the Vercel AI Gateway", row(report({}), "gateway").compellable === "Vercel Inc. (US)");
  const withUrl = (url: string) => report({ settings: { ...SHIPPED, models: { ...SHIPPED.models, targets: { gateway: { kind: "vercel-ai-gateway", url } } } } });
  const own = withUrl("https://llm.acme.example/v4/ai?key=zzz");
  const badGw = withUrl("llm.acme.example/v4?key=zzz");
  ok("a set models.targets.gateway.url that does not parse is never reported as the Vercel default", row(badGw, "gateway").where.includes("does not parse") && row(badGw, "gateway").compellable !== "Vercel Inc. (US)");
  ok("…and never prints its value", !JSON.stringify(badGw).includes("zzz"));
  const staleEnv = report({ env: { OE_AI_GATEWAY_URL: "https://old.acme.example" } });
  ok("🔴 the deleted OE_AI_GATEWAY_URL is not reported as a gateway", row(staleEnv, "gateway").compellable === "Vercel Inc. (US)" && !row(staleEnv, "gateway").where.includes("old.acme.example"));
  const only = report({
    settings: { ...SHIPPED, models: { ...SHIPPED.models, targets: { gateway: { kind: "vercel-ai-gateway", providers: { only: ["azure", "bedrock"] } } } } },
  });
  ok("🔴 providers.only narrows who serves the model route", row(only, "model route").compellable.startsWith("only azure, bedrock"));
  const mixed = report({
    settings: {
      ...SHIPPED,
      models: { ...SHIPPED.models, targets: { gateway: { kind: "vercel-ai-gateway", providers: { only: ["azure"] } }, relay: { kind: "vercel-ai-gateway" } } },
    },
  });
  ok("🔴 providers.only on one target of two does not narrow the model route", row(mixed, "model route").compellable.startsWith("the upstream provider"));
  const two = report({
    settings: {
      ...SHIPPED,
      models: { ...SHIPPED.models, targets: { gateway: { kind: "vercel-ai-gateway", url: "https://old.acme.example" }, relay: { kind: "vercel-ai-gateway" } } },
    },
  });
  ok(
    "🔴 one target's url retargets only that target",
    row(two, "gateway").where.includes("gateway: your gateway at old.acme.example") && row(two, "gateway").where.includes("relay: the Vercel AI Gateway"),
  );
  ok("…and both operators are compellable", row(two, "gateway").compellable.includes("Vercel Inc. (US)") && row(two, "gateway").compellable.includes("the operator of old.acme.example"));
  ok("no providers.only: the gateway's allowlist decides", row(report({}), "model route").compellable.startsWith("the upstream provider"));
  ok("models.targets.gateway.url names the operator's gateway by host", row(own, "gateway").where.includes("llm.acme.example") && !JSON.stringify(own).includes("zzz"));
  const eu = report({ settings: { ...SHIPPED, models: { ...SHIPPED.models, dataPolicy: { zeroRetention: true, region: "eu" } } } });
  ok("models.dataPolicy.region pins the model route's region", row(eu, "model route").region.startsWith("EU only"));
  ok("the data policy is named in words", row(eu, "model route").where.includes("zero retention, region EU"));
  ok("no region row: the route is not pinned", row(report({}), "model route").region.startsWith("not pinned"));
  const roles = report({ stackRoles: { primary: "vendor/model-a", judge: "vendor/model-b" } });
  ok("the stack's role ids are printed", row(roles, "model route").where.includes("primary vendor/model-a"));
  const forced = report({ settings: { ...SHIPPED, models: { ...SHIPPED.models, force: "vendor/pinned" } } });
  ok("models.force is named as an override", row(forced, "model route").where.includes("models.force vendor/pinned"));
  const bare = report({
    bareDefaultVia: "mistral",
    bareModels: [
      { where: "subagent review", id: "vendor/model-a", via: "mistral", source: "role" },
      { where: "subagent extra", id: "vendor/other", via: "mistral", source: "default" },
    ],
  });
  const bareWhere = row(bare, "model route").where;
  ok("a role-named subagent is named with its role's target", bareWhere.includes("subagent review via mistral") && !bareWhere.includes("review vendor/model-a"));
  ok("a subagent whose model no role names is flagged", bareWhere.includes("subagent extra vendor/other via mistral (no role names this model)"));
  ok("any other bare id takes the primary role's target", bareWhere.includes("any other via mistral, the primary role's target"));
  ok("no bare facts: the row says nothing about bare ids", !row(report({}), "model route").where.includes("bare model ids"));
  const unloaded = report({ bareDefaultVia: "gateway", bareModels: [{ where: "subagent broken", id: undefined }] });
  ok("a subagent whose module did not load is named as unknown", row(unloaded, "model route").where.includes("subagent broken model unknown (its module did not load)"));
}

{
  const app = mkdtempSync(join(tmpdir(), "oe-sov-subagents-"));
  mkdirSync(join(app, "agent", "subagents", "good"), { recursive: true });
  mkdirSync(join(app, "agent", "subagents", "broken"), { recursive: true });
  writeFileSync(join(app, "agent", "subagents", "good", "agent.ts"), `export default { model: "vendor/model-a" };\n`);
  writeFileSync(join(app, "agent", "subagents", "broken", "agent.ts"), `throw new Error("this subagent does not load");\n`);
  const found = await declaredSubagentModels(app);
  ok(
    `declared subagents: the broken one stays in the list with an unknown model — got ${JSON.stringify(found)}`,
    found?.length === 2 && found[0]!.where === "subagent broken" && found[0]!.id === undefined && found[1]!.where === "subagent good" && found[1]!.id === "vendor/model-a",
  );
}

{
  const app = mkdtempSync(join(tmpdir(), "oe-sov-order-"));
  mkdirSync(join(app, "agent", "model"), { recursive: true });
  mkdirSync(join(app, "agent", "subagents", "helper"), { recursive: true });
  writeFileSync(
    join(app, "agent", "model", "stacks.ts"),
    `export function resolveStack() { return { utility: { id: "x/u" }, primary: { id: "x/p", via: "mistral" } }; }\n`,
  );
  writeFileSync(join(app, "agent", "subagents", "helper", "agent.ts"), `export default { model: "x/other" };\n`);
  const facts = await gatherSovereigntyInput(app, {});
  ok(`stack order: the default target is the primary's — got ${facts.bareDefaultVia}`, facts.bareDefaultVia === "mistral");
  ok(
    `stack order: a subagent no role names goes via the primary's target — got ${JSON.stringify(facts.bareModels)}`,
    JSON.stringify(facts.bareModels) === JSON.stringify([{ where: "subagent helper", id: "x/other", via: "mistral", source: "default" }]),
  );
}

{
  const app = mkdtempSync(join(tmpdir(), "oe-sov-unregistered-"));
  mkdirSync(join(app, "agent", "model"), { recursive: true });
  mkdirSync(join(app, "agent", "subagents", "helper"), { recursive: true });
  writeFileSync(join(app, "agent", "model", "stacks.ts"), `export function resolveStack() { return { primary: { id: "x/p", via: "mistral" } }; }\n`);
  writeFileSync(join(app, "agent", "subagents", "helper", "agent.ts"), `export default { model: "x/p" };\n`);
  writeFileSync(join(app, "agent", "model", "models.ts"), `export const MODELS = {};\n`);
  const facts = await gatherSovereigntyInput(app, {});
  ok(
    `unregistered: every bare id is reported via gateway — got ${facts.bareDefaultVia} ${JSON.stringify(facts.bareModels)}`,
    facts.bareRoutesRegistered === false && facts.bareDefaultVia === "gateway" && facts.bareModels?.[0]?.id === "x/p" && (facts.bareModels[0] as { via: string }).via === "gateway",
  );
  const words = row(report({ bareDefaultVia: facts.bareDefaultVia, bareModels: facts.bareModels, bareRoutesRegistered: facts.bareRoutesRegistered }), "model route").where;
  ok(`unregistered: the row names the missing call — got ${words}`, words.includes("all via gateway, because agent/model/models.ts does not call registerBareModelRoutes") && !words.includes("via mistral"));
  writeFileSync(join(app, "agent", "model", "models.ts"), `registerBareModelRoutes(Object.values(MODELS));\n`);
  const reg = await gatherSovereigntyInput(app, {});
  ok(`registered: the bare id takes its role's target — got ${JSON.stringify(reg.bareModels)}`, reg.bareRoutesRegistered === true && reg.bareDefaultVia === "mistral" && (reg.bareModels?.[0] as { via: string }).via === "mistral");
  ok("registersBareModelRoutes ignores a line comment that holds the call", !registersBareModelRoutes("// registerBareModelRoutes(Object.values(MODELS));\n"));
  ok("registersBareModelRoutes ignores a block comment that holds the call", !registersBareModelRoutes("/* registerBareModelRoutes(Object.values(MODELS)); */\n"));
  ok("registersBareModelRoutes reads a call after a URL in a string", registersBareModelRoutes('const u = "https://x.example"; registerBareModelRoutes(Object.values(MODELS));\n'));
  const missing = mkdtempSync(join(tmpdir(), "oe-sov-nomodels-"));
  mkdirSync(join(missing, "agent", "model"), { recursive: true });
  writeFileSync(join(missing, "agent", "model", "stacks.ts"), `export function resolveStack() { return { primary: { id: "x/p", via: "mistral" } }; }\n`);
  const nm = await gatherSovereigntyInput(missing, {});
  const nmWords = row(report({ bareDefaultVia: nm.bareDefaultVia, bareModels: nm.bareModels, bareRoutesRegistered: nm.bareRoutesRegistered }), "model route").where;
  ok(`no models.ts: the bare-id target is unknown — got ${nm.bareRoutesRegistered} ${nmWords}`, nm.bareRoutesRegistered === "unknown" && nmWords.includes("target unknown, because agent/model/models.ts did not read") && !nmWords.includes("via mistral"));
}

{
  const sinks = report({ settings: { ...SHIPPED, auditExport: { targets: [{ name: "splunk", format: "splunk-hec", url: "https://hec.acme.example:8088/services/collector?x=1" }] } } });
  ok("an audit export target is named with its host", row(sinks, "audit").where.includes("splunk (splunk-hec, hec.acme.example)"));
  ok("chat platforms name their operators", row(report({ chatPlatforms: ["slack", "teams"] }), "chat surface").compellable === "Slack (Salesforce, US); Microsoft (US)");
  ok("a github.com remote names GitHub", row(report({ configRemoteHost: "github.com" }), "config").compellable === "GitHub (Microsoft, US)");
  const ship = (url: string) => report({ settings: { ...SHIPPED, observability: { logShip: { url } } } });
  ok("a set observability.logShip.url that does not parse still says logs are shipped", row(ship("in.logs.example/x?t=1"), "runtime logs").where.includes("does not parse"));
  ok("no observability.logShip.url: nothing is shipped", !row(report({}), "runtime logs").where.includes("shipped to"));
  ok("log shipping names its host", row(ship("https://in.logs.example/ingest"), "runtime logs").where.includes("in.logs.example"));
  ok("🔴 a stale OE_LOG_SHIP_URL ships nothing (OPE-2650)", !row(report({ env: { OE_LOG_SHIP_URL: "https://in.logs.example/ingest" } }), "runtime logs").where.includes("shipped to"));
  const dry = report({ settings: { ...SHIPPED, egress: { enforce: false, allowUnenforced: false } } });
  ok("egress dry-run is named on the row and in the limits", row(dry, "other outbound calls").where.includes("DRY-RUN") && dry.limits.some((l) => l.includes("not enforced")));
  ok("originRemoteHost reads an scp-style remote", originRemoteHost('[remote "origin"]\n\turl = git@github.com:acme/app.git\n') === "github.com");
  ok("originRemoteHost reads an https remote, host only", originRemoteHost('[core]\n[remote "origin"]\n\turl = https://tok@gitlab.example/acme/app.git\n') === "gitlab.example");
  ok("originRemoteHost: no origin, no host", originRemoteHost('[remote "upstream"]\n\turl = git@github.com:a/b.git\n') === undefined);
}

{
  const open = report({
    transcription: [
      { slot: "primary", via: "deepinfra", id: "Qwen/Qwen3-ASR-1.7B", host: "api.deepinfra.com" },
      { slot: "fallback", via: "self-hosted", id: "Qwen/Qwen3-ASR-1.7B", host: "qwen3-asr" },
    ],
  });
  const t = row(open, "transcription");
  ok("a deepinfra route is named DIRECT to its host", t.where.includes("DIRECT to api.deepinfra.com (via deepinfra)"));
  ok("…and DeepInfra is named as compellable", t.compellable.includes("DeepInfra (US)") && t.compellable.includes("the operator of qwen3-asr"));
  ok("…and the data policy is said not to reach it", t.region.includes("does not reach"));
  const gw = row(report({ transcription: [{ slot: "primary", via: "gateway", id: "vendor/stt" }] }), "transcription");
  const policed = report({
    settings: { ...SHIPPED, models: { ...SHIPPED.models, dataPolicy: { noTraining: true } } },
    transcription: [{ slot: "primary", via: "deepinfra", id: "Qwen/Qwen3-ASR-1.7B", host: "api.deepinfra.com" }],
  });
  ok("🔴 under a data policy the deepinfra route is reported REFUSED", row(policed, "transcription").where.includes("REFUSED by models.dataPolicy"));
  ok("…and DeepInfra is not compellable", !row(policed, "transcription").compellable.includes("DeepInfra") && row(policed, "transcription").region.startsWith("none"));
  ok("no stacks module: the transcription region is unknown too", row(report({}), "transcription").region === "unknown");
  ok("a gateway route rides the gateway", gw.where.includes("through the gateway") && !gw.compellable.includes("DeepInfra"));
  ok("no stacks module: transcription is unknown", row(report({}), "transcription").where.startsWith("unknown"));
}

{
  ok("an eve script without the switch reports eve telemetry ON", row(report({ eveScripts: { disabled: ["dev"], enabled: ["build"] } }), "other outbound calls").where.includes("eve CLI telemetry is ON in the scripts build"));
  ok("every eve script with the switch reports OFF", row(report({ eveScripts: { disabled: ["dev", "build"], enabled: [] } }), "other outbound calls").where.includes("eve CLI telemetry is OFF"));
  ok("no package.json read: eve telemetry is unknown", row(report({}), "other outbound calls").where.includes("eve CLI telemetry: unknown"));
  const split = eveScriptTelemetry(JSON.stringify({ scripts: { dev: "EVE_TELEMETRY_DISABLED=1 eve dev", build: "eve build", lint: "tsc", seed: "tsx seed-eve.ts" } }));
  ok("eveScriptTelemetry splits the scripts that start eve", JSON.stringify(split) === JSON.stringify({ disabled: ["dev"], enabled: ["build"] }));
  const scoped = eveScriptTelemetry(
    JSON.stringify({ scripts: { gen: "EVE_TELEMETRY_DISABLED=1 tsx gen.ts && eve build", mid: "EVE_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=6144 eve build", npx: "EVE_TELEMETRY_DISABLED=1 npx eve start" } }),
  );
  ok("🔴 a switch scoped to another command does not count for eve", scoped?.enabled.includes("gen") === true);
  ok("…another assignment between the switch and eve still counts", scoped?.disabled.includes("mid") === true && scoped?.disabled.includes("npx") === true);
  const forms = eveScriptTelemetry(
    JSON.stringify({
      scripts: {
        start: "cross-env NODE_ENV=production eve start",
        a: "npx -y eve info",
        b: "eve",
        d: "dotenv -- eve dev",
        e: "./node_modules/.bin/eve build",
        f: "(eve build)",
        g: "npx eve@0.71.0 dev",
        h: "dotenv -e .env.local -- eve dev",
        i: "dotenv -e .env.local eve dev",
        j: "EVE_TELEMETRY_DISABLED=1 tsx x.ts && dotenv -e .env -- eve dev",
        k: "npx -p foo eve dev",
        l: "node -r dotenv/config node_modules/eve/bin/eve.js dev",
        m: "env -u X eve dev",
        n: "dotenv --weird-flag value eve dev",
        q: "npx -c 'eve dev'",
        r: 'dotenv -e .env -- sh -c "eve dev"',
        s: 'concurrently "eve dev" "tsx watch w.ts"',
        t: "pnpm exec eve dev",
        u: "bunx eve dev",
        c: "cross-env EVE_TELEMETRY_DISABLED=1 eve dev",
        o: "EVE_TELEMETRY_DISABLED=1 dotenv -e .env -- eve dev",
        p: "dotenv -v EVE_TELEMETRY_DISABLED=1 -- eve dev",
      },
    }),
  );
  ok("🔴 every launcher form that starts eve without the switch is ON", ["start", "a", "b", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "q", "r", "s", "t", "u"].every((k) => forms?.enabled.includes(k)));
  ok("…and a launcher with the switch in eve's own prefix is OFF", JSON.stringify(forms?.disabled) === '["c","o","p"]');
  ok("namesWorkflowWorld reads an experimental.workflow.world", namesWorkflowWorld("experimental: { workflow: { world: postgresWorld() } }"));
  ok("namesWorkflowWorld: no world named", !namesWorkflowWorld("export default defineAgent({ model })"));
  const custom = report({ host: "docker", customWorkflowWorld: true });
  ok("a named workflow world replaces the local-disk answer", !row(custom, "transcripts").where.includes(".eve/.workflow-data") && row(custom, "transcripts").compellable.includes("that world's store"));
  ok("…on the tool-call logs and run state too", !row(custom, "tool-call logs").where.includes(".eve/") && !row(custom, "run state").where.includes(".eve/"));
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t: string) => out.push(t), err: (l: string) => err.push(l) } };
};
const ENV = { DATABASE_URL: NEON_URL, DO_NOT_TRACK: "1" };

{
  const c = io();
  const code = await runSovereigntyCommand(["--host", "docker"], c.io, REPO, ENV);
  const text = c.out.join("");
  ok("oe sovereignty exits 0 on this app", code === 0);
  ok("oe sovereignty prints every piece", SOVEREIGNTY_PIECES.every((p) => text.includes(`■ ${p}\n`)));
  ok("oe sovereignty reads the app's own settings (its stack)", text.includes('stack "american-closed"'));
  ok("oe sovereignty reads the app's stacks file (a role id)", /primary [a-z0-9-]+\/[a-z0-9.-]+/u.test(text));
  ok("oe sovereignty reads the roster (slack is selected)", text.includes("Slack (Salesforce, US)"));
  const expectOff = !telemetrySwitches(getSettings().telemetry, appEnv(REPO, ENV)).enabled;
  ok("oe sovereignty honours the env it reads", text.includes("nowhere: telemetry is OFF") === expectOff);
  ok("oe sovereignty reads the app's transcription role", text.includes("■ transcription\n  where:       primary "));
  ok("oe sovereignty reads the app's declared subagent and its target (OPE-2566)", text.includes("subagent fresh_eyes_review via gateway") && text.includes("any other via gateway"));
  ok("oe sovereignty reads the app's eve scripts", text.includes("eve CLI telemetry is OFF in every script"));
  ok("oe sovereignty never prints the DSN", !text.includes(SECRET_PASSWORD) && !text.includes("ep-quiet-lab"));
  const j = io();
  ok("--json exits 0", (await runSovereigntyCommand(["--json", "--host=vercel"], j.io, REPO, ENV)) === 0);
  const parsed = JSON.parse(j.out.join("")) as { host: string; rows: SovereigntyRow[] };
  ok("--json is the report object", parsed.host === "vercel" && parsed.rows.length === SOVEREIGNTY_PIECES.length);
  const bad = io();
  ok("a bad --host exits 2", (await runSovereigntyCommand(["--host", "mars"], bad.io, REPO, ENV)) === 2 && bad.err[0]!.includes("vercel or docker"));
  ok("an unknown flag exits 2", (await runSovereigntyCommand(["--verbose"], io().io, REPO, ENV)) === 2);
}

const broken = mkdtempSync(join(tmpdir(), "oe-sovereignty-"));
mkdirSync(join(broken, "agent", "settings"), { recursive: true });
writeFileSync(join(broken, "package.json"), '{ "name": "fixture", "type": "module" }\n');
writeFileSync(join(broken, "agent", "agent.ts"), "export {};\n");
writeFileSync(join(broken, "agent", "settings", "settings.ts"), 'throw new Error("models.stack: must be a non-empty stack alias");\n');
{
  const c = io();
  const code = await runSovereigntyCommand([], c.io, broken, {});
  ok("a settings file that throws exits 1", code === 1);
  ok("…and prints nothing to stdout", c.out.length === 0);
  ok("…and names the problem", c.err.join("\n").includes("must be a non-empty stack alias"));
  ok("no app at all exits 1", (await runSovereigntyCommand([], io().io, tmpdir(), {})) === 1);
}

{
  const stdout = execFileSync(process.execPath, ["--import", "tsx", join(REPO, "packages", "core", "scripts", "oe-cli.ts"), "sovereignty", "--json", "--host", "docker"], {
    cwd: REPO,
    env: { ...process.env, ...ENV, OE_APP_ROOT: "" },
    encoding: "utf8",
  });
  ok("`oe sovereignty --json` through the dispatcher prints the report", (JSON.parse(stdout) as { host: string }).host === "docker");
}

{
  ok("sovereignty is a declared ops tool", (OPS_TOOL_NAMES as readonly string[]).includes("sovereignty"));
  const outerProject = process.env.CLAUDE_PROJECT_DIR;
  const AMBIENT = ["DATABASE_URL", "OE_OPERATIONAL_PROVIDER"] as const;
  const outerAmbient = Object.fromEntries(AMBIENT.map((k) => [k, process.env[k]]));
  const call = async (projectDir: string, args: Record<string, unknown>) => {
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    const server = buildOpsServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "sovereignty-test", version: "0" });
    await client.connect(ct);
    const res = await client.callTool({ name: "sovereignty", arguments: args });
    await client.close();
    return { isError: res.isError === true, body: JSON.parse((res.content as { text: string }[])[0]!.text) as Record<string, unknown> };
  };
  const fixtureEnv = join(broken, "fixture.env");
  writeFileSync(fixtureEnv, `DATABASE_URL=${NEON_URL}\n`);
  try {
    for (const k of AMBIENT) delete process.env[k];
    const res = await call(REPO, { host: "vercel", envPath: fixtureEnv });
    const rows = res.body.rows as SovereigntyRow[];
    ok("the ops tool answers ok on this app", !res.isError && res.body.ok === true);
    ok("the ops tool prints the same pieces as the CLI", JSON.stringify(rows.map((r) => r.piece)) === JSON.stringify(SOVEREIGNTY_PIECES));
    ok("the ops tool reads the env (a Neon region)", rows.find((r) => r.piece === "memory")!.region === "aws eu-central-1");
    ok("the ops tool never returns the DSN", !JSON.stringify(res.body).includes(SECRET_PASSWORD));
    const refused = await call(broken, {});
    ok("the ops tool fails closed on a settings file that throws", refused.isError && refused.body.ok === false && String(refused.body.note).includes("did not load"));
  } finally {
    if (outerProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = outerProject;
    for (const k of AMBIENT) {
      if (outerAmbient[k] === undefined) delete process.env[k];
      else process.env[k] = outerAmbient[k];
    }
  }
}

console.log(`✓ sovereignty: ${n} checks passed`);
process.exit(0);

// proves: OPS-sovereignty
