import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { getSettings, registerSettings, type AgentSettingsOverrides } from "../settings/settings.js";
import { importAppModule } from "../scaffold/app-root.js";
import { loadRosterConfig } from "../scaffold/roster-fs.js";
import { parseRosterConfig } from "../scaffold/roster-plan.js";
import type { BareModelFact, SovereigntyInput, TranscriptionRouteFact } from "./sovereignty.js";
import { bareModelRoutes, bareModelVia } from "../model/bare-model-via.js";
import { EVE_TELEMETRY_SWITCH, eveCommands } from "./eve-scripts.js";

export async function registerAppSettings(appRoot: string): Promise<string | undefined> {
  try {
    const mod = await importAppModule<{ SETTINGS_OVERRIDES?: AgentSettingsOverrides }>("agent/settings/settings.ts", appRoot);
    if (mod.SETTINGS_OVERRIDES === undefined) return "agent/settings/settings.ts exports no SETTINGS_OVERRIDES";
    registerSettings(mod.SETTINGS_OVERRIDES);
    return undefined;
  } catch (err) {
    return `agent/settings/settings.ts did not load: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function appEnv(appRoot: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const file = join(appRoot, ".env.local");
  if (!existsSync(file)) return { ...base };
  try {
    return { ...base, ...parseEnv(readFileSync(file, "utf8")) };
  } catch {
    return { ...base };
  }
}

function vercelRegions(appRoot: string): string[] | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(appRoot, "vercel.json"), "utf8")) as { regions?: unknown };
    return Array.isArray(raw.regions) ? raw.regions.filter((r): r is string => typeof r === "string") : undefined;
  } catch {
    return undefined;
  }
}

export function originRemoteHost(gitConfig: string): string | undefined {
  const section = /\[remote "origin"\]([^[]*)/u.exec(gitConfig)?.[1];
  const url = section === undefined ? undefined : /^\s*url\s*=\s*(\S+)\s*$/mu.exec(section)?.[1];
  if (url === undefined) return undefined;
  const scp = /^[^@/]+@([^:/]+):/u.exec(url);
  if (scp) return scp[1];
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function configRemoteHost(appRoot: string): string | undefined {
  try {
    return originRemoteHost(readFileSync(join(appRoot, ".git", "config"), "utf8"));
  } catch {
    return undefined;
  }
}

async function stackRoles(appRoot: string, alias: string): Promise<Record<string, string> | undefined> {
  try {
    const mod = await importAppModule<{ resolveStack?: (a: string) => Record<string, { id?: unknown }> }>("agent/model/stacks.ts", appRoot);
    if (typeof mod.resolveStack !== "function") return undefined;
    const out: Record<string, string> = {};
    for (const [role, spec] of Object.entries(mod.resolveStack(alias))) if (typeof spec?.id === "string") out[role] = spec.id;
    return out;
  } catch {
    return undefined;
  }
}

const ROLE_ORDER: readonly string[] = ["primary", "utility", "vision", "supervisor", "judge"];

async function stackRoleRoutes(appRoot: string, models: { readonly stack: string; readonly force: string; readonly primary: string }): Promise<{ id: string; via?: string }[] | undefined> {
  try {
    const mod = await importAppModule<{ resolveStack?: (a: string) => Record<string, { id?: unknown; via?: unknown }> }>("agent/model/stacks.ts", appRoot);
    if (typeof mod.resolveStack !== "function") return undefined;
    const rank = (role: string): number => {
      const i = ROLE_ORDER.indexOf(role);
      return i === -1 ? ROLE_ORDER.length : i;
    };
    const entries = Object.entries(mod.resolveStack(models.stack)).sort(([a], [b]) => rank(a) - rank(b));
    const out: { id: string; via?: string }[] = [];
    for (const [role, spec] of entries) {
      if (typeof spec?.id !== "string") continue;
      const id = role === "primary" ? models.force || models.primary || spec.id : spec.id;
      out.push(typeof spec.via === "string" ? { id, via: spec.via } : { id });
    }
    return out;
  } catch {
    return undefined;
  }
}

export interface DeclaredSubagentModel {
  readonly where: string;
  readonly id: string | undefined;
}

export async function declaredSubagentModels(appRoot: string): Promise<DeclaredSubagentModel[] | undefined> {
  let dirs: string[];
  try {
    dirs = readdirSync(join(appRoot, "agent", "subagents"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(appRoot, "agent", "subagents", e.name, "agent.ts")))
      .map((e) => e.name)
      .sort();
  } catch {
    return existsSync(join(appRoot, "agent")) ? [] : undefined;
  }
  const out: DeclaredSubagentModel[] = [];
  for (const name of dirs) {
    try {
      const mod = await importAppModule<{ default?: { model?: unknown } }>(`agent/subagents/${name}/agent.ts`, appRoot);
      const model = mod.default?.model;
      if (typeof model === "string" && model !== "") out.push({ where: `subagent ${name}`, id: model });
    } catch {
      out.push({ where: `subagent ${name}`, id: undefined });
    }
  }
  return out;
}

export function registersBareModelRoutes(modelsTs: string): boolean {
  const code = modelsTs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return /\bregisterBareModelRoutes\s*\(/.test(code);
}

async function bareModelFacts(
  appRoot: string,
  models: { readonly stack: string; readonly force: string; readonly primary: string },
): Promise<{ bareModels?: BareModelFact[]; bareDefaultVia?: string; bareRoutesRegistered?: boolean | "unknown" }> {
  const roles = await stackRoleRoutes(appRoot, models);
  if (roles === undefined) return {};
  const text = readText(join(appRoot, "agent", "model", "models.ts"));
  const registered = text === undefined ? "unknown" : registersBareModelRoutes(text);
  const routes = bareModelRoutes(registered === false ? [] : roles);
  const subagents = await declaredSubagentModels(appRoot);
  return {
    bareDefaultVia: routes.fallback,
    bareRoutesRegistered: registered,
    ...(subagents !== undefined ? { bareModels: subagents.map((b) => (b.id === undefined ? { where: b.where, id: undefined } : { where: b.where, id: b.id, ...bareModelVia(b.id, routes) })) } : {}),
  };
}

async function transcriptionRoutes(appRoot: string, alias: string): Promise<TranscriptionRouteFact[] | undefined> {
  try {
    const mod = await importAppModule<{ resolveTranscription?: (a: string) => Record<string, { via?: unknown; id?: unknown; baseUrl?: unknown }> }>(
      "agent/model/stacks.ts",
      appRoot,
    );
    if (typeof mod.resolveTranscription !== "function") return undefined;
    const out: TranscriptionRouteFact[] = [];
    for (const [slot, r] of Object.entries(mod.resolveTranscription(alias))) {
      if (r === undefined || typeof r.via !== "string" || typeof r.id !== "string") continue;
      let host: string | undefined;
      if (r.via === "deepinfra") host = "api.deepinfra.com";
      else if (r.via === "self-hosted" && typeof r.baseUrl === "string") {
        try {
          host = new URL(r.baseUrl).hostname || undefined;
        } catch {
          host = undefined;
        }
      }
      out.push({ slot, via: r.via, id: r.id, host });
    }
    return out;
  } catch {
    return undefined;
  }
}

export function eveScriptTelemetry(pkgJson: string): { disabled: string[]; enabled: string[] } | undefined {
  let scripts: unknown;
  try {
    scripts = (JSON.parse(pkgJson) as { scripts?: unknown }).scripts;
  } catch {
    return undefined;
  }
  if (scripts === null || typeof scripts !== "object") return undefined;
  const out = { disabled: [] as string[], enabled: [] as string[] };
  for (const [name, cmd] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof cmd !== "string") continue;
    const runs = eveCommands(cmd);
    if (runs.length === 0) continue;
    (runs.every((r) => r.prefix.includes(EVE_TELEMETRY_SWITCH)) ? out.disabled : out.enabled).push(name);
  }
  return out;
}

export function namesWorkflowWorld(agentTs: string): boolean {
  return /\bworkflow\s*:\s*\{[^}]*\bworld\s*:/su.test(agentTs);
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

async function chatPlatforms(appRoot: string): Promise<string[] | undefined> {
  const loaded = await loadRosterConfig(appRoot);
  if (loaded.error !== undefined) return undefined;
  const parsed = parseRosterConfig(loaded.raw);
  if (parsed.config === undefined) return undefined;
  return Object.entries(parsed.config.providers ?? {})
    .filter(([, decision]) => decision !== false)
    .map(([id]) => id)
    .sort();
}

export async function gatherSovereigntyInput(appRoot: string, env: NodeJS.ProcessEnv, host?: "vercel" | "docker"): Promise<SovereigntyInput> {
  const s = getSettings();
  return {
    env,
    settings: {
      models: s.models,
      auditExport: s.auditExport,
      egress: s.egress,
      sandbox: { region: s.sandbox.region },
      memory: { provider: s.memory.provider },
      observability: { logShip: { url: s.observability.logShip.url } },
      telemetry: { enabled: s.telemetry.enabled, url: s.telemetry.url },
    },
    ...(host !== undefined ? { host } : {}),
    vercelLinked: existsSync(join(appRoot, ".vercel", "project.json")),
    vercelRegions: vercelRegions(appRoot),
    stackRoles: await stackRoles(appRoot, s.models.stack),
    chatPlatforms: await chatPlatforms(appRoot),
    configRemoteHost: configRemoteHost(appRoot),
    transcription: await transcriptionRoutes(appRoot, s.models.stack),
    ...(await bareModelFacts(appRoot, s.models)),
    eveScripts: ((t) => (t === undefined ? undefined : eveScriptTelemetry(t)))(readText(join(appRoot, "package.json"))),
    customWorkflowWorld: ((t) => (t === undefined ? undefined : namesWorkflowWorld(t)))(readText(join(appRoot, "agent", "agent.ts"))),
  };
}
