import { resolveWindowSources, currentTurnOrganization, type BindableContext } from "../identity/binding.js";
import type { Domain } from "../memory/domain.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import type { EntityRef } from "./entity-actions.js";

export interface TicketDestination {
  readonly platform?: string;
  readonly target?: string;
}

export interface TicketDraft {
  readonly title: string;
  readonly body: string;
}

export interface CreatedTicket {
  readonly ref: EntityRef;
  readonly url?: string;
  readonly summary: string;
}

export type TicketCreateFn = (target: string, draft: TicketDraft, organizationId?: string) => Promise<CreatedTicket>;

export interface TicketCreateAdapter {
  readonly platform: string;
  checkAccess?(ctx: BindableContext, target: string, domains: readonly Domain[]): void | Promise<void>;
  defaultTarget?(ctx: BindableContext): string | undefined;
  create: TicketCreateFn;
}

const TICKET_CREATE_ADAPTERS: Record<string, TicketCreateAdapter> = {};

export function registerTicketCreateAdapter(adapter: TicketCreateAdapter): void {
  if (!admitProviderRegistration(adapter.platform, "ticket-create-adapter")) return;
  TICKET_CREATE_ADAPTERS[adapter.platform] = adapter;
}

export function supportedTicketCreatePlatforms(): readonly string[] {
  return Object.keys(TICKET_CREATE_ADAPTERS);
}

export function ticketCreateFn(platform: string): TicketCreateFn | undefined {
  return TICKET_CREATE_ADAPTERS[platform]?.create;
}

export interface ResolvedTicketCreate {
  readonly platform: string;
  readonly target: string;
  readonly organizationId?: string;
  readonly run: (draft: TicketDraft) => Promise<CreatedTicket>;
}

export async function resolveTicketCreate(
  ctx: BindableContext,
  dest: TicketDestination | undefined,
  domains: readonly Domain[],
): Promise<ResolvedTicketCreate> {
  const sources = resolveWindowSources(ctx, domains);
  const supported = supportedTicketCreatePlatforms();

  let platform = dest?.platform;
  if (!platform) {
    const candidates = sources.filter((s) => supported.includes(s));
    if (candidates.length === 1) platform = candidates[0];
    else {
      throw new Error(
        candidates.length === 0
          ? `create_ticket: none of this window's sources (${sources.join(", ") || "none"}) can file a work item — ` +
            (supported.length ? `supported on ${supported.join(", ")}; add one to the memory domain's sources.` : "no surface supports it yet.")
          : `create_ticket: this window has more than one work surface (${candidates.join(", ")}) — pass \`platform\` to say which one to file on.`,
      );
    }
  }

  if (!sources.includes(platform)) {
    throw new Error(
      `create_ticket: "${platform}" is not one of this window's sources (${sources.join(", ") || "none"}) — ` +
        "you can only file into a surface that fans into this window (add it to the memory domain's sources).",
    );
  }

  const adapter = TICKET_CREATE_ADAPTERS[platform];
  if (!adapter) {
    throw new Error(
      `create_ticket is not supported on "${platform}" — ` +
        (supported.length ? `supported on ${supported.join(", ")}.` : "no surface supports it yet."),
    );
  }

  const target = dest?.target ?? adapter.defaultTarget?.(ctx);
  if (!target) {
    throw new Error(
      `create_ticket: no destination for "${platform}" and none could be inferred from this turn — ` +
        "pass `target` (a GitHub repo as \"owner/repo\", or a Linear team key such as \"ENG\").",
    );
  }

  await adapter.checkAccess?.(ctx, target, domains);
  const organizationId = currentTurnOrganization(ctx);
  return {
    platform,
    target,
    ...(organizationId ? { organizationId } : {}),
    run: (draft: TicketDraft) => adapter.create(target, draft, organizationId),
  };
}

import { githubTicketCreateAdapter } from "../scm/issue-actions.js";

registerTicketCreateAdapter(githubTicketCreateAdapter);
