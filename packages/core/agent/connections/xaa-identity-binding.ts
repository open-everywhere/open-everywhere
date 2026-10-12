import { appendAudit } from "../audit/audit.js";
import { RAW_VAULT_SUBJECT_PREFIX, SHARED_VAULT_SUBJECT_PREFIX } from "../identity/oauth-vault-share.js";
import { parsePrincipalKey } from "../identity/principal-key.js";
import { expandLinkSet, resolveLinkSet } from "../identity/link-store.js";

export const OKTA_LINK_PLATFORM = "okta";

export const XAA_LINK_REFUSED_ACTION = "connector.xaa.link_refused";

export type XaaBindingStage = "sign-in" | "mint";

export type XaaBindingVerdict =
  | { readonly ok: true; readonly idpNativeId: string }
  | { readonly ok: false; readonly reason: string; readonly unreadable?: true };

type Requester =
  | { readonly kind: "raw"; readonly org: string; readonly platform: string; readonly tenant?: string; readonly nativeId: string }
  | { readonly kind: "shared"; readonly org: string; readonly linkSetId: string };

function parseVaultSubject(subject: string): Requester | undefined {
  if (subject.startsWith(SHARED_VAULT_SUBJECT_PREFIX)) {
    const body = subject.slice(SHARED_VAULT_SUBJECT_PREFIX.length);
    const slash = body.indexOf("/");
    if (slash <= 0 || slash === body.length - 1) return undefined;
    return { kind: "shared", org: body.slice(0, slash), linkSetId: body.slice(slash + 1) };
  }
  if (!subject.startsWith(RAW_VAULT_SUBJECT_PREFIX)) return undefined;
  const body = subject.slice(RAW_VAULT_SUBJECT_PREFIX.length);
  const slash = body.indexOf("/");
  if (slash <= 0) return undefined;
  const parsed = parsePrincipalKey(body.slice(slash + 1));
  if (!parsed) return undefined;
  return { kind: "raw", org: body.slice(0, slash), platform: parsed.platform, ...(parsed.tenant !== undefined ? { tenant: parsed.tenant } : {}), nativeId: parsed.id };
}

async function auditRefusal(
  requester: Requester,
  input: { readonly reason: string; readonly connection: string; readonly signerSubject: string | undefined; readonly stage: XaaBindingStage },
): Promise<void> {
  await appendAudit({
    org: requester.org,
    platform: requester.kind === "raw" ? requester.platform : "link-set",
    workspace: requester.kind === "raw" ? (requester.tenant ?? "") : "",
    principalId: requester.kind === "raw" ? requester.nativeId : requester.linkSetId,
    action: XAA_LINK_REFUSED_ACTION,
    detail: { reason: input.reason, connection: input.connection, signerSubject: input.signerSubject ?? null, stage: input.stage },
  });
}

export async function recordXaaRefusal(input: {
  readonly principalSubject: string;
  readonly connection: string;
  readonly reason: string;
  readonly signerSubject?: string;
}): Promise<void> {
  const requester = parseVaultSubject(input.principalSubject);
  if (!requester) return;
  await auditRefusal(requester, { reason: input.reason, connection: input.connection, signerSubject: input.signerSubject, stage: "sign-in" });
}

export async function checkXaaIdentityBinding(input: {
  readonly principalSubject: string;
  readonly signerSubject: string | undefined;
  readonly connection: string;
  readonly stage?: XaaBindingStage;
}): Promise<XaaBindingVerdict> {
  const stage = input.stage ?? "sign-in";
  const requester = parseVaultSubject(input.principalSubject);
  if (!requester) return { ok: false, reason: "the link request names no readable account" };

  const refuse = async (reason: string, unreadable = false): Promise<XaaBindingVerdict> => {
    await auditRefusal(requester, { reason, connection: input.connection, signerSubject: input.signerSubject, stage });
    return unreadable ? { ok: false, reason, unreadable: true } : { ok: false, reason };
  };

  if (!input.signerSubject) return await refuse("the IdP sign-in named no signer");

  let idpAccounts: readonly { readonly nativeId: string }[];
  try {
    let linkSetId: string;
    if (requester.kind === "shared") {
      linkSetId = requester.linkSetId;
    } else {
      const set = await resolveLinkSet(requester.org, requester.platform, requester.nativeId, requester.tenant ?? null);
      if (!set) return await refuse("no confirmed identity link for the requester");
      linkSetId = set.id;
    }
    const linked = await expandLinkSet(requester.org, linkSetId);
    idpAccounts = linked.filter((a) => a.platform === OKTA_LINK_PLATFORM);
  } catch {
    return await refuse("the identity-link plane could not be read", true);
  }
  if (idpAccounts.length === 0) return await refuse("the requester has no linked Okta account");

  const matched = idpAccounts.find((a) => a.nativeId === input.signerSubject);
  if (!matched) {
    return await refuse(
      stage === "mint" ? "the Okta account behind the stored grant is no longer a confirmed account of the requester" : "the IdP sign-in was completed by a different Okta account",
    );
  }
  return { ok: true, idpNativeId: matched.nativeId };
}
