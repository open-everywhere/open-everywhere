import type { Domain } from "../memory/domain.js";
import type { ConnectorCredentials } from "./connector-credentials.js";

export interface DomainCredentialOverride {
  readonly connector: string;
  readonly credential: string;
  readonly use: string;
  readonly inboundSecret?: string;
}

export interface CredentialBoundDomain {
  readonly name?: string;
  readonly credentials?: readonly DomainCredentialOverride[];
}

export function credentialOverrideFor(
  domain: CredentialBoundDomain | undefined,
  connector: string,
  credential: string,
): DomainCredentialOverride | undefined {
  return (domain?.credentials ?? []).find((c) => c.connector === connector && c.credential === credential);
}

export function domainCredentialId(domain: CredentialBoundDomain | undefined, connector: string, credential: string): string {
  return credentialOverrideFor(domain, connector, credential)?.use ?? credential;
}

export interface ConnectorIntegration {
  readonly credentialId: string;
  readonly inboundSecret: string;
  readonly domain?: string;
}

export function connectorIntegrations(
  domains: readonly Domain[],
  connector: string,
  credential: string,
  defaultInboundSecret: string,
): readonly ConnectorIntegration[] {
  const out: ConnectorIntegration[] = [{ credentialId: credential, inboundSecret: defaultInboundSecret }];
  const seen = new Set<string>([`${credential}\u0000${defaultInboundSecret}`]);
  for (const d of domains) {
    const override = credentialOverrideFor(d, connector, credential);
    if (!override) continue;
    const inboundSecret = override.inboundSecret ?? defaultInboundSecret;
    const key = `${override.use}\u0000${inboundSecret}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ credentialId: override.use, inboundSecret, domain: d.name });
  }
  return out;
}

export function domainCredentialProblems(domain: CredentialBoundDomain): readonly string[] {
  const bad: string[] = [];
  const name = domain.name ?? "(unnamed)";
  const seen = new Set<string>();
  for (const c of domain.credentials ?? []) {
    const where = `  "${name}" credential override ${JSON.stringify(`${c.connector ?? ""}/${c.credential ?? ""}`)}`;
    for (const [field, value] of [["connector", c.connector], ["credential", c.credential], ["use", c.use]] as const) {
      if (typeof value !== "string" || value.trim().length === 0) {
        bad.push(`${where}: \`${field}\` must be a non-empty string`);
      }
    }
    if (c.inboundSecret !== undefined && (typeof c.inboundSecret !== "string" || c.inboundSecret.trim().length === 0)) {
      bad.push(`${where}: \`inboundSecret\` must be a non-empty operator-secret name when present (omit it to share the deployment default)`);
    }
    if (typeof c.connector !== "string" || typeof c.credential !== "string") continue;
    const key = `${c.connector}\u0000${c.credential}`;
    if (seen.has(key)) {
      bad.push(`${where}: declared more than once — a domain overrides each (connector, credential) at most once, so two entries are a contradiction rather than a precedence question`);
    }
    seen.add(key);
    if (typeof c.use === "string" && c.use === c.credential) {
      bad.push(`${where}: \`use\` names the credential it replaces, so the override does nothing — delete it (an unbound domain already uses the org default)`);
    }
  }
  return bad;
}

export function assertDomainCredentialsResolvable(domains: readonly Domain[], catalogues: readonly ConnectorCredentials[]): void {
  const bad: string[] = [];
  for (const d of domains) {
    for (const c of d.credentials ?? []) {
      const cfg = catalogues.find((p) => p.connector === c.connector);
      if (!cfg) {
        bad.push(`  "${d.name}" overrides credential "${c.credential}" on connector "${c.connector}", which has no credential catalogue (agent/access/connector-credentials.ts)`);
        continue;
      }
      if (!cfg.credentials.some((pc) => pc.id === c.credential)) {
        bad.push(`  "${d.name}" overrides credential "${c.credential}" on connector "${c.connector}", which declares no such credential — name the ORG-DEFAULT credential the override replaces (one of: ${cfg.credentials.map((pc) => pc.id).join(", ")})`);
      }
      if (!cfg.credentials.some((pc) => pc.id === c.use)) {
        bad.push(`  "${d.name}" binds connector "${c.connector}" to credential "${c.use}", which that connector does not declare — add it to agent/access/connector-credentials.ts with its own secretRef + broker (one of the declared ids: ${cfg.credentials.map((pc) => pc.id).join(", ")})`);
      }
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `invalid per-domain credential override(s):\n${bad.join("\n")}\n` +
        `A bound domain NEVER falls back to the org credential — that would hand it the exact key it was bound away from — so an unresolvable binding is refused at boot.`,
    );
  }
}
