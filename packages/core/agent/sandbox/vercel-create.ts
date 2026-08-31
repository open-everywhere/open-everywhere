export const KNOWN_SANDBOX_REGIONS = ["iad1", "sfo1", "cle1", "cdg1"] as const;

export const DEFAULT_SANDBOX_REGION = "iad1";

export const SANDBOX_REGION_PASSTHROUGH_SUPPORTED = false;

export const SANDBOX_REGION_GAP =
  "eve 0.47.2 creates every Vercel sandbox through its own vendored @vercel/sandbox, whose " +
  "Sandbox.create enumerates the fields it forwards and has no `region` among them — a region " +
  "set here would be DROPPED SILENTLY and the sandbox would run in the default region. The same " +
  "eve vendors a newer copy that does forward a region (@vercel/sandbox-delete), but loads it only " +
  "on the delete path, and the create path's module seam is package-internal";

const REGION_SHAPE = /^[a-z]{3}[0-9]$/;

export function normalizeSandboxRegion(raw: string): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

export function sandboxRegionProblem(raw: string): string | undefined {
  if (typeof raw !== "string") return "must be a string";
  const region = normalizeSandboxRegion(raw);
  if (region === "") return undefined;
  if (!REGION_SHAPE.test(region)) {
    return (
      `must be a Vercel region id — three lowercase letters then a digit, e.g. ` +
      `${KNOWN_SANDBOX_REGIONS.join(", ")} — or "" to pin nothing`
    );
  }
  return undefined;
}

export type SandboxRegionPlan =
  | { readonly kind: "unset" }
  | { readonly kind: "invalid"; readonly error: string }
  | { readonly kind: "inert"; readonly warn: string }
  | { readonly kind: "refused"; readonly error: string }
  | { readonly kind: "pinned"; readonly region: string; readonly info: string };

export function resolveSandboxRegionPlan(input: {
  readonly region: string;
  readonly onVercel: boolean;
  readonly passthroughSupported?: boolean;
}): SandboxRegionPlan {
  const passthroughSupported = input.passthroughSupported ?? SANDBOX_REGION_PASSTHROUGH_SUPPORTED;
  const region = normalizeSandboxRegion(input.region);
  if (region === "") return { kind: "unset" };

  const problem = sandboxRegionProblem(region);
  if (problem !== undefined) {
    return {
      kind: "invalid",
      error: `[open-everywhere:sandbox] sandbox.region=${JSON.stringify(input.region)} ${problem}. Refusing to boot.`,
    };
  }

  if (!input.onVercel) {
    return {
      kind: "inert",
      warn:
        `[open-everywhere:sandbox] ⚠ sandbox.region=${region} is a VERCEL-BACKEND knob and does nothing here. ` +
        `The docker/justbash backend runs on the host you run it on — that host, not this setting, is where ` +
        `sandbox compute happens.`,
    };
  }

  if (!passthroughSupported) {
    return {
      kind: "refused",
      error:
        `[open-everywhere:sandbox] sandbox.region=${region} cannot be honoured: ${SANDBOX_REGION_GAP}. ` +
        `Refusing to boot rather than run in ${DEFAULT_SANDBOX_REGION} under a residency pin. ` +
        `Clear sandbox.region to boot without the pin (and drop the sandbox leg of any residency claim), ` +
        `or move to an eve whose CREATE path forwards the region.`,
    };
  }

  return {
    kind: "pinned",
    region,
    info: `[open-everywhere:sandbox] sandbox region = ${region} (pinned at sandbox CREATE; existing sandboxes keep theirs)`,
  };
}

export type OeVercelCreateOptions = {
  readonly timeout: number;
  readonly snapshotExpiration: number;
  readonly keepLastSnapshots: { readonly count: number; readonly deleteEvicted: boolean };
  readonly region?: string;
};

export function vercelSandboxCreateOptions(input: {
  readonly timeoutMs: number;
  readonly snapshotExpirationMs: number;
  readonly regionPlan: SandboxRegionPlan;
}): OeVercelCreateOptions {
  const base = {
    timeout: input.timeoutMs,
    snapshotExpiration: input.snapshotExpirationMs,
    keepLastSnapshots: { count: 1, deleteEvicted: true },
  } as const;
  return input.regionPlan.kind === "pinned" ? { ...base, region: input.regionPlan.region } : base;
}
