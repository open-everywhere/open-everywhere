import type { AwsRoleGrant } from "../access/bundle.js";
import { actingPrincipalIdOf, buildResolveRequest, resolveAccessFor } from "../access/request.js";
import { surfaceKeyOf } from "../access/resolver.js";
import { bindFrom } from "../identity/binding.js";
import type { BindableContext } from "../identity/binding.js";

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiresAtMs?: number;
}

export type AwsIdentityKind = "domain-role" | "user-sso";

export interface AwsIdentityRequest {
  readonly kind: AwsIdentityKind;
  readonly roleArn: string;
  readonly region?: string;
  readonly audience?: string;
  readonly roleSessionName: string;
  readonly principalId?: string;
}

export interface AwsIdentityProvider {
  mint(req: AwsIdentityRequest): Promise<AwsCredentials>;
}

export interface ResolvedAwsIdentity {
  readonly credentials: AwsCredentials;
  readonly roleArn: string;
  readonly region?: string;
  readonly boundAs: AwsIdentityKind;
  readonly roleSessionName: string;
}

let registered: AwsIdentityProvider | undefined;

export function registerAwsIdentityProvider(provider: AwsIdentityProvider): void {
  registered = provider;
}

export function resetAwsIdentityProvider(): void {
  registered = undefined;
}

export function awsIdentityProvider(): AwsIdentityProvider | undefined {
  return registered;
}

export function requireAwsIdentityProvider(): AwsIdentityProvider {
  if (!registered) {
    throw new Error(
      "no AWS-identity provider is registered — the AWS adapter (packages/adapters/agent/aws) is not " +
        "wired. Register it at boot (register-adapters.ts). Fail-closed: no AWS access.",
    );
  }
  return registered;
}

export function awsRoleSessionName(label: string): string {
  const cleaned = label.replace(/[^\w+=,.@-]/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "");
  return `oe-${cleaned || "session"}`.slice(0, 64);
}

export interface AwsIdentityPlan {
  readonly kind: AwsIdentityKind;
  readonly grant: AwsRoleGrant;
  readonly roleSessionName: string;
  readonly principalId?: string;
}

export interface AwsIdentityOptions {
  readonly roleArn?: string;
  readonly as?: AwsIdentityKind;
}

export function planAwsIdentity(input: {
  readonly grants: readonly AwsRoleGrant[];
  readonly mode: string;
  readonly actingPrincipalId: string | undefined;
  readonly domains: readonly string[];
  readonly surfaceKey: string;
  readonly opts?: AwsIdentityOptions;
}): AwsIdentityPlan {
  const { grants, mode, actingPrincipalId, domains, surfaceKey, opts = {} } = input;
  if (grants.length === 0) {
    throw new Error(
      "no AWS role is granted to this scope — an admin binds an `awsRoles` grant to this channel's " +
        "domain. Fail-closed: no AWS access.",
    );
  }
  let grant: AwsRoleGrant;
  if (opts.roleArn) {
    const found = grants.find((g) => g.roleArn === opts.roleArn);
    if (!found) {
      throw new Error(
        `roleArn "${opts.roleArn}" is not granted to this scope — granted role(s): ${grants
          .map((g) => g.roleArn)
          .join(", ")}.`,
      );
    }
    grant = found;
  } else if (grants.length === 1) {
    grant = grants[0]!;
  } else {
    throw new Error(
      `this scope is granted ${grants.length} AWS roles (${grants
        .map((g) => g.roleArn)
        .join(", ")}) — name one via roleArn to disambiguate.`,
    );
  }

  const kind: AwsIdentityKind = opts.as ?? "domain-role";
  if (kind === "user-sso") {
    if (!actingPrincipalId) {
      throw new Error(
        "acting as your AWS SSO identity needs a verified sender on this turn — a triggered routine " +
          "fire has no acting sender (only the creator it is attributed to), and a fire may not assume " +
          "a human's SSO identity in that person's name. Ask a person in this conversation to do it.",
      );
    }
    if (mode !== "dm") {
      throw new Error(
        "acting as your AWS SSO identity is only available in a DM — a personal identity does not " +
          "apply in a shared channel; use the domain role there.",
      );
    }
    return { kind, grant, roleSessionName: awsRoleSessionName(actingPrincipalId), principalId: actingPrincipalId };
  }

  return { kind, grant, roleSessionName: awsRoleSessionName(domains[0] ?? surfaceKey) };
}

export async function resolveAwsIdentity(
  ctx: BindableContext,
  opts?: AwsIdentityOptions,
): Promise<ResolvedAwsIdentity> {
  const access = resolveAccessFor(ctx);
  const plan = planAwsIdentity({
    grants: access.awsRoles,
    mode: bindFrom(ctx).mode,
    actingPrincipalId: actingPrincipalIdOf(ctx),
    domains: access.domains,
    surfaceKey: surfaceKeyOf(buildResolveRequest(ctx)),
    opts,
  });
  const credentials = await requireAwsIdentityProvider().mint({
    kind: plan.kind,
    roleArn: plan.grant.roleArn,
    region: plan.grant.region,
    audience: plan.grant.audience,
    roleSessionName: plan.roleSessionName,
    principalId: plan.principalId,
  });
  return {
    credentials,
    roleArn: plan.grant.roleArn,
    region: plan.grant.region,
    boundAs: plan.kind,
    roleSessionName: plan.roleSessionName,
  };
}
