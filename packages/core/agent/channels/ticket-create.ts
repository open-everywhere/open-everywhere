import { currentTurnOrganization, type BindableContext } from "../identity/binding.js";
import { workDestinationPlatforms } from "./work-destinations.js";
import { registerWorkPlatform } from "./work-registry.js";
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
  readonly workRole?: string;
  checkAccess?(ctx: BindableContext, target: string, domains: readonly Domain[]): void | Promise<void>;
  defaultTarget?(ctx: BindableContext): string | undefined;
  workspaceFor?(ctx: BindableContext): string | undefined;
  create: TicketCreateFn;
}

const TICKET_CREATE_ADAPTERS: Record<string, TicketCreateAdapter> = {};

export function registerTicketCreateAdapter(adapter: TicketCreateAdapter): void {
  if (!admitProviderRegistration(adapter.platform, "ticket-create-adapter")) return;
  TICKET_CREATE_ADAPTERS[adapter.platform] = adapter;
  registerWorkPlatform(adapter.platform, adapter.workRole);
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
  const destinations = workDestinationPlatforms(ctx, domains);
  const supported = supportedTicketCreatePlatforms();

  let platform = dest?.platform;
  if (!platform) {
    const candidates = destinations.filter((s) => supported.includes(s));
    if (candidates.length === 1) platform = candidates[0];
    else {
      throw new Error(
        candidates.length === 0
          ? `create_ticket: none of this session's work destinations (${destinations.join(", ") || "none"}) can file a work item — ` +
            (supported.length
              ? `supported on ${supported.join(", ")}; give the memory domain a work credential for one of them (\`credentials\`). A chat channel on that platform does not confer it.`
              : "no surface supports it yet.")
          : `create_ticket: this session has more than one work surface (${candidates.join(", ")}) — pass \`platform\` to say which one to file on.`,
      );
    }
  }

  if (!destinations.includes(platform)) {
    throw new Error(
      `create_ticket: "${platform}" is not one of this session's work destinations (${destinations.join(", ") || "none"}) — ` +
        "the memory domain must hold a work credential for it (`credentials`). Talking on that platform does not grant filing on it.",
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
  const organizationId = currentTurnOrganization(ctx) ?? adapter.workspaceFor?.(ctx);
  return {
    platform,
    target,
    ...(organizationId ? { organizationId } : {}),
    run: (draft: TicketDraft) => adapter.create(target, draft, organizationId),
  };
}

import { githubTicketCreateAdapter } from "../scm/issue-actions.js";

registerTicketCreateAdapter(githubTicketCreateAdapter);
