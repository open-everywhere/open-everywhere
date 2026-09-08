import { getSettings } from "../settings/settings.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import {
  parseSurfaceKeyEntry,
  surfaceKeyEntriesIntersect,
  surfaceKeyEntryMatches,
  surfaceKeyEntrySpecificity,
  type SurfaceKeyEntry,
} from "./surface-key-grammar.js";

export type SurfaceTrust = "internal" | "public";

export interface Surface {
  readonly key: string;
  readonly trust: SurfaceTrust;
  readonly subtree?: boolean;
}

const KNOWN_TRUST: ReadonlySet<string> = new Set<SurfaceTrust>(["internal", "public"]);

export function defineSurface(input: Surface): Surface {
  const { key, trust, subtree } = input;
  const parsed = typeof key === "string" ? parseSurfaceKeyEntry(key) : undefined;
  if (!parsed) {
    throw new Error(
      `defineSurface: malformed surface key ${JSON.stringify(key)} — expected "<platform>/<tenant>", "<platform>/<tenant>/<surface>", a same-level glob "<platform>/<tenant>/<prefix>*" (ONE trailing "*", last segment only), or a group rung "<platform>/<tenant>/<marker>:<id>" (e.g. "teams/<tenantId>/team:<teamId>")`,
    );
  }
  if (!KNOWN_TRUST.has(trust)) {
    throw new Error(
      `defineSurface: unknown trust ${JSON.stringify(trust)} for surface "${key}" — known: ${[...KNOWN_TRUST].map((t) => JSON.stringify(t)).join(", ")}. "external" is NOT a value: it is the fail-closed default of an unlisted surface, and "public" is how an operator DECLARES a room external.`,
    );
  }
  if (subtree !== undefined && typeof subtree !== "boolean") {
    throw new Error(
      `defineSurface: subtree must be a boolean for surface "${key}", not ${JSON.stringify(subtree)}. Write \`subtree: true\` to vouch the whole subtree, or leave it out to vouch that one surface.`,
    );
  }
  if (subtree !== true) return { key, trust };
  if (parsed.kind !== "surface" || parsed.glob) {
    throw new Error(
      `defineSurface: subtree: true needs ONE EXACT surface key, and "${key}" is not one (it is a ${parsed.kind === "tenant" ? "whole tenant" : parsed.kind === "group" ? "group rung" : "same-level glob"}). A tenant already covers every surface under it at any depth, and a glob names a set nobody enumerated — neither leaves a subtree to walk. Name the one surface the subtree hangs from.`,
    );
  }
  if (trust !== "internal") {
    throw new Error(
      `defineSurface: subtree: true is only declarable with trust: "internal", not ${JSON.stringify(trust)} (surface "${key}"). The subtree form exists to PROMOTE a set of surfaces the key cannot name, and only the promotion has a resolver — a platform's subtree walk answers "is this under a declared root?". A "public" subtree would be a demotion nothing reads, so it is refused instead of accepted and ignored.`,
    );
  }
  return { key, trust, subtree: true };
}

interface RegisteredSurface {
  readonly surface: Surface;
  readonly parsed: SurfaceKeyEntry;
  readonly specificity: number;
}

let surfaces: readonly RegisteredSurface[] = [];

export function registerSurfaces(input: Iterable<Surface>): void {
  const next: RegisteredSurface[] = [];
  for (const raw of input) {
    const existing = next.find((e) => e.surface.key === raw.key);
    if (existing && existing.surface.trust !== raw.trust) {
      throw new Error(
        `registerSurfaces: conflicting trust for surface "${raw.key}" — ${JSON.stringify(existing.surface.trust)} vs ${JSON.stringify(raw.trust)}. A key may be listed once; a reviewed config must not contradict itself.`,
      );
    }
    if (existing && existing.surface.subtree !== (raw.subtree === true ? true : undefined)) {
      throw new Error(
        `registerSurfaces: conflicting subtree claim for surface "${raw.key}" — one line declares \`subtree: true\` and another does not. A key may be listed once; a reviewed config must not contradict itself.`,
      );
    }
    const s = defineSurface(raw);
    if (existing) continue;
    const parsed = parseSurfaceKeyEntry(s.key)!;
    next.push({ surface: s, parsed, specificity: surfaceKeyEntrySpecificity(parsed) });
  }
  for (let i = 0; i < next.length; i++) {
    for (let j = i + 1; j < next.length; j++) {
      const a = next[i];
      const b = next[j];
      if (a.specificity !== b.specificity) continue;
      if (a.surface.trust === b.surface.trust) continue;
      if (!surfaceKeyEntriesIntersect(a.parsed, b.parsed)) continue;
      throw new Error(
        `registerSurfaces: "${a.surface.key}" (${a.surface.trust}) and "${b.surface.key}" (${b.surface.trust}) are equally specific and can match the SAME surface with DIFFERENT trust — the winner would be declaration order, which is not a decision anyone reviewed. Narrow one of them, or make an EXACT entry for the overlap (an exact key always beats a glob).`,
      );
    }
  }
  surfaces = next;
  for (const [platform, handler] of subtreePlatforms) handler(subtreeSurfaceKeys(platform));
}

