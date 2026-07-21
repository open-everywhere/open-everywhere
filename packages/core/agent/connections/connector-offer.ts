import type { Provider, ProviderCredential, ProviderCredentialType } from "../access/providers.js";
import { principalOf } from "../access/providers.js";

export interface SurfaceIntakeCapability {
  readonly secretModal?: boolean;
  readonly buttons?: boolean;
}

export type SurfaceIntakeDeclarations = Readonly<Record<string, SurfaceIntakeCapability>>;

export const SURFACE_INTAKE_CAPS: SurfaceIntakeDeclarations = {
  slack: { secretModal: true, buttons: true },
  discord: { buttons: true },
  teams: {},
  github: {},
  linear: {},
  notion: {},
};

export interface BrokerIntakeRoute {
  readonly hostWrite: boolean;
  readonly operatorOnly?: boolean;
}

export const BROKER_INTAKE_CAPS: Readonly<Record<string, BrokerIntakeRoute>> = {
  db: { hostWrite: true },
  "vercel-connect": { hostWrite: false },
  env: { hostWrite: false, operatorOnly: true },
};

export function brokerHostWrite(broker: string): boolean {
  return BROKER_INTAKE_CAPS[broker]?.hostWrite === true;
}

export function hostWriteBrokerAvailable(registeredBrokers: Iterable<string>): boolean {
  for (const name of registeredBrokers) if (brokerHostWrite(name)) return true;
  return false;
}

export type ConnectRouteKind = "modal" | "url" | "text-degrade" | "unavailable";

export interface ConnectRoute {
  readonly kind: ConnectRouteKind;
  readonly reason?: string;
}

export interface ConnectorOption {
  readonly credentialType: ProviderCredentialType;
  readonly principal: "app" | "user";
  readonly credentialId: string;
  readonly secretRef?: string;
  readonly vercelConnector?: string;
  readonly dashboardUrl?: string;
  readonly route: ConnectRoute;
}

export type ConnectMode = "dm" | "channel";

export interface ResolveConnectorInput {
  readonly provider: Provider;
  readonly platform: string;
  readonly mode: ConnectMode;
  readonly isAdmin: boolean;
  readonly hostWriteBroker: boolean;
  readonly declarations?: SurfaceIntakeDeclarations;
}

const OFFER_ORDER: readonly ProviderCredentialType[] = ["user-oauth", "service-oauth", "api-key"];

export function offerableCredential(provider: Provider, type: ProviderCredentialType): ProviderCredential | undefined {
  return provider.credentials.find((c) => c.type === type && c.intake !== false);
}

export function resolveConnectorOptions(input: ResolveConnectorInput): readonly ConnectorOption[] {
  const decl = input.declarations ?? SURFACE_INTAKE_CAPS;
  const surface = decl[input.platform] ?? {};
  const options: ConnectorOption[] = [];

  for (const type of OFFER_ORDER) {
    if (!input.provider.allows.includes(type)) continue;
    const cred = offerableCredential(input.provider, type);
    if (!cred) continue;
    const principal = principalOf(type);

    if (principal === "user" && input.mode !== "dm") continue;
    if (principal === "app" && !input.isAdmin) continue;

    let route: ConnectRoute;
    if (type === "user-oauth" || type === "service-oauth") {
      route = { kind: "url" };
    } else {
      if (!input.hostWriteBroker) {
        route = {
          kind: "unavailable",
          reason:
            `this deployment has no host-side secret store configured — an operator sets ${cred.secretRef ?? "the key"} ` +
            `out of band (environment variables) or provisions it via the Vercel dashboard/CLI; it can't be pasted here.`,
        };
      } else if (input.platform === "slack" && surface.secretModal) {
        route = { kind: "modal" };
      } else {
        route = {
          kind: "text-degrade",
          reason: "no secure key entry on this surface — ask me in a Slack channel to paste it into a private modal, or an operator can set it via the Vercel dashboard/CLI.",
        };
      }
    }

    options.push({
      credentialType: type,
      principal,
      credentialId: cred.id,
      ...(cred.secretRef ? { secretRef: cred.secretRef } : {}),
      ...(cred.vercelConnector ? { vercelConnector: cred.vercelConnector } : {}),
      ...(cred.dashboardUrl ? { dashboardUrl: cred.dashboardUrl } : {}),
      route,
    });
  }

  return options;
}

export function optionLabel(o: ConnectorOption): string {
  return o.credentialType === "user-oauth" ? "Connect my account" : o.credentialType === "service-oauth" ? "Connect org account" : "Set API key";
}
