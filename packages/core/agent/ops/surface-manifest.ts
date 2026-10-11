export const DEPLOY_HOST_PLACEHOLDER = "YOUR-DEPLOY-URL";

export interface SurfaceAppManifestSource {
  readonly format: "json" | "yaml";
  readonly consoleUrl: string;
  readonly steps: readonly string[];
  readonly collect: readonly string[];
  readonly template: (opts: { readonly appName?: string }) => string;
  readonly appNameMax?: number;
}

export interface SurfaceAppManifest {
  readonly surface: string;
  readonly format: "json" | "yaml";
  readonly consoleUrl: string;
  readonly steps: readonly string[];
  readonly collect: readonly string[];
  readonly manifest: string;
  readonly host?: string;
  readonly appName?: string;
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

export function surfaceAppNameProblem(surface: string, raw: string): string | undefined {
  const source = SOURCES[surface];
  if (source === undefined) return undefined;
  if (source.appNameMax === undefined) return `the "${surface}" manifest takes no app name`;
  const name = raw.trim();
  if (name === "") return "the app name is empty";
  if (name.length > source.appNameMax) return `the app name is ${name.length} characters; the "${surface}" console accepts at most ${source.appNameMax}`;
  if (/[\x00-\x1f\x7f]/.test(name)) return "the app name holds a control character";
  return undefined;
}

export function surfaceAppManifest(
  surface: string,
  opts: { readonly host?: string; readonly appName?: string } = {},
): SurfaceAppManifest | undefined {
  const source = SOURCES[surface];
  if (source === undefined) return undefined;
  const appName =
    opts.appName === undefined || surfaceAppNameProblem(surface, opts.appName) !== undefined ? undefined : opts.appName.trim();
  const template = source.template(appName === undefined ? {} : { appName });
  const manifest = opts.host === undefined ? template : template.split(DEPLOY_HOST_PLACEHOLDER).join(opts.host);
  return {
    surface,
    format: source.format,
    consoleUrl: source.consoleUrl,
    steps: source.steps,
    collect: source.collect,
    manifest,
    ...(opts.host === undefined ? {} : { host: opts.host }),
    ...(appName === undefined ? {} : { appName }),
    placeholdersRemaining: manifest.split(DEPLOY_HOST_PLACEHOLDER).length - 1,
  };
}

export interface SurfaceAppPackageFinding {
  readonly id: string;
  readonly level: "block" | "warn";
  readonly detail: string;
  readonly fix?: string;
}

export type SurfaceAppListingRoute = "org" | "store";

export interface SurfaceAppPackageInput {
  readonly host: string;
  readonly appName?: string;
  readonly route: SurfaceAppListingRoute;
  readonly developerName?: string;
  readonly partnerId?: string;
  readonly version?: string;
  readonly supportContact?: string;
  readonly channelFeatures?: "omit" | "tier1";
  readonly icons: Readonly<Record<string, Uint8Array | undefined>>;
  readonly env: NodeJS.ProcessEnv;
}

export interface SurfaceAppPackageResult {
  readonly findings: readonly SurfaceAppPackageFinding[];
  readonly manifest: string;
  readonly archive?: Uint8Array;
  readonly fileName: string;
  readonly steps: readonly string[];
}

export interface SurfaceAppPackageSource {
  readonly icons: Readonly<Record<string, string>>;
  readonly outDir: string;
  readonly build: (input: SurfaceAppPackageInput) => SurfaceAppPackageResult;
}

const PACKAGE_SOURCES: Record<string, SurfaceAppPackageSource> = {};

export function registerSurfaceAppPackage(surface: string, source: SurfaceAppPackageSource): void {
  PACKAGE_SOURCES[surface] = source;
}

export function surfaceAppPackageSource(surface: string): SurfaceAppPackageSource | undefined {
  return PACKAGE_SOURCES[surface];
}

export function surfaceAppPackageSurfaces(): string[] {
  return Object.keys(PACKAGE_SOURCES).sort();
}

export function _resetSurfaceAppPackagesForTest(): void {
  for (const k of Object.keys(PACKAGE_SOURCES)) delete PACKAGE_SOURCES[k];
}