export function _resetSurfacesForTest(): void {
  surfaces = [];
  for (const [platform, handler] of subtreePlatforms) handler(subtreeSurfaceKeys(platform));
}

export type SubtreeSurfaceHandler = (keys: readonly string[]) => void;

const subtreePlatforms = new Map<string, SubtreeSurfaceHandler>();

export function registerSubtreePlatform(platform: string, handler: SubtreeSurfaceHandler): void {
  if (!admitProviderRegistration(platform, "subtree-surfaces")) return;
  subtreePlatforms.set(platform, handler);
  handler(subtreeSurfaceKeys(platform));
}

export function _resetSubtreePlatformsForTest(): void {
  subtreePlatforms.clear();
}

export function subtreeSurfaceKeys(platform: string): readonly string[] {
  return surfaces.filter((e) => e.surface.subtree === true && e.parsed.platform === platform).map((e) => e.surface.key);
}

export function applySubtreeSurfaceClaims(): void {
  const unowned = surfaces.filter((e) => e.surface.subtree === true && !subtreePlatforms.has(e.parsed.platform));
  if (unowned.length > 0) {
    const platforms = [...new Set(unowned.map((e) => e.parsed.platform))].sort();
    throw new Error(
      `applySubtreeSurfaceClaims: subtree: true is declared on ${unowned.map((e) => JSON.stringify(e.surface.key)).join(", ")}, but ${platforms.map((p) => JSON.stringify(p)).join(", ")} does not honour it. A surface key on that platform already names a whole room, so there is no subtree to walk and the line would grant nothing. Either the entry means one surface — drop \`subtree\` — or the bundle that honours it is not selected by this deployment (roster.config.ts).`,
    );
  }
  for (const [platform, handler] of subtreePlatforms) handler(subtreeSurfaceKeys(platform));
}

export interface SurfaceTrustQuery {
  readonly tenantKey: string;
  readonly surfaceKeys: readonly string[];
  readonly groupKey?: string;
  readonly enterpriseKey?: string;
}

export function declaredSurfaceTrust(q: SurfaceTrustQuery): SurfaceTrust | undefined {
  const keys = [
    ...q.surfaceKeys,
    ...(q.groupKey === undefined ? [] : [q.groupKey]),
    q.tenantKey,
    ...(q.enterpriseKey === undefined ? [] : [q.enterpriseKey]),
  ];
  let best: { readonly trust: SurfaceTrust; readonly specificity: number; readonly keyIndex: number } | undefined;
  for (const e of surfaces) {
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      if (!surfaceKeyEntryMatches(e.parsed, keys[keyIndex])) continue;
      const better =
        best === undefined ||
        e.specificity > best.specificity ||
        (e.specificity === best.specificity && keyIndex < best.keyIndex);
      if (better) best = { trust: e.surface.trust, specificity: e.specificity, keyIndex };
      break;
    }
  }
  return best?.trust;
}

export function declaredTrustForKeys(workspaceKey: string, surfaceKey: string): SurfaceTrust | undefined {
  return declaredSurfaceTrust({ tenantKey: workspaceKey, surfaceKeys: [surfaceKey] });
}

export function isVouchedInternal(workspaceKey: string, surfaceKey: string): boolean {
  return declaredTrustForKeys(workspaceKey, surfaceKey) === "internal";
}

export function isVouchedSurface(
  surfaceKey: string,
  opts?: {
    readonly containerKey?: string;
    readonly groupKey?: string;
  },
): boolean {
  const containerKey = opts?.containerKey;
  return (
    declaredSurfaceTrust({
      tenantKey: tenantKeyOfSurfaceKey(surfaceKey),
      surfaceKeys: containerKey === undefined || containerKey === surfaceKey ? [surfaceKey] : [surfaceKey, containerKey],
      ...(opts?.groupKey === undefined ? {} : { groupKey: opts.groupKey }),
    }) === "internal"
  );
}

type FloorSuppliedRung = "tenantKey" | "surfaceKeys" | "groupKey";

export const FLOOR_UNREACHABLE_RUNGS: Readonly<Record<Exclude<keyof SurfaceTrustQuery, FloorSuppliedRung>, string>> = {
  enterpriseKey:
    "a Grid enterprise id sits ABOVE the workspace and appears in no surface key, so a reader holding one key cannot derive it — `bindFrom` reads it off the event envelope instead (identity/binding.ts `trustEnterpriseKey`). FAIL-CLOSED: a Grid-only declaration binds every workspace under it internal, and this floor answers `false` for the same room.",
};

function tenantKeyOfSurfaceKey(surfaceKey: string): string {
  return surfaceKey.split("/").slice(0, 2).join("/");
}

export function declaredWorkspaceTrust(workspaceKey: string, enterpriseKey?: string): SurfaceTrust | undefined {
  return declaredSurfaceTrust({
    tenantKey: workspaceKey,
    surfaceKeys: [workspaceKey],
    ...(enterpriseKey === undefined ? {} : { enterpriseKey }),
  });
}

export function registeredSurfaces(): readonly Surface[] {
  return surfaces.map((e) => e.surface);
}

export function dmTrustTtlMs(): number {
  return getSettings().identity.dmTrustTtlMs;
}
