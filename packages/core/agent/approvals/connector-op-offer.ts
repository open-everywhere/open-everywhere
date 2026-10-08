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
  readonly input?: Readonly<Record<string, unknown>>;
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

export const CONNECTOR_OP_CARD_KIND = "op.connector";

export const CONNECTOR_REPLAY_INPUT_KEY = "oe_approved_card";

export const CONNECTOR_REPLAY_INPUT_CAP = 32_768;

const CARD_ID = /^[A-Za-z0-9-]{8,64}$/u;

export function readConnectorReplayCardId(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== CONNECTOR_REPLAY_INPUT_KEY) return undefined;
  const id = (input as Record<string, unknown>)[CONNECTOR_REPLAY_INPUT_KEY];
  return typeof id === "string" && CARD_ID.test(id) ? id : undefined;
}

export function mentionsConnectorReplay(input: unknown): boolean {
  return input !== null && typeof input === "object" && !Array.isArray(input) && Object.prototype.hasOwnProperty.call(input, CONNECTOR_REPLAY_INPUT_KEY);
}

export interface StoredConnectorCall {
  readonly tool: string;
  readonly connection: string;
  readonly sessionKey: string;
  readonly memoKind: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ConnectorCardCall extends Omit<StoredConnectorCall, "input"> {
  readonly input?: Readonly<Record<string, unknown>>;
  readonly inputCleared: boolean;
}

export function connectorCardCall(argsJson: string): ConnectorCardCall | undefined {
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return undefined;
  }
  if (args === null || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  for (const field of ["tool", "connection", "sessionKey", "memoKind"] as const) {
    if (typeof a[field] !== "string" || (a[field] as string).length === 0) return undefined;
  }
  const input = a["input"];
  return {
    tool: a["tool"] as string,
    connection: a["connection"] as string,
    sessionKey: a["sessionKey"] as string,
    memoKind: a["memoKind"] as string,
    ...(input !== null && typeof input === "object" && !Array.isArray(input) ? { input: input as Record<string, unknown> } : {}),
    inputCleared: a[CONNECTOR_INPUT_CLEARED_KEY] === true,
  };
}

export function storedConnectorCall(argsJson: string): StoredConnectorCall | undefined {
  const call = connectorCardCall(argsJson);
  if (call?.input === undefined) return undefined;
  return { tool: call.tool, connection: call.connection, sessionKey: call.sessionKey, memoKind: call.memoKind, input: call.input };
}

export const CONNECTOR_INPUT_CLEARED_KEY = "inputCleared";

export function connectorArgsWithoutInput<A extends object>(args: A): A {
  if (args === null || typeof args !== "object" || Array.isArray(args) || !Object.prototype.hasOwnProperty.call(args, "input")) return args;
  const kept = Object.entries(args as Record<string, unknown>).filter(([k]) => k !== "input" && k !== CONNECTOR_INPUT_CLEARED_KEY);
  return Object.fromEntries([...kept, [CONNECTOR_INPUT_CLEARED_KEY, true]]) as A;
}

export const CONNECTOR_REPLAY_ADMISSION_TTL_MS = 60 * 60 * 1000;

export function connectorReplayAdmissionKey(cardId: string, callId: string): string {
  return `connector-op-replay:${cardId}:call:${callId}`;
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
