import type { BindableContext } from "../identity/binding.js";

export function connectorCardContext(surface: BindableContext, session: unknown): BindableContext {
  if (session === null || typeof session !== "object") return surface;
  const base = surface as { session?: Record<string, unknown> };
  return { ...surface, session: { ...(session as Record<string, unknown>), ...(base.session ?? {}) } } as unknown as BindableContext;
}

export interface ConnectorOpCardOffer {
  readonly org: string;
  readonly tool: string;
  readonly connection: string;
  readonly grain: "destructive" | "call";
  readonly sessionKey: string;
  readonly memoKind: string;
  readonly inputPreview: string;
  readonly auth: unknown;
  readonly session?: unknown;
  readonly tainted: boolean;
  readonly credential?: "domain" | "personal";
}

export const CONNECTOR_INPUT_PREVIEW_CAP = 600;

export type ConnectorOpCardResult =
  | { readonly outcome: "carded"; readonly pendingId: string; readonly where: string }
  | { readonly outcome: "approved" }
  | { readonly outcome: "refused"; readonly reason: string };

export type ConnectorOpCardOfferer = (offer: ConnectorOpCardOffer) => Promise<ConnectorOpCardResult>;

let registered: ConnectorOpCardOfferer | undefined;

export function registerConnectorOpCardOfferer(offerer: ConnectorOpCardOfferer): void {
  registered = offerer;
}

export async function offerConnectorOpCard(offer: ConnectorOpCardOffer): Promise<ConnectorOpCardResult> {
  if (registered === undefined) {
    return { outcome: "refused", reason: "no approval card plane is loaded in this process, so nobody can approve it" };
  }
  try {
    return await registered(offer);
  } catch (err) {
    return { outcome: "refused", reason: `the approval card could not be posted (${(err instanceof Error ? err.message : String(err)).slice(0, 200)})` };
  }
}

const CONNECTOR_OP_APPROVAL_PREFIX = "connector.approved:";

export function connectorOpApprovalKind(tool: string, inputDigest?: string): string {
  return inputDigest === undefined ? `${CONNECTOR_OP_APPROVAL_PREFIX}${tool}` : `${CONNECTOR_OP_APPROVAL_PREFIX}${tool}#${inputDigest}`;
}

export interface SignInCardOffer {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly recipientId: string;
  readonly connector: string;
  readonly url: string;
  readonly fromContainer: string;
}

export type SignInCardDeliverer = (offer: SignInCardOffer) => Promise<boolean>;

let signInDeliverer: SignInCardDeliverer | undefined;

export function registerSignInCardDeliverer(deliverer: SignInCardDeliverer): void {
  signInDeliverer = deliverer;
}

export async function deliverSignInCard(offer: SignInCardOffer): Promise<boolean> {
  if (signInDeliverer === undefined) return false;
  try {
    return await signInDeliverer(offer);
  } catch {
    return false;
  }
}
