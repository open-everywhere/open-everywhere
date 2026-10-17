import type { Domain, ModelRoute, NamedKnobLayer } from "../memory/domain.js";

const MODEL_TARGET_KINDS = ["vercel-ai-gateway"] as const;
export type ModelTargetKind = (typeof MODEL_TARGET_KINDS)[number];

export const DEFAULT_MODEL_VIA = "gateway";

export interface ModelTargetProviders {
  readonly only?: readonly string[];
  readonly order?: readonly string[];
}

export interface ModelTarget {
  readonly kind: ModelTargetKind;
  readonly url?: string;
  readonly providers?: ModelTargetProviders;
  readonly options?: Readonly<Record<string, unknown>>;
}

export type ModelTargets = Readonly<Record<string, ModelTarget>>;

export const SHIPPED_MODEL_TARGETS: ModelTargets = { [DEFAULT_MODEL_VIA]: { kind: "vercel-ai-gateway" } };

const TARGET_KEYS = ["kind", "url", "providers", "options"] as const;
const PROVIDER_KEYS = ["only", "order"] as const;
const TARGET_NAME = /^[a-z][a-z0-9-]{0,31}$/;

const OWNED_OPTION_KEYS: Readonly<Record<string, string>> = {
  only: "providers.only",
  order: "providers.order",
  zeroDataRetention: "models.dataPolicy.zeroRetention",
  disallowPromptTraining: "models.dataPolicy.noTraining",
  inferenceRegion: "models.dataPolicy.region",
};

function providerListProblem(v: unknown, where: string): string | undefined {
  if (!Array.isArray(v) || v.length === 0) return `${where} must be a non-empty list of provider slugs`;
  for (const s of v) {
    if (typeof s !== "string" || s.trim() === "" || s !== s.trim()) return `${where} must hold provider slugs, for example "openai"`;
  }
  if (new Set(v).size !== v.length) return `${where} names a provider twice`;
  return undefined;
}

function validateModelTarget(name: string, v: unknown): string | undefined {
  const at = `target "${name}"`;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return `${at} must be an object: { kind, url?, providers?, options? }`;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!(TARGET_KEYS as readonly string[]).includes(k)) return `${at}: unknown key "${k}" — valid keys: ${TARGET_KEYS.join(", ")}`;
  }
  if (!(MODEL_TARGET_KINDS as readonly unknown[]).includes(o["kind"])) {
    return `${at}: kind must be one of ${MODEL_TARGET_KINDS.map((k) => `"${k}"`).join(", ")} (got ${JSON.stringify(o["kind"])})`;
  }
  if (o["url"] !== undefined) {
    if (typeof o["url"] !== "string") return `${at}: url must be a string`;
    let u: URL;
    try {
      u = new URL(o["url"]);
    } catch {
      return `${at}: url is not a URL`;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return `${at}: url must be http or https`;
  }
  if (o["providers"] !== undefined) {
    const p = o["providers"];
    if (p === null || typeof p !== "object" || Array.isArray(p)) return `${at}: providers must be an object: { only?, order? }`;
    const po = p as Record<string, unknown>;
    for (const k of Object.keys(po)) {
      if (!(PROVIDER_KEYS as readonly string[]).includes(k)) return `${at}: unknown providers key "${k}" — valid keys: ${PROVIDER_KEYS.join(", ")}`;
    }
    for (const k of PROVIDER_KEYS) {
      if (po[k] !== undefined) {
        const problem = providerListProblem(po[k], `${at}: providers.${k}`);
        if (problem !== undefined) return problem;
      }
    }
    if (Array.isArray(po["only"]) && Array.isArray(po["order"])) {
      const outside = (po["order"] as string[]).filter((s) => !(po["only"] as string[]).includes(s));
      if (outside.length > 0) return `${at}: providers.order names ${outside.map((s) => `"${s}"`).join(", ")}, which providers.only does not allow`;
    }
  }
  if (o["options"] !== undefined) {
    const opt = o["options"];
    if (opt === null || typeof opt !== "object" || Array.isArray(opt)) return `${at}: options must be an object`;
    for (const k of Object.keys(opt)) {
      const owner = OWNED_OPTION_KEYS[k];
      if (owner !== undefined) return `${at}: options.${k} is not allowed — set ${owner} instead`;
    }
  }
  return undefined;
}

