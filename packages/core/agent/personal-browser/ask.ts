import { actingPrincipalIdOf, resolveAccessFor } from "../access/request.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { resolvePartition } from "../memory/partition.js";
import { getConfig } from "../access/config.js";
import { compileNetworkPolicy } from "../access/egress.js";
import { narrowByConnectorOverride } from "../access/connector-scope.js";
import { resolveNetworkAccessLevel } from "../access/network-access.js";
import { nonMemberWake } from "../tools/propose_mcp_server.js";
import { personalBrowserPolicy, personalBrowserRefusal } from "./policy.js";
import { browserHosts, type BrowserOwner } from "./lifecycle.js";

export function browserOwnerFor(ctx: BindableContext): BrowserOwner {
  const binding = bindFrom(ctx);
  const principalId = actingPrincipalIdOf(ctx);
  const refusal = personalBrowserRefusal(personalBrowserPolicy(), { mode: binding.mode, trust: binding.trust, nonMember: nonMemberWake(ctx), actingPrincipal: principalId });
  if (refusal !== undefined) throw new Error(refusal);
  const person = tryPrincipalKey(binding.platform, binding.workspace, principalId!);
  if (person === undefined) throw new Error("I can't name your account on this platform's tenant, so I can't find your browser");
  const dmChannelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
  if (!dmChannelId) throw new Error("I couldn't resolve this DM's id — ask again from our direct message");
  const p = resolvePartition(ctx);
  return { org: p.org, person, principalId: principalId!, platform: binding.platform, dmChannelId, partition: p };
}

export async function browserHostsFor(ctx: BindableContext): Promise<readonly string[] | "all"> {
  const access = resolveAccessFor(ctx);
  const compiled = await compileNetworkPolicy(
    access,
    async () => ({ "x-oe-personal-browser": "host-only" }),
    (ids) => narrowByConnectorOverride(ctx, ids),
    resolveNetworkAccessLevel(access, getConfig().loadNetworkAccess?.() ?? []),
  );
  return browserHosts(compiled);
}
