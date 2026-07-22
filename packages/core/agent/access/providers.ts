export type ProviderCredentialType = "api-key" | "service-oauth" | "user-oauth";

export function principalOf(type: ProviderCredentialType): "app" | "user" {
  return type === "user-oauth" ? "user" : "app";
}

export interface ExecutorConnectionRef {
  readonly integration: string;
  readonly owner: string;
  readonly connection: string;
  readonly client?: string;
  readonly template?: string;
}

export interface CredentialHomeRef {
  readonly kind: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export const EXECUTOR_HOME_KIND = "executor";
export const VERCEL_CONNECT_HOME_KIND = "vercel-connect";

export function executorHome(config: ExecutorConnectionRef): CredentialHomeRef {
  return { kind: EXECUTOR_HOME_KIND, config: config as unknown as Readonly<Record<string, unknown>> };
}

export function vercelConnectorHome(connector: string): CredentialHomeRef {
  return { kind: VERCEL_CONNECT_HOME_KIND, config: { connector } };
}

export function executorHomeOf(cred: { readonly home?: CredentialHomeRef }): ExecutorConnectionRef | undefined {
  return cred.home?.kind === EXECUTOR_HOME_KIND ? (cred.home.config as unknown as ExecutorConnectionRef) : undefined;
}

export function vercelConnectorOf(cred: { readonly home?: CredentialHomeRef }): string | undefined {
  if (cred.home?.kind !== VERCEL_CONNECT_HOME_KIND) return undefined;
  const c = cred.home.config.connector;
  return typeof c === "string" ? c : undefined;
}

export interface ProviderCredential {
  readonly id: string;
  readonly type: ProviderCredentialType;
  readonly secretRef?: string;
  readonly broker?: string;
  readonly intake?: boolean;
  readonly home?: CredentialHomeRef;
  readonly dashboardUrl?: string;
}

export interface Provider {
  readonly name: string;
  readonly connection: string;
  readonly allows: readonly ProviderCredentialType[];
  readonly credentials: readonly ProviderCredential[];
  readonly skill?: string;
  readonly description?: string;
}

export interface ProviderGrant {
  readonly provider: string;
  readonly credential: string;
}

export interface ResolvedConnectorCredential {
  readonly connection: string;
  readonly provider: string;
  readonly credential: string;
  readonly type: ProviderCredentialType;
  readonly principal: "app" | "user";
  readonly secretRef?: string;
  readonly broker?: string;
  readonly home?: CredentialHomeRef;
}

export function defineProvider(p: Provider): Provider {
  return p;
}

export interface ExclusiveCredentialHome {
  readonly name: string;
  readonly validFor: readonly ProviderCredentialType[];
  validateConfig(config: Readonly<Record<string, unknown>>, where: string): void;
}

const EXCLUSIVE_HOMES = new Map<string, ExclusiveCredentialHome>();

export function registerExclusiveCredentialHome(home: ExclusiveCredentialHome): void {
  EXCLUSIVE_HOMES.set(home.name, home);
}

export function resetExclusiveCredentialHomes(): void {
  EXCLUSIVE_HOMES.clear();
  registerCoreExclusiveHomes();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function registerCoreExclusiveHomes(): void {
  registerExclusiveCredentialHome({
    name: EXECUTOR_HOME_KIND,
    validFor: ["api-key", "service-oauth", "user-oauth"],
    validateConfig: (config, where) => {
      const e = config as Partial<ExecutorConnectionRef>;
      if (!isRecord(config) || !e.integration || !e.owner || !e.connection) {
        throw new Error(`${where}: executor binding needs non-empty { integration, owner, connection }`);
      }
    },
  });
  registerExclusiveCredentialHome({
    name: VERCEL_CONNECT_HOME_KIND,
    validFor: ["service-oauth", "user-oauth"],
    validateConfig: (config, where) => {
      if (!isRecord(config) || typeof config.connector !== "string" || !config.connector) {
        throw new Error(`${where}: vercel-connect home needs a non-empty { connector }`);
      }
    },
  });
}
registerCoreExclusiveHomes();

export function assertProvidersValid(providers: readonly Provider[]): void {
  const seen = new Set<string>();
  for (const p of providers) {
    if (!p.name) throw new Error("provider: missing name");
    if (seen.has(p.name)) throw new Error(`provider "${p.name}": duplicate name`);
    seen.add(p.name);
    if (!p.connection) throw new Error(`provider "${p.name}": missing connection slug`);
    if (!p.allows.length) throw new Error(`provider "${p.name}": empty credential allowlist`);
    const credIds = new Set<string>();
    for (const c of p.credentials) {
      if (credIds.has(c.id)) throw new Error(`provider "${p.name}": duplicate credential id "${c.id}"`);
      credIds.add(c.id);
      const where = `provider "${p.name}" credential "${c.id}"`;

      if (c.home) {
        const h = EXCLUSIVE_HOMES.get(c.home.kind);
        if (!h) {
          throw new Error(`${where}: unknown credential home kind "${c.home.kind}" — no ExclusiveCredentialHome is registered for it (register one; a new home vendor is registration-only)`);
        }
        if (!h.validFor.includes(c.type)) {
          throw new Error(`${where}: a ${c.type} credential cannot be homed at "${h.name}" (valid for: ${h.validFor.join(", ")})`);
        }
        h.validateConfig(c.home.config, where);
        if (c.secretRef) throw new Error(`${where}: a ${h.name}-homed credential must NOT carry a secretRef — its secret lives at the ${h.name} home, not on a broker (one home; mutual exclusivity)`);
        if (c.broker) throw new Error(`${where}: a ${h.name}-homed credential must NOT carry a broker — the home is the connector-plane transport, not a token-vending broker (mutual exclusivity)`);
      } else {
        if (c.type === "api-key" && !c.secretRef) throw new Error(`${where}: api-key needs a secretRef`);
        if (c.type === "api-key" && !c.broker) {
          throw new Error(`${where}: api-key needs an explicit broker stamp ("env" | "db" | ...) — a credential has exactly one home; unstamped-follows-selection is not allowed`);
        }
        if (c.type === "service-oauth" || c.type === "user-oauth") {
          throw new Error(`${where}: ${c.type} needs a home — a vercel-connect connector (vercelConnectorHome) or an exclusive vendor home (e.g. executorHome)`);
        }
      }

      if (c.intake === false && c.type !== "api-key") {
        throw new Error(`${where}: intake:false is only valid on an api-key credential (it marks operator-env plumbing that is never offered for intake)`);
      }
    }
  }
}

export function expandProviderGrant(
  grant: ProviderGrant,
  provider: Provider | undefined,
  opts: { readonly dm: boolean },
): { resolved: ResolvedConnectorCredential | null; warnings: readonly string[] } {
  if (!provider) {
    return { resolved: null, warnings: [`grant references unknown provider "${grant.provider}" — ignored`] };
  }
  const cred = provider.credentials.find((c) => c.id === grant.credential);
  if (!cred) {
    return {
      resolved: null,
      warnings: [`provider "${provider.name}": grant references unknown credential "${grant.credential}" — ignored`],
    };
  }
  const principal = principalOf(cred.type);

  if (principal === "user" && !opts.dm) {
    return {
      resolved: null,
      warnings: [
        `provider "${provider.name}": credential "${cred.id}" is user-principal (${cred.type}) — ` +
          `personal credentials resolve only in DMs, never on a channel/domain binding. Ignored.`,
      ],
    };
  }

  if (!provider.allows.includes(cred.type)) {
    return {
      resolved: null,
      warnings: [
        `provider "${provider.name}": credential "${cred.id}" (${cred.type}) is not in the connection's ` +
          `allowlist (${provider.allows.join(", ")}) — ignored`,
      ],
    };
  }

  return {
    resolved: {
      connection: provider.connection,
      provider: provider.name,
      credential: cred.id,
      type: cred.type,
      principal,
      secretRef: cred.secretRef,
      broker: cred.broker,
      home: cred.home,
    },
    warnings: [],
  };
}

let registeredProviders: readonly Provider[] = [];

export function setRegisteredProviders(providers: readonly Provider[]): void {
  registeredProviders = providers;
}

export function resetRegisteredProviders(): void {
  registeredProviders = [];
}

export function findProviderCredential(providerName: string, credentialId: string): ProviderCredential | undefined {
  const provider = registeredProviders.find((p) => p.name === providerName);
  return provider?.credentials.find((c) => c.id === credentialId);
}
