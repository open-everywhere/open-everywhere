export type ProviderCredentialType = "api-key" | "service-oauth" | "user-oauth";

export function principalOf(type: ProviderCredentialType): "app" | "user" {
  return type === "user-oauth" ? "user" : "app";
}

export interface ProviderCredential {
  readonly id: string;
  readonly type: ProviderCredentialType;
  readonly secretRef?: string;
  readonly broker?: string;
  readonly vercelConnector?: string;
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
}

export function defineProvider(p: Provider): Provider {
  return p;
}

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
      if (c.type === "api-key" && !c.secretRef)
        throw new Error(`provider "${p.name}" credential "${c.id}": api-key needs a secretRef`);
      if (c.type === "api-key" && !c.broker)
        throw new Error(
          `provider "${p.name}" credential "${c.id}": api-key needs an explicit broker stamp ` +
            `("env" | "db" | ...) — a credential has exactly one home; unstamped-follows-selection is not allowed`,
        );
      if ((c.type === "service-oauth" || c.type === "user-oauth") && !c.vercelConnector)
        throw new Error(`provider "${p.name}" credential "${c.id}": ${c.type} needs a vercelConnector`);
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
