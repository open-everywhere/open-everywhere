import { getSettings } from "../settings/settings.js";
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
}

const KNOWN_TRUST: ReadonlySet<string> = new Set<SurfaceTrust>(["internal", "public"]);

export function defineSurface(input: Surface): Surface {
  const { key, trust } = input;
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
  return { key, trust };
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
}

export function _resetSurfacesForTest(): void {
  surfaces = [];
}

export interface SurfaceTrustQuery {
  readonly tenantKey: string;
  readonly surfaceKeys: readonly string[];
  readonly groupKey?: string;
}

export function declaredSurfaceTrust(q: SurfaceTrustQuery): SurfaceTrust | undefined {
  const keys = [...q.surfaceKeys, ...(q.groupKey === undefined ? [] : [q.groupKey]), q.tenantKey];
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

export function isVouchedSurface(surfaceKey: string): boolean {
  const hit = surfaces.find((e) => e.surface.key === surfaceKey);
  return hit?.surface.trust === "internal";
}

export function declaredWorkspaceTrust(workspaceKey: string): SurfaceTrust | undefined {
  return declaredSurfaceTrust({ tenantKey: workspaceKey, surfaceKeys: [workspaceKey] });
}

export function registeredSurfaces(): readonly Surface[] {
  return surfaces.map((e) => e.surface);
}

export function dmTrustTtlMs(): number {
  return getSettings().identity.dmTrustTtlMs;
}
