import { connectorGrantName } from "../access/bundle.js";
import type { Binding, Bundle, Scope } from "../access/bundle.js";
import { overlayModuleHeader, unwrapOverlayModule, wrapOverlayModule, type OverlayModuleGrammar } from "../access/overlay-module.js";
import type { Domain } from "./domain.js";
import { memoryRefs } from "./domain.js";
import type { MemorySilo } from "./silo.js";
import type { MemorySelection } from "./selection.js";

export type AgentMemory =
  | { readonly kind: "existing-silo"; readonly silo: string }
  | {
      readonly kind: "new-readonly";
      readonly provider: string;
      readonly container?: string;
      readonly path?: string;
      readonly select?: MemorySelection;
      readonly skill?: string;
    };

export interface AgentSpec {
  readonly name: string;
  readonly title?: string;
  readonly channels: readonly string[];
  readonly memory: AgentMemory;
  readonly connectors?: readonly string[];
  readonly instructions?: string;
  readonly exposed?: boolean;
}

export interface AgentsFile {
  readonly domains: readonly Domain[];
  readonly silos: readonly MemorySilo[];
  readonly bundles: readonly Bundle[];
  readonly bindings: readonly Binding[];
  readonly specs: readonly AgentSpec[];
}

export class AgentsCodemodError extends Error {}

export function emptyAgentsFile(): AgentsFile {
  return { domains: [], silos: [], bundles: [], bindings: [], specs: [] };
}

export function agentSiloName(spec: AgentSpec): string {
  return spec.memory.kind === "existing-silo" ? spec.memory.silo : `${spec.name}-silo`;
}

export function agentBundleName(spec: AgentSpec | { readonly name: string }): string {
  return `agent:${spec.name}`;
}

export function assertExposedAgentSpec(spec: AgentSpec, resolveSilo?: (name: string) => MemorySilo | undefined): void {
  if (!spec.exposed) return;
  if (spec.memory.kind === "new-readonly") return;
  const name = spec.memory.silo;
  const silo = resolveSilo?.(name);
  if (!silo) {
    throw new AgentsCodemodError(
      `exposed agent "${spec.name}" references existing silo "${name}", but it cannot be resolved to confirm it is read-only — an exposed agent may only read a curated READ-ONLY silo (pass the merged silo set, or use a { kind: "new-readonly" } silo)`,
    );
  }
  if (silo.readOnly !== true) {
    throw new AgentsCodemodError(
      `exposed agent "${spec.name}" reads silo "${name}", which is WRITABLE — an exposed agent may only read a curated READ-ONLY silo (mark the silo readOnly, or give the agent its own { kind: "new-readonly" } silo)`,
    );
  }
}

export function assertExposedAgentsCurated(
  domains: readonly Domain[],
  silos: readonly MemorySilo[],
  specs: readonly AgentSpec[],
): void {
  const domainByName = new Map(domains.map((d) => [d.name, d]));
  const siloByName = new Map(silos.map((s) => [s.name, s]));
  const bad: string[] = [];
  for (const spec of specs) {
    if (!spec.exposed) continue;
    const domain = domainByName.get(spec.name);
    if (!domain) {
      bad.push(`  exposed agent "${spec.name}" has no merged domain — the overlay derived one, so a missing domain means the merge dropped it`);
      continue;
    }
    if (domain.match !== undefined) {
      bad.push(`  exposed agent "${spec.name}" resolves to a criteria (match "${domain.match}") domain — an exposed agent must be an explicit channels domain, never a pseudo-domain`);
    }
    if (domain.includeOrg !== undefined) {
      bad.push(`  exposed agent "${spec.name}" sets includeOrg "${domain.includeOrg}" — an exposed agent may not inherit the org brain (that would leak internal memory to a wider audience)`);
    }
    for (const ref of memoryRefs(domain)) {
      const silo = siloByName.get(ref);
      if (!silo) {
        bad.push(`  exposed agent "${spec.name}" references silo "${ref}", which is not in the merged silo set`);
      } else if (silo.readOnly !== true) {
        bad.push(`  exposed agent "${spec.name}" reads WRITABLE silo "${ref}" — an exposed agent may only read curated read-only silos`);
      }
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: exposed agent(s) violate the curated-read-only invariant:\n" +
        bad.join("\n") +
        "\n(memory/agents-codemod.ts assertExposedAgentsCurated / create_agent flow).",
    );
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

const DOMAIN_FIELDS = new Set(["name", "title", "channels", "memory"]);
const SILO_FIELDS = new Set(["name", "description", "provider", "container", "path", "readOnly", "skill", "recursive", "select"]);
const BUNDLE_FIELDS = new Set(["name", "title", "connectors", "instructions"]);
const BINDING_FIELDS = new Set(["bundle", "scope"]);
const SPEC_FIELDS = new Set(["name", "title", "channels", "memory", "connectors", "instructions", "exposed"]);

function refuseUnknownFields(what: string, obj: Record<string, unknown>, allowed: Set<string>): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new AgentsCodemodError(`${what} has field "${k}" — the agents overlay is machine-owned and carries only its emitted fields (put anything else in code config)`);
    }
  }
}

