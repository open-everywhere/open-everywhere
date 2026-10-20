import type { SandboxEnvironment, SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";

export interface NetworkPolicySandboxSession extends SandboxSession {
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
}

export type CoarseNetworkPolicy = Extract<SandboxNetworkPolicy, "allow-all" | "deny-all">;

export interface CoarseNetworkPolicySandboxSession extends SandboxSession {
  setNetworkPolicy(policy: CoarseNetworkPolicy): Promise<void>;
}

export type SandboxFirewall =
  | { readonly carries: "full"; readonly environment: SandboxEnvironment<object | undefined, NetworkPolicySandboxSession> }
  | { readonly carries: "coarse"; readonly environment: SandboxEnvironment<object | undefined, CoarseNetworkPolicySandboxSession> }
  | { readonly carries: "none"; readonly backend: string };

export interface NetworkPolicyContext {
  getSandbox<Session extends SandboxSession>(
    environment: SandboxEnvironment<object | undefined, Session>,
  ): Promise<Session & { setNetworkPolicy?: unknown }>;
}

let registered: SandboxFirewall | undefined;

export function registerSandboxFirewall(firewall: SandboxFirewall): void {
  registered = firewall;
}

function isCoarseNetworkPolicy(policy: SandboxNetworkPolicy): policy is CoarseNetworkPolicy {
  return policy === "allow-all" || policy === "deny-all";
}

export async function applySessionNetworkPolicy(ctx: NetworkPolicyContext, policy: SandboxNetworkPolicy): Promise<void> {
  const firewall = registered;
  if (firewall === undefined) {
    throw new Error(
      "[open-everywhere:egress] no sandbox firewall is registered, so the compiled network policy cannot be applied. " +
        "The app's sandbox definition (agent/sandbox/sandbox.ts) calls registerSandboxFirewall() at boot; a process that " +
        "reaches this line without it is running core with no sandbox definition loaded. Refusing to continue unenforced.",
    );
  }
  if (firewall.carries === "none") {
    throw new Error(
      `[open-everywhere:egress] the configured sandbox backend (${firewall.backend}) fixes its network policy when the ` +
        "sandbox is created and exposes no setNetworkPolicy, so this session's compiled policy cannot be applied. " +
        "Wire the egress proxy (`egress.proxyUrl`) to enforce egress off Vercel, or run a backend whose sandbox carries a policy. " +
        "Refusing to continue unenforced.",
    );
  }
  if (firewall.carries === "coarse") {
    if (!isCoarseNetworkPolicy(policy)) {
      throw new Error(
        "[open-everywhere:egress] the configured sandbox backend applies only the coarse \"allow-all\" and \"deny-all\" " +
          "policies, and this session compiled a host allow-list. Applying it would enforce NOTHING from it. " +
          "Wire the egress proxy (`egress.proxyUrl`) to enforce the allow-list off Vercel. Refusing to continue unenforced.",
      );
    }
    const sandbox = await ctx.getSandbox(firewall.environment);
    await sandbox.setNetworkPolicy(policy);
    return;
  }
  const sandbox = await ctx.getSandbox(firewall.environment);
  await sandbox.setNetworkPolicy(policy);
}
