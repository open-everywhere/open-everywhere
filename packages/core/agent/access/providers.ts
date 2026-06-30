export type TransportKind = "mcp" | "rest";

export type ProviderCredentialType = "api-key" | "service-oauth" | "user-oauth";

export function principalOf(type: ProviderCredentialType): "app" | "user" {
  return type === "user-oauth" ? "user" : "app";
}

export interface ProviderCredential {
  readonly id: string;
  readonly type: ProviderCredentialType;
  readonly secretRef?: string;
  readonly vercelConnector?: string;
}

export interface ProviderTransport {
  readonly kind: TransportKind;
  readonly connection: string;
  readonly allows: readonly ProviderCredentialType[];
}

export interface Provider {
  readonly name: string;
  readonly transports: readonly ProviderTransport[];
  readonly credentials: readonly ProviderCredential[];
  readonly defaultTransport?: TransportKind;
  readonly skill?: string;
  readonly description?: string;
}

export interface ProviderGrant {
  readonly provider: string;
  readonly credential: string;
  readonly transports?: readonly TransportKind[];
}

export interface ResolvedConnectorCredential {
  readonly connection: string;
  readonly transport: TransportKind;
  readonly provider: string;
  readonly credential: string;
  readonly type: ProviderCredentialType;
  readonly principal: "app" | "user";
  readonly secretRef?: string;
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
    if (!p.transports.length) throw new Error(`provider "${p.name}": needs at least one transport`);
    const credIds = new Set<string>();
    for (const c of p.credentials) {
      if (credIds.has(c.id)) throw new Error(`provider "${p.name}": duplicate credential id "${c.id}"`);
      credIds.add(c.id);
      if (c.type === "api-key" && !c.secretRef)
        throw new Error(`provider "${p.name}" credential "${c.id}": api-key needs a secretRef`);
      if ((c.type === "service-oauth" || c.type === "user-oauth") && !c.vercelConnector)
        throw new Error(`provider "${p.name}" credential "${c.id}": ${c.type} needs a vercelConnector`);
    }
    for (const t of p.transports) {
      if (!t.connection) throw new Error(`provider "${p.name}" transport "${t.kind}": missing connection slug`);
      if (!t.allows.length) throw new Error(`provider "${p.name}" transport "${t.kind}": empty allowlist`);
    }
    if (p.defaultTransport && !p.transports.some((t) => t.kind === p.defaultTransport))
      throw new Error(`provider "${p.name}": defaultTransport "${p.defaultTransport}" has no transport`);
  }
}

export function expandProviderGrant(
  grant: ProviderGrant,
  provider: Provider | undefined,
  opts: { readonly dm: boolean },
): { resolved: readonly ResolvedConnectorCredential[]; warnings: readonly string[] } {
  const warnings: string[] = [];
  if (!provider) {
    return { resolved: [], warnings: [`grant references unknown provider "${grant.provider}" — ignored`] };
  }
  const cred = provider.credentials.find((c) => c.id === grant.credential);
  if (!cred) {
    return {
      resolved: [],
      warnings: [`provider "${provider.name}": grant references unknown credential "${grant.credential}" — ignored`],
    };
  }
  const principal = principalOf(cred.type);

  if (principal === "user" && !opts.dm) {
    return {
      resolved: [],
      warnings: [
        `provider "${provider.name}": credential "${cred.id}" is user-principal (${cred.type}) — ` +
          `personal credentials resolve only in DMs, never on a channel/domain binding. Ignored.`,
      ],
    };
  }

  let chosen: readonly TransportKind[];
  if (grant.transports?.length) {
    chosen = grant.transports;
  } else if (provider.defaultTransport) {
    chosen = [provider.defaultTransport];
  } else if (provider.transports.length === 1) {
    chosen = [provider.transports[0].kind];
  } else {
    chosen = provider.transports.map((t) => t.kind);
    warnings.push(
      `provider "${provider.name}": grant for credential "${cred.id}" pins no transport and the provider ` +
        `has ${provider.transports.length} with no defaultTransport — exposing all valid transports. Set a ` +
        `defaultTransport or pin grant.transports to expose one.`,
    );
  }

  const resolved: ResolvedConnectorCredential[] = [];
  for (const kind of chosen) {
    const t = provider.transports.find((x) => x.kind === kind);
    if (!t) {
      warnings.push(`provider "${provider.name}": no "${kind}" transport — skipped`);
      continue;
    }
    if (!t.allows.includes(cred.type)) {
      warnings.push(
        `provider "${provider.name}": credential "${cred.id}" (${cred.type}) is not allowed on the ` +
          `"${kind}" transport (allows: ${t.allows.join(", ")}) — skipped`,
      );
      continue;
    }
    resolved.push({
      connection: t.connection,
      transport: kind,
      provider: provider.name,
      credential: cred.id,
      type: cred.type,
      principal,
      secretRef: cred.secretRef,
      vercelConnector: cred.vercelConnector,
    });
  }
  return { resolved, warnings };
}
