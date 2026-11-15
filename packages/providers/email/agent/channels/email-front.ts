import {
  admitInboundEmail,
  emailSeatRoute,
  planReplyRecipients,
  remainderTaints,
  splitEmailBody,
  emailDomainOf,
  mkMessageTrigger,
  renderWake,
  nonRequesterAttrsIf,
  stampNonMemberChatAuth,
  type EmailAdmission,
  type EmailPolicy,
  type EmailRefusalReason,
  type EmailTransport,
  type InboundEmail,
  type IngestedChatMessage,
  type NormalizedWake,
  type Principal,
  type UnifiedWakeOrigin,
  type WakeMessageInput,
  type WakeTrust,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildEmailAuth, type OpenEverywhereEmailAuth } from "./email-identity.js";
import type { AuditDetail } from "@open-everywhere/core/agent/adapter-api.js";

type EmailOrigin = Extract<UnifiedWakeOrigin, { platform: "email" }>;

export const EMAIL_DEDUPE_TTL_MS = 72 * 60 * 60 * 1000;

export type EmailFrontRefusal = EmailRefusalReason | "no-domain";

export type EmailFrontOutcome =
  | { readonly kind: "unauthorized"; readonly reason: string }
  | { readonly kind: "no-transport" }
  | { readonly kind: "ignored" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "refused"; readonly reason: EmailFrontRefusal }
  | { readonly kind: "admitted"; readonly route: "room" | "dm"; readonly surfaceKey: string; readonly tainted: boolean };

export interface EmailWakePlan {
  readonly surfaceKey: string;
  readonly route: "room" | "dm";
  readonly auth: OpenEverywhereEmailAuth;
  readonly origin: EmailOrigin;
  readonly trigger: WakeMessageInput;
  readonly remainder: string;
  readonly subject: string;
  readonly tainted: boolean;
  readonly trust: "internal" | "external";
  readonly dropped: number;
  readonly ingested: readonly IngestedChatMessage[];
  readonly mail: InboundEmail;
}

export interface EmailFrontDeps {
  readonly policy: () => EmailPolicy;
  readonly transport: (id: string) => EmailTransport | undefined;
  readonly principals: () => readonly Principal[];
  readonly markSeen: (key: string) => Promise<boolean>;
  readonly roomHasSeat: (surfaceKey: string) => boolean;
  readonly wakeTrust: (auth: OpenEverywhereEmailAuth, sender: string) => WakeTrust;
  readonly dispatchRoom: (plan: EmailWakePlan) => Promise<void>;
  readonly dispatchDm: (plan: EmailWakePlan) => Promise<void>;
  readonly audit: (row: { readonly action: string; readonly workspace: string; readonly surface?: string; readonly principalId?: string; readonly detail: AuditDetail }) => Promise<void>;
  readonly now?: () => number;
}

function emailTriggerBody(subject: string, ownText: string, hasRemainder: boolean, attachments: InboundEmail["attachments"]): string {
  const lines = [`Subject: ${subject || "(no subject)"}`, ""];
  lines.push(ownText !== "" ? ownText : hasRemainder ? "(no new text — the whole message is the quoted or forwarded mail shown as context)" : "(the message had no text)");
  if (attachments.length > 0) {
    const names = attachments.slice(0, 10).map((a) => `${a.filename ?? "unnamed"} (${a.size} bytes)`);
    lines.push("", `Attachments (not opened): ${names.join(", ")}${attachments.length > 10 ? `, and ${attachments.length - 10} more` : ""}`);
  }
  return lines.join("\n");
}

function buildEmailWake(plan: EmailWakePlan, wakeId: string, tail?: readonly WakeMessageInput[]): NormalizedWake {
  return {
    platform: "email",
    reason: plan.route === "dm" ? "dm" : "mention",
    addressing: "direct-mention",
    containerNoun: "inbox",
    wakeId,
    locus: { channel: { id: plan.origin.inbox }, thread: { ts: plan.origin.threadId } },
    backscroll: tail && tail.length > 0 ? tail : undefined,
    ...(plan.remainder !== ""
      ? {
          contextLines: [{ senderType: "unknown" as const, ts: plan.mail.receivedAt, text: plan.remainder, trust: "unauth" as const }],
          contextSource: `email:${plan.origin.inbox}`,
        }
      : {}),
    trigger: mkMessageTrigger(plan.trigger),
  };
}

export function renderEmailWake(plan: EmailWakePlan, wakeId: string, tail?: readonly WakeMessageInput[]): { message: string; context: readonly string[] } {
  const r = renderWake(buildEmailWake(plan, wakeId, tail));
  return { message: r.message, context: r.context ?? [] };
}

function refusalAuditInbox(mail: InboundEmail): { workspace: string; surface?: string } {
  return { workspace: emailDomainOf(mail.inbox) || "unknown" };
}

