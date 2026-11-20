import { loadEveInternalFunctions } from "./load.js";

/**
 * Deep read of `eve/dist/src/shared/sandbox-network-policy.js`.
 *
 * No public entry exports eve's runtime check for a sandbox network policy. The function states
 * eve's own reading of the `SandboxNetworkPolicy` type: each matcher sets exactly one of `exact`,
 * `startsWith` or `regex`, and each rule sets exactly one of `transform` or `forwardURL`. The egress
 * rule shape test drives every policy that OE compiles through this function.
 */
export const EVE_NETWORK_POLICY_FILE = "shared/sandbox-network-policy.js";

const OWNER = "scripts/eve-deep-reads/network-policy.ts";

export type IsSandboxNetworkPolicy = (value: unknown) => boolean;

/** Loads `isSandboxNetworkPolicy`, eve's runtime check for the sandbox network-policy shape. */
export async function loadIsSandboxNetworkPolicy(root: string): Promise<IsSandboxNetworkPolicy> {
  const { isSandboxNetworkPolicy } = await loadEveInternalFunctions({
    root,
    file: EVE_NETWORK_POLICY_FILE,
    names: ["isSandboxNetworkPolicy"],
    owner: OWNER,
  });
  return isSandboxNetworkPolicy as unknown as IsSandboxNetworkPolicy;
}