export function parseAgentsFile(value: unknown): AgentsFile {
  if (!isRecord(value)) throw new AgentsCodemodError("agents file must be a JSON object with domains/silos/bundles/bindings/specs arrays");
  const keys = Object.keys(value).filter((k) => k !== "$comment");
  const unknown = keys.filter((k) => !["domains", "silos", "bundles", "bindings", "specs"].includes(k));
  if (unknown.length > 0) throw new AgentsCodemodError(`agents file has unknown top-level key(s): ${unknown.join(", ")}`);
  for (const arr of ["domains", "silos", "bundles", "bindings", "specs"] as const) {
    if (!Array.isArray(value[arr])) throw new AgentsCodemodError(`agents file needs a \`${arr}\` array (use [] when empty)`);
  }

  const domains: Domain[] = [];
  for (const d of value.domains as unknown[]) {
    if (!isRecord(d) || typeof d.name !== "string" || d.name.length === 0) {
      throw new AgentsCodemodError(`every agents domain needs a name (got: ${JSON.stringify(d)})`);
    }
    refuseUnknownFields(`agents domain "${String(d.name)}"`, d, DOMAIN_FIELDS);
    if (d.channels !== undefined && !isStringArray(d.channels)) throw new AgentsCodemodError(`agents domain "${d.name}" channels must be a string array`);
    if (d.memory !== undefined && typeof d.memory !== "string" && !isStringArray(d.memory)) {
      throw new AgentsCodemodError(`agents domain "${d.name}" memory must be a silo name or a list of silo names`);
    }
    domains.push(d as unknown as Domain);
  }

  const silos: MemorySilo[] = [];
  for (const s of value.silos as unknown[]) {
    if (!isRecord(s) || typeof s.name !== "string" || s.name.length === 0 || typeof s.provider !== "string" || s.provider.length === 0) {
      throw new AgentsCodemodError(`every agents silo needs a name and a provider (got: ${JSON.stringify(s)})`);
    }
    refuseUnknownFields(`agents silo "${String(s.name)}"`, s, SILO_FIELDS);
    silos.push(s as unknown as MemorySilo);
  }

  const bundles: Bundle[] = [];
  for (const b of value.bundles as unknown[]) {
    if (!isRecord(b) || typeof b.name !== "string" || !b.name.startsWith("agent:")) {
      throw new AgentsCodemodError(`every agents bundle needs an "agent:"-prefixed name (got: ${JSON.stringify(isRecord(b) ? b.name : b)})`);
    }
    refuseUnknownFields(`agents bundle "${b.name}"`, b, BUNDLE_FIELDS);
    if (b.connectors !== undefined && !isStringArray(b.connectors)) throw new AgentsCodemodError(`agents bundle "${b.name}" connectors must be a string array (a \`{ name, trust }\` declaration is an operator assertion — put it in a code bundle)`);
    if (b.instructions !== undefined && typeof b.instructions !== "string") throw new AgentsCodemodError(`agents bundle "${b.name}" instructions must be a string`);
    bundles.push(b as unknown as Bundle);
  }

  const bindings: Binding[] = [];
  for (const bd of value.bindings as unknown[]) {
    if (!isRecord(bd) || typeof bd.bundle !== "string" || !bd.bundle.startsWith("agent:") || !isRecord(bd.scope)) {
      throw new AgentsCodemodError(`every agents binding needs { bundle: "agent:…", scope } (got: ${JSON.stringify(bd)})`);
    }
    refuseUnknownFields(`agents binding "${bd.bundle}"`, bd, BINDING_FIELDS);
    const scope = bd.scope as Record<string, unknown>;
    if (scope.level !== "domain" || typeof scope.domain !== "string" || scope.domain.includes("/")) {
      throw new AgentsCodemodError(`agents binding for "${bd.bundle}" must be domain-scoped with a bare domain name ({ level: "domain", domain: "<name>" })`);
    }
    bindings.push(bd as unknown as Binding);
  }

  const specs: AgentSpec[] = [];
  for (const sp of value.specs as unknown[]) {
    if (!isRecord(sp) || typeof sp.name !== "string" || sp.name.length === 0) {
      throw new AgentsCodemodError(`every agents spec needs a name (got: ${JSON.stringify(sp)})`);
    }
    refuseUnknownFields(`agents spec "${String(sp.name)}"`, sp, SPEC_FIELDS);
    if (!isStringArray(sp.channels)) throw new AgentsCodemodError(`agents spec "${sp.name}" needs a channels string array`);
    if (!isRecord(sp.memory) || (sp.memory.kind !== "existing-silo" && sp.memory.kind !== "new-readonly")) {
      throw new AgentsCodemodError(`agents spec "${sp.name}" memory must be { kind: "existing-silo" | "new-readonly", … }`);
    }
    if (sp.memory.kind === "existing-silo" && typeof sp.memory.silo !== "string") {
      throw new AgentsCodemodError(`agents spec "${sp.name}" existing-silo memory needs a silo name`);
    }
    if (sp.memory.kind === "new-readonly" && typeof sp.memory.provider !== "string") {
      throw new AgentsCodemodError(`agents spec "${sp.name}" new-readonly memory needs a provider`);
    }
    if (sp.connectors !== undefined && !isStringArray(sp.connectors)) throw new AgentsCodemodError(`agents spec "${sp.name}" connectors must be a string array`);
    if (sp.exposed !== undefined && typeof sp.exposed !== "boolean") throw new AgentsCodemodError(`agents spec "${sp.name}" exposed must be a boolean`);
    specs.push(sp as unknown as AgentSpec);
  }

  return { domains, silos, bundles, bindings, specs };
}

