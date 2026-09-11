import { admitProviderRegistration } from "../access/provider-selection.js";

export interface SurfaceCommandScope {
  readonly scopes: readonly string[];
}

export type SurfaceCommandStatus = "unchanged" | "updated" | "skipped" | "failed" | "unsupported";

export interface SurfaceCommandOutcome {
  readonly status: SurfaceCommandStatus;
  readonly detail: string;
}

export type SurfaceCommandReconciler = (scope: SurfaceCommandScope) => Promise<SurfaceCommandOutcome>;

const SCOPES = new Map<string, SurfaceCommandScope>();
const RECONCILERS = new Map<string, SurfaceCommandReconciler>();

export function declareSurfaceCommandScope(platform: string, scope: SurfaceCommandScope): void {
  const key = typeof platform === "string" ? platform.trim() : "";
  if (key.length === 0) {
    throw new Error("declareSurfaceCommandScope: the platform must be a non-empty name (e.g. \"discord\").");
  }
  const seen = new Set<string>();
  for (const raw of scope.scopes) {
    const entry = typeof raw === "string" ? raw.trim() : "";
    if (entry.length === 0) {
      throw new Error(`declareSurfaceCommandScope("${key}"): a scope entry is blank. Every entry names one room (a Discord guild id).`);
    }
    if (seen.has(entry)) {
      throw new Error(`declareSurfaceCommandScope("${key}"): scope "${entry}" is listed twice. A room is registered once.`);
    }
    seen.add(entry);
  }
  if (seen.size === 0) {
    throw new Error(
      `declareSurfaceCommandScope("${key}"): the scope list is empty, so this declaration would register the commands nowhere. Name at least one room, or delete the declaration.`,
    );
  }
  SCOPES.set(key, { scopes: [...seen] });
}

export function registerSurfaceCommandReconciler(platform: string, reconciler: SurfaceCommandReconciler): void {
  if (!admitProviderRegistration(platform, "surface-command-reconciler")) return;
  RECONCILERS.set(platform, reconciler);
}

export function surfaceCommandScopeFor(platform: string): SurfaceCommandScope | undefined {
  return SCOPES.get(platform);
}

export interface SurfaceCommandReport {
  readonly platform: string;
  readonly outcome: SurfaceCommandOutcome;
}

export async function reconcileSurfaceCommands(deps: { readonly log?: (line: string) => void } = {}): Promise<readonly SurfaceCommandReport[]> {
  const log = deps.log ?? ((line: string): void => console.info(line));
  const reports: SurfaceCommandReport[] = [];
  for (const [platform, scope] of [...SCOPES.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const reconciler = RECONCILERS.get(platform);
    let outcome: SurfaceCommandOutcome;
    if (reconciler === undefined) {
      outcome = {
        status: "unsupported",
        detail: `no command reconciler is registered for "${platform}" — the declaration in the app's config names a platform this deployment does not carry, so nothing was registered.`,
      };
    } else {
      try {
        outcome = await reconciler(scope);
      } catch (err) {
        outcome = { status: "failed", detail: `the reconciler threw: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    reports.push({ platform, outcome });
    const line = `[open-everywhere:command-registration] ${platform}: ${outcome.status} — ${outcome.detail}`;
    if (outcome.status === "failed" || outcome.status === "unsupported") console.warn(line);
    else log(line);
  }
  return reports;
}

export function resetSurfaceCommandRegistryForTest(): void {
  SCOPES.clear();
  RECONCILERS.clear();
}
