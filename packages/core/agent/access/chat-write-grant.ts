import { appendAudit } from "../audit/audit.js";
import { allowedSurfaceIdsFrom } from "../channels/channel-read.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import type { Domain } from "../memory/domain.js";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import { resolveAccessFor } from "./request.js";
import type { ResourceCapability } from "./resource-capabilities.js";
import { parseResourceAddress, resourceAddress, resourceTypesFor } from "./resource-grant.js";

export const CONTAINER_RESOURCE_TYPE = "channel";

export interface ChatWriteTarget {
  readonly platform: string;
  readonly container: string;
  readonly address: string;
}

export class ChatWriteGrantError extends Error {
  constructor(
    readonly platform: string,
    readonly container: string,
    readonly boundary: "malformed" | "ungranted" | "cross-domain",
    message: string,
  ) {
    super(message);
  }
}

function grantedAddresses(ctx: BindableContext): Readonly<Record<string, readonly ResourceCapability[]>> {
  try {
    return resolveAccessFor(ctx).resourceCapabilities;
  } catch {
    return {};
  }
}

function callerDomainKey(ctx: BindableContext): string | undefined {
  try {
    return domainKeyOf(resolvePartition(ctx));
  } catch {
    return undefined;
  }
}

export function chatWriteTargetsFrom(
  domainKey: string,
  granted: Readonly<Record<string, readonly ResourceCapability[]>>,
  domains: readonly Domain[],
): readonly ChatWriteTarget[] {
  const rosterByPlatform = new Map<string, Set<string>>();
  const out: ChatWriteTarget[] = [];
  for (const [address, capabilities] of Object.entries(granted)) {
    if (!capabilities.includes("post")) continue;
    const parsed = parseResourceAddress(address);
    if (!parsed || parsed.type !== CONTAINER_RESOURCE_TYPE) continue;
    if (!resourceTypesFor(parsed.connector).includes(parsed.type)) continue;
    let roster = rosterByPlatform.get(parsed.connector);
    if (!roster) {
      roster = allowedSurfaceIdsFrom(domainKey, parsed.connector, domains).ids;
      rosterByPlatform.set(parsed.connector, roster);
    }
    if (!roster.has(parsed.id)) continue;
    out.push({ platform: parsed.connector, container: parsed.id, address });
  }
  return out.sort((a, b) => a.address.localeCompare(b.address));
}

export function chatWriteTargets(ctx: BindableContext, domains: readonly Domain[]): readonly ChatWriteTarget[] {
  const domainKey = callerDomainKey(ctx);
  if (!domainKey) return [];
  return chatWriteTargetsFrom(domainKey, grantedAddresses(ctx), domains);
}

export function chatWriteMount(ctx: BindableContext, domains: () => readonly Domain[]): boolean {
  try {
    return chatWriteTargets(ctx, domains()).length > 0;
  } catch {
    return false;
  }
}

export function resolveChatWriteTargetFrom(
  domainKey: string | undefined,
  granted: Readonly<Record<string, readonly ResourceCapability[]>>,
  domains: readonly Domain[],
  requested: string,
): ChatWriteTarget {
  const parsed = parseResourceAddress(requested);
  if (!parsed) {
    throw new ChatWriteGrantError(
      "",
      requested,
      "malformed",
      `"${requested}" is not a container address — write \`<connector>:${CONTAINER_RESOURCE_TYPE}/<id>\`, e.g. ` +
        `${resourceAddress("slack", CONTAINER_RESOURCE_TYPE, "C0123ABC")}.`,
    );
  }
  const target =
    domainKey === undefined ? undefined : chatWriteTargetsFrom(domainKey, granted, domains).find((t) => t.address === requested);
  if (target) return target;

  const inDomain =
    domainKey !== undefined && allowedSurfaceIdsFrom(domainKey, parsed.connector, domains).ids.has(parsed.id);
  if (inDomain) {
    throw new ChatWriteGrantError(
      parsed.connector,
      parsed.id,
      "ungranted",
      `posting to ${parsed.connector} container "${parsed.id}" is not granted to this scope. The container is in this ` +
        `session's memory domain, so the remedy is one config line: add ${JSON.stringify(requested)} to a bound ` +
        `bundle's \`resourceGrants\` (access/resource-grant.ts).`,
    );
  }
  throw new ChatWriteGrantError(
    parsed.connector,
    parsed.id,
    "cross-domain",
    `posting to ${parsed.connector} container "${parsed.id}" is refused: it is not in this session's memory domain. ` +
      `The agent may only post in containers its own domain declares — a grant cannot reach across domains. ` +
      `The remedy is to add the container to that domain's \`channels\` in memory/config/domains.ts, which is a reviewed ` +
      `config change, and then grant it.`,
  );
}

export function resolveChatWriteTarget(
  ctx: BindableContext,
  domains: readonly Domain[],
  requested: string,
): ChatWriteTarget {
  return resolveChatWriteTargetFrom(callerDomainKey(ctx), grantedAddresses(ctx), domains, requested);
}

export async function assertChatWriteAllowed(
  ctx: BindableContext,
  domains: readonly Domain[],
  requested: string,
): Promise<ChatWriteTarget> {
  try {
    return resolveChatWriteTarget(ctx, domains, requested);
  } catch (err) {
    if (err instanceof ChatWriteGrantError) await auditChatWriteRefusal(ctx, err);
    throw err;
  }
}

async function auditChatWriteRefusal(ctx: BindableContext, refusal: ChatWriteGrantError): Promise<void> {
  try {
    const partition = resolvePartition(ctx);
    const principalId = bindFrom(ctx).principalId;
    const platform = refusal.boundary === "malformed" ? partition.platform : refusal.platform;
    const foreignCaller = partition.platform !== platform;
    await appendAudit({
      org: partition.org,
      platform,
      workspace: foreignCaller ? "unknown" : partition.workspace,
      surface: foreignCaller ? "unknown" : partition.surface,
      ...(principalId ? { principalId } : {}),
      action: "chat.post_refused",
      detail: {
        target: refusal.container,
        boundary: refusal.boundary,
        callerSurfaceKey: partition.surfaceKey,
        ...(domainKeyOf(partition) === partition.surfaceKey ? {} : { callerDomainKey: domainKeyOf(partition) }),
      },
    });
  } catch (err) {
    console.warn(`[open-everywhere:audit] chat.post_refused row was not written: ${String(err)}`);
  }
}
