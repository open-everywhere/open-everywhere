export const DEPLOY_HOST_PLACEHOLDER = "YOUR-DEPLOY-URL";

export interface SurfaceAppManifestSource {
  readonly format: "json" | "yaml";
  readonly consoleUrl: string;
  readonly steps: readonly string[];
  readonly collect: readonly string[];
  readonly template: () => string;
}

export interface SurfaceAppManifest {
  readonly surface: string;
  readonly format: "json" | "yaml";
  readonly consoleUrl: string;
  readonly steps: readonly string[];
  readonly collect: readonly string[];
  readonly manifest: string;
  readonly host?: string;
  readonly placeholdersRemaining: number;
}

const SOURCES: Record<string, SurfaceAppManifestSource> = {};

export function registerSurfaceAppManifest(surface: string, source: SurfaceAppManifestSource): void {
  SOURCES[surface] = source;
}

export function _resetSurfaceAppManifestsForTest(): void {
  for (const k of Object.keys(SOURCES)) delete SOURCES[k];
}

export function surfaceAppManifestSurfaces(): string[] {
  return Object.keys(SOURCES).sort();
}

export function normalizeDeployHost(raw: string): string | undefined {
  const trimmed = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(trimmed)) return undefined;
  return trimmed;
}

export function surfaceAppManifest(surface: string, opts: { readonly host?: string } = {}): SurfaceAppManifest | undefined {
  const source = SOURCES[surface];
  if (source === undefined) return undefined;
  const template = source.template();
  const manifest = opts.host === undefined ? template : template.split(DEPLOY_HOST_PLACEHOLDER).join(opts.host);
  return {
    surface,
    format: source.format,
    consoleUrl: source.consoleUrl,
    steps: source.steps,
    collect: source.collect,
    manifest,
    ...(opts.host === undefined ? {} : { host: opts.host }),
    placeholdersRemaining: manifest.split(DEPLOY_HOST_PLACEHOLDER).length - 1,
  };
}