export function validateModelTargets(v: unknown): string | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return `must be an object of named targets, for example { gateway: { kind: "vercel-ai-gateway" } }`;
  const o = v as Record<string, unknown>;
  for (const name of Object.keys(o)) {
    if (!TARGET_NAME.test(name)) return `target name "${name}" must be lowercase letters, digits and dashes, starting with a letter`;
    const problem = validateModelTarget(name, o[name]);
    if (problem !== undefined) return problem;
  }
  if (!Object.hasOwn(o, DEFAULT_MODEL_VIA)) {
    return `must name a "${DEFAULT_MODEL_VIA}" target: a route or a stack role with no via uses it`;
  }
  return undefined;
}

export function modelTargetFor(via: string | undefined, targets: ModelTargets): ModelTarget {
  const name = via ?? DEFAULT_MODEL_VIA;
  const t = Object.hasOwn(targets, name) ? targets[name] : undefined;
  if (t === undefined) throw new Error(`models.targets has no target "${name}" — known targets: ${Object.keys(targets).join(", ")}`);
  return t;
}

export function viaProblem(via: unknown, targets: ModelTargets, where: string): string | undefined {
  if (via === undefined) return undefined;
  if (typeof via !== "string") return `${where}: via must be a target name`;
  if (!Object.hasOwn(targets, via)) return `${where}: via "${via}" names no target in models.targets (known: ${Object.keys(targets).join(", ")})`;
  return undefined;
}

export function assertRouteTargets(domains: readonly Domain[], roles: readonly NamedKnobLayer[], targets: ModelTargets): void {
  const bad: string[] = [];
  const check = (route: ModelRoute | undefined, where: string): void => {
    if (route === undefined) return;
    if (Object.hasOwn(route, "providers")) {
      bad.push(`  ${where}: the key "providers" was renamed "providerOrder" (OPE-2556). Rename it. For a provider allowlist, set models.targets.<name>.providers.only`);
    }
    const problem = viaProblem(route.via, targets, where);
    if (problem !== undefined) bad.push(`  ${problem}`);
  };
  for (const [kind, layers] of [
    ["domain", domains],
    ["role", roles],
  ] as const) {
    for (const l of layers) {
      for (const role of ["primary", "utility", "supervisor"] as const) check(l.models?.[role], `${kind} "${l.name}" ${role} route`);
    }
  }
  if (bad.length > 0) throw new Error("open-everywhere: model route(s) that do not fit models.targets:\n" + bad.join("\n"));
}

export function modelTargetWords(t: ModelTarget): string {
  const words = ["Vercel AI Gateway"];
  if (t.url !== undefined) {
    try {
      words[0] = `Vercel AI Gateway at ${new URL(t.url).host}`;
    } catch {
    }
  }
  if (t.providers?.only !== undefined) words.push(`only ${t.providers.only.join(", ")}`);
  if (t.providers?.order !== undefined) words.push(`order ${t.providers.order.join(", ")}`);
  return words.join(", ");
}

export interface ResolvableModel {
  readonly id: string;
  readonly via?: string;
}

export function resolvableModels(
  roleModels: readonly ResolvableModel[],
  domains: readonly Domain[],
  layers: readonly NamedKnobLayer[],
  force: string,
): ResolvableModel[] {
  const out = new Map<string, ResolvableModel>();
  const add = (id: string | undefined, via: string | undefined): void => {
    if (id === undefined || id === "") return;
    const v = via ?? DEFAULT_MODEL_VIA;
    out.set(`${v}\u0000${id}`, v === DEFAULT_MODEL_VIA ? { id } : { id, via: v });
  };
  for (const m of roleModels) add(m.id, m.via);
  for (const l of [...domains, ...layers]) {
    for (const role of ["primary", "utility", "supervisor"] as const) add(l.models?.[role]?.id, l.models?.[role]?.via);
  }
  if (force !== "") for (const via of new Set([...out.values()].map((m) => m.via))) add(force, via);
  return [...out.values()];
}