const DOMAIN_KEYS = ["name", "title", "channels", "memory"];
const SILO_KEYS = ["name", "description", "provider", "container", "path", "readOnly", "recursive", "skill", "select"];
const BUNDLE_KEYS = ["name", "title", "connectors", "instructions"];
const BINDING_KEYS = ["bundle", "scope"];
const SCOPE_KEYS = ["level", "domain"];
const SPEC_KEYS = ["name", "title", "channels", "memory", "connectors", "instructions", "exposed"];
const MEMORY_KEYS = ["kind", "silo", "provider", "container", "path", "skill", "select"];
const SELECTION_KEYS = ["default", "rules"];
const RULE_KEYS = ["path", "mode"];

function orderKeys(obj: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of order) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj).sort()) if (!(k in out)) out[k] = obj[k];
  return out;
}

function canonicalSelection(sel: MemorySelection): Record<string, unknown> {
  const obj: Record<string, unknown> = { ...sel };
  if (sel.rules) obj.rules = sel.rules.map((r) => orderKeys({ ...r }, RULE_KEYS));
  return orderKeys(obj, SELECTION_KEYS);
}

function canonicalDomain(d: Domain): Record<string, unknown> {
  const obj: Record<string, unknown> = { ...d };
  if (d.channels) obj.channels = [...d.channels].sort();
  if (Array.isArray(d.memory)) obj.memory = [...d.memory].sort();
  return orderKeys(obj, DOMAIN_KEYS);
}

function canonicalSilo(s: MemorySilo): Record<string, unknown> {
  const obj: Record<string, unknown> = { ...s };
  if (s.select) obj.select = canonicalSelection(s.select);
  return orderKeys(obj, SILO_KEYS);
}

function canonicalBundle(b: Bundle): Record<string, unknown> {
  const obj: Record<string, unknown> = { ...b };
  if (b.connectors) obj.connectors = [...b.connectors].sort((x, y) => connectorGrantName(x).localeCompare(connectorGrantName(y)));
  return orderKeys(obj, BUNDLE_KEYS);
}

function canonicalBinding(bd: Binding): Record<string, unknown> {
  return orderKeys({ ...bd, scope: orderKeys({ ...bd.scope } as Record<string, unknown>, SCOPE_KEYS) }, BINDING_KEYS);
}

function canonicalSpec(sp: AgentSpec): Record<string, unknown> {
  const obj: Record<string, unknown> = { ...sp };
  obj.channels = [...sp.channels].sort();
  if (sp.connectors) obj.connectors = [...sp.connectors].sort();
  const mem: Record<string, unknown> = { ...sp.memory };
  if (sp.memory.kind === "new-readonly" && sp.memory.select) mem.select = canonicalSelection(sp.memory.select);
  obj.memory = orderKeys(mem, MEMORY_KEYS);
  return orderKeys(obj, SPEC_KEYS);
}

function scopeSortKey(s: Scope): string {
  return `${s.domain ?? ""}/${s.level}`;
}

