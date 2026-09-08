export type SurfaceKeyEntry =
  | { readonly kind: "tenant"; readonly platform: string; readonly tenant: string }
  | {
      readonly kind: "surface" | "group";
      readonly platform: string;
      readonly tenant: string;
      readonly prefix: string;
      readonly glob: boolean;
    };

const GROUP_MARKER = ":";

export function isGroupSegment(segment: string): boolean {
  return segment.includes(GROUP_MARKER);
}

export function parseSurfaceKeyEntry(entry: string): SurfaceKeyEntry | undefined {
  const segs = entry.split("/");
  const [platform, tenant, surface] = segs;
  if (!platform || !tenant) return undefined;
  if (platform.includes("*") || tenant.includes("*")) return undefined;
  if (isGroupSegment(platform) || isGroupSegment(tenant)) return undefined;
  if (segs.length === 2) return { kind: "tenant", platform, tenant };
  if (segs.length !== 3 || surface === undefined) return undefined;
  const kind = isGroupSegment(surface) ? ("group" as const) : ("surface" as const);
  const star = surface.indexOf("*");
  if (star === -1) return surface === "" ? undefined : { kind, platform, tenant, prefix: surface, glob: false };
  if (star !== surface.length - 1) return undefined;
  const prefix = surface.slice(0, -1);
  return { kind, platform, tenant, prefix, glob: true };
}

export function surfaceKeyEntryMatches(e: SurfaceKeyEntry, key: string): boolean {
  const segs = key.split("/");
  if (segs[0] !== e.platform || segs[1] !== e.tenant) return false;
  if (e.kind === "tenant") return true;
  if (segs.length !== 3) return false;
  const last = segs[2] ?? "";
  if (isGroupSegment(last) !== (e.kind === "group")) return false;
  return e.glob ? last.startsWith(e.prefix) : last === e.prefix;
}

export function surfaceKeyEntriesIntersect(a: SurfaceKeyEntry, b: SurfaceKeyEntry): boolean {
  if (a.platform !== b.platform || a.tenant !== b.tenant) return false;
  if (a.kind === "tenant" || b.kind === "tenant") return true;
  if (a.kind !== b.kind) return false;
  if (a.glob && b.glob) return a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix);
  if (a.glob) return b.prefix.startsWith(a.prefix);
  if (b.glob) return a.prefix.startsWith(b.prefix);
  return a.prefix === b.prefix;
}

export function surfaceKeyEntriesEquivalent(a: SurfaceKeyEntry, b: SurfaceKeyEntry): boolean {
  return surfaceKeyEntryContains(a, b) && surfaceKeyEntryContains(b, a);
}

export function surfaceKeyEntryContains(outer: SurfaceKeyEntry, inner: SurfaceKeyEntry): boolean {
  if (outer.platform !== inner.platform || outer.tenant !== inner.tenant) return false;
  if (outer.kind === "tenant") return true;
  if (inner.kind === "tenant") return false;
  if (outer.kind !== inner.kind) return false;
  if (!outer.glob) return !inner.glob && inner.prefix === outer.prefix;
  return inner.prefix.startsWith(outer.prefix);
}

export function surfaceKeyEntrySpecificity(e: SurfaceKeyEntry): number {
  if (e.kind === "tenant") return 0;
  if (e.kind === "group") return 1;
  return e.glob ? 2 : 3;
}
