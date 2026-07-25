import {
  bindFrom,
  currentTurnIssue,
  currentTurnGithubTarget,
  resolveWindowSources,
  type BindableContext,
} from "../identity/binding.js";
import type { Domain } from "../memory/domain.js";
import { admitProviderRegistration } from "../access/provider-selection.js";

export interface EntityRef {
  readonly platform: string;
  readonly id: string;
}

export type EntityVerb = "setState" | "assign" | "addLabel";

export type EntityActionFn = (entityId: string, value: string) => Promise<string>;

export interface EntityActionAdapter {
  readonly platform: string;
  checkAccess?(ctx: BindableContext, entityId: string): void;
  setState?: EntityActionFn;
  assign?: EntityActionFn;
  addLabel?: EntityActionFn;
}

const ENTITY_ACTION_ADAPTERS: Record<string, EntityActionAdapter> = {};

export function registerEntityActionAdapter(adapter: EntityActionAdapter): void {
  if (!admitProviderRegistration(adapter.platform, "entity-action-adapter")) return;
  ENTITY_ACTION_ADAPTERS[adapter.platform] = adapter;
}

export function supportedEntityActionPlatforms(): readonly string[] {
  return Object.keys(ENTITY_ACTION_ADAPTERS);
}

function platformsSupporting(verb: EntityVerb): readonly string[] {
  return Object.values(ENTITY_ACTION_ADAPTERS)
    .filter((a) => typeof a[verb] === "function")
    .map((a) => a.platform);
}

export function entityActionFn(platform: string, verb: EntityVerb): EntityActionFn | undefined {
  return ENTITY_ACTION_ADAPTERS[platform]?.[verb];
}

export function currentTurnEntityRef(ctx: BindableContext): EntityRef | undefined {
  const binding = bindFrom(ctx);
  if (binding.platform === "linear") {
    const issue = currentTurnIssue(ctx);
    return issue ? { platform: "linear", id: issue } : undefined;
  }
  if (binding.platform === "github") {
    const t = currentTurnGithubTarget(ctx);
    return t ? { platform: "github", id: `${t.owner}/${t.repo}#${t.number}` } : undefined;
  }
  return undefined;
}

export interface ResolvedEntityAction {
  readonly ref: EntityRef;
  readonly run: (value: string) => Promise<string>;
}

export function resolveEntityAction(
  ctx: BindableContext,
  verb: EntityVerb,
  explicitRef: EntityRef | undefined,
  domains: readonly Domain[],
): ResolvedEntityAction {
  const ref = explicitRef ?? currentTurnEntityRef(ctx);
  if (!ref) {
    throw new Error(
      `${verb}: no ticket entity for this turn — pass \`ref\` explicitly ({ platform, id }), or call this from a turn on a ticketing entity (a Linear issue or a GitHub issue/PR). ` +
        `Chat surfaces (Slack, Discord, Teams, Telegram) and Notion have no entity for this verb — not supported there.`,
    );
  }
  const sources = resolveWindowSources(ctx, domains);
  if (!sources.includes(ref.platform)) {
    throw new Error(
      `${verb}: "${ref.platform}" is not one of this window's sources (${sources.join(", ") || "none"}) — ` +
        "you can only act on an entity whose platform fans into this window (add it to the memory domain's sources).",
    );
  }
  const adapter = ENTITY_ACTION_ADAPTERS[ref.platform];
  const fn = adapter?.[verb];
  if (!fn) {
    const supported = platformsSupporting(verb);
    throw new Error(
      `${verb} is not supported on "${ref.platform}" — entity-gated: ` +
        (supported.length ? `supported on ${supported.join(", ")}.` : "no surface supports it yet."),
    );
  }
  adapter.checkAccess?.(ctx, ref.id);
  return { ref, run: (value: string) => fn(ref.id, value) };
}

import { githubEntityAdapter } from "../scm/issue-actions.js";

registerEntityActionAdapter(githubEntityAdapter);
