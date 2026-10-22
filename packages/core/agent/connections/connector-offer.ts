import type { ConnectorCredentials, ConnectorCredential, ConnectorCredentialType } from "../access/connector-credentials.js";
import { isHumanActing, principalOf, oauthConnectorOf } from "../access/connector-credentials.js";
import { hostWriteHomeAvailable as homesHostWriteAvailable, type CredentialHome } from "../credentials/home.js";

export interface SurfaceIntakeCapability {
  readonly secretModal?: boolean;
  readonly buttons?: boolean;
  readonly pageLink?: boolean;
}

export type SurfaceIntakeDeclarations = Readonly<Record<string, SurfaceIntakeCapability>>;

export const SURFACE_INTAKE_CAPS: SurfaceIntakeDeclarations = {
  slack: { secretModal: true, buttons: true },
  discord: { buttons: true, pageLink: true },
  teams: { pageLink: true },
  github: { pageLink: true },
  linear: { pageLink: true },
  notion: { pageLink: true },
};

export interface BrokerIntakeRoute {
  readonly hostWrite: boolean;
  readonly operatorOnly?: boolean;
}

export const BROKER_INTAKE_CAPS: Readonly<Record<string, BrokerIntakeRoute>> = {
  db: { hostWrite: true },
  env: { hostWrite: false, operatorOnly: true },
};

function brokerHostWrite(broker: string): boolean {
  return BROKER_INTAKE_CAPS[broker]?.hostWrite === true;
}

export function hostWriteBrokerAvailable(registeredBrokers: Iterable<string>): boolean {
  for (const name of registeredBrokers) if (brokerHostWrite(name)) return true;
  return false;
}

export function hostWriteHomeAvailable(homes: Iterable<CredentialHome>): boolean {
  return homesHostWriteAvailable(homes);
}

export type ConnectRouteKind = "modal" | "url" | "page" | "text-degrade" | "unavailable";

export interface ConnectRoute {
  readonly kind: ConnectRouteKind;
  readonly reason?: string;
}

export interface ConnectorOption {
  readonly credentialType: ConnectorCredentialType;
  readonly principal: "app" | "user";
  readonly credentialId: string;
  readonly secretRef?: string;
  readonly oauthConnector?: string;
  readonly dashboardUrl?: string;
  readonly route: ConnectRoute;
}

export type ConnectMode = "dm" | "channel";

export function unqualifiedAppRowMintHome(type: ConnectorCredentialType, cred: ConnectorCredential): string | undefined {
  if (type !== "service-oauth" || cred.dashboardUrl) return undefined;
  return oauthConnectorOf(cred);
}

export interface ResolveConnectorInput {
  readonly catalogue: ConnectorCredentials;
  readonly platform: string;
  readonly mode: ConnectMode;
  readonly isAdmin: boolean;
  readonly isOrgAdmin: boolean;
  readonly hostWriteBroker: boolean;
  readonly intakePageAvailable?: boolean;
  readonly declarations?: SurfaceIntakeDeclarations;
}

const OFFER_ORDER: readonly ConnectorCredentialType[] = ["user-oauth", "service-oauth", "api-key"];

export function offerableCredential(catalogue: ConnectorCredentials, type: ConnectorCredentialType): ConnectorCredential | undefined {
  return catalogue.credentials.find((c) => c.type === type && c.intake !== false && !isHumanActing(c));
}

export function resolveConnectorOptions(input: ResolveConnectorInput): readonly ConnectorOption[] {
  const decl = input.declarations ?? SURFACE_INTAKE_CAPS;
  const surface = decl[input.platform] ?? {};
  const options: ConnectorOption[] = [];

  for (const type of OFFER_ORDER) {
    if (!input.catalogue.allows.includes(type)) continue;
    const cred = offerableCredential(input.catalogue, type);
    if (!cred) continue;
    const principal = principalOf(type);

    if (principal === "user" && input.mode !== "dm") continue;
    if (principal === "app" && !input.isAdmin) continue;
    if (unqualifiedAppRowMintHome(type, cred) && !input.isOrgAdmin) continue;

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
      } else if (surface.pageLink && input.intakePageAvailable) {
        route = { kind: "page" };
      } else {
        route = {
          kind: "text-degrade",
          reason: "I can't take a key safely here. Ask me in Slack, where I can open a private form, or ask your admin to add it.",
        };
      }
    }

    options.push({
      credentialType: type,
      principal,
      credentialId: cred.id,
      ...(cred.secretRef ? { secretRef: cred.secretRef } : {}),
      ...(oauthConnectorOf(cred) ? { oauthConnector: oauthConnectorOf(cred) } : {}),
      ...(cred.dashboardUrl ? { dashboardUrl: cred.dashboardUrl } : {}),
      route,
    });
  }

  return options;
}

export function optionLabel(o: ConnectorOption): string {
  return o.credentialType === "user-oauth" ? "Connect my account" : o.credentialType === "service-oauth" ? "Connect org account" : "Set API key";
}
