import { appendAudit } from "../audit/audit.js";
import { allowedSurfaceIdsFrom } from "../channels/channel-read.js";
import { PERSON_RESOURCE_TYPE, personAddress, readDmAudience } from "../channels/dm-audience.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import type { Domain } from "../memory/domain.js";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import { resolveAccessFor } from "./request.js";
import type { ResourceCapability } from "./resource-capabilities.js";
import { parseResourceAddress, resourceTypesFor } from "./resource-grant.js";

export { PERSON_RESOURCE_TYPE };

export interface ChatDmTarget {
  readonly platform: string;
  readonly principalId: string;
  readonly address: string;
}

export class ChatDmGrantError extends Error {
  constructor(
    readonly platform: string,
    readonly principalId: string,
    readonly boundary: "malformed" | "ungranted" | "cross-domain" | "stopped" | "unreadable",
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

export function domainWorksOnPlatform(domainKey: string, platform: string, domains: readonly Domain[]): boolean {
  return allowedSurfaceIdsFrom(domainKey, platform, domains).ids.size > 0;
}

export function chatDmTargetsFrom(
  domainKey: string,
  granted: Readonly<Record<string, readonly ResourceCapability[]>>,
  domains: readonly Domain[],
): readonly ChatDmTarget[] {
  const worksOn = new Map<string, boolean>();
  const out: ChatDmTarget[] = [];
  for (const [address, capabilities] of Object.entries(granted)) {
    if (!capabilities.includes("dm")) continue;
    const parsed = parseResourceAddress(address);
    if (!parsed || parsed.type !== PERSON_RESOURCE_TYPE) continue;
    if (!resourceTypesFor(parsed.connector).includes(parsed.type)) continue;
    let works = worksOn.get(parsed.connector);
    if (works === undefined) {
      works = domainWorksOnPlatform(domainKey, parsed.connector, domains);
      worksOn.set(parsed.connector, works);
    }
    if (!works) continue;
    out.push({ platform: parsed.connector, principalId: parsed.id, address });
  }
  return out.sort((a, b) => a.address.localeCompare(b.address));
}

export function chatDmTargets(ctx: BindableContext, domains: readonly Domain[]): readonly ChatDmTarget[] {
  const domainKey = callerDomainKey(ctx);
  if (!domainKey) return [];
  return chatDmTargetsFrom(domainKey, grantedAddresses(ctx), domains);
}

export function chatDmMount(ctx: BindableContext, domains: () => readonly Domain[]): boolean {
  try {
    return chatDmTargets(ctx, domains()).length > 0;
  } catch {
    return false;
  }
}

export function resolveChatDmTargetFrom(
  domainKey: string | undefined,
  granted: Readonly<Record<string, readonly ResourceCapability[]>>,
  domains: readonly Domain[],
  requested: string,
): ChatDmTarget {
  const parsed = parseResourceAddress(requested);
  if (!parsed) {
    throw new ChatDmGrantError(
      "",
      requested,
      "malformed",
      `"${requested}" is not a person address — write \`<connector>:${PERSON_RESOURCE_TYPE}/<id>\`, e.g. ` +
        `${personAddress("slack", "U0123ABC")}.`,
    );
  }
  const target =
    domainKey === undefined ? undefined : chatDmTargetsFrom(domainKey, granted, domains).find((t) => t.address === requested);
  if (target) return target;

  const worksOnPlatform = domainKey !== undefined && domainWorksOnPlatform(domainKey, parsed.connector, domains);
  if (worksOnPlatform) {
    throw new ChatDmGrantError(
      parsed.connector,
      parsed.id,
      "ungranted",
      `direct-messaging ${parsed.connector} person "${parsed.id}" is not granted to this scope. This session works on ` +
        `${parsed.connector}, so the remedy is one config line: add ${JSON.stringify(requested)} to a bound bundle's ` +
        `\`resourceGrants\` (access/resource-grant.ts). Nobody is DMed by presence alone.`,
    );
  }
  throw new ChatDmGrantError(
    parsed.connector,
    parsed.id,
    "cross-domain",
    `direct-messaging ${parsed.connector} person "${parsed.id}" is refused: this session's memory domain declares no ` +
      `${parsed.connector} container, so it does not work on that surface at all. A grant cannot reach a surface the ` +
      `domain does not hold. The remedy is to give that domain a ${parsed.connector} container in its \`reach\` ` +
      `(memory/config/domains/<domain>.ts), which is a reviewed config change, and then grant the person.`,
  );
}

function resolveChatDmTarget(ctx: BindableContext, domains: readonly Domain[], requested: string): ChatDmTarget {
  return resolveChatDmTargetFrom(callerDomainKey(ctx), grantedAddresses(ctx), domains, requested);
}

export interface AdmittedChatDm {
  readonly target: ChatDmTarget;
  readonly delivered: boolean;
}

export async function assertChatDmAllowed(
  ctx: BindableContext,
  domains: readonly Domain[],
  requested: string,
): Promise<AdmittedChatDm> {
  let target: ChatDmTarget;
  try {
    target = resolveChatDmTarget(ctx, domains, requested);
  } catch (err) {
    if (err instanceof ChatDmGrantError) await auditChatDmRefusal(ctx, err);
    throw err;
  }
  const org = orgOf(ctx);
  const audience = await readDmAudience(org, target.address);
  if (!audience.readable) {
    const refusal = new ChatDmGrantError(
      target.platform,
      target.principalId,
      "unreadable",
      `nothing was sent to ${target.platform} person "${target.principalId}": this deployment could not read whether they ` +
        `have asked the agent to stop, and it will not send a direct message it cannot check. Nobody refused you — say ` +
        `that the check itself failed, and that an operator should look at the store.`,
    );
    await auditChatDmRefusal(ctx, refusal);
    throw refusal;
  }
  if (audience.stopped) {
    const refusal = new ChatDmGrantError(
      target.platform,
      target.principalId,
      "stopped",
      `${target.platform} person "${target.principalId}" asked this agent to stop sending them direct messages, so nothing ` +
        `was sent. That boundary is theirs and no configuration overrides it — only they can lift it, by telling the ` +
        `agent in their own DM. Say so plainly rather than trying another route to reach them.`,
    );
    await auditChatDmRefusal(ctx, refusal);
    throw refusal;
  }
  return { target, delivered: audience.delivered };
}

function orgOf(ctx: BindableContext): string {
  try {
    return resolvePartition(ctx).org;
  } catch {
    return "";
  }
}

async function auditChatDmRefusal(ctx: BindableContext, refusal: ChatDmGrantError): Promise<void> {
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
      action: "dm.refused",
      detail: {
        target: refusal.principalId,
        boundary: refusal.boundary,
        callerSurfaceKey: partition.surfaceKey,
        ...(domainKeyOf(partition) === partition.surfaceKey ? {} : { callerDomainKey: domainKeyOf(partition) }),
      },
    });
  } catch (err) {
    console.warn(`[open-everywhere:audit] dm.refused row was not written: ${String(err)}`);
  }
}
