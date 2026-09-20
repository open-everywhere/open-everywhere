import { appendAudit } from "../audit/audit.js";
import { RAW_VAULT_SUBJECT_PREFIX } from "../identity/oauth-vault-share.js";
import { parsePrincipalKey } from "../identity/principal-key.js";
import { expandLinkSet, resolveLinkSet } from "../identity/link-store.js";

export const AWS_SSO_LINK_PLATFORM = "aws";

export type AwsSsoBindingVerdict =
  | { readonly ok: true; readonly awsNativeId: string }
  | { readonly ok: false; readonly reason: string };

interface RequesterAccount {
  readonly org: string;
  readonly platform: string;
  readonly tenant?: string;
  readonly nativeId: string;
}

function parseRawVaultSubject(subject: string): RequesterAccount | undefined {
  if (!subject.startsWith(RAW_VAULT_SUBJECT_PREFIX)) return undefined;
  const body = subject.slice(RAW_VAULT_SUBJECT_PREFIX.length);
  const slash = body.indexOf("/");
  if (slash <= 0) return undefined;
  const org = body.slice(0, slash);
  const parsed = parsePrincipalKey(body.slice(slash + 1));
  if (!parsed) return undefined;
  return { org, platform: parsed.platform, ...(parsed.tenant !== undefined ? { tenant: parsed.tenant } : {}), nativeId: parsed.id };
}

export async function checkAwsSsoIdentityBinding(input: {
  readonly principalSubject: string;
  readonly signerSubject: string | undefined;
}): Promise<AwsSsoBindingVerdict> {
  const requester = parseRawVaultSubject(input.principalSubject);
  if (!requester) {
    return { ok: false, reason: "the link request names no readable account" };
  }

  const refuse = async (reason: string): Promise<AwsSsoBindingVerdict> => {
    await appendAudit({
      org: requester.org,
      platform: requester.platform,
      workspace: requester.tenant ?? "",
      principalId: requester.nativeId,
      action: "aws.sso.link_refused",
      detail: { reason, signerSubject: input.signerSubject ?? null },
    });
    return { ok: false, reason };
  };

  if (!input.signerSubject) return await refuse("the AWS sign-in named no signer");

  let awsAccounts: readonly { readonly nativeId: string }[];
  try {
    const set = await resolveLinkSet(requester.org, requester.platform, requester.nativeId, requester.tenant ?? null);
    if (!set) return await refuse("no confirmed identity link for the requester");
    const linked = await expandLinkSet(requester.org, set.id);
    awsAccounts = linked.filter((a) => a.platform === AWS_SSO_LINK_PLATFORM);
  } catch {
    return await refuse("the identity-link plane could not be read");
  }
  if (awsAccounts.length === 0) return await refuse("the requester has no linked AWS Identity Center account");

  const matched = awsAccounts.find((a) => a.nativeId === input.signerSubject);
  if (!matched) return await refuse("the AWS sign-in was completed by a different Identity Center account");
  return { ok: true, awsNativeId: matched.nativeId };
}
