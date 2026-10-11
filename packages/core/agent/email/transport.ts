import { admitProviderRegistration } from "../access/provider-selection.js";
import { processRegistryMap } from "../lib/process-registry.js";

export interface InboundEmailAttachment {
  readonly filename?: string;
  readonly contentType?: string;
  readonly size: number;
}

export interface InboundEmail {
  readonly deliveryId: string;
  readonly inbox: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly from: string;
  readonly replyTo: readonly string[];
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly newText?: string;
  readonly fullText: string;
  readonly receivedAt: string;
  readonly senderAuth: "pass" | "fail" | "none";
  readonly flagged?: "spam" | "blocked";
  readonly headers: Readonly<Record<string, string>>;
  readonly attachments: readonly InboundEmailAttachment[];
}

export type EmailDeliveryVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface EmailReplyRequest {
  readonly inbox: string;
  readonly inReplyToMessageId: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly text: string;
}

export interface EmailReplyResult {
  readonly messageId: string;
}

export interface EmailThreadMessage {
  readonly messageId: string;
  readonly from: string;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly sentAt: string;
  readonly text: string;
  readonly sent?: boolean;
  readonly suspect?: boolean;
}

export interface EmailTransport {
  readonly id: string;
  readonly sharedDomains: readonly string[];
  verify(headers: Readonly<Record<string, string>>, rawBody: string): Promise<EmailDeliveryVerdict>;
  parse(headers: Readonly<Record<string, string>>, rawBody: string): InboundEmail | null;
  reply(req: EmailReplyRequest): Promise<EmailReplyResult>;
  readThread?(inbox: string, threadId: string, limit: number): Promise<readonly EmailThreadMessage[]>;
}

const TRANSPORTS = processRegistryMap<EmailTransport>("email-transports.v1");

export function registerEmailTransport(transport: EmailTransport): void {
  if (!admitProviderRegistration("email", "email-transport")) return;
  TRANSPORTS.set(transport.id, transport);
}

export function emailTransport(id: string): EmailTransport | undefined {
  return TRANSPORTS.get(id);
}
