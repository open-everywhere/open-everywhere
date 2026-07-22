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

export interface ProviderCredential {
  readonly id: string;
  readonly type: ProviderCredentialType;
  readonly secretRef?: string;
  readonly broker?: string;
  readonly intake?: boolean;
  readonly vercelConnector?: string;
  readonly executor?: ExecutorConnectionRef;
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
  readonly vercelConnector?: string;
  readonly executor?: ExecutorConnectionRef;
}

export function defineProvider(p: Provider): Provider {
  return p;
}

export interface ExclusiveCredentialHome {
  readonly name: string;
  declares(cred: ProviderCredential): boolean;
  validateShape(cred: ProviderCredential, where: string): void;
}

const EXCLUSIVE_HOMES = new Map<string, ExclusiveCredentialHome>();

export function registerExclusiveCredentialHome(home: ExclusiveCredentialHome): void {
  EXCLUSIVE_HOMES.set(home.name, home);
}

export function resetExclusiveCredentialHomes(): void {
  EXCLUSIVE_HOMES.clear();
  registerCoreExclusiveHomes();
}

function registerCoreExclusiveHomes(): void {
  registerExclusiveCredentialHome({
    name: "executor",
    declares: (c) => c.executor !== undefined,
    validateShape: (c, where) => {
      const e = c.executor!;
      if (!e.integration || !e.owner || !e.connection) {
        throw new Error(`${where}: executor binding needs non-empty { integration, owner, connection }`);
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

      const declared = [...EXCLUSIVE_HOMES.values()].filter((h) => h.declares(c));
      if (declared.length > 1) {
        throw new Error(`${where}: declares more than one exclusive home (${declared.map((h) => h.name).join(", ")}) — a credential has exactly one home`);
      }
      if (declared.length === 1) {
        const h = declared[0];
        h.validateShape(c, where);
        if (c.secretRef) throw new Error(`${where}: an ${h.name}-homed credential must NOT carry a secretRef — its secret lives inside ${h.name}, not on a broker (one home; mutual exclusivity)`);
        if (c.broker) throw new Error(`${where}: an ${h.name}-homed credential must NOT carry a broker — the exclusive home is the connector-plane transport, not a token-vending broker (mutual exclusivity)`);
        if (c.vercelConnector) throw new Error(`${where}: an ${h.name}-homed credential must NOT carry a vercelConnector — its OAuth is minted + held inside ${h.name} (mutual exclusivity)`);
      } else {
        if (c.type === "api-key" && !c.secretRef) throw new Error(`${where}: api-key needs a secretRef`);
        if (c.type === "api-key" && !c.broker) {
          throw new Error(`${where}: api-key needs an explicit broker stamp ("env" | "db" | ...) — a credential has exactly one home; unstamped-follows-selection is not allowed`);
        }
        if ((c.type === "service-oauth" || c.type === "user-oauth") && !c.vercelConnector) {
          throw new Error(`${where}: ${c.type} needs a vercelConnector`);
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
      vercelConnector: cred.vercelConnector,
      executor: cred.executor,
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