export function stringifyAgents(file: AgentsFile): string {
  const canonical = {
    domains: [...file.domains].sort((a, b) => a.name.localeCompare(b.name)).map(canonicalDomain),
    silos: [...file.silos].sort((a, b) => a.name.localeCompare(b.name)).map(canonicalSilo),
    bundles: [...file.bundles].sort((a, b) => a.name.localeCompare(b.name)).map(canonicalBundle),
    bindings: [...file.bindings]
      .sort((a, b) => a.bundle.localeCompare(b.bundle) || scopeSortKey(a.scope).localeCompare(scopeSortKey(b.scope)))
      .map(canonicalBinding),
    specs: [...file.specs].sort((a, b) => a.name.localeCompare(b.name)).map(canonicalSpec),
  };
  return JSON.stringify(canonical, null, 2) + "\n";
}

export const AGENTS_MODULE: OverlayModuleGrammar = {
  what: "agents overlay",
  header: overlayModuleHeader("agents overlay", "packages/core/agent/memory/agents-codemod.ts"),
  typeImport: 'import type { AgentsFile } from "@open-everywhere/core/agent/memory/agents-codemod.js";',
  typeName: "AgentsFile",
};

export function emitAgentsModule(file: AgentsFile): string {
  return wrapOverlayModule(AGENTS_MODULE, stringifyAgents(file));
}

export function parseAgentsModule(text: string): AgentsFile {
  const file = parseAgentsFile(unwrapOverlayModule(AGENTS_MODULE, text, (m) => new AgentsCodemodError(m)));
  if (emitAgentsModule(file) !== text) {
    throw new AgentsCodemodError(
      "agents overlay is not in canonical form — re-emitting its own data does not reproduce the file, so it has been hand-edited. Run `npm run overlays:normalize` and commit the result (the codemod refuses to rewrite a file it did not write).",
    );
  }
  return file;
}

export function renormalizeAgentsModule(text: string): string {
  return emitAgentsModule(parseAgentsFile(unwrapOverlayModule(AGENTS_MODULE, text, (m) => new AgentsCodemodError(m))));
}

function upsertByName<T extends { readonly name: string }>(list: readonly T[], next: T): T[] {
  const has = list.some((x) => x.name === next.name);
  return has ? list.map((x) => (x.name === next.name ? next : x)) : [...list, next];
}

function upsertBinding(list: readonly Binding[], next: Binding): Binding[] {
  const has = list.some((b) => b.bundle === next.bundle && b.scope.level === next.scope.level && b.scope.domain === next.scope.domain);
  return has ? list.map((b) => (b.bundle === next.bundle && b.scope.level === next.scope.level && b.scope.domain === next.scope.domain ? next : b)) : [...list, next];
}

export interface ApplyAgentResult {
  readonly file: AgentsFile;
  readonly changed: boolean;
}

export function applyAgentSpec(file: AgentsFile, spec: AgentSpec): ApplyAgentResult {
  if (!spec.name || spec.name.includes("/")) {
    throw new AgentsCodemodError(`agent name "${spec.name}" must be a bare, non-empty domain name (no "/")`);
  }
  const siloName = agentSiloName(spec);
  const bundleName = agentBundleName(spec);

  const domain: Domain = {
    name: spec.name,
    ...(spec.title !== undefined ? { title: spec.title } : {}),
    channels: [...spec.channels],
    memory: siloName,
  };

  const newSilo: MemorySilo | undefined =
    spec.memory.kind === "new-readonly"
      ? {
          name: siloName,
          provider: spec.memory.provider,
          ...(spec.memory.container !== undefined ? { container: spec.memory.container } : {}),
          ...(spec.memory.path !== undefined ? { path: spec.memory.path } : {}),
          readOnly: true,
          ...(spec.memory.skill !== undefined ? { skill: spec.memory.skill } : {}),
          ...(spec.memory.select !== undefined ? { select: spec.memory.select } : {}),
        }
      : undefined;

  const bundle: Bundle = {
    name: bundleName,
    ...(spec.title !== undefined ? { title: spec.title } : {}),
    ...(spec.connectors !== undefined && spec.connectors.length > 0 ? { connectors: [...new Set(spec.connectors)].sort() } : {}),
    ...(spec.instructions !== undefined ? { instructions: spec.instructions } : {}),
  };

  const binding: Binding = { bundle: bundleName, scope: { level: "domain", domain: spec.name } };

  const next: AgentsFile = {
    domains: upsertByName(file.domains, domain),
    silos: newSilo ? upsertByName(file.silos, newSilo) : file.silos,
    bundles: upsertByName(file.bundles, bundle),
    bindings: upsertBinding(file.bindings, binding),
    specs: upsertByName(file.specs, spec),
  };

  const changed = stringifyAgents(next) !== stringifyAgents(file);
  return { file: next, changed };
}