export function planEmailWake(input: {
  readonly admission: Extract<EmailAdmission, { admit: true }>;
  readonly mail: InboundEmail;
  readonly policy: EmailPolicy;
  readonly principals: readonly Principal[];
  readonly wakeTrust: EmailFrontDeps["wakeTrust"];
}): EmailWakePlan {
  const { admission, mail, policy } = input;
  const sender = admission.sender.address;
  const route = emailSeatRoute(admission.inbox, sender);
  const recipients = planReplyRecipients({ policy, inbox: admission.inbox, principals: input.principals, sender, mail });
  const body = splitEmailBody(mail, policy.maxInboundChars);
  const tainted = remainderTaints(body);
  const bindTrust: "internal" | "external" = admission.trust === "internal" && !recipients.outsider ? "internal" : "external";
  const surfaceSeg = route.surfaceKey.split("/")[2]!;
  const base = buildEmailAuth({
    inbox: admission.inbox.address,
    domain: emailDomainOf(admission.inbox.address),
    surface: surfaceSeg,
    mode: route.kind === "dm" ? "dm" : "channel",
    trust: bindTrust,
    sender,
    threadId: mail.threadId,
    messageId: mail.messageId,
  });
  const stamped: OpenEverywhereEmailAuth = { ...base, attributes: { ...base.attributes, ...nonRequesterAttrsIf(tainted, "email-remainder") } };
  const trust = input.wakeTrust(stamped, sender);
  const ingested: IngestedChatMessage[] = [{ trust, refuted: admission.trust === "external" }];
  const auth = stampNonMemberChatAuth(stamped as OpenEverywhereEmailAuth & { attributes: Record<string, unknown> }, ingested, route.kind === "dm" ? { dm: true } : { surfaceKey: route.surfaceKey }) as OpenEverywhereEmailAuth;
  return {
    surfaceKey: route.surfaceKey,
    route: route.kind,
    auth,
    origin: {
      platform: "email",
      inbox: admission.inbox.address,
      threadId: mail.threadId,
      messageId: mail.messageId,
      to: recipients.to,
      ...(recipients.cc.length > 0 ? { cc: recipients.cc } : {}),
    },
    trigger: {
      from: "human",
      author: admission.principal?.name ?? admission.sender.name ?? sender,
      authorId: sender,
      id: mail.messageId,
      sentAt: mail.receivedAt,
      trust,
      mention: true,
      body: emailTriggerBody(body.subject, body.ownText, body.remainder !== "", mail.attachments),
    },
    remainder: body.remainder,
    subject: body.subject,
    tainted,
    trust: bindTrust,
    dropped: recipients.dropped,
    ingested,
    mail,
  };
}

export async function verifyEmailDelivery(
  headers: Readonly<Record<string, string>>,
  rawBody: string,
  deps: Pick<EmailFrontDeps, "policy" | "transport">,
): Promise<{ readonly ok: true; readonly transport: EmailTransport; readonly policy: EmailPolicy } | { readonly ok: false; readonly outcome: EmailFrontOutcome }> {
  const policy = deps.policy();
  const transport = deps.transport(policy.transport);
  if (!transport) return { ok: false, outcome: { kind: "no-transport" } };
  const verdict = await transport.verify(headers, rawBody);
  if (!verdict.ok) return { ok: false, outcome: { kind: "unauthorized", reason: verdict.reason } };
  return { ok: true, transport, policy };
}

export async function processVerifiedEmail(
  transport: EmailTransport,
  policy: EmailPolicy,
  headers: Readonly<Record<string, string>>,
  rawBody: string,
  deps: EmailFrontDeps,
): Promise<EmailFrontOutcome> {
  const mail = transport.parse(headers, rawBody);
  if (!mail) return { kind: "ignored" };
  if (!(await deps.markSeen(`email:${transport.id}:${mail.deliveryId}`))) return { kind: "duplicate" };

  const principals = deps.principals();
  const admission = admitInboundEmail({ policy, mail, principals, sharedDomains: transport.sharedDomains });
  const refuse = async (reason: EmailFrontRefusal, sender?: string): Promise<EmailFrontOutcome> => {
    await deps.audit({
      action: "email.refused",
      ...refusalAuditInbox(mail),
      ...(sender ? { principalId: sender } : {}),
      detail: { reason, inbox: mail.inbox, transport: transport.id },
    });
    return { kind: "refused", reason };
  };
  if (!admission.admit) return refuse(admission.reason, admission.sender);

  const plan = planEmailWake({ admission, mail, policy, principals, wakeTrust: deps.wakeTrust });
  if (plan.route === "room" && !deps.roomHasSeat(plan.surfaceKey)) return refuse("no-domain", admission.sender.address);
  if (plan.route === "room") await deps.dispatchRoom(plan);
  else await deps.dispatchDm(plan);
  await deps.audit({
    action: "email.admitted",
    workspace: emailDomainOf(plan.origin.inbox),
    surface: plan.surfaceKey,
    principalId: admission.sender.address,
    detail: {
      inbox: plan.origin.inbox,
      route: plan.route,
      trust: plan.trust,
      senderTrust: admission.trust,
      via: admission.via,
      to: plan.origin.to.length,
      cc: plan.origin.cc?.length ?? 0,
      dropped: plan.dropped,
      tainted: plan.tainted,
    },
  });
  return { kind: "admitted", route: plan.route, surfaceKey: plan.surfaceKey, tainted: plan.tainted };
}

export async function handleEmailDelivery(headers: Readonly<Record<string, string>>, rawBody: string, deps: EmailFrontDeps): Promise<EmailFrontOutcome> {
  const v = await verifyEmailDelivery(headers, rawBody, deps);
  if (!v.ok) return v.outcome;
  return processVerifiedEmail(v.transport, v.policy, headers, rawBody, deps);
}
