import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const AGENT_DIR = join(ROOT, "agent");

const scratch = mkdtempSync(join(tmpdir(), "oe-boot-smoke-"));
process.env.OE_PGLITE_DIR = join(scratch, "pglite");
process.env.OE_MEMORY_DIR = join(scratch, "memory");
delete process.env.DATABASE_URL;

const problems: string[] = [];

const { routinePermissionCardOffererRegistered } = await import("@open-everywhere/core/agent/approvals/routine-permission-offer.js");
const cardOffererBeforeBoot = routinePermissionCardOffererRegistered();

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) tsFilesUnder(p, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const modules = tsFilesUnder(AGENT_DIR).sort();
if (modules.length === 0) problems.push("found no modules under agent/ — this gate is checking the wrong tree.");

const loaded = new Map<string, Record<string, unknown>>();
for (const file of modules) {
  const rel = relative(ROOT, file).split(sep).join("/");
  try {
    loaded.set(rel, (await import(pathToFileURL(file).href)) as Record<string, unknown>);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    problems.push(`BOOT: ${rel} threw at module load — a hosted function importing it is DEAD at cold start.\n      ${message.split("\n")[0]}`);
  }
}

type Route = { transport?: string; method?: string; path?: string };
const seen = new Map<string, string>();
let routeCount = 0;
for (const [rel, mod] of loaded) {
  if (!rel.startsWith("agent/channels/")) continue;
  const channel = mod.default as { __kind?: string; routes?: Route[] } | undefined;
  if (!channel || channel.__kind !== "eve:channel" || !Array.isArray(channel.routes)) continue;
  for (const route of channel.routes) {
    if (typeof route?.path !== "string") continue;
    routeCount++;
    if (!route.path.startsWith("/")) {
      problems.push(`ROUTE: ${rel} declares a non-absolute path ${JSON.stringify(route.path)} — it will not mount where you think.`);
      continue;
    }
    const key = `${route.transport ?? "http"} ${route.method ?? "GET"} ${route.path}`;
    const owner = seen.get(key);
    if (owner && owner !== rel) {
      problems.push(`ROUTE COLLISION: "${key}" is declared by BOTH ${owner} and ${rel} — one silently shadows the other at runtime.`);
      continue;
    }
    seen.set(key, rel);
  }
}

{
  const agent = loaded.get("agent/agent.ts")?.default as
    | { model?: { kind?: string; events?: Record<string, unknown> } }
    | undefined;
  if (!agent) {
    problems.push("SHAPE: agent/agent.ts exported no default agent definition.");
  } else if (agent.model && typeof agent.model === "object" && agent.model.kind === "eve:dynamic") {
    const events = Object.keys(agent.model.events ?? {});
    if (!events.includes("step.started")) {
      problems.push(
        `MODEL SCOPE: agent/agent.ts binds its dynamic model to [${events.join(", ") || "nothing"}] — it MUST include ` +
          `"step.started". Eve accepts a model INSTANCE only at step scope; at session/turn scope it silently discards ` +
          `the wrapper and runs the static fallback, killing per-domain routing and per-row cost attribution with no error.`,
      );
    }
  }
}

const CRON_FIELD_BOUNDS: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
function cronFieldValid(field: string, [min, max]: [number, number]): boolean {
  return field.split(",").every((part) => {
    if (part.length === 0) return false;
    const [range, step, ...rest] = part.split("/");
    if (rest.length > 0) return false;
    if (step !== undefined && !/^[1-9][0-9]*$/.test(step)) return false;
    if (range === "*") return true;
    const bounds = range.split("-");
    if (bounds.length > 2) return false;
    const numbers = bounds.map((b) => (/^[0-9]+$/.test(b) ? Number(b) : Number.NaN));
    if (numbers.some((n) => Number.isNaN(n) || n < min || n > max)) return false;
    if (numbers.length === 2 && numbers[0] > numbers[1]) return false;
    return true;
  });
}
function cronValid(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, i) => cronFieldValid(field, CRON_FIELD_BOUNDS[i]));
}

