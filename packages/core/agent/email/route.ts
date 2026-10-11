import { createHash } from "node:crypto";
import { emailDomainOf, emailLocalPartOf } from "./address.js";
import { emailInboxSurfaceKey, emailSurfaceSegment, type EmailInbox } from "./policy.js";

export type EmailSeatRoute =
  | { readonly kind: "room"; readonly surfaceKey: string }
  | { readonly kind: "dm"; readonly surfaceKey: string };

export function emailDmSurfaceSegment(inbox: string, sender: string): string {
  const digest = createHash("sha256").update(`${inbox}\n${sender}`).digest("hex").slice(0, 16);
  return `dm-${emailSurfaceSegment(emailLocalPartOf(sender)).slice(0, 40)}-${digest}`;
}

export function emailSeatRoute(inbox: EmailInbox, sender: string): EmailSeatRoute {
  if (inbox.kind === "room") return { kind: "room", surfaceKey: emailInboxSurfaceKey(inbox.address) };
  return { kind: "dm", surfaceKey: `email/${emailDomainOf(inbox.address)}/${emailDmSurfaceSegment(inbox.address, sender)}` };
}
