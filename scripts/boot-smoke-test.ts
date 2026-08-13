import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const AGENT_DIR = join(ROOT, "agent");

const scratch = mkdtempSync(join(tmpdir(), "oe-boot-smoke-"));
process.env.OE_PGLITE_DIR = join(scratch, "pglite");
process.env.OE_MEMORY_DIR = join(scratch, "memory");
delete process.env.DATABASE_URL;

const problems: string[] = [];

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
  const { evalMockModel, MOCK_MODEL_ID, mockModelArmed } = await import("../agent/model/mock-model.js");
  if (mockModelArmed()) {
    problems.push(
      "MOCK MODEL: OE_EVAL_MOCK_MODEL is armed in this process — the boot gate must run with it UNSET, " +
        "or ⑤ asserts nothing. (Nothing currently arms it — see the OPE-463 retirement note above.)",
    );
  } else {
    let refused = false;
    try {
      evalMockModel();
    } catch {
      refused = true;
    }
    if (!refused) {
      problems.push(
        "MOCK MODEL: evalMockModel() returned a model with OE_EVAL_MOCK_MODEL unset — the fail-closed guard is gone, " +
          "so a real deployment could answer a chat surface with canned text.",
      );
    }

    const agent = loaded.get("agent/agent.ts")?.default as
      | { model?: { events?: Record<string, (event: unknown, ctx: unknown) => unknown> } }
      | undefined;
    const resolver = agent?.model?.events?.["step.started"];
    if (typeof resolver !== "function") {
      problems.push("MOCK MODEL: agent/agent.ts exposes no step.started model resolver to check.");
    } else {
      const selection = (await resolver(undefined, {})) as { model?: { modelId?: unknown } } | null;
      const seated = selection && typeof selection === "object" ? selection.model : undefined;
      if (seated && typeof seated === "object" && seated.modelId === MOCK_MODEL_ID) {
        problems.push(
          `MODEL SEAT: the turn seat resolved to the EVAL MOCK (${MOCK_MODEL_ID}) with OE_EVAL_MOCK_MODEL unset — ` +
            "this build would answer every wake with canned text instead of calling a model.",
        );
      }
    }
  }
}

{
  const { SCRIPTED_MODEL_ENV, SCRIPTED_MODEL_ID, scriptedModelArmed } = await import("../agent/model/scripted-model.js");
  const { registerScript } = await import("../agent/model/scripted-model.js");
  const { scriptedModelFor } = await import("../agent/model/scripted-resolve.js");
  if (scriptedModelArmed()) {
    problems.push(
      `SCRIPTED MODEL: ${SCRIPTED_MODEL_ENV} is armed in this process — the boot gate must run with it UNSET, ` +
        "or ⑤b asserts nothing. (It is armed only inside the vitest integration forks.)",
    );
  } else {
    if (scriptedModelFor(undefined, {}) !== null) {
      problems.push("SCRIPTED MODEL: scriptedModelFor() returned non-null with the env unset — the normal build would consult test scripts.");
    }
    let refused = false;
    try {
      registerScript({ parent: [] });
    } catch {
      refused = true;
    }
    if (!refused) {
      problems.push("SCRIPTED MODEL: registerScript() accepted a script with the env unset — the fail-closed guard is gone.");
    }
    const priorArm = process.env[SCRIPTED_MODEL_ENV];
    const priorVercel = process.env.VERCEL;
    try {
      process.env[SCRIPTED_MODEL_ENV] = "1";
      process.env.VERCEL = "1";
      let vercelRefused = false;
      try {
        scriptedModelFor(undefined, {});
      } catch {
        vercelRefused = true;
      }
      if (!vercelRefused) {
        problems.push("SCRIPTED MODEL: scriptedModelFor() did not throw when armed on Vercel — a hosted deployment could answer from a script.");
      }
    } finally {
      if (priorArm === undefined) delete process.env[SCRIPTED_MODEL_ENV];
      else process.env[SCRIPTED_MODEL_ENV] = priorArm;
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
          `MODEL SEAT: the turn seat resolved to the SCRIPTED double (${SCRIPTED_MODEL_ID}) with ${SCRIPTED_MODEL_ENV} unset — ` +
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

  if (typeof agent?.compaction?.modelContextWindowTokens !== "number") {
    problems.push(
      "MODEL SELECTION: agent/agent.ts's `compaction.modelContextWindowTokens` is missing. It is NOT the " +
        "field the 0.33 union constrains (that is the AGENT-LEVEL one) and it is not optional in practice — " +
        "the compaction slot is authored as a model INSTANCE, so without it `eve build` fails with " +
        '"does not have known AI Gateway context window metadata".',
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

rmSync(scratch, { recursive: true, force: true });

if (problems.length > 0) {
  console.error(`✗ boot-smoke: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

console.log(
  `✓ boot-smoke: ${modules.length} agent module(s) load clean; ${routeCount} channel route(s), no collisions; ` +
    `${scheduleCount} schedule cron(s) valid; dynamic model bound at step.started; eval mock inert; ` +
    `turn-model selection carries the primary window + gateway options`,
);
process.exit(0);