let scheduleCount = 0;
for (const [rel, mod] of loaded) {
  const schedule = mod.default as { cron?: unknown } | undefined;
  if (!schedule || typeof schedule !== "object" || typeof schedule.cron !== "string") continue;
  scheduleCount++;
  if (!cronValid(schedule.cron)) {
    problems.push(
      `CRON: ${rel} declares cron ${JSON.stringify(schedule.cron)}, which is not a valid 5-field expression — ` +
        `the schedule will never fire, silently. (If this is the routine dispatcher, the whole triggered plane is dark.)`,
    );
  }
}

{
  const { SCRIPTED_MODEL_VALVE, SCRIPTED_MODEL_ID, scriptedModelArmed } = await import("../agent/model/scripted-model.js");
  const { testValveArmed, __setTestValveForTest } = await import("@open-everywhere/core/agent/testing/test-valves.js");
  const { registerScript } = await import("../agent/model/scripted-model.js");
  const { scriptedModelFor } = await import("../agent/model/scripted-resolve.js");
  if (scriptedModelArmed()) {
    problems.push(
      `SCRIPTED MODEL: the ${SCRIPTED_MODEL_VALVE} test valve is armed in this process — the boot gate must run with it UNSET, ` +
        "or ⑤ asserts nothing. (It is armed only inside the vitest integration forks.)",
    );
  } else {
    if ((await scriptedModelFor(undefined, {})) !== null) {
      problems.push("SCRIPTED MODEL: scriptedModelFor() returned non-null with the valve unarmed — the normal build would consult test scripts.");
    }
    let refused = false;
    try {
      registerScript({ parent: [] });
    } catch {
      refused = true;
    }
    if (!refused) {
      problems.push("SCRIPTED MODEL: registerScript() accepted a script with the valve unarmed — the fail-closed guard is gone.");
    }
    const priorEnv = process.env.OE_SCRIPTED_MODEL;
    process.env.OE_SCRIPTED_MODEL = "1";
    if (scriptedModelArmed() || (await scriptedModelFor(undefined, {})) !== null) {
      problems.push("SCRIPTED MODEL: the retired OE_SCRIPTED_MODEL=1 env var armed the double — a deployment could arm a test seam.");
    }
    if (priorEnv === undefined) delete process.env.OE_SCRIPTED_MODEL;
    else process.env.OE_SCRIPTED_MODEL = priorEnv;
    const priorArm = testValveArmed("scripted-model");
    const priorVercel = process.env.VERCEL;
    try {
      __setTestValveForTest("scripted-model", true);
      process.env.VERCEL = "1";
      let vercelRefused = false;
      try {
        await scriptedModelFor(undefined, {});
      } catch {
        vercelRefused = true;
      }
      if (!vercelRefused) {
        problems.push("SCRIPTED MODEL: scriptedModelFor() did not throw when armed on Vercel — a hosted deployment could answer from a script.");
      }
    } finally {
      __setTestValveForTest("scripted-model", priorArm);
      if (priorVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = priorVercel;
    }
    const agent = loaded.get("agent/agent.ts")?.default as
      | { model?: { events?: Record<string, (event: unknown, ctx: unknown) => unknown> } }
      | undefined;
    const resolver = agent?.model?.events?.["step.started"];
    if (typeof resolver === "function") {
      const selection = (await resolver(undefined, {})) as { model?: { modelId?: unknown } } | null;
      const seated = selection && typeof selection === "object" ? selection.model : undefined;
      if (seated && typeof seated === "object" && seated.modelId === SCRIPTED_MODEL_ID) {
        problems.push(
          `MODEL SEAT: the turn seat resolved to the SCRIPTED double (${SCRIPTED_MODEL_ID}) with the ${SCRIPTED_MODEL_VALVE} valve unarmed — ` +
            "this build would answer wakes from test scripts.",
        );
      }
    }
  }
}

{
  const agent = loaded.get("agent/agent.ts")?.default as
    | {
        model?: { events?: Record<string, (event: unknown, ctx: unknown) => unknown> };
        modelContextWindowTokens?: unknown;
        modelOptions?: unknown;
        compaction?: { modelContextWindowTokens?: unknown };
      }
    | undefined;

  if (agent?.modelContextWindowTokens !== undefined) {
    problems.push(
      "MODEL SELECTION: agent/agent.ts sets an agent-level `modelContextWindowTokens`. With a DYNAMIC " +
        "`model` (defineDynamic) eve 0.33 types that field as `never` — it must ride each resolver return " +
        "as `{ model, modelContextWindowTokens }` instead (agent.ts primaryModelSelection).",
    );
  }
  if (agent?.modelOptions !== undefined) {
    problems.push(
      "MODEL SELECTION: agent/agent.ts sets an agent-level `modelOptions`. With a DYNAMIC `model` eve 0.33 " +
        "types that field as `never` — it must ride each resolver return as `{ model, modelOptions }` instead.",
    );
  }

  const resolver = agent?.model?.events?.["step.started"];
  if (typeof resolver !== "function") {
    problems.push("MODEL SELECTION: agent/agent.ts exposes no step.started model resolver to check.");
  } else {
    const { PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS } = await import("../agent/model/models.js");
    const selection = (await resolver(undefined, {})) as
      | {
          model?: unknown;
          modelContextWindowTokens?: unknown;
          modelOptions?: { providerOptions?: Record<string, unknown> };
        }
      | null
      | undefined;
    if (!selection || typeof selection !== "object" || selection.model === undefined) {
      problems.push(
        "MODEL SELECTION: the step.started resolver did not return a selection object. Every return path must " +
          "be `{ model, modelContextWindowTokens, modelOptions }` — a bare model silently drops the context " +
          "window (eve never backfills it from the fallback) and with it the compaction-threshold rescale.",
      );
    } else {
      if (selection.modelContextWindowTokens !== PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS) {
        problems.push(
          `MODEL SELECTION: the step.started selection carries modelContextWindowTokens=` +
            `${String(selection.modelContextWindowTokens)}, expected the stack's primary window ` +
            `(${PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS}). Compaction fires at a FRACTION of this number, so a wrong ` +
            "or absent value compacts at the wrong point in every long session.",
        );
      }
      if (selection.modelOptions?.providerOptions?.["gateway"] === undefined) {
        problems.push(
          "MODEL SELECTION: the step.started selection carries no `modelOptions.providerOptions.gateway`. Those " +
            "options used to reach the model call via the agent-level `modelOptions`; with that field gone, a " +
            "selection that omits them runs every turn with NO gateway provider options at all.",
        );
      }
    }
  }
}

{
  const eveRoot = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
  const eveAbs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
  const { resolveCompactionModel } = (await import(eveAbs("dist/src/harness/compaction.js"))) as {
    resolveCompactionModel: (input: {
      compactionModelReference?: unknown;
      model: unknown;
      modelReference: unknown;
      resolveModel: (ref: unknown) => Promise<unknown>;
    }) => Promise<{ model: unknown; providerOptions: unknown }>;
  };
  const { isDynamicModelDefinition } = (await import(eveAbs("dist/src/shared/agent-definition.js"))) as {
    isDynamicModelDefinition: (model: unknown) => boolean;
  };

  const agent = loaded.get("agent/agent.ts")?.default as
    | { model?: unknown; compaction?: { model?: unknown; modelContextWindowTokens?: unknown; thresholdPercent?: unknown } }
    | undefined;

  if (!isDynamicModelDefinition(agent?.model)) {
    problems.push(
      "COMPACTION: agent/agent.ts's agent-level `model` is no longer a dynamic definition (eve's own " +
        "isDynamicModelDefinition says no). The OPE-670 argument below assumes it IS dynamic — re-read " +
        "eve's loadSourceBackedRuntimeModelReference before relaxing anything here.",
    );
  }

  if (agent?.compaction?.model !== undefined) {
    problems.push(
      "COMPACTION: agent/agent.ts authors a `compaction.model`. eve 0.38.3 resolves that slot's reference " +
        'through the AGENT-LEVEL `model` field and throws "…to provide a static runtime model" while that ' +
        "field is dynamic — the turn dies after 3 retries on the first compaction of any session (OPE-670). " +
        "Leave the slot without a model: eve then summarises with the live turn model.",
    );
  }
  if (agent?.compaction?.modelContextWindowTokens !== undefined) {
    problems.push(
      "COMPACTION: agent/agent.ts sets `compaction.modelContextWindowTokens`. eve consumes that field ONLY " +
        "as the compaction reference's own window, and there is no compaction reference — so it is inert " +
        "config that implies a compaction model exists.",
    );
  }

  const pct = agent?.compaction?.thresholdPercent;
  if (typeof pct !== "number" || !(pct > 0) || !(pct <= 1)) {
    problems.push(
      `COMPACTION: agent/agent.ts's \`compaction.thresholdPercent\` is ${String(pct)}, expected a fraction in (0, 1]. ` +
        "It is the only thing that decides WHEN compaction fires; eve's own default (0.9) is not this deployment's choice.",
    );
  }

  const liveModel = { marker: "the-live-turn-model" };
  const sessionRef = { id: "gateway/primary", providerOptions: { gateway: { caching: "auto" } } };
  let resolveModelCalls = 0;
  const spyResolve = async (): Promise<unknown> => {
    resolveModelCalls += 1;
    return { marker: "resolved-from-a-reference" };
  };
  const shipped = await resolveCompactionModel({
    compactionModelReference: undefined,
    model: liveModel,
    modelReference: sessionRef,
    resolveModel: spyResolve,
  });
  if (shipped.model !== liveModel) {
    problems.push(
      "COMPACTION: with no compaction reference, eve's resolveCompactionModel did not return the live turn " +
        "model by identity. The absence of `compaction.model` is the whole fix for OPE-670 — if this arm " +
        "changed, the fix no longer holds and compaction needs re-deriving against the pinned eve.",
    );
  }
  if (resolveModelCalls !== 0) {
    problems.push(
      `COMPACTION: eve resolved a model reference ${resolveModelCalls} time(s) with no compaction reference set. ` +
        "That resolution is the throwing path (loadSourceBackedRuntimeModelReference) — it must not be reached.",
    );
  }
  if ((shipped.providerOptions as { gateway?: unknown } | undefined)?.gateway === undefined) {
    problems.push(
      "COMPACTION: the summary call lost the session model reference's gateway providerOptions. eve reads them " +
        "off whichever reference it used, so the turn model's options are what the compaction call carries.",
    );
  }

  const distinctRef = { id: "gateway/utility", providerOptions: undefined };
  const authored = await resolveCompactionModel({
    compactionModelReference: distinctRef,
    model: liveModel,
    modelReference: sessionRef,
    resolveModel: spyResolve,
  });
  if (resolveModelCalls !== 1 || authored.model === liveModel) {
    problems.push(
      `COMPACTION (negative control): a DISTINCT compaction reference did not reach eve's resolveModel ` +
        `(calls=${resolveModelCalls}). The "no authored compaction model" gate above only means something ` +
        "while this arm is live — if eve stopped resolving compaction references, re-read the chain.",
    );
  }
}

{
  if (cardOffererBeforeBoot) {
    problems.push(
      "CARD SEAM (negative control): the routine permission card offerer was already registered BEFORE the agent " +
        "tree loaded. This gate then proves nothing about that tree — find what else fills the slot.",
    );
  } else if (!routinePermissionCardOffererRegistered()) {
    problems.push(
      "CARD SEAM: nothing in the agent tree reaches approvals/flow.ts, so nothing fills the routine permission card " +
        "offerer. An unattended CONNECTOR refusal would then post NO card and say nothing about it — the routine's " +
        "owner is told to arm a declaration with no way to click it.",
    );
  }
}

{
  const { getSettings } = await import("@open-everywhere/core/agent/settings/settings.js");
  const settings = getSettings();
  const declared: [string, unknown, unknown][] = [
    ["browser.enabled", settings.browser.enabled, false],
    ["identity.name", settings.identity.name, ""],
    ["identity.shortName", settings.identity.shortName, ""],
    ["sandbox.selfHostBackend", settings.sandbox.selfHostBackend, "docker"],
    ["wake.testWakeRoute", settings.wake.testWakeRoute, false],
  ];
  const expected: Record<string, unknown> = {
    "browser.enabled": true,
    "identity.name": "Open Everywhere",
    "identity.shortName": "oe",
    "sandbox.selfHostBackend": "justbash",
    "wake.testWakeRoute": true,
  };
  for (const [key, live, shipped] of declared) {
    if (live !== expected[key]) {
      problems.push(`SETTINGS: ${key} resolves to ${JSON.stringify(live)} after boot, but agent/settings/settings.ts declares ${JSON.stringify(expected[key])}.`);
    }
    if (live === shipped) {
      problems.push(`SETTINGS: ${key} resolves to the SHIPPED default ${JSON.stringify(shipped)} — the deployment's override never reached getSettings().`);
    }
  }
  const drivers = settings.wake.e2eDrivers;
  if (drivers.length !== 4) problems.push(`SETTINGS: wake.e2eDrivers resolves ${drivers.length} identities after boot, not the four agent/settings/settings.ts declares.`);
  for (const surface of ["slack", "discord", "notion"]) {
    if (!drivers.some((d) => d.surface === surface)) problems.push(`SETTINGS: wake.e2eDrivers names no ${surface} driver after boot.`);
  }
  const pairs = settings.wake.driverAllowlist;
  if (pairs.length !== 3) problems.push(`SETTINGS: wake.driverAllowlist resolves ${pairs.length} pairs after boot, not the three agent/settings/settings.ts declares.`);
  const targets = settings.models.targets;
  const mistral = targets["mistral"];
  if (targets["gateway"]?.kind !== "vercel-ai-gateway" || targets["gateway"]?.providers !== undefined) {
    problems.push(`SETTINGS: models.targets.gateway resolves ${JSON.stringify(targets["gateway"])} after boot, not the bare shipped target.`);
  }
  if (JSON.stringify(mistral?.providers?.only) !== JSON.stringify(["mistral"]) || mistral?.dataPolicy?.zeroRetention !== true) {
    problems.push(`SETTINGS: models.targets.mistral resolves ${JSON.stringify(mistral)} after boot, not the provider pin and zero-retention row agent/settings/settings.ts declares.`);
  }

  const { SETTINGS_OVERRIDES } = await import("../agent/settings/settings.js");
  const declaredKeys = Object.entries(SETTINGS_OVERRIDES as Record<string, Record<string, unknown> | undefined>)
    .flatMap(([group, values]) => (values === undefined ? [] : Object.keys(values).map((key) => `${group}.${key}`)))
    .sort();
  const watchedKeys = [...Object.keys(expected), "wake.e2eDrivers", "wake.driverAllowlist", "models.targets"].sort();
  for (const key of declaredKeys) {
    if (!watchedKeys.includes(key)) problems.push(`SETTINGS: agent/settings/settings.ts declares ${key} and nothing in this block watches it — add it to the list above.`);
  }
  for (const key of watchedKeys) {
    if (!declaredKeys.includes(key)) problems.push(`SETTINGS: this block watches ${key}, which agent/settings/settings.ts no longer declares — the check now asserts a shipped default against itself.`);
  }
}

rmSync(scratch, { recursive: true, force: true });

if (problems.length > 0) {
  console.error(`✗ boot-smoke: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

console.log(
  `✓ boot-smoke: ${modules.length} agent module(s) load clean; ${routeCount} channel route(s), no collisions; ` +
    `${scheduleCount} schedule cron(s) valid; dynamic model bound at step.started; scripted model inert; ` +
    `turn-model selection carries the primary window + gateway options; compaction resolves without a reference; ` +
    `the routine permission card offerer is registered by the agent tree`,
);
process.exit(0);

// proves: DEP-06, DEP-07, DEP-08, DEP-09, DEP-10, DEP-11
