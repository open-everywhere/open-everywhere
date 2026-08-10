export type ContributionKind = "tool" | "channel" | "hook" | "schedule" | "connection" | "skill";

export const CONTRIBUTION_KINDS: readonly ContributionKind[] = [
  "tool",
  "channel",
  "hook",
  "schedule",
  "connection",
  "skill",
];

export const SLOT_DIR: Readonly<Record<ContributionKind, string>> = {
  tool: "tools",
  channel: "channels",
  hook: "hooks",
  schedule: "schedules",
  connection: "connections",
  skill: "skills",
};

export interface Contribution {
  readonly kind: ContributionKind;
  readonly name: string;
  readonly module: string;
  readonly summary?: string;
  readonly since?: string;
}

export interface ContributionManifest {
  readonly schemaVersion: 1;
  readonly package: string;
  readonly contributions: readonly Contribution[];
  readonly register?: string;
}

export type ContributionKey = string;

export interface RosterPackageConfig {
  readonly exclude?: Readonly<Record<ContributionKey, string>>;
  readonly note?: Readonly<Record<ContributionKey, string>>;
  readonly about?: string;
}

export type RosterPackageDecision = boolean | RosterPackageConfig;

export interface RosterFrameworkConfig {
  readonly disable?: Readonly<Record<string, string>>;
}

export interface RosterConfig {
  readonly framework?: RosterFrameworkConfig;
  readonly core?: RosterPackageDecision;
  readonly adapters?: RosterPackageDecision;
  readonly providers?: Readonly<Record<string, RosterPackageDecision>>;
  readonly packages?: Readonly<Record<string, RosterPackageDecision>>;
  readonly subagents?: Readonly<Record<string, { readonly framework?: RosterFrameworkConfig }>>;
  readonly output?: {
    readonly agentDir?: string;
  };
}

export function defineRoster(config: RosterConfig): RosterConfig {
  return config;
}

export type LockedDecision = "mounted" | "excluded";

export interface LockedPackage {
  readonly version: string;
  readonly contributions: Readonly<Record<string, LockedDecision>>;
}

export interface RosterLock {
  readonly schemaVersion: 1;
  readonly generator: number;
  readonly framework: Readonly<Record<string, "disabled">>;
  readonly packages: Readonly<Record<string, LockedPackage>>;
}

export const ROSTER_GENERATOR_VERSION = 1;
