export type SurfaceTrust = "internal";

export interface Surface {
  readonly key: string;
  readonly trust: SurfaceTrust;
}

const KNOWN_TRUST: ReadonlySet<string> = new Set<SurfaceTrust>(["internal"]);

const QUALIFIED_KEY = /^[^/]+\/[^/]+(?:\/[^/]+)?$/;

export function defineSurface(input: Surface): Surface {
  const { key, trust } = input;
  if (typeof key !== "string" || !QUALIFIED_KEY.test(key)) {
    throw new Error(
      `defineSurface: malformed surface key ${JSON.stringify(key)} — expected "<platform>/<workspace>" or "<platform>/<workspace>/<surface>" (2–3 non-empty, slash-free segments)`,
    );
  }
  if (!KNOWN_TRUST.has(trust)) {
    throw new Error(
      `defineSurface: unknown trust ${JSON.stringify(trust)} for surface "${key}" — known: ${[...KNOWN_TRUST].map((t) => JSON.stringify(t)).join(", ")}`,
    );
  }
  return { key, trust };
}

let surfaces: ReadonlyMap<string, Surface> = new Map();

export function registerSurfaces(input: Iterable<Surface>): void {
  const next = new Map<string, Surface>();
  for (const raw of input) {
    const existing = next.get(raw.key);
    if (existing && existing.trust !== raw.trust) {
      throw new Error(
        `registerSurfaces: conflicting trust for surface "${raw.key}" — ${JSON.stringify(existing.trust)} vs ${JSON.stringify(raw.trust)}. A key may be listed once; a reviewed config must not contradict itself.`,
      );
    }
    const s = defineSurface(raw);
    next.set(s.key, s);
  }
  surfaces = next;
}

export function _resetSurfacesForTest(): void {
  surfaces = new Map();
}

function isInternalAt(key: string): boolean {
  return surfaces.get(key)?.trust === "internal";
}

export function isVouchedInternal(workspaceKey: string, surfaceKey: string): boolean {
  return isInternalAt(workspaceKey) || isInternalAt(surfaceKey);
}

export function isVouchedSurface(surfaceKey: string): boolean {
  return isInternalAt(surfaceKey);
}

export function vouchedSurfaces(): string[] {
  return [...surfaces.values()].filter((s) => s.trust === "internal").map((s) => s.key);
}
