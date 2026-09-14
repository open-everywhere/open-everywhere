export type SurfaceDisclosure =
  | "dm"
  | "open"
  | "unknown";

export interface DmMaskableRow {
  readonly surfaceKey: string;
  readonly surfaceMode?: string;
  readonly kind?: string;
}

export function surfaceDisclosureOf(row: DmMaskableRow): SurfaceDisclosure {
  if (row.surfaceMode === "dm") return "dm";
  if (row.surfaceMode === "channel" || row.surfaceMode === "mpim") return "open";
  if (row.kind === "dm") return "dm";
  if (row.kind === "channel") return "open";
  return "unknown";
}

export function foldDisclosure(rows: Iterable<DmMaskableRow>): SurfaceDisclosure {
  let open = false;
  for (const row of rows) {
    const disclosure = surfaceDisclosureOf(row);
    if (disclosure === "dm") return "dm";
    if (disclosure === "open") open = true;
  }
  return open ? "open" : "unknown";
}

export function dmBucketKey(surfaceKey: string): string {
  return bucketKey(surfaceKey, "(dms)");
}

export function unclassifiedBucketKey(surfaceKey: string): string {
  return bucketKey(surfaceKey, "(unclassified)");
}

function bucketKey(surfaceKey: string, bucket: string): string {
  const parts = surfaceKey.split("/");
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}/${bucket}` : bucket;
}

export function maskSurfaceKey(surfaceKey: string, disclosure: SurfaceDisclosure): string {
  switch (disclosure) {
    case "dm":
      return dmBucketKey(surfaceKey);
    case "unknown":
      return unclassifiedBucketKey(surfaceKey);
    default:
      return surfaceKey;
  }
}

export function maskedSurfaceKeyOf(row: DmMaskableRow): string {
  return maskSurfaceKey(row.surfaceKey, surfaceDisclosureOf(row));
}

export function maskDmSurfaceKey<T extends DmMaskableRow>(row: T): T {
  const masked = maskedSurfaceKeyOf(row);
  return masked === row.surfaceKey ? row : { ...row, surfaceKey: masked };
}
