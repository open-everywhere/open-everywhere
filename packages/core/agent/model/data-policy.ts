const DATA_POLICY_REGIONS = ["eu", "us"] as const;
export type DataPolicyRegion = (typeof DATA_POLICY_REGIONS)[number];

export interface ModelDataPolicy {
  readonly zeroRetention?: boolean;
  readonly noTraining?: boolean;
  readonly region?: DataPolicyRegion;
}

const KEYS = ["zeroRetention", "noTraining", "region"] as const;

export function validateDataPolicy(v: unknown): string | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return "must be an object: { zeroRetention?, noTraining?, region? }";
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!(KEYS as readonly string[]).includes(k)) return `unknown row "${k}" — valid rows: ${KEYS.join(", ")}`;
  }
  for (const k of ["zeroRetention", "noTraining"] as const) {
    if (o[k] !== undefined && typeof o[k] !== "boolean") return `${k} must be true or false`;
  }
  if (o["region"] !== undefined && !(DATA_POLICY_REGIONS as readonly unknown[]).includes(o["region"])) {
    return `region must be one of ${DATA_POLICY_REGIONS.map((r) => `"${r}"`).join(", ")}`;
  }
  return undefined;
}

export function dataPolicyRows(p: ModelDataPolicy): string[] {
  const rows: string[] = [];
  if (p.zeroRetention === true) rows.push("zeroRetention");
  if (p.noTraining === true) rows.push("noTraining");
  if (p.region !== undefined) rows.push(`region ${p.region}`);
  return rows;
}

export function dataPolicyActive(p: ModelDataPolicy): boolean {
  return dataPolicyRows(p).length > 0;
}

export function dataPolicyWords(p: ModelDataPolicy): string {
  const words: string[] = [];
  if (p.zeroRetention === true) words.push("zero retention");
  if (p.noTraining === true) words.push("no training");
  if (p.region !== undefined) words.push(`region ${p.region.toUpperCase()}`);
  return words.length > 0 ? words.join(", ") : "none";
}
